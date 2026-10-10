#!/usr/bin/env python3
"""Pipecat pipeline for Port Call — a local addition, not part of upstream.

Pipecat cannot join a Google Meet, so the bot stays the bot: browser, join, capture, camera, chat.
What moves here is what happens to the audio once the bot has it. The bot opens one WebSocket per
Meet audio stream and each connection gets its own Pipecat pipeline:

    bot --ws--> transport.input -> Silero VAD -> Whisper (stt_local.py, on this Mac)
                -> Smart Turn (is the speaker done? judged from the sound) -> events back to the bot

Why it is worth the move, measured against the bot's own pipeline (which re-sends a growing window
to Whisper every 2 s and calls text final when two passes agree, 6.3-8.5 s after speech by the
repo's notes): here the voice detector cuts the utterance when the speaker stops, Whisper hears it
once, and the text is final.

The voice leg is teed up, not on. With PIPECAT_VOICE unset nothing is ever sent back but events.
The slot is marked in build(): an LLM and a TTS between the turn detector and transport.output(),
and the serializer already carries audio frames back to the bot as raw PCM.

Wire format, bot -> here: a binary message is 8 bytes of little-endian capture time in ms (the
bot's clock, so transcripts can be matched to who was lit up when) followed by PCM16 mono 16 kHz.
Here -> bot: JSON text events (speech_start, transcript, turn_start, turn_end); binary, later, is
PCM for the bot to play.

The bot does not send silence: its in-page gate drops quiet blocks. So the end of an utterance
usually arrives as audio simply stopping, and VADProcessor's audio_idle_timeout is what closes
it. Blocks are 256 ms, so anything much under 0.4 s would cut speech at an ordinary hiccup.

    .venv-pipecat/bin/python pipecat_local.py          (./pc up does this)
"""
import asyncio, json, os, sys, time
from collections import deque
from dataclasses import dataclass, field

import uvicorn
from fastapi import FastAPI, WebSocket
from loguru import logger

from pipecat import __version__ as PIPECAT_VERSION
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    Frame, InputAudioRawFrame, OutputAudioRawFrame, OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame, TranscriptionFrame, UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.base_serializer import FrameSerializer
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

PORT = int(os.environ.get("PIPECAT_PORT", 8179))
STT_BASE = os.environ.get("PIPECAT_STT_BASE", "http://127.0.0.1:8177/v1")   # stt_local.py
RATE = 16000
VAD_START_SECS, VAD_STOP_SECS = 0.2, 0.2
IDLE_SECS = float(os.environ.get("PIPECAT_IDLE_SECS", 0.45))   # see the docstring: blocks are 256 ms
VOICE = os.environ.get("PIPECAT_VOICE", "") == "1"
# How long after the speaker stops this rig's Whisper can take to return (its P99, in Pipecat's
# terms). The turn detector uses it as the longest it will hold a finished turn open for a
# transcript that has not arrived. Pipecat's stock figure for Whisper is 1.0 s; large-v3-turbo
# here takes 0.8-1.1 s from the cut alone, so at 1.0 a turn with a pause in it ended on the words
# before the pause, ahead of its last transcript. In the ordinary case the turn ends the moment
# the transcript lands, so a generous figure costs nothing; /health reports what is observed.
STT_P99_SECS = float(os.environ.get("PIPECAT_STT_P99_SECS", 3.0))

# Pipecat logs transcript text at DEBUG. Transcripts are meeting content: keep them out of the log.
#
# One Pipecat warning is filtered and counted instead: "no audio received while speaking, forcing
# speech stop". It is meant for a microphone muted mid-word. Here it is how most utterances end,
# because the bot sends no silence (see the docstring), so it fired once per utterance.
CLOSED_BY_AUDIO_STOPPING = 0
RECENT_STT_MS: list[int] = []      # the last 50, to check STT_P99_SECS against reality


def _log_filter(record) -> bool:
    global CLOSED_BY_AUDIO_STOPPING
    if record["name"] == "pipecat.audio.vad.vad_controller" and "forcing speech stop" in record["message"]:
        CLOSED_BY_AUDIO_STOPPING += 1
        return False
    return True


logger.remove()
logger.add(sys.stderr, level=os.environ.get("PIPECAT_LOG", "WARNING"), filter=_log_filter)


@dataclass
class Stream:
    """What one connection knows: the bot's capture clock, and the utterance being cut."""
    meeting: str
    channel: str
    capture_ms: int = 0           # capture time of the END of the newest block received
    speech_t0: int = 0            # capture time the current utterance began
    speech_t1: int = 0            # ...and ended
    utterance_no: int = 0         # counts speech starts; says whether a transcript is for the latest
    # One entry per cut, oldest first: (utterance_no, t0, t1, wall clock at the cut). Whisper works
    # through cuts in order and may be a whole utterance behind, so each call takes ITS cut from
    # here instead of reading "the current one" off this object.
    cuts: deque = field(default_factory=deque)
    stats: dict = field(default_factory=lambda: {"utterances": 0, "empty": 0, "stt_ms": 0, "turns": 0})


class PortCallSerializer(FrameSerializer):
    def __init__(self, stream: Stream):
        super().__init__()
        self.stream = stream

    async def deserialize(self, data):
        if isinstance(data, (bytes, bytearray)) and len(data) > 8:
            pcm = bytes(data[8:])
            self.stream.capture_ms = int.from_bytes(data[:8], "little") + len(pcm) * 1000 // (2 * RATE)
            return InputAudioRawFrame(audio=pcm, sample_rate=RATE, num_channels=1)
        return None   # no control messages yet

    async def serialize(self, frame: Frame):
        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            return json.dumps(frame.message)
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio   # the voice leg: PCM for the bot to play
        return None


class Clock(FrameProcessor):
    """Stamps each utterance with the bot's capture clock, between the voice detector and Whisper."""

    def __init__(self, stream: Stream):
        super().__init__()
        self.stream = stream

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            s = self.stream
            if isinstance(frame, VADUserStartedSpeakingFrame):
                s.utterance_no += 1
                s.speech_t0 = s.capture_ms - int(VAD_START_SECS * 1000)
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                s.speech_t1 = s.capture_ms
                s.cuts.append((s.utterance_no, s.speech_t0, s.speech_t1, time.monotonic()))
        await self.push_frame(frame, direction)


class LocalWhisper(OpenAISTTService):
    """Whisper through stt_local.py, so the console's model dropdown still decides the model.
    Sends a transcript event for every utterance, empty ones included, so a cut that produced no
    text is visible rather than silently missing."""

    def __init__(self, stream: Stream):
        super().__init__(base_url=STT_BASE, api_key="local", ttfs_p99_latency=STT_P99_SECS,
                         settings=OpenAISTTService.Settings(model="whisper-1", language=Language.EN))
        self.stream = stream
        self._superseded: set[int] = set()

    async def push_frame(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM):
        # Pipecat's segmented STT marks EVERY transcript final. That is wrong for one case, and it
        # ended turns early: someone pauses and carries on, and the first part's transcript lands
        # after they have resumed. Marked final, it is later taken as the final transcript of the
        # whole turn, so the turn ended on the words before the pause while the rest was still
        # with Whisper. A transcript for an utterance that has been superseded goes out not-final.
        if isinstance(frame, TranscriptionFrame) and id(frame) in self._superseded:
            self._superseded.discard(id(frame))
            return await STTService.push_frame(self, frame, direction)
        await super().push_frame(frame, direction)

    async def run_stt(self, audio: bytes):
        s, text, language, frames = self.stream, "", "en", []
        no, t0, t1, cut = s.cuts.popleft() if s.cuts else (s.utterance_no, s.speech_t0, s.speech_t1, 0.0)
        async for frame in super().run_stt(audio):
            if isinstance(frame, TranscriptionFrame):
                text += frame.text
                language = str(frame.language.value) if frame.language else language
            frames.append(frame)
        ms = round((time.monotonic() - cut) * 1000) if cut else 0
        s.stats["utterances"] += 1
        s.stats["empty"] += 0 if text.strip() else 1
        s.stats["stt_ms"] = ms
        RECENT_STT_MS.append(ms)
        del RECENT_STT_MS[:-50]
        text = " ".join(text.split())      # whisper.cpp wraps its text; a transcript line is one line
        # The event leaves BEFORE the transcription frame is released into the pipeline. That frame
        # is what lets the turn detector end the turn, and Pipecat fast-tracks the turn's end past
        # ordinary frames, so sent any later the bot hears "turn over" ahead of the words it closes.
        yield OutputTransportMessageUrgentFrame(message={
            "type": "transcript", "text": text, "t0": t0, "t1": t1, "language": language, "stt_ms": ms})
        for frame in frames:
            if isinstance(frame, TranscriptionFrame) and s.utterance_no != no:
                self._superseded.add(id(frame))       # they have spoken again since this cut
            yield frame


class Events(FrameProcessor):
    """The pipeline's frames, as the JSON events the bot acts on."""

    def __init__(self, stream: Stream):
        super().__init__()
        self.stream = stream

    async def send(self, **message):
        await self.push_frame(OutputTransportMessageUrgentFrame(message=message))

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, VADUserStartedSpeakingFrame):
                await self.send(type="speech_start", t=self.stream.speech_t0)
            elif isinstance(frame, UserStartedSpeakingFrame):
                await self.send(type="turn_start", t=self.stream.speech_t0)
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self.stream.stats["turns"] += 1
                await self.send(type="turn_end", t=self.stream.speech_t1)
        await self.push_frame(frame, direction)


def build(websocket: WebSocket, stream: Stream) -> PipelineWorker:
    transport = FastAPIWebsocketTransport(websocket, FastAPIWebsocketParams(
        audio_in_enabled=True, audio_in_sample_rate=RATE, audio_in_channels=1, audio_in_passthrough=True,
        audio_out_enabled=VOICE, add_wav_header=False, session_timeout=None,
        serializer=PortCallSerializer(stream)))
    turns = UserTurnProcessor(user_turn_strategies=UserTurnStrategies(
        start=[VADUserTurnStartStrategy()],
        stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3())]))
    pipeline = Pipeline([
        transport.input(),
        VADProcessor(vad_analyzer=SileroVADAnalyzer(sample_rate=RATE, params=VADParams(
            start_secs=VAD_START_SECS, stop_secs=VAD_STOP_SECS)), audio_idle_timeout=IDLE_SECS),
        Clock(stream),
        LocalWhisper(stream),
        turns,
        Events(stream),
        # ── the voice leg goes here when it is wanted ──────────────────────────────────────────
        # A user-turn aggregator, an LLM and a TTS: the turn_end the bot already receives is the
        # frame an LLM would answer, and transport.output() already returns audio to the bot.
        transport.output(),
    ])
    # A stream nobody speaks on for five minutes is normal in a meeting, not a dead session.
    # enable_rtvi=False: by default Pipecat also sends its own client protocol down the socket,
    # which duplicates these events and carries the transcript text a second time.
    task = PipelineWorker(pipeline, params=PipelineParams(audio_in_sample_rate=RATE),
                          cancel_on_idle_timeout=False, enable_rtvi=False)

    @transport.event_handler("on_client_disconnected")
    async def gone(_transport, _client):
        await task.cancel()

    return task


app = FastAPI()
STREAMS: dict[str, Stream] = {}


@app.get("/health")
def health():
    return {"status": "ok", "pipecat": PIPECAT_VERSION, "stt": STT_BASE, "voice": VOICE,
            "turn_detector": "smart-turn-v3 (local)", "idle_secs": IDLE_SECS,
            "stt_p99_secs_assumed": STT_P99_SECS,
            "stt_ms_recent_max": max(RECENT_STT_MS, default=0),      # from the cut; compare with the line above
            "utterances_closed_by_audio_stopping": CLOSED_BY_AUDIO_STOPPING,
            "streams": {k: v.stats for k, v in STREAMS.items()}}


@app.websocket("/ws")
async def ws(websocket: WebSocket, meeting: str = "?", channel: str = "0"):
    await websocket.accept()
    key = f"{meeting}/{channel}"
    stream = STREAMS[key] = Stream(meeting, channel)
    print(f"[pipecat] {time.strftime('%H:%M:%S')} stream {key} connected", flush=True)
    try:
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(build(websocket, stream))
        await runner.run()
    finally:
        STREAMS.pop(key, None)
        print(f"[pipecat] {time.strftime('%H:%M:%S')} stream {key} closed {stream.stats}", flush=True)


if __name__ == "__main__":
    print(f"[pipecat] {PIPECAT_VERSION} on 127.0.0.1:{PORT}, whisper at {STT_BASE}, voice leg "
          f"{'ON' if VOICE else 'off'}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
