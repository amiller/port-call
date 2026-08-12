"""OpenAI /v1/audio/speech -> local TTS, for Vexa's bot SPEAK path.

The bot pipes our response body straight into `paplay --raw --format=s16le --rate=24000
--channels=1`, so we must return HEADERLESS raw PCM — a WAV header would be played as noise.

MONO, and measure it with a CLICK TRAIN, not a duration span. A span/threshold measure cannot
tell a decay tail from a rate error: it read mono as "2x fast" and sent me to stereo, which was
a REGRESSION (clicks 1.000s apart came back 2.000s apart -- exactly 2x slow, because paplay does
honour --channels=1 and consumed the stereo stream as twice as many mono frames). Mono measures
RATIO 1.000. Bench recipe, no meeting/bot needed: play 3 clicks 1s apart into tts_sink, parecord
virtual_mic, compare the GAPS. Unmute tts_sink first -- the entrypoint mutes it and a muted
sink's monitor records pure silence, which looks exactly like a dead audio chain. (2026-08-11)

TTS_ENGINE=piper (default, natural) | espeak (robotic, zero-dependency fallback voice).
Both engines are local: no meeting text leaves the machine. near.ai serves no TTS model,
so unlike transcription this direction has no enclave option.
"""
import os, re, subprocess
from pathlib import Path
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response

TOKEN = os.environ.get("TTS_API_TOKEN", "")
ENGINE = os.environ.get("TTS_ENGINE", "piper")
PIPER = os.path.expanduser(os.environ.get("PIPER_BIN", "~/.local/bin/piper"))
MODEL = os.path.expanduser(os.environ.get(
    "PIPER_MODEL", "~/.local/share/piper-voices/en_US-lessac-medium.onnx"))
# `!name` plays sfx/name.wav (or any file dropped in there) instead of speaking. The bot's SPEAK
# path is just "fetch audio, pipe to paplay", so sound effects need no bot-side support at all.
SFX = Path(os.environ.get("SFX_DIR", Path(__file__).parent / "sfx"))
app = FastAPI()


def _ffmpeg(args, data):
    """Normalize whatever the engine emitted to the headerless s16le/24k/mono paplay wants."""
    return subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", *args, "-i", "pipe:0",
         "-f", "s16le", "-ar", "24000", "-ac", "1", "pipe:1"],
        input=data, capture_output=True, check=True).stdout


# Every failure below is espeak-ng's text normalization, not the neural model — so it is
# deterministic and fixable here, before synthesis. Measured behaviours:
#   "..."            -> no pause AND fuses adjacent words ("Yeah... hmm" -> "yeh-hum")
#   "e.g." / "Dr."   -> ends the sentence; each fragment gets its own falling intonation
#   emoji            -> read aloud by name ("party popper")
#   **bold**         -> "asterisk asterisk bold asterisk asterisk"
# An LLM told not to emit these will still do it sometimes, so this runs unconditionally.
ABBREV = {"e.g.": "for example", "i.e.": "that is", "etc.": "and so on", "vs.": "versus",
          "approx.": "approximately", "Dr.": "Doctor", "Mr.": "Mister", "Mrs.": "Missus",
          "Prof.": "Professor", "No.": "Number", "no.": "number", "Inc.": "Incorporated",
          "Ltd.": "Limited", "et al.": "and others", "Fig.": "Figure", "cf.": "compare"}
EMOJI = re.compile("[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF←-⇿⬀-⯿]+")


def normalize(text):
    text = EMOJI.sub(" ", text)
    text = re.sub(r"https?://\S+|`+", " ", text)          # URLs read letter-by-letter; backticks are silent noise
    text = re.sub(r"\*+|_{2,}|#{1,6}\s", "", text)         # markdown emphasis is spoken as "asterisk"
    for k, v in ABBREV.items():
        text = re.sub(rf"(?<!\w){re.escape(k)}", v, text)
    text = re.sub(r"\.{2,}", ",", text)                    # ellipsis -> a real pause instead of word fusion
    text = re.sub(r"(\w)—(\w)", r"\1 — \2", text)          # unspaced em-dash is silently dropped
    return re.sub(r"\s+", " ", text).strip()


def sfx(name):
    """Play a local audio file. Any format ffmpeg reads works — the .wav ones ship pre-rendered
    at the target format, anything else you drop in gets converted on the way out."""
    hit = next((p for p in sorted(SFX.glob(f"{name}.*"))), None)
    if hit is None:
        raise HTTPException(status_code=404,
                            detail=f"no sfx '{name}' in {SFX} ({[p.stem for p in SFX.glob('*')]})")
    return _ffmpeg([], hit.read_bytes())


# Measured on this hardware, not taken from docs:
#  --no-normalize: piper normalizes EACH SENTENCE to full scale, so a quiet aside is boosted to
#    the same peak as an emphatic line (audible pumping), and at 0 dBFS the 22050->24000 resample
#    clips (peak 1.0010, clipped samples). Off + fixed gain measured clean at 0.5947.
#  --noise-w-scale: phoneme-duration jitter, the real prosody knob (0.0 => bit-identical runs).
PIPER_FLAGS = ["--no-normalize", "--volume", "0.9", "--length-scale", "1.05",
               "--noise-w-scale", "0.6", "--sentence-silence", "0.2"]


def synth(text, voice):
    if ENGINE == "piper":
        raw = subprocess.run([PIPER, "-m", MODEL, "--output-raw", *PIPER_FLAGS],
                             input=text.encode(), capture_output=True, check=True).stdout
        rate = subprocess.run(
            ["python3", "-c", "import json,sys; print(json.load(open(sys.argv[1]))['audio']['sample_rate'])",
             MODEL + ".json"], capture_output=True, check=True).stdout.decode().strip()
        return _ffmpeg(["-f", "s16le", "-ar", rate, "-ac", "1"], raw)
    espeak = ["espeak", "--stdout"] + ([] if voice == "auto" else ["-v", voice]) + ["--", text]
    return _ffmpeg([], subprocess.run(espeak, capture_output=True, check=True).stdout)


@app.get("/health")
def health():
    return {"status": "healthy", "engine": ENGINE, "model": MODEL if ENGINE == "piper" else None}


@app.post("/v1/audio/speech")
async def speech(body: dict, x_api_key: str = Header(default="")):
    if TOKEN and x_api_key != TOKEN:
        raise HTTPException(status_code=401, detail="bad X-API-Key")
    text = body["input"].strip()
    if text.startswith("!"):
        name = text[1:].split()[0]
        pcm = sfx(name)
        print(f"[tts] sfx {name}: {len(pcm)}B pcm ({len(pcm)/48000:.1f}s)", flush=True)
    else:
        clean = normalize(text)
        pcm = synth(clean, body.get("voice") or "auto")
        note = "" if clean == text else f" (normalized from {len(text)})"
        print(f"[tts] {ENGINE}: {len(clean)} chars{note} -> {len(pcm)}B pcm ({len(pcm)/48000:.1f}s)", flush=True)
    return Response(content=pcm, media_type="audio/pcm")
