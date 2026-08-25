#!/usr/bin/env bash
# Isolate WHERE screen capture dies in the Signal container. Runs in seconds, needs no call and no
# human — the point is that an agent can iterate on this instead of on a 4-minute e2e.
#
#   ./probe-screenshare.sh [host]
#
# The four checks are chosen to split the stack at each layer that could be at fault:
#
#   1. ffmpeg x11grab on :99      — can ANYTHING read Signal's display? (hud-cam proves :98 works)
#   2. plain chromium getDisplayMedia on :98 — can a NON-Electron Chromium capture in this image?
#   3. Signal renderer getDisplayMedia       — does Electron's renderer reach the capturer at all?
#   4. Signal renderer getUserMedia desktop  — the path Signal actually uses, with a bogus sourceId
#
# The interesting outcome is a DISAGREEMENT: if 1 and 2 pass while 3 and 4 fail, the fault is
# Electron's desktopCapturer/Chromium capture stack rather than X11, which is the opposite of what
# patches/bot-screen-share.ts concluded for the Meet image ("X11 desktop capture fails at device
# launch ... root cause never found").
set -uo pipefail
cd "$(dirname "$0")"
HOST=${1:-${SIGNAL_HOST:-fractal}}
C=${SEAT_CONTAINER:-port-call-signal-a}
A=${A_PORT:-9334}
AHUD=${A_HUD_PORT:-9336}

say() { printf '%-46s %s\n' "$1" "$2"; }

echo "── 1. ffmpeg x11grab :99 (Signal's own display) ──"
if ssh "$HOST" "docker exec $C ffmpeg -loglevel error -f x11grab -video_size 1280x720 -i :99 -frames:v 1 -y /tmp/probe99.png" 2>/tmp/probe1.err; then
  say "x11grab :99" "OK — the display is readable"
else
  say "x11grab :99" "FAILED — $(tail -1 /tmp/probe1.err)"
fi

echo "── 2. plain chromium getDisplayMedia (hud-cam's browser, :98) ──"
CDP_TARGET=page.html node cdp.mjs "$AHUD" eval -e "
(async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const t = s.getVideoTracks()[0]; const st = t.getSettings ? t.getSettings() : {};
    t.stop();
    return { ok: true, w: st.width, h: st.height };
  } catch (e) { return { ok: false, err: String(e).slice(0, 160) }; }
})()" 2>&1 | tail -1

echo "── 3. Signal renderer getDisplayMedia ──"
node cdp.mjs "$A" eval -e "
(async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const t = s.getVideoTracks()[0]; t.stop();
    return { ok: true, label: t.label };
  } catch (e) { return { ok: false, err: String(e).slice(0, 160) }; }
})()" 2>&1 | tail -1

echo "── 4. Signal renderer getUserMedia chromeMediaSource:desktop ──"
# Signal's real path. A bogus sourceId is fine: we are asking whether the CAPTURER engages, and the
# error text differs between "no such source" and "capture stack refused".
node cdp.mjs "$A" eval -e "
(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'screen:0:0' } }
    });
    const t = s.getVideoTracks()[0]; t.stop();
    return { ok: true, label: t.label };
  } catch (e) { return { ok: false, err: String(e).slice(0, 200) }; }
})()" 2>&1 | tail -1

echo
echo "Signal's own chooser asks Electron's desktopCapturer (MAIN process) for sources before any of"
echo "this runs, and the e2e sees it return zero. That API is not reachable from a renderer, so if"
echo "3 and 4 succeed here the gap is enumeration, not capture."
