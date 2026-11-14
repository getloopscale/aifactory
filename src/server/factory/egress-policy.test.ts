import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Just enough of mitmproxy for the addon to load and answer, so the policy runs without a proxy.
const STUB = `
class Headers(dict):
    pass
class Request:
    def __init__(self, host):
        self.host = host
        self.pretty_host = host
        self.headers = Headers()
class Response:
    @staticmethod
    def make(status, body, headers):
        return status
class Mode:
    def __init__(self, type_name):
        self.type_name = type_name
class Client:
    def __init__(self, transparent, sni, tls=False):
        self.proxy_mode = Mode("transparent" if transparent else "regular")
        self.sni = sni
        self.tls_established = tls
class HTTPFlow:
    def __init__(self, host, transparent=False, sni=None, tls=False):
        self.request = Request(host)
        self.client_conn = Client(transparent, sni, tls)
        self.response = None
class Question:
    def __init__(self, name, type=1):
        self.name = name
        self.type = type
class DnsRequest:
    def __init__(self, name, type):
        self.question = Question(name, type) if name else None
    def fail(self, code):
        return "failed:" + str(code)
    def succeed(self, answers):
        return "answered:" + ",".join(answers)
class DnsFlow:
    def __init__(self, name, type=1):
        self.request = DnsRequest(name, type)
        self.response = None
class Server:
    def __init__(self, address):
        self.address = address
        self.error = None
class ConnectData:
    def __init__(self, sni, address=("93.184.216.34", 443)):
        self.client = Client(True, sni)
        self.server = Server(address)
`

/**
 * Loads egress.py against a rules file, runs `steps` (Python, with the addon as `egress` and `write(rules)`
 * to replace the file the way the factory does), and returns what the steps printed.
 */
function policy(rules: object, steps: string): string {
  const root = mkdtempSync(join(tmpdir(), 'egress-test-'))
  dirs.push(root)
  mkdirSync(join(root, 'mitmproxy'))
  writeFileSync(join(root, 'mitmproxy', '__init__.py'), '')
  writeFileSync(join(root, 'mitmproxy', 'http.py'), STUB)
  mkdirSync(join(root, 'mitmproxy', 'net', 'dns'), { recursive: true })
  writeFileSync(join(root, 'mitmproxy', 'net', '__init__.py'), '')
  writeFileSync(join(root, 'mitmproxy', 'net', 'dns', '__init__.py'), '')
  writeFileSync(join(root, 'mitmproxy', 'net', 'dns', 'response_codes.py'), 'REFUSED = 5\n')
  writeFileSync(join(root, 'mitmproxy', 'net', 'dns', 'types.py'), 'A = 1\nAAAA = 28\n')
  writeFileSync(
    join(root, 'mitmproxy', 'dns.py'),
    'class ResourceRecord:\n    A = staticmethod(lambda name, ip: name + "=" + str(ip))\n    AAAA = A\n',
  )
  const file = join(root, 'rules.json')
  writeFileSync(file, JSON.stringify({ allow: rules }))
  const script = `
import importlib.util, json, os, sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["FACTORY_EGRESS_RULES"] = ${JSON.stringify(file)}
from mitmproxy import http
spec = importlib.util.spec_from_file_location("egress", ${JSON.stringify(resolve('ops/sandbox/egress.py'))})
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)
tick = [1000000000]
def write(rules):
    next = ${JSON.stringify(file)} + ".next"
    with open(next, "w") as f:
        json.dump({"allow": rules}, f)
    tick[0] += 5
    os.utime(next, (tick[0], tick[0]))
    os.rename(next, ${JSON.stringify(file)})
def send(host, transparent=False, sni=None, tls=False):
    flow = http.HTTPFlow(host, transparent, sni, tls)
    egress.request(flow)
    return flow
${steps}
`
  const run = spawnSync('python3', ['-I', '-c', script], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`python failed: ${run.stderr}`)
  return run.stdout.trim()
}

describe('the egress policy of a sandbox', () => {
  it('attaches the header of a listed host and refuses a host that is not listed', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic FIRST' } } },
      'print(send("github.com").request.headers["authorization"]); print(send("evil.example").response)',
    )

    expect(out).toBe('Basic FIRST\n403')
  })

  it('attaches the credential the factory renewed, once the rules file is replaced, without a restart', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic FIRST' } } },
      [
        'send("github.com")',
        'write({"github.com": {"headers": {"authorization": "Basic RENEWED"}}})',
        'print(send("github.com").request.headers["authorization"])',
      ].join('\n'),
    )

    expect(out).toBe('Basic RENEWED')
  })

  it('keeps the rules it has when the file cannot be read, rather than letting traffic through', () => {
    const out = policy(
      { 'github.com': {} },
      [
        'os.remove(os.environ["FACTORY_EGRESS_RULES"])',
        'print(send("github.com").response, send("evil.example").response)',
      ].join('\n'),
    )

    expect(out).toBe('None 403')
  })

  it('connects a connection that named no proxy to the name in its handshake, never to the address it chose', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic X' } } },
      [
        'listed = http.ConnectData("GitHub.com")',
        'egress.server_connect(listed)',
        'print(listed.server.address, listed.server.error)',
        'other = http.ConnectData("evil.example")',
        'egress.server_connect(other)',
        'print(other.server.address, other.server.error is not None)',
        'bare = http.ConnectData(None)',
        'egress.server_connect(bare)',
        'print(bare.server.error is not None)',
      ].join('\n'),
    )

    expect(out).toBe("('github.com', 443) None\n('93.184.216.34', 443) True\nTrue")
  })

  it('refuses, on the transparent listener, a request whose Host is not the name of its handshake', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic X' } } },
      [
        'same = send("github.com", True, "github.com")',
        'print(same.request.headers["authorization"])',
        'print(send("github.com", True, "registry.npmjs.org").response)',
      ].join('\n'),
    )

    expect(out).toBe('Basic X\n403')
  })

  it('answers every DNS query itself and asks no name server about a name the rules do not list', () => {
    const out = policy(
      { 'github.com': {}, '*.npmjs.org': {} },
      [
        'import ipaddress, socket',
        'asked = []',
        'def getaddrinfo(name, port, family, kind):',
        '    asked.append(name)',
        '    return [(family, kind, 0, "", ("10.1.2.3", 0))]',
        'socket.getaddrinfo = getaddrinfo',
        'def ask(name, type=1):',
        '    flow = http.DnsFlow(name, type)',
        '    egress.dns_request(flow)',
        '    return flow.response',
        'print(ask("github.com"), ask("registry.npmjs.org"), ask("github.com", 16))',
        'print(ask("c2VjcmV0.attacker.example"), ask("c2VjcmV0.attacker.example", 28), ask(None))',
        'print(asked)',
      ].join('\n'),
    )

    expect(out).toBe(
      "answered:github.com=10.1.2.3 answered:registry.npmjs.org=10.1.2.3 answered:\nfailed:5 failed:5 failed:5\n['github.com', 'registry.npmjs.org']",
    )
  })

  it('sends plain HTTP to the name its Host header gives, which must be listed, and never to the address chosen', () => {
    const out = policy(
      { 'github.com': { headers: { authorization: 'Basic X' } } },
      [
        'plain = send("GitHub.com", True)',
        'print(plain.request.headers["authorization"], plain.request.host)',
        'print(send("evil.example", True).response)',
        'print(send("github.com", True, None, True).response)',
        'allowed = http.ConnectData(None, ("github.com", 80))',
        'egress.server_connect(allowed)',
        'print(allowed.server.error)',
        'chosen = http.ConnectData(None, ("93.184.216.34", 80))',
        'egress.server_connect(chosen)',
        'print(chosen.server.error is not None)',
      ].join('\n'),
    )

    expect(out).toBe('Basic X github.com\n403\n403\nNone\nTrue')
  })

  it('names no function after a mitmproxy event it does not mean to handle', () => {
    // mitmproxy calls every module function named after an event. A helper named `load` was called with the
    // loader as an argument, the addon failed to load, and no sandbox could start until it was renamed.
    const events = [
      'load',
      'running',
      'configure',
      'done',
      'update',
      'client_connected',
      'client_disconnected',
      'server_connect',
      'server_connected',
      'server_disconnected',
      'tls_clienthello',
      'tls_start_client',
      'tls_start_server',
      'tls_established_client',
      'tls_established_server',
      'tls_failed_client',
      'tls_failed_server',
      'http_connect',
      'http_connect_upstream',
      'http_connected',
      'http_connect_error',
      'requestheaders',
      'request',
      'responseheaders',
      'response',
      'error',
      'websocket_start',
      'websocket_message',
      'websocket_end',
      'tcp_start',
      'tcp_message',
      'tcp_end',
      'tcp_error',
      'udp_start',
      'udp_message',
      'udp_end',
      'udp_error',
      'dns_request',
      'dns_response',
      'dns_error',
      'add_log',
    ]
    const out = policy(
      { 'github.com': {} },
      `print(" ".join(sorted(n for n in ${JSON.stringify(events)} if callable(getattr(egress, n, None)))))`,
    )

    expect(out).toBe('dns_request http_connect request server_connect')
  })
})
