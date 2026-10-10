#!/usr/bin/env python3
"""Local transcription for Port Call — a local addition, not part of upstream.

The bot posts WAV to an OpenAI-style /v1/audio/transcriptions URL. Upstream points that at near.ai;
this serves it from whisper.cpp on this Mac (Metal), so meeting audio never leaves the machine.

    bot (container) -> host.docker.internal:8177  this file  -> 127.0.0.1:8178  whisper-server

Why this sits in front of whisper-server instead of the bot calling it directly:
  - whisper.cpp names the language in full ("english"). The bot stores it in a varchar(10) column,
    so "luxembourgish" would fail the insert. Mapped to ISO codes here.
  - One process has to own which model is loaded so the console can offer a dropdown: it downloads
    a model on request, checks it, and swaps whisper-server over. The old model keeps serving until
    the new one is on disk.

whisper-server is started with beam search (-bs 5 -bo 5). Its own default is greedy, and in testing
greedy dropped a whole opening sentence that beam 5 — the whisper-cli default — kept.

    python3 stt_local.py serve          run the service (./pc up does this)
    python3 stt_local.py status         what is loaded, what is installed
    python3 stt_local.py use <model>    switch model, downloading it first if needed
"""
import hashlib, json, os, shutil, signal, socket, subprocess, sys, threading, time, zlib
import urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("STT_MODELS_DIR", HERE / "models"))
SELECTED = MODELS / ".selected"
PORT = int(os.environ.get("STT_PORT", 8177))
ENGINE_PORT = int(os.environ.get("STT_ENGINE_PORT", 8178))
ENGINE_URL = f"http://127.0.0.1:{ENGINE_PORT}/v1/audio/transcriptions"
SOURCE = os.environ.get("STT_SOURCE", "https://huggingface.co/ggerganov/whisper.cpp/resolve/main")
LOG = os.environ.get("STT_ENGINE_LOG", "/tmp/port-call-whisper.log")
# A download is refused if it would leave less than this free. Other tools on this Mac treat
# under 10 GB free as an emergency and start evicting their own models.
MIN_FREE_GB = float(os.environ.get("STT_MIN_FREE_GB", 11))
DEFAULT = "small.en"

# name, bytes, sha256, note — sizes and digests read from the model repo's own listing.
CATALOG = [
    ("base.en", 147964211, "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
     "fastest, English"),
    ("small.en", 487614201, "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
     "balanced, English"),
    ("small", 487601967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
     "balanced, any language"),
    ("medium.en-q5_0", 539225533, "76733e26ad8fe1c7a5bf7531a9d41917b2adc0f20f2e4f5531688a8c6cd88eb0",
     "more accurate, English"),
    ("large-v3-turbo-q5_0", 574041195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
     "most accurate for its size, any language"),
    ("large-v3-turbo", 1624555275, "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
     "most accurate, any language"),
]
BY_NAME = {c[0]: c for c in CATALOG}

# whisper's language names -> the ISO codes the rest of the pipeline expects.
LANG = dict(p.split("=")[::-1] for p in (
    "en=english|zh=chinese|de=german|es=spanish|ru=russian|ko=korean|fr=french|ja=japanese|"
    "pt=portuguese|tr=turkish|pl=polish|ca=catalan|nl=dutch|ar=arabic|sv=swedish|it=italian|"
    "id=indonesian|hi=hindi|fi=finnish|vi=vietnamese|he=hebrew|uk=ukrainian|el=greek|ms=malay|"
    "cs=czech|ro=romanian|da=danish|hu=hungarian|ta=tamil|no=norwegian|th=thai|ur=urdu|hr=croatian|"
    "bg=bulgarian|lt=lithuanian|la=latin|mi=maori|ml=malayalam|cy=welsh|sk=slovak|te=telugu|"
    "fa=persian|lv=latvian|bn=bengali|sr=serbian|az=azerbaijani|sl=slovenian|kn=kannada|et=estonian|"
    "mk=macedonian|br=breton|eu=basque|is=icelandic|hy=armenian|ne=nepali|mn=mongolian|bs=bosnian|"
    "kk=kazakh|sq=albanian|sw=swahili|gl=galician|mr=marathi|pa=punjabi|si=sinhala|km=khmer|"
    "sn=shona|yo=yoruba|so=somali|af=afrikaans|oc=occitan|ka=georgian|be=belarusian|tg=tajik|"
    "sd=sindhi|gu=gujarati|am=amharic|yi=yiddish|lo=lao|uz=uzbek|fo=faroese|ht=haitian creole|"
    "ps=pashto|tk=turkmen|nn=nynorsk|mt=maltese|sa=sanskrit|lb=luxembourgish|my=myanmar|bo=tibetan|"
    "tl=tagalog|mg=malagasy|as=assamese|tt=tatar|haw=hawaiian|ln=lingala|ha=hausa|ba=bashkir|"
    "jw=javanese|su=sundanese|yue=cantonese").split("|"))


def model_path(name):
    return MODELS / f"ggml-{name}.bin"


def installed(name):
    p = model_path(name)
    return p.is_file() and p.stat().st_size == BY_NAME[name][1]


def english_only(name):
    return ".en" in (name or "")


class Busy(Exception):
    pass


class Engine:
    """The whisper-server child process and the one model it has loaded."""

    def __init__(self):
        self.proc = None
        self.model = None
        self.activity = None      # {"kind": "downloading"|"loading", "name", "done", "total"}
        self.error = ""
        self.busy = threading.Lock()   # one download or swap at a time
        self.stats = {"requests": 0, "errors": 0, "last_ms": 0, "audio_s": 0.0}

    def alive(self):
        return self.proc is not None and self.proc.poll() is None and self.model is not None

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc, self.model = None, None

    def start(self, name):
        exe = shutil.which("whisper-server")
        if not exe:
            raise RuntimeError("whisper-server not found — brew install whisper-cpp")
        self.stop()
        self.activity = {"kind": "loading", "name": name}
        self.proc = subprocess.Popen(
            [exe, "-m", str(model_path(name)), "--host", "127.0.0.1", "--port", str(ENGINE_PORT),
             "--inference-path", "/v1/audio/transcriptions",
             "-l", "en" if english_only(name) else "auto", "-bs", "5", "-bo", "5", "-sns"],
            stdout=open(LOG, "ab"), stderr=subprocess.STDOUT)
        # whisper-server loads the model before it binds, so an open port means ready.
        deadline = time.time() + 120
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError(f"whisper-server exited ({self.proc.returncode}) — see {LOG}")
            try:
                socket.create_connection(("127.0.0.1", ENGINE_PORT), 0.5).close()
                break
            except OSError:
                if time.time() > deadline:
                    self.stop()
                    raise RuntimeError("whisper-server did not come up in 120s")
                time.sleep(0.3)
        self.model = name
        SELECTED.write_text(name)

    def download(self, name):
        _, size, sha, _ = BY_NAME[name]
        check_room(name)
        tmp = model_path(name).with_suffix(".partial")
        self.activity = {"kind": "downloading", "name": name, "done": 0, "total": size}
        digest = hashlib.sha256()
        try:
            req = urllib.request.Request(f"{SOURCE}/ggml-{name}.bin",
                                         headers={"User-Agent": "port-call-local-stt"})
            with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
                    digest.update(chunk)
                    self.activity["done"] += len(chunk)
            if digest.hexdigest() != sha:
                raise RuntimeError(f"ggml-{name}.bin failed its checksum — discarded")
            os.replace(tmp, model_path(name))
        finally:
            tmp.unlink(missing_ok=True)

    def select(self, name):
        """Switch to `name`, downloading first if needed. The loaded model keeps serving through
        the download; if the new one fails to start, the previous one is brought back."""
        if not self.busy.acquire(blocking=False):
            raise Busy()
        previous = self.model
        try:
            self.error = ""
            if not installed(name):
                self.download(name)
            self.start(name)
        except Exception as e:
            self.error = str(e)
            if previous and not self.alive() and installed(previous):
                try:
                    self.start(previous)
                    self.error += f" — still on {previous}"
                except Exception:
                    pass
        finally:
            self.activity = None
            self.busy.release()

    def status(self):
        a = self.activity
        state = a["kind"] if a else "ready" if self.alive() else "error" if self.error else "stopped"
        return {
            "state": state, "current": self.model if self.alive() else None,
            "activity": a, "error": self.error,
            "free_gb": round(shutil.disk_usage(MODELS).free / 1e9, 1),
            "source": SOURCE.split("//", 1)[-1].split("/resolve", 1)[0],
            "recommended": DEFAULT,   # what the console's one-click install fetches
            "stats": self.stats,
            "models": [{"name": n, "file": f"ggml-{n}.bin", "size_mb": round(b / 1e6),
                        "note": note, "installed": installed(n)} for n, b, _, note in CATALOG],
        }


def check_room(name):
    size = BY_NAME[name][1]
    after = (shutil.disk_usage(MODELS).free - size) / 1e9
    if after < MIN_FREE_GB:
        raise RuntimeError(f"not downloading ggml-{name}.bin ({size / 1e6:.0f} MB): it would leave "
                           f"{after:.1f} GB free, under the {MIN_FREE_GB:g} GB floor")


def normalize(d, model):
    """Make whisper.cpp's verbose_json look like what the bot's client was written against."""
    name = str(d.get("language") or "").lower()
    if english_only(model):
        d["language"], d["language_probability"] = "en", 1.0
    else:
        d["language"] = LANG.get(name, name[:10] or "unknown")
        d["language_probability"] = d.get("detected_language_probability") or 0
    for k in ("language_probabilities", "detected_language", "detected_language_probability"):
        d.pop(k, None)
    for s in d.get("segments") or []:
        s.pop("tokens", None)
        raw = (s.get("text") or "").strip().encode()
        # The bot drops segments whose text compresses too well (repetition loops). whisper.cpp
        # does not report the ratio, so compute it the way whisper does.
        if raw and "compression_ratio" not in s:
            s["compression_ratio"] = round(len(raw) / len(zlib.compress(raw)), 3)
        for w in s.get("words") or []:
            w.pop("t_dtw", None)
    return d


ENGINE = Engine()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, body):
        b = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/models":
            return self._json(200, ENGINE.status())
        if self.path == "/health":
            ok = ENGINE.alive()
            return self._json(200 if ok else 503, {"status": "healthy" if ok else "unavailable",
                                                   "backend": f"whisper.cpp {ENGINE.model}"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/model":
            return self._select(body)
        if self.path.rstrip("/").endswith("/v1/audio/transcriptions"):
            return self._transcribe(body)
        self._json(404, {"error": "not found"})

    def _select(self, body):
        try:
            name = json.loads(body or b"{}").get("name")
        except ValueError:
            name = None
        if name not in BY_NAME:
            return self._json(400, {"error": f"unknown model — one of {list(BY_NAME)}"})
        if ENGINE.busy.locked():
            return self._json(409, {"error": "busy with another model — wait for it to finish"})
        if not installed(name):
            try:
                check_room(name)
            except RuntimeError as e:
                return self._json(409, {"error": str(e)})
        if not (ENGINE.alive() and ENGINE.model == name):
            threading.Thread(target=ENGINE.select, args=(name,), daemon=True).start()
            time.sleep(0.2)   # let the status below show the new activity
        self._json(202, ENGINE.status())

    def _transcribe(self, body):
        # 503 is the bot's cue to retry with backoff, which covers the few seconds of a swap.
        if not ENGINE.alive():
            return self._json(503, {"error": "no local transcription model is loaded"})
        model, t0 = ENGINE.model, time.monotonic()
        ENGINE.stats["requests"] += 1
        try:
            req = urllib.request.Request(ENGINE_URL, data=body, method="POST", headers={
                "Content-Type": self.headers.get("Content-Type", "")})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read())
        except urllib.error.HTTPError as e:
            ENGINE.stats["errors"] += 1
            return self._json(e.code, {"error": e.read().decode(errors="replace")[:300]})
        except Exception as e:
            ENGINE.stats["errors"] += 1
            return self._json(503, {"error": f"whisper-server unreachable: {e}"})
        if "segments" not in d and "error" in d:   # whisper-server reports bad audio as 200 + error
            ENGINE.stats["errors"] += 1
            return self._json(400, d)
        d = normalize(d, model)
        ms = round((time.monotonic() - t0) * 1000)
        ENGINE.stats["last_ms"] = ms
        ENGINE.stats["audio_s"] = round(ENGINE.stats["audio_s"] + (d.get("duration") or 0), 1)
        # Content-free on purpose: transcript text is meeting content and is never logged here.
        print(f"[stt] {time.strftime('%H:%M:%S')} model={model} dur={d.get('duration') or 0:.1f}s "
              f"{ms}ms segs={len(d.get('segments') or [])} chars={len((d.get('text') or '').strip())}",
              flush=True)
        self._json(200, d)

    def log_message(self, *a):
        pass


def serve():
    MODELS.mkdir(parents=True, exist_ok=True)
    # A whisper-server orphaned by a killed run would hold the port and fail the next start.
    subprocess.run(["pkill", "-f", f"whisper-server .*--port {ENGINE_PORT}"], capture_output=True)
    # The last selection if it is still on disk, else any installed model. With none installed the
    # service still comes up: the console then offers a one-click install.
    want = SELECTED.read_text().strip() if SELECTED.exists() else DEFAULT
    have = [n for n in [want, *BY_NAME] if n in BY_NAME and installed(n)]
    if have:
        threading.Thread(target=ENGINE.select, args=(have[0],), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)

    def shutdown(*_):
        ENGINE.stop()
        os._exit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(f"[stt] listening on 127.0.0.1:{PORT}, models in {MODELS}", flush=True)
    server.serve_forever()


def call(path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method="POST" if body else "GET",
                                 data=json.dumps(body).encode() if body else None)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)
    except OSError:
        sys.exit("local transcription is not running — ./pc up")


def show(s):
    a = s.get("activity")
    line = f"{s['state']}: {s['current'] or '-'}"
    if a and a["kind"] == "downloading":
        line = f"downloading {a['name']} {a['done'] * 100 // a['total']}%"
    if not a and not any(m["installed"] for m in s["models"]):
        line = f"no model installed — ./pc model {s['recommended']}, or use the console's install button"
    print(line + (f"   ({s['error']})" if s.get("error") else ""))
    for m in s["models"]:
        mark = "*" if m["name"] == s["current"] else " "
        have = "installed" if m["installed"] else "not downloaded"
        print(f" {mark} {m['name']:<20} {m['size_mb']:>5} MB  {have:<15} {m['note']}")
    print(f"   free disk: {s['free_gb']} GB")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "serve":
        serve()
    elif cmd == "status":
        show(call("/models"))
    elif cmd == "use" and len(sys.argv) == 3:
        s = call("/model", {"name": sys.argv[2]})
        if "error" in s and "state" not in s:
            sys.exit(s["error"])
        while (s := call("/models"))["activity"]:
            a = s["activity"]
            pct = f" {a['done'] * 100 // a['total']}%" if a["kind"] == "downloading" else ""
            print(f"\r{a['kind']} {a['name']}{pct}   ", end="", flush=True)
            time.sleep(1)
        print("\r", end="")
        show(s)
    else:
        sys.exit(__doc__.split("\n\n")[-1])
