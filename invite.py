#!/usr/bin/env python3
"""Provision a tenant on a hosted Port Call instance, and print what they need to use it.

    ./invite.py <gateway-url> <email> "<name>"          # create + mint
    ./invite.py <gateway-url> <email> --show            # look up an existing tenant

Reads ADMIN_TOKEN from the environment (or cvm.env in this directory).

WHY THIS IS A TOOL AND NOT A DOC: the three calls below have to happen in order, the second needs
an id only the first returns, and the whole thing is unreachable from outside a hosted deployment
unless the gateway carries the admin passthrough (f45968d). Written down as prose it gets done
wrong once and then trusted.

WHERE OAUTH3 GOES: this is the operator performing an invite. The tenant-facing version is the same
three calls with the identity coming from an oauth3 permit instead of the operator's judgement —
login resolves to an email, and this decides whether that email already has tokens. Keeping the
minting here means oauth3 sits IN FRONT of a working model rather than replacing it (see #64).
"""
import json, os, sys, urllib.request, urllib.error

# The published handbook. Override if it moves.
HANDBOOK = os.environ.get(
    "PORT_CALL_HANDBOOK",
    "https://claude.ai/code/artifact/61165100-d6c0-4dd3-81cc-f07134f7c60c")

def call(method, url, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"X-Admin-API-Key": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        # Surface the downstream body: "403 Invalid or missing admin token" and "401 X-Admin-API-Key
        # required" are different problems and the difference is the whole diagnosis.
        raise SystemExit(f"{method} {url} -> {e.code} {e.read().decode()[:200]}")

def admin_token():
    tok = os.environ.get("ADMIN_TOKEN")
    if tok: return tok
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cvm.env")
    if os.path.exists(here):
        for line in open(here):
            if line.startswith("ADMIN_TOKEN="): return line.split("=", 1)[1].strip()
    raise SystemExit("no ADMIN_TOKEN (env or cvm.env)")

def main():
    if len(sys.argv) < 4: raise SystemExit(__doc__)
    base, email, name = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
    tok = admin_token()

    # POST /admin/users is idempotent: a known email returns the existing user rather than erroring,
    # which is what makes re-running this safe.
    status, user = call("POST", f"{base}/admin/users", tok, {"email": email, "name": name})
    uid = user["id"]
    print(f"user {uid}  {user['email']}  max_concurrent_bots={user.get('max_concurrent_bots')}"
          f"  ({'created' if status == 201 else 'existing'})")

    if name == "--show":
        return
    tokens = {}
    for scope in ("bot", "tx"):
        _, t = call("POST", f"{base}/admin/users/{uid}/tokens?scope={scope}", tok)
        tokens[scope] = t["token"]

    # One link, nothing to edit. The handbook reads these from the fragment, which is never sent to
    # any server, and stores them in the reader's own browser. The alternative — a doc full of
    # YOUR-INSTANCE placeholders — makes the SENDER do find-and-replace before every invite, which
    # is work we invented and then handed to the person doing the favour.
    # ONE link that lands them in a working console. Not a document with values to paste: the
    # token rides in the fragment, which browsers never send to a server, and the console stores it
    # and scrubs the address bar. Nothing for either side to copy.
    import urllib.parse as _u
    console = f"{base}/console#t={_u.quote(tokens['bot'])}"
    print(f"""
Send them this. It opens their console, already signed in:

  {console}

Reading transcripts needs the other token, and the console takes it the same way:

  {base}/console#t={_u.quote(tokens['tx'])}

Background, if they want it — the handbook explains what the bot can and cannot do:

  {HANDBOOK}#{_u.urlencode({"i": base.replace("https://", "").replace("http://", "").rstrip("/")})}

Raw values, if you would rather hand them over some other way:

  PORT_CALL_URL={base}
  PORT_CALL_BOT_TOKEN={tokens['bot']}
  PORT_CALL_TX_TOKEN={tokens['tx']}

The bot joins meetings under THIS instance's own Google identity, not theirs — see #64. Tell them
that before they invite it to anything, not after.

These links carry a token, so treat them like one: fine in a DM, not in a channel that logs URLs.""")

if __name__ == "__main__":
    main()
