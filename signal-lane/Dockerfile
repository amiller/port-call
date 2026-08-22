# Signal Desktop as a Port Call seat — headless, driven over CDP.
#
# Signal Desktop is Electron, so --remote-debugging-port gives full control of its React UI, and
# its VIDEO capture goes through the renderer's getUserMedia (the Meet camera patch works verbatim).
# Its AUDIO does not: RingRTC is a native module that opens PulseAudio itself, so both audio
# directions have to be virtual devices — the same tts_sink/virtual_mic graph the rig already uses.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb pulseaudio pulseaudio-utils procps socat x11vnc websockify novnc \
      fonts-liberation libnss3 libasound2 xdg-utils \
 && curl -fsSL https://updates.signal.org/desktop/apt/keys.asc \
      | gpg --dearmor -o /usr/share/keyrings/signal-desktop-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/signal-desktop-keyring.gpg] https://updates.signal.org/desktop/apt xenial main" \
      > /etc/apt/sources.list.d/signal-xenial.list \
 && apt-get update && apt-get install -y --no-install-recommends signal-desktop \
 && rm -rf /var/lib/apt/lists/*

# pulseaudio --system runs as user 'pulse' and only pulse-access members may connect.
# Without this every pactl call in the entrypoint dies with "Access denied".
RUN usermod -aG pulse-access root

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME /data
EXPOSE 9334 6080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
