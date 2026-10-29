"""Read-only RabbitMQ binding audit for d5. Never prints credentials.

Usage: broker-audit.py <broker-host> <local-port>
Reads the management URL (with credentials) from env MGMT_URL.
"""
import base64, json, os, re, ssl, sys, urllib.parse, urllib.request, http.client, socket

REPORT_KEY = "observability.event_stats.reported"
EXCHANGE_RE = re.compile(r"^(iam|programs|scheduling)\.events(\..+)?$")

def topic_match(pattern: str, key: str) -> bool:
    p, k = pattern.split("."), key.split(".")
    def m(i, j):
        if i == len(p):
            return j == len(k)
        if p[i] == "#":
            return any(m(i + 1, jj) for jj in range(j, len(k) + 1))
        if j == len(k):
            return False
        return (p[i] == "*" or p[i] == k[j]) and m(i + 1, j + 1)
    return m(0, 0)

host, port = sys.argv[1], int(sys.argv[2])
u = urllib.parse.urlsplit(os.environ["MGMT_URL"])
auth = base64.b64encode(f"{urllib.parse.unquote(u.username or '')}:{urllib.parse.unquote(u.password or '')}".encode()).decode()
ctx = ssl.create_default_context()

def get(path):
    # Connect to the local tunnel but verify TLS against the real broker hostname.
    sock = socket.create_connection(("127.0.0.1", port), timeout=20)
    tls = ctx.wrap_socket(sock, server_hostname=host)
    conn = http.client.HTTPSConnection(host, 443, context=ctx)
    conn.sock = tls
    conn.request("GET", path, headers={"Authorization": f"Basic {auth}", "Host": host})
    r = conn.getresponse()
    body = r.read()
    if r.status != 200:
        raise SystemExit(f"GET {path.split('?')[0]} -> HTTP {r.status}")
    return json.loads(body)

exchanges = [e for e in get("/api/exchanges?columns=name,vhost,type") if EXCHANGE_RE.match(e["name"])]
print(f"exchanges audited: {len(exchanges)} (types: {sorted({e['type'] for e in exchanges})}, vhosts: {sorted({e['vhost'] for e in exchanges})})")
total = matches = 0
for e in sorted(exchanges, key=lambda e: (e["vhost"], e["name"])):
    vh = urllib.parse.quote(e["vhost"], safe="")
    ex = urllib.parse.quote(e["name"], safe="")
    for b in get(f"/api/exchanges/{vh}/{ex}/bindings/source"):
        total += 1
        hit = e["type"] == "fanout" or topic_match(b["routing_key"], REPORT_KEY) if e["type"] in ("topic", "fanout") else b["routing_key"] == REPORT_KEY
        if hit:
            matches += 1
            print(f"MATCH vhost={e['vhost']} exchange={e['name']} -> {b['destination_type']}:{b['destination']} key={b['routing_key']!r}")
print(f"bindings checked: {total}; matching {REPORT_KEY}: {matches}")
