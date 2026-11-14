"""The egress policy of one sandbox, for mitmproxy.

Reads /rules/rules.json, `{"allow": {"github.com": {"headers": {"authorization": "..."}}, "*.npmjs.org": {}}}`.
A request to a host that is not listed is refused, and a listed host gets its headers attached outside the
sandbox, so a credential never exists inside it. There is no catch-all entry.

The factory replaces the file while the sandbox runs, to renew a credential before it expires, so the file is
read again whenever it changes. The factory renames a complete file over the old one, so a read never sees
half of it. A file that cannot be read keeps the rules already loaded: the policy never opens up.

A connection that did not name the proxy (a child that dropped the environment) arrives on the transparent
listener, where the only name it carries is the SNI of its TLS handshake. That name is checked against the rules,
and the proxy connects to it, never to the address the client chose: a client cannot get a credential attached
to a request it sends to some other address by claiming a listed name. Plain HTTP has no SNI: it goes to the
name its Host header gives, which the rules must list, and never to the address the client chose. A connection
that names nothing (TLS with no SNI, a bare IP) is refused there. A name is resolved (the DNS listener)
only when the rules allow it: an unlisted name is answered REFUSED, so a query carries nothing out.
"""
import json
import os
import sys

from mitmproxy import http

RULES = os.environ.get("FACTORY_EGRESS_RULES", "/rules/rules.json")


def read_rules():
    with open(RULES) as f:
        return json.load(f)["allow"]


ALLOW = read_rules()
LOADED = os.stat(RULES).st_mtime_ns


def current():
    global ALLOW, LOADED
    try:
        changed = os.stat(RULES).st_mtime_ns
        if changed != LOADED:
            ALLOW, LOADED = read_rules(), changed
    except (OSError, ValueError, KeyError) as error:
        print(f"egress: keeping the rules loaded before; {RULES} could not be read: {error}", file=sys.stderr)
    return ALLOW


def rule_for(host):
    allow = current()
    host = (host or "").lower().rstrip(".")
    if host in allow:
        return allow[host]
    for pattern, rule in allow.items():
        if pattern.startswith("*.") and host.endswith(pattern[1:]):
            return rule
    return None


def refuse(flow):
    flow.response = http.Response.make(
        403, b"blocked by the factory egress policy", {"content-type": "text/plain"}
    )


def transparent(client):
    return getattr(getattr(client, "proxy_mode", None), "type_name", "") == "transparent"


def server_connect(data):
    """Where a transparent connection goes: the name it announced, never the address the client chose."""
    if not transparent(data.client):
        return
    sni = (data.client.sni or "").lower().rstrip(".")
    if sni:
        if rule_for(sni) is None:
            data.server.error = "blocked by the factory egress policy"
            return
        data.server.address = (sni, data.server.address[1])
        return
    # No SNI: plain HTTP, whose `request` hook already pointed the connection at the Host it names, or a
    # connection that names nothing, whose address is an IP no rule lists.
    if rule_for(data.server.address[0]) is None:
        data.server.error = "blocked by the factory egress policy"


def resolve(name, kind):
    """The addresses of an allowed name, from the proxy's own resolver; nothing asks any other server."""
    import ipaddress
    import socket

    family = socket.AF_INET if kind == "A" else socket.AF_INET6
    try:
        found = socket.getaddrinfo(name, None, family, socket.SOCK_STREAM)
    except OSError:
        return []
    return sorted({ipaddress.ip_address(info[4][0]) for info in found}, key=str)


def dns_request(flow):
    """
    Answers every DNS query itself, before anything is forwarded or resolved: a name the rules do not list is
    REFUSED and no server is ever asked, so a query cannot carry data to a name server. The listener is a
    reverse proxy to an address that does not answer (see docker-sandbox.ts), so a query that reached the
    forwarding step would fail instead of leaving.
    """
    from mitmproxy import dns
    from mitmproxy.net.dns import response_codes, types

    question = flow.request.question
    if question is None or rule_for(question.name) is None:
        flow.response = flow.request.fail(response_codes.REFUSED)
        return
    kinds = {types.A: "A", types.AAAA: "AAAA"}
    kind = kinds.get(question.type)
    answers = []
    if kind:
        make = dns.ResourceRecord.A if kind == "A" else dns.ResourceRecord.AAAA
        answers = [make(question.name, address) for address in resolve(question.name, kind)]
    flow.response = flow.request.succeed(answers)


def http_connect(flow: http.HTTPFlow):
    if rule_for(flow.request.host) is None:
        refuse(flow)


def request(flow: http.HTTPFlow):
    rule = rule_for(flow.request.pretty_host)
    if rule is None:
        refuse(flow)
        return
    if transparent(flow.client_conn):
        sni = (flow.client_conn.sni or "").lower().rstrip(".")
        host = flow.request.pretty_host.lower().rstrip(".")
        if sni:
            if sni != host:
                refuse(flow)
                return
        elif getattr(flow.client_conn, "tls_established", False):
            # TLS with no SNI: the Host header is the client's word and nothing else says where it goes.
            refuse(flow)
            return
        else:
            # Plain HTTP: connect to the name the Host header gives, as the allowlist read it, and not to
            # the address the client chose, which could be anything.
            flow.request.host = host
    for name, value in (rule.get("headers") or {}).items():
        flow.request.headers[name] = value
