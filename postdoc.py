#!/usr/bin/env python3
"""Post-meeting Google Doc pipeline (issues #14 / #15).

Pulls a completed meeting's transcript out of the rig's postgres, has Claude write the notes,
creates the Doc as Andrew, and shares it with the roster-resolved attendees as commenter.

Runs from the laptop: postgres and the roster live on fractal (reached over ssh), the Drive
write token lives here and stays here.

  ./postdoc.py 99                  one meeting
  ./postdoc.py 99 --dry-run        print the markdown, create nothing
  ./postdoc.py 99 --no-share       create the doc, share it with nobody
  ./postdoc.py 99 --no-share --delete-after      end-to-end test that leaves nothing behind
  ./postdoc.py --poll              every completed meeting in the last day that has no doc yet
  ./postdoc.py --auth              mint a Drive+Docs token (surgical edits, comments survive)
"""
import argparse, datetime, json, os, shlex, subprocess, sys

HOST = "fractal"
PG = "docker exec vexa-rig-postgres-1 psql -U postgres vexa -tAc"
ARCHIVE = "/media/amiller/fractal-nvme2/vexa-archive"
# TWO tokens, and which one is live decides whether editing an existing doc is surgical or
# destructive.
#
# The legacy token belongs to OAuth client 503335792260-…, whose PROJECT Andrew has no console
# access to — the same wall lab-room.py hit with the Meet API. The Docs API can therefore never be
# enabled for it, so edits have to go export -> modify -> re-upload, which REPLACES the file and
# would silently destroy any comments people have left.
#
# TOKEN_OWN belongs to client 501810722786-… in gen-lang-client-0375995010, which IS his (every
# service account lives there) and already has the Docs API on. With it, edits are insertions at an
# index and comments survive. Mint it with:  ./postdoc.py auth
SCRIPTS = "/home/amiller/projects/teleport/planning/scripts"
TOKEN_OWN = f"{SCRIPTS}/postdoc_token.json"
TOKEN_LEGACY = f"{SCRIPTS}/drive_write_token.json"
TOKEN = TOKEN_OWN if os.path.exists(TOKEN_OWN) else TOKEN_LEGACY
# The desktop client Andrew controls, with a localhost redirect. Same one lab-room.py authorises
# against; override if that ever moves.
CLIENT_SECRETS = os.environ.get(
    "POSTDOC_CLIENT_SECRETS",
    os.path.expanduser("~/projects/teleport/onboard-elaine/credentials.json"))
SCOPES = ["https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/documents"]
MIN_SEGMENTS = 100
# Notes engine. "near" keeps the whole pipeline on NEAR inference — the same provider and the same
# key already doing the transcription — which is what makes a pod/CVM deployment possible at all:
# there is no `claude` CLI in a confidential VM, and no way to carry an OAuth session into one.
# The call is issued FROM fractal, inside the near-shim container that already holds NEAR_API_KEY,
# so the key never moves to whatever machine is running this script.
#
# THE MODEL CHOICE IS THE SECURITY BOUNDARY, not the "near" engine flag. NEAR serves two kinds of
# model over one API. Open-weight models it holds run inside its enclave and say so in their own
# metadata ("Attested model served via Chutes TEE, verified end-to-end by NEAR AI"); the gateway's
# Intel TDX quote is readable at /v1/attestation/report. Proprietary models — anthropic/*,
# google/gemini*, openai/gpt-5* — cannot run there, so NEAR proxies them and the transcript
# arrives at the vendor in the clear. Picking one of those buys anonymity of the CALLER and no
# protection at all for the CONTENT, which is backwards for meeting notes: the substance is the
# thing worth protecting, and it is precisely what survives any redaction pass. Default to an
# attested model, and treat a proprietary NEAR_MODEL as sending the transcript to that vendor.
NOTES_ENGINE = os.environ.get("NOTES_ENGINE", "near")
NEAR_MODEL = os.environ.get("NEAR_MODEL", "deepseek/deepseek-v3.2")
# Measured 2026-08-21: the TEE model 502s ("model is currently unavailable") on max_tokens above
# 8000, regardless of prompt size. The error names the wrong cause, so it reads as an outage.
NEAR_MAX_TOKENS = int(os.environ.get("NEAR_MAX_TOKENS", "8000"))
CLAUDE_MODEL = "opus"

CAVEAT = ('*A note on the transcript: this is live ASR, not a post-pass. Names and numbers are the '
          'least reliable part, and quiet stretches produce filler artifacts ("Thanks.", "Bye.") '
          'that nobody said. Where a name was unclear it is marked [?].*')

PROMPT = """Below is the full transcript of a meeting, captured live by a meeting bot running \
Whisper large-v3. Read it and write the shared document for its participants.

Rules:
- Nothing in any section may be absent from the transcript. Every number, proper noun and quoted \
phrase must actually appear below, or be marked [?].
- This is live ASR. It mangles names constantly. Do NOT silently correct a name into what you \
think it should be — if you are inferring, mark it [?]. Filler artifacts ("Thanks.", "Bye.", \
"Mm-hmm.") in quiet stretches were not said by anyone; ignore them.
- PRIVACY, before anything else: if anyone asks for something not to be shared, recorded, or \
"said outside this room", that content appears in NO section. People who are discussed but not \
present get no personal details beyond what the discussion itself needs. When in doubt, leave \
it out — the reader can ask; a leak cannot be unshared.
- Write for the people who were in the room. Concrete detail, not a précis: the threads, the \
decisions, the numbers, the disagreements, who said what when it matters.
- Organise the notes thematically, each theme opening with a short **bolded lead-in** followed by \
prose. Not a bullet dump.
- Follow-ups are the actions and open questions, one bullet each, named owner where the \
transcript names one.
- Plain, direct prose. No throat-clearing, no summary-of-a-summary, no "in conclusion".

Output exactly this shape and nothing else — no preamble, no code fence:

NAME: <a short name for this meeting, 2-5 words, the way a person would refer to it. Name the \
TOPIC, never the tooling: no bot names (ASR mangles them, and a title is the one place a \
mishear cannot be marked [?]), no proper noun you are not certain of>

## Digest

<AT MOST 300 words, self-contained, written to be copy-pasted onward as a single message to \
someone who was NOT in the meeting. Assume the reader is a close collaborator of the \
participants. Lead with the one thing that changed or was decided; compress, don't enumerate. \
Because this block travels beyond the room, people who were NOT in the meeting appear here \
only in neutral, factual terms — no characterizations, habits, preferences or stories about \
them, and nothing a participant flagged as separate or sensitive. That detail belongs in the \
Notes, which stay with the participants.>

## Notes

<the thematic notes>

## Follow-ups

<the bullets>

## Abridged transcript

<the conversation itself, condensed to what a participant would want to re-read: keep the real \
exchanges and turns of phrase, correct obvious mishears (marking real uncertainty [?]), merge \
fragmented lines, drop filler and dead air. Keep speaker labels. Aim for roughly a third the \
length of the raw transcript. This REPLACES the raw transcript in the shared document, so err \
toward keeping anything substantive.>

--- TRANSCRIPT ({speakers}), {date} ---

{transcript}
"""


def ssh(cmd, **kw):
    return subprocess.run(["ssh", HOST, cmd], stdout=subprocess.PIPE, text=True,
                          check=True, **kw).stdout


def near_notes(prompt):
    """Generate the notes on NEAR, from inside the container that holds the key.

    stdin carries the prompt so a two-hour transcript never becomes an argv or a quoted shell
    string, and the request body is assembled in Python on the far side rather than by the shell.
    """
    script = (
        "import os,sys,json,urllib.request\n"
        "p=sys.stdin.read()\n"
        "b=json.dumps({'model':%r,'max_tokens':%d,'stream':True,"
        "'messages':[{'role':'user','content':p}]}).encode()\n"
        "r=urllib.request.Request('https://cloud-api.near.ai/v1/chat/completions',data=b,"
        "headers={'Authorization':'Bearer '+os.environ['NEAR_API_KEY'],"
        "'Content-Type':'application/json'})\n"
        "out=[]\n"
        "for ln in urllib.request.urlopen(r,timeout=600):\n"
        "    ln=ln.strip()\n"
        "    if not ln.startswith(b'data: ') or ln==b'data: [DONE]': continue\n"
        "    out.append((json.loads(ln[6:])['choices'][0].get('delta') or {}).get('content') or '')\n"
        "sys.stdout.write(''.join(out))\n" % (NEAR_MODEL, NEAR_MAX_TOKENS))
    return subprocess.run(
        ["ssh", HOST, f"docker exec -i vexa-rig-near-shim-1 python3 -c {shlex.quote(script)}"],
        input=prompt, stdout=subprocess.PIPE, text=True, check=True, timeout=4200).stdout


def claude_notes(prompt):
    return subprocess.run(
        ["claude", "-p", prompt, "--model", CLAUDE_MODEL, "--allowedTools", ""],
        stdout=subprocess.PIPE, text=True, check=True, cwd="/tmp", timeout=1800).stdout


def sql(q):
    return ssh(f"{PG} {shlex.quote(q)}").strip()


def utc(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)


def auth():
    """Mint a Drive+Docs token against the client Andrew actually controls.  ./postdoc.py auth"""
    from google_auth_oauthlib.flow import InstalledAppFlow
    # Unbuffered: when stdout is not a tty Python buffers it, and run_local_server's "visit this
    # URL" line never reaches the log — the flow then waits forever on a URL nobody saw.
    sys.stdout.reconfigure(line_buffering=True)
    flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRETS, SCOPES)
    creds = flow.run_local_server(port=int(os.environ.get("POSTDOC_AUTH_PORT", "8767")),
                                  prompt="consent", access_type="offline", open_browser=False,
                                  authorization_prompt_message="Open this URL and approve:\n\n{url}\n")
    open(TOKEN_OWN, "w").write(creds.to_json())
    print(f"wrote {TOKEN_OWN}\n  scopes: {' '.join(SCOPES)}")
    print("  edits to existing docs are now surgical; comments survive")


def _creds():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    creds = Credentials.from_authorized_user_file(TOKEN)
    if creds.expired:
        creds.refresh(Request())
    return creds


def drive():
    from googleapiclient.discovery import build
    return build("drive", "v3", credentials=_creds())


def can_edit_surgically():
    """True when the live token can reach the Docs API. Decides insert-vs-rewrite, and the caller
    must not guess: a rewrite on a doc with comments destroys them."""
    return TOKEN == TOKEN_OWN


def append_section(doc_id, markdown):
    """Insert text at the end of an existing doc WITHOUT rewriting it.

    Falls back to nothing: if the Docs API is not reachable this raises, because the alternative
    (export, edit, re-upload) silently discards every comment on the document and the caller
    deserves to decide that rather than have it happen."""
    from googleapiclient.discovery import build
    if not can_edit_surgically():
        raise SystemExit(
            "refusing to edit: only the legacy token is present, and its project cannot enable the\n"
            "Docs API, so the only edit path would REPLACE the file and destroy any comments.\n"
            "Run  ./postdoc.py auth  to mint a token that can insert instead.")
    docs = build("docs", "v1", credentials=_creds())
    end = docs.documents().get(documentId=doc_id).execute()["body"]["content"][-1]["endIndex"] - 1
    docs.documents().batchUpdate(documentId=doc_id, body={"requests": [
        {"insertText": {"location": {"index": end}, "text": markdown}}]}).execute()
    return end


def existing_doc(svc, mid):
    q = f"appProperties has {{ key='vexaMeeting' and value='{mid}' }} and trashed=false"
    files = svc.files().list(q=q, fields="files(id,name)").execute()["files"]
    return files[0] if files else None


# One conversation can span several meeting rows: every crash, eviction or rejoin starts a new
# one. 2026-08-21 produced three rows for a single call with Ahmed. Stitching them is not merely
# concatenation — the bot was ABSENT between rows, and an unmarked seam reads as a quiet stretch,
# which is indistinguishable from nobody talking once Whisper's filler artifacts are in the mix.
# So the gap is stated in the transcript, in the caveat, and to the model writing the notes.
GAP_MARK_S = 120


def build_markdown(mid, include_raw=False, merge=()):
    ids = [mid, *merge]
    rows = json.loads(sql(
        "select coalesce(json_agg(json_build_object('id',id,'code',platform_specific_id,"
        "'status',status,'start',extract(epoch from start_time),"
        "'end',extract(epoch from end_time)) order by start_time), '[]') "
        f"from meetings where id in ({','.join(str(i) for i in ids)})"))
    if len(rows) != len(ids):
        sys.exit(f"asked for {ids}, found {[r['id'] for r in rows]}")
    for r in rows:
        if r["status"] != "completed":
            sys.exit(f"meeting {r['id']} is {r['status']}, not completed")
    codes = {r["code"] for r in rows}
    if len(codes) != 1:
        sys.exit(f"refusing to stitch different rooms: {codes}")
    meeting = {"code": rows[0]["code"], "status": "completed",
               "start": rows[0]["start"], "end": rows[-1]["end"]}

    segs = json.loads(sql(
        "select coalesce(json_agg(json_build_object('t',start_time,'s',speaker,'x',text) "
        f"order by start_time, id), '[]') from transcriptions "
        f"where meeting_id in ({','.join(str(i) for i in ids)})"))
    if len(segs) < MIN_SEGMENTS:
        sys.exit(f"meetings {ids} have {len(segs)} segments, below the floor of {MIN_SEGMENTS}")

    gaps = [(segs[i]["t"], segs[i + 1]["t"]) for i in range(len(segs) - 1)
            if segs[i + 1]["t"] - segs[i]["t"] > GAP_MARK_S]

    # roster.py is the gate: it exits non-zero and names anyone it cannot reach.
    resolved = ssh(f"python3 {ARCHIVE}/roster.py {mid}")
    emails = [e for e in (x.strip() for x in resolved.split("share with:")[1]
              .splitlines()[0].split(",")) if e and e != "(nobody)"]
    roster = {k: v for k, v in json.loads(ssh(f"cat {ARCHIVE}/roster.json")).items()
              if not k.startswith("_")}
    people, seen = [], set()
    for s in (x["s"] for x in segs):
        r = roster.get(s, {})
        if s not in seen and not r.get("bot") and "ignore" not in r:
            seen.add(s)
            people.append(s)

    # Per-person steering lives in the roster, beside the address — not in code and not in the
    # public tracker. First preference honored: a recipient known to want the raw transcript gets
    # it, overriding the withhold-by-default. Learned 2026-08-20 when a recipient flagged the
    # withheld-transcript line the day after the default shipped: a pipeline default must yield
    # to what the actual recipient asked for.
    for s_ in people:
        if roster.get(s_, {}).get("prefs", {}).get("raw_transcript"):
            include_raw = True

    lines = []
    for i, s_ in enumerate(segs):
        if i and s_["t"] - segs[i - 1]["t"] > GAP_MARK_S:
            lines.append(f"\n*** NOT RECORDED: {(s_['t'] - segs[i - 1]['t']) / 60:.0f} minutes "
                         f"with no bot in the room — nothing was captured here ***\n")
        lines.append(f"[{utc(s_['t']):%H:%M:%S}] {s_['s'] or 'Speaker'}: {s_['x'].strip()}")
    transcript = "\n\n".join(lines)

    prompt = PROMPT.format(speakers=", ".join(people),
                           date=f"{utc(meeting['start']):%d %B %Y}",
                           transcript=transcript)
    out = (near_notes(prompt) if NOTES_ENGINE == "near" else claude_notes(prompt)).strip()
    if not out.startswith("NAME:"):
        sys.exit(f"model did not return the expected shape:\n{out[:500]}")
    name, notes = out.split("\n", 1)
    name = name[len("NAME:"):].strip()

    start, end = utc(meeting["start"]), utc(meeting["end"])
    mins = round((meeting["end"] - meeting["start"]) / 60)
    parts = [
        f"# {name} — {start:%-d %B %Y}",
        f"**Time:** {start:%H:%M}–{end:%H:%M} UTC ({mins} min) "
        f"**Participants:** {', '.join(people)} "
        f"**Captured by:** Port Call, Andrew's meeting bot — Whisper large-v3 over a TEE "
        f"endpoint, transcribed live; notes and abridgement by a model reading only this "
        f"meeting's transcript, written for the participants.",
        CAVEAT,
        # Only promise the inline marker when the raw transcript is actually attached: with it
        # withheld there is nothing "below" to point at, and a caveat that describes a document
        # other than the one in your hands is worse than no caveat.
        *([("*Coverage gap: the bot was out of the room for "
            + ", ".join(f"{(b - a) / 60:.0f} minutes from {utc(a):%H:%M} UTC" for a, b in gaps)
            + ". Nothing from that stretch was captured"
            + (", and it is marked inline in the transcript below" if include_raw else "")
            + ". Absence there is missing data, not silence.*")] if gaps else []),
        notes.strip(),
    ]
    # The raw transcript is withheld from the shared doc by default — direct participant feedback
    # (2026-08-19): raw ASR is "not only useless, it's misleading", and a shared doc travels. The
    # abridged transcript above replaces it; the raw stays in postgres, available on request.
    if include_raw:
        parts += ["## Full raw transcript", "*Times are UTC.*", transcript]
    else:
        parts += ["*The raw ASR transcript is withheld from this document — the abridgement "
                  "above replaces it. The raw text lives in the bot's own database on the "
                  "operator's hardware (no third-party service holds it); meeting audio is "
                  "deleted after 21 days. Ask and you get the raw text; ask and it gets "
                  "deleted.*"]
    parts += ["*Spotted something wrong or missing? Comment on this doc — comments get read "
              "and folded into how these notes are made.*"]
    body = "\n\n".join(parts)
    title = f"{name} — {start:%-d %b %Y} — notes"
    return title, body, emails


def share(svc, doc_id, emails):
    for email in emails:
        try:
            svc.permissions().create(fileId=doc_id, sendNotificationEmail=True,
                                     body={"type": "user", "role": "commenter",
                                           "emailAddress": email}).execute()
        except Exception as e:
            # Drive returns "Internal error encountered" on calls that in fact succeeded.
            print(f"  permissions.create({email}) raised: {e}", file=sys.stderr)
    granted = {p.get("emailAddress"): p["role"] for p in
               svc.permissions().list(fileId=doc_id, fields="permissions(emailAddress,role)"
                                      ).execute()["permissions"]}
    missing = [e for e in emails if granted.get(e) != "commenter"]
    if missing:
        sys.exit(f"not shared as commenter with: {', '.join(missing)} (have: {granted})")
    return granted


def from_capture(path):
    """Parse a `--dry-run` capture back into (title, body, emails); see the print() below."""
    head, _, body = open(path).read().partition("\n\n")
    title, share_line = head.split("\n")[:2]
    return (title.removeprefix("=== ").strip(),
            body,
            [e.strip() for e in share_line.removeprefix("=== share with:").split(",") if e.strip()])


def run(mid, args):
    svc = None if args.dry_run else drive()
    prev = existing_doc(svc, mid) if svc else None   # before the model call, not after
    if prev and not args.update:
        print(f"meeting {mid} already has a doc: {prev['name']} {prev['id']}")
        return

    # --from-file replays an approved --dry-run capture verbatim. Regenerating would produce
    # DIFFERENT notes from the ones a human read and approved, and the doc goes to other people.
    title, body, emails = (from_capture(args.from_file) if args.from_file
                           else build_markdown(mid, include_raw=args.raw,
                                              merge=[int(x) for x in args.merge.split(',') if x.strip()]))
    emails = list(dict.fromkeys(emails + args.also))
    if args.caveat:
        extra = " ".join(args.caveat)
        assert CAVEAT in body, "caveat block not found in the assembled doc"
        body = body.replace(CAVEAT, CAVEAT[:-1] + " " + extra + "*", 1)
    if args.no_share:
        emails = []
    if args.dry_run:
        print(f"=== {title}\n=== share with: {', '.join(emails)}\n\n{body}")
        return

    from googleapiclient.http import MediaInMemoryUpload
    if prev:   # --update: replace the content of the existing doc, keeping its id and sharing
        media = MediaInMemoryUpload(body.encode(), mimetype="text/markdown")
        svc.files().update(fileId=prev["id"], media_body=media,
                           body={"name": title}).execute()
        print(f"updated {title}\n  https://docs.google.com/document/d/{prev['id']}/edit")
        print(f"  shared (unchanged): {share(svc, prev['id'], emails)}")
        return

    doc = svc.files().create(
        body={"name": title, "mimeType": "application/vnd.google-apps.document",
              "appProperties": {"vexaMeeting": str(mid)}},
        media_body=MediaInMemoryUpload(body.encode(), mimetype="text/markdown"),
        fields="id,name").execute()
    print(f"created {doc['name']}\n  https://docs.google.com/document/d/{doc['id']}/edit")
    print(f"  shared: {share(svc, doc['id'], emails)}")
    if args.delete_after:
        svc.files().delete(fileId=doc["id"]).execute()
        print(f"  deleted {doc['id']}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("meeting_id", nargs="?", type=int)
    p.add_argument("--auth", action="store_true",
                   help="mint a Drive+Docs token against the client Andrew controls, then exit")
    p.add_argument("--poll", action="store_true")
    p.add_argument("--since", type=int, default=24, help="hours, with --poll")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--update", action="store_true",
                   help="regenerate and replace an existing doc in place (same id, same sharing)")
    p.add_argument("--raw", action="store_true",
                   help="include the full raw transcript (withheld by default)")
    p.add_argument("--no-share", action="store_true")
    p.add_argument("--from-file", metavar="PATH",
                   help="create the doc from a saved --dry-run capture, byte for byte")
    p.add_argument("--merge", default="", metavar="IDS",
                   help="comma-separated extra meeting ids to stitch in (same room only) — one "
                        "conversation split across rows by a crash, eviction or rejoin")
    p.add_argument("--delete-after", action="store_true")
    # The roster resolves SPEAKERS. Someone who attended and never said a word is invisible to it,
    # so a quiet attendee silently misses the doc — the same "shared with 3 of 4 and looks fine"
    # failure the roster exists to prevent, arriving from the other direction.
    p.add_argument("--also", action="append", default=[], metavar="EMAIL",
                   help="extra recipient, repeatable (e.g. an attendee who never spoke)")
    # A caveat the pipeline cannot derive. The one that keeps coming up is a shared microphone:
    # one channel, several humans, so every word from that room lands under one name. The doc goes
    # to the people it misattributes, so saying so is the difference between a record and a wrong one.
    p.add_argument("--caveat", action="append", default=[], metavar="TEXT",
                   help="extra line for the transcript caveat, repeatable")
    args = p.parse_args()

    if args.auth:
        auth()
    elif args.poll:
        ids = sql(f"select m.id from meetings m where m.status='completed' "
                  f"and m.end_time > now() - interval '{args.since} hours' "
                  f"and (select count(*) from transcriptions where meeting_id=m.id) "
                  f">= {MIN_SEGMENTS} order by m.id").split()
        svc = drive()
        todo = [int(i) for i in ids if not existing_doc(svc, int(i))]
        print(f"completed in last {args.since}h with >= {MIN_SEGMENTS} segments: "
              f"{ids or '(none)'}; without a doc: {todo or '(none)'}")
        # One meeting with an unknown speaker must not stop the rest of the sweep, but the
        # run still ends non-zero and names every meeting it could not do.
        failed = []
        for mid in todo:
            try:
                run(mid, args)
            except (Exception, SystemExit) as e:
                failed.append(str(mid))
                print(f"meeting {mid} FAILED: {e}", file=sys.stderr)
        if failed:
            sys.exit("could not produce a doc for: " + ", ".join(failed))
    elif args.meeting_id:
        run(args.meeting_id, args)
    else:
        p.error("give a meeting id or --poll")


if __name__ == "__main__":
    main()
