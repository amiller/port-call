"""OpenAI /v1/audio/transcriptions -> near.ai TEE whisper-large-v3.
Vexa's bot POSTs WAV here; inference runs in near's enclave, not local CPU."""
import os, time, wave, io, hashlib, audioop, collections, httpx
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse

NEAR = "https://cloud-api.near.ai/v1/audio/transcriptions"
KEY = os.environ["NEAR_API_KEY"]
# SET-BUT-EMPTY is the dangerous case, and os.environ does not catch it. In a dstack CVM the
# encrypted env does not reach docker compose interpolation, so `${NEAR_API_KEY}` resolves to ""
# and this shim used to boot happily, report {"status":"healthy"} to every probe, and 401 every
# single transcription. Fail at import instead: a crash-looping container is visible, a healthy
# one that transcribes nothing is not.
if not KEY.strip():
    raise SystemExit("near-shim: NEAR_API_KEY is empty — refusing to start and pretend to transcribe")
# metrics = content-free diagnostics (default when set); text = also log transcripts, for debugging only
LOG = os.environ.get("SHIM_LOG", "")
app = FastAPI()

STATS = {"chunks": 0, "bytes": 0, "inflight": 0, "last_ms": 0, "last_ts": 0,
         "audio_s": 0.0, "unique_s": 0.0, "recent": collections.deque(maxlen=40)}

# longest window seen per utterance, keyed by a truncated digest — Vexa resubmits a growing
# window of the same speech, so submitted seconds overstate what is actually distinct audio.
_windows = collections.OrderedDict()

def _track(text, dur):
    key = hashlib.sha1(text.strip().lower()[:40].encode()).hexdigest()[:10]
    prev = _windows.get(key, 0.0)
    if dur > prev:
        _windows[key] = dur
        STATS["unique_s"] += dur - prev
    _windows.move_to_end(key)
    while len(_windows) > 512:
        _windows.popitem(last=False)
    return key

@app.get("/health")
def health():
    return {"status": "healthy", "backend": "near.ai whisper-large-v3"}

@app.get("/stats")
def stats():
    return {k: (list(v) if k == "recent" else v) for k, v in STATS.items()}

@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...),
                     language: str = Form(None),
                     response_format: str = Form("verbose_json")):
    data = await file.read()
    form = {"model": "openai/whisper-large-v3", "response_format": "verbose_json"}
    if language and language != "auto":
        form["language"] = language
    STATS["inflight"] += 1
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=120) as c:
            r = await c.post(NEAR, headers={"Authorization": f"Bearer {KEY}"},
                             files={"file": (file.filename or "a.wav", data, "audio/wav")},
                             data=form)
    finally:
        STATS["inflight"] -= 1
    ms = round((time.monotonic() - t0) * 1000)
    STATS["chunks"] += 1; STATS["bytes"] += len(data)
    STATS["last_ms"] = ms; STATS["last_ts"] = time.time()
    STATS["recent"].append({"ts": time.time(), "bytes": len(data), "ms": ms, "status": r.status_code})
    body = r.json()
    if LOG:
        w = wave.open(io.BytesIO(data))
        dur = w.getnframes() / w.getframerate()
        peak = audioop.max(w.readframes(w.getnframes()), w.getsampwidth()) / 32768.0
        text = body.get("text") or ""
        STATS["audio_s"] += dur
        key = _track(text, dur)
        segs = body.get("segments") or []
        lp = min((s["avg_logprob"] for s in segs if "avg_logprob" in s), default=None)
        cr = max((s["compression_ratio"] for s in segs if "compression_ratio" in s), default=None)
        fields = (f"{time.strftime('%H:%M:%S')} utt={key} {len(data)}B dur={dur:.1f}s peak={peak:.3f} "
                  f"{ms}ms http={r.status_code} segs={len(segs)} chars={len(text.strip())} "
                  f"lp={lp if lp is None else round(lp, 2)} cr={cr if cr is None else round(cr, 2)}")
        # transcript text is meeting content — only with an explicit opt-in
        if LOG == "text":
            fields += f" text={text!r}"
        print("[shim]", fields, flush=True)
    return JSONResponse(status_code=r.status_code, content=body)
