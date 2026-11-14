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
to a request it sends to some other address by claiming a listed name. A connection with no SNI (plain HTTP, or
a bare IP) is refused there, since nothing proves where it is going. A name is resolved (the DNS listener)
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
    if not transparent(data.client):
        return
    sni = (data.client.sni or "").lower().rstrip(".")
    if not sni or rule_for(sni) is None:
        data.server.error = "blocked by the factory egress policy"
        return
    data.server.address = (sni, data.server.address[1])


def dns_request(flow):
    """A name is resolved only when the rules allow it, so a query cannot carry data to a name server."""
    from mitmproxy.net.dns import response_codes

    question = flow.request.question
    if question is None or rule_for(question.name) is None:
        flow.response = flow.request.fail(response_codes.REFUSED)


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
        if sni != flow.request.pretty_host.lower().rstrip("."):
            refuse(flow)
            return
    for name, value in (rule.get("headers") or {}).items():
        flow.request.headers[name] = value
