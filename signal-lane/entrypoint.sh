#!/bin/bash
set -euo pipefail

# `docker compose restart` keeps the container filesystem, so PulseAudio's pid/socket from the
# previous run survive and the daemon refuses to start ("Daemon startup failed") — the container
# then restart-loops forever. Clear the runtime state first; it is per-boot by definition.
rm -rf /var/run/pulse /run/pulse 2>/dev/null || true
# Same class of bug, same cause: Xvfb's lock also survives a restart, and it fails HARD —
# "Server is already active for display 99" — taking the whole entrypoint down with it.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

pulseaudio --system --disallow-exit --disallow-module-loading=false --log-level=notice --daemonize
for _ in $(seq 1 30); do pactl info >/dev/null 2>&1 && break; sleep 1; done
pactl info >/dev/null

# The speak path. RingRTC's device enumeration DROPS .monitor sources, so a null sink alone is
# invisible to Signal — the monitor must be remapped into a real source. Same graph as the rig.
pactl load-module module-null-sink sink_name=tts_sink sink_properties=device.description=TTSAudioSink
pactl load-module module-remap-source master=tts_sink.monitor source_name=virtual_mic \
      source_properties=device.description=VirtualMicrophone
# The capture path: call audio plays here and nowhere audible, so parec gets the call alone.
pactl load-module module-null-sink sink_name=call_out sink_properties=device.description=CallOut
pactl set-default-source virtual_mic

Xvfb :99 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99
# Wait on the X socket rather than xdpyinfo, which is not installed — the old loop redirected its
# "command not found" to /dev/null and so never succeeded, silently burning its full 30s every boot.
for _ in $(seq 1 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done
# Assert, do not hope — its PulseAudio twin above does the same. Without this a slow or dead Xvfb
# falls through and signal-desktop fails later with something that looks unrelated.
[ -S /tmp/.X11-unix/X99 ] || { echo "Xvfb never created /tmp/.X11-unix/X99" >&2; exit 1; }

# --password-store=basic is the whole reason this profile is portable: without it Electron seals
# the SQLCipher key against the host keyring (safeStorageBackend=gnome_libsecret) and the directory
# cannot be moved or backed up. Set at FIRST launch or the profile is already sealed.
# A LIVE view of the seat's own screen. The linking QR expires every couple of minutes, so passing
# screenshots to a human is a losing race — Signal refreshes the code itself, and VNC shows whatever
# is currently on screen. Also the only way to see what the seat is doing when CDP says one thing
# and the UI is doing another.
x11vnc -display :99 -forever -shared -nopw -quiet -rfbport 5900 &
websockify --web=/usr/share/novnc 6080 localhost:5900 &

# Electron IGNORES --remote-debugging-address and binds CDP to 127.0.0.1 only, so nothing outside
# the container can reach it. socat republishes it on 9334 for the compose port mapping.
socat TCP-LISTEN:9334,fork,reuseaddr TCP:127.0.0.1:9333 &

# Feed the HUD into the loopback camera when the host has one passed through. Absent device ⇒ this
# seat simply has no camera, which is the honest state rather than a crash: only the speaker seat
# needs one.
if [ -e "${HUD_DEVICE:-/dev/video0}" ]; then
  /usr/local/bin/hud-cam.sh > /tmp/hud-cam.log 2>&1 &
  echo "hud-cam: feeding ${HUD_DEVICE:-/dev/video0}"
else
  echo "hud-cam: no ${HUD_DEVICE:-/dev/video0} — camera disabled for this seat"
fi

# NO --use-fake-device-for-media-stream any more: it registers a synthetic camera that SHADOWS the
# real one, and Signal captured it in preference to ours — both seats showed Chromium's green test
# card while the check happily called it a pass. The camera Signal should find is PortCallCam, the
# v4l2loopback device hud-cam.sh feeds. --use-fake-ui-for-media-stream stays: it auto-answers the
# mic/camera prompts, which also removes the separate permissions_popup target on first join. The HUD's enumerateDevices patch advertises one at the JS layer and getUserMedia does
# hand back the canvas (verified 1280x720), yet the far seat still renders an avatar — so the
# question is whether Signal's send path needs a device to exist below JS. This is the same flag
# pair the Meet rig passes (patches/browser-args.ts).
# --use-fake-ui-for-media-stream auto-answers the mic/camera prompts, which also removes the
# separate permissions_popup target the harness has to chase on first join.
exec signal-desktop --no-sandbox --user-data-dir=/data --password-store=basic \
     --use-fake-ui-for-media-stream \
     --remote-debugging-port=9333 --ozone-platform=x11
