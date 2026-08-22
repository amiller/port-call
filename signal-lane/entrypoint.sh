#!/bin/bash
set -euo pipefail

# `docker compose restart` keeps the container filesystem, so PulseAudio's pid/socket from the
# previous run survive and the daemon refuses to start ("Daemon startup failed") — the container
# then restart-loops forever. Clear the runtime state first; it is per-boot by definition.
rm -rf /var/run/pulse /run/pulse 2>/dev/null || true

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
for _ in $(seq 1 30); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 1; done

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

exec signal-desktop --no-sandbox --user-data-dir=/data --password-store=basic \
     --remote-debugging-port=9333 --ozone-platform=x11
