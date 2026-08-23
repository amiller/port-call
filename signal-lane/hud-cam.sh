#!/usr/bin/env bash
# Render the Port Call HUD into /dev/video0 so Signal can capture it as a real camera.
#
# WHY THIS EXISTS: Signal captures call video NATIVELY from a device, the same way it captures
# audio — patching getUserMedia in its renderer does not reach the call, it only answers our own
# calls. So the HUD needs to BE a camera, not a canvas. That is what v4l2loopback is for.
#
# The chain: chromium draws hud.js on its own headless display, ffmpeg grabs that display and
# writes it to the loopback device, and Signal selects "PortCallCam" like any other webcam.
set -euo pipefail
DISP=${HUD_DISPLAY:-:98}
DEV=${HUD_DEVICE:-/dev/video0}
W=${HUD_WIDTH:-1280}; H=${HUD_HEIGHT:-720}; FPS=${HUD_FPS:-15}

[ -e "$DEV" ] || { echo "hud-cam: $DEV does not exist — is v4l2loopback loaded on the host and passed into this container?" >&2; exit 1; }

rm -f "/tmp/.X${DISP#:}-lock" "/tmp/.X11-unix/X${DISP#:}" 2>/dev/null || true
Xvfb "$DISP" -screen 0 "${W}x${H}x24" -ac -noreset &
for _ in $(seq 1 30); do [ -S "/tmp/.X11-unix/X${DISP#:}" ] && break; sleep 1; done
[ -S "/tmp/.X11-unix/X${DISP#:}" ] || { echo "hud-cam: Xvfb never came up on $DISP" >&2; exit 1; }

DISPLAY="$DISP" chromium --no-sandbox --disable-gpu --kiosk --no-first-run \
  --window-size="$W,$H" --window-position=0,0 \
  --autoplay-policy=no-user-gesture-required \
  --remote-debugging-port=9400 --remote-allow-origins='*' \
  "file:///opt/hud-cam/page.html" >/tmp/hud-chromium.log 2>&1 &

sleep 6
# yuv420p is not optional: v4l2loopback consumers (Chromium/RingRTC included) reject most other
# pixel formats and the failure looks like "camera produces nothing" rather than a format error.
exec ffmpeg -loglevel error -f x11grab -video_size "${W}x${H}" -framerate "$FPS" -i "$DISP" \
     -pix_fmt yuv420p -f v4l2 "$DEV"
