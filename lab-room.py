#!/usr/bin/env python3
"""Create (or re-open) a PERMANENT open lab room for unattended e2e, via the Meet REST API.

Why this exists: an ad-hoc "Quick access" room only lives as long as the call does. Once the
meeting ends, the code stops resolving and the bot is redirected to Meet's marketing page — which
is exactly how the autonomous loop died mid-run. Calendar-created links stay joinable when empty
but require a human to admit, and Quick access has no Calendar API.

The Meet REST API can create a space with accessType=OPEN, which is joinable by anyone with the
link, no knock, indefinitely. That needs ONE extra OAuth scope, authorized once:

    python3 lab-room.py auth        # prints a consent URL; paste the code back
    python3 lab-room.py create      # prints the permanent lab room code
    python3 lab-room.py open <code> # force an existing space to OPEN

Token is kept beside the calendar tokens, separate from them (different scope, different grant).
"""
import json, os, sys
from pathlib import Path

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
import urllib.request, urllib.error

HERE = Path(os.path.expanduser("~/projects/teleport/planning/scripts"))
# Use the OAuth client for the project Andrew ACTUALLY controls. The calendar tokens all use
# client 503335792260-…, whose project he has no console access to — so the Meet API can never be
# enabled there. gen-lang-client-0375995010 is his (every service account lives in it) and has a
# desktop client with a localhost redirect. Override with LAB_CLIENT_SECRETS if that changes.
SECRETS = Path(os.environ.get(
    "LAB_CLIENT_SECRETS",
    os.path.expanduser("~/projects/teleport/onboard-elaine/credentials.json")))
TOKEN = HERE / "meet_space_token.json"
SCOPES = ["https://www.googleapis.com/auth/meetings.space.created"]
API = "https://meet.googleapis.com/v2"


def creds():
    if not TOKEN.exists():
        sys.exit("no token — run: python3 lab-room.py auth")
    c = Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if c.expired and c.refresh_token:
        c.refresh(Request())
        TOKEN.write_text(c.to_json())
    return c


def call(method, path, body=None):
    c = creds()
    req = urllib.request.Request(
        f"{API}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {c.token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # Google puts the ACTIONABLE text in the response body ("API not enabled", "wrong scope");
        # letting HTTPError propagate shows only a traceback and hides it.
        body = e.read().decode(errors="replace")
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body[:500]
        sys.exit(f"Meet API {e.code}: {msg}")


def auth():
    # Unbuffered: when stdout is not a tty Python buffers it, so run_local_server's "visit this
    # URL" line never reaches a log file and the flow waits forever on a URL nobody saw.
    sys.stdout.reconfigure(line_buffering=True)
    # run_local_server, NOT the out-of-band flow: Google shut OOB down in 2022, and this is an
    # "installed" client whose only registered redirect is http://localhost — so a loopback
    # redirect is both the supported path and the one this client is configured for.
    flow = InstalledAppFlow.from_client_secrets_file(str(SECRETS), SCOPES)
    port = int(os.environ.get("LAB_AUTH_PORT", "8766"))
    creds = flow.run_local_server(port=port, prompt="consent", access_type="offline",
                                  open_browser=False,
                                  authorization_prompt_message="Open this URL and approve:\n\n{url}\n")
    TOKEN.write_text(creds.to_json())
    print(f"\nsaved {TOKEN}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "create"
    if cmd == "auth":
        auth()
    elif cmd == "create":
        s = call("POST", "/spaces", {"config": {"accessType": "OPEN", "entryPointAccess": "ALL"}})
        print("lab room:", s.get("meetingUri"))
        print("code:    ", s.get("meetingCode"))
        print("name:    ", s.get("name"))
    elif cmd == "open":
        code = sys.argv[2]
        s = call("PATCH", f"/spaces/{code}?updateMask=config.accessType",
                 {"config": {"accessType": "OPEN"}})
        print("now OPEN:", s.get("meetingUri"))
    else:
        sys.exit(__doc__)
