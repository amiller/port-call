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
"""
import argparse, datetime, json, os, shlex, subprocess, sys

HOST = "fractal"
PG = "docker exec vexa-rig-postgres-1 psql -U postgres vexa -tAc"
ARCHIVE = "/media/amiller/fractal-nvme2/vexa-archive"
TOKEN = "/home/amiller/projects/teleport/planning/scripts/drive_write_token.json"
MIN_SEGMENTS = 100
# Notes engine. "near" keeps the whole pipeline on NEAR inference — the same provider and the same
# key already doing the transcription — which is what makes a pod/CVM deployment possible at all:
# there is no `claude` CLI in a confidential VM, and no way to carry an OAuth session into one.
# The call is issued FROM fractal, inside the near-shim container that already holds NEAR_API_KEY,
# so the key never moves to whatever machine is running this script.
NOTES_ENGINE = os.environ.get("NOTES_ENGINE", "near")
NEAR_MODEL = os.environ.get("NEAR_MODEL", "anthropic/claude-sonnet-5")
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

NAME: <a short name for this meeting, 2-5 words, the way a person would refer to it>

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
        "b=json.dumps({'model':%r,'max_tokens':16000,'messages':[{'role':'user','content':p}]}).encode()\n"
        "r=urllib.request.Request('https://cloud-api.near.ai/v1/chat/completions',data=b,"
        "headers={'Authorization':'Bearer '+os.environ['NEAR_API_KEY'],"
        "'Content-Type':'application/json'})\n"
        "print(json.load(urllib.request.urlopen(r,timeout=1800))"
        "['choices'][0]['message']['content'])\n" % NEAR_MODEL)
    return subprocess.run(
        ["ssh", HOST, f"docker exec -i vexa-rig-near-shim-1 python3 -c {shlex.quote(script)}"],
        input=prompt, stdout=subprocess.PIPE, text=True, check=True, timeout=1900).stdout


def claude_notes(prompt):
    return subprocess.run(
        ["claude", "-p", prompt, "--model", CLAUDE_MODEL, "--allowedTools", ""],
        stdout=subprocess.PIPE, text=True, check=True, cwd="/tmp", timeout=1800).stdout


def sql(q):
    return ssh(f"{PG} {shlex.quote(q)}").strip()


def utc(epoch):
    return datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)


def drive():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    creds = Credentials.from_authorized_user_file(TOKEN)
    if creds.expired:
        creds.refresh(Request())
    return build("drive", "v3", credentials=creds)


def existing_doc(svc, mid):
    q = f"appProperties has {{ key='vexaMeeting' and value='{mid}' }} and trashed=false"
    files = svc.files().list(q=q, fields="files(id,name)").execute()["files"]
    return files[0] if files else None


def build_markdown(mid, include_raw=False):
    meeting = json.loads(sql(
        "select json_build_object('code',platform_specific_id,'status',status,"
        f"'start',extract(epoch from start_time),'end',extract(epoch from end_time)) "
        f"from meetings where id={mid}"))
    if meeting["status"] != "completed":
        sys.exit(f"meeting {mid} is {meeting['status']}, not completed")

    segs = json.loads(sql(
        "select coalesce(json_agg(json_build_object('t',start_time,'s',speaker,'x',text) "
        f"order by start_time, id), '[]') from transcriptions where meeting_id={mid}"))
    if len(segs) < MIN_SEGMENTS:
        sys.exit(f"meeting {mid} has {len(segs)} segments, below the floor of {MIN_SEGMENTS}")

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

    lines = [f"[{utc(s['t']):%H:%M:%S}] {s['s'] or 'Speaker'}: {s['x'].strip()}" for s in segs]
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
        notes.strip(),
    ]
    # The raw transcript is withheld from the shared doc by default — direct participant feedback
    # (2026-08-19): raw ASR is "not only useless, it's misleading", and a shared doc travels. The
    # abridged transcript above replaces it; the raw stays in postgres, available on request.
    if include_raw:
        parts += ["## Full raw transcript", "*Times are UTC.*", transcript]
    else:
        parts += ["*The raw ASR transcript is withheld from this document — the abridgement "
                  "above replaces it. The raw text is retained and available on request.*"]
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


def run(mid, args):
    svc = None if args.dry_run else drive()
    prev = existing_doc(svc, mid) if svc else None   # before the model call, not after
    if prev and not args.update:
        print(f"meeting {mid} already has a doc: {prev['name']} {prev['id']}")
        return

    title, body, emails = build_markdown(mid, include_raw=args.raw)
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
    p.add_argument("--poll", action="store_true")
    p.add_argument("--since", type=int, default=24, help="hours, with --poll")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--update", action="store_true",
                   help="regenerate and replace an existing doc in place (same id, same sharing)")
    p.add_argument("--raw", action="store_true",
                   help="include the full raw transcript (withheld by default)")
    p.add_argument("--no-share", action="store_true")
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

    if args.poll:
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
