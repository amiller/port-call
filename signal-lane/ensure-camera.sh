#!/usr/bin/env bash
# Make sure the host has the loopback camera the HUD is rendered into. Idempotent; safe to call
# before every run.
#
#   ./ensure-camera.sh [host]
#
# Not a boot-time /etc/modules-load.d file on purpose: the sudo grant on the rig host is exactly
#   (root) NOPASSWD: /usr/sbin/modprobe v4l2loopback *, /usr/sbin/modprobe -r v4l2loopback
# and nothing else — no write access to /etc. Running it before the run also survives a reboot
# without anyone remembering to, which a boot file only does until the next machine.
set -euo pipefail
HOST=${1:-${SIGNAL_HOST:-fractal}}
DEV=${HUD_DEVICE:-/dev/video0}
OPTS=${V4L2_OPTS:-"devices=1 video_nr=0 card_label=PortCallCam exclusive_caps=1"}

ssh "$HOST" "
  if [ -e $DEV ]; then echo 'ensure-camera: $DEV already present'; exit 0; fi
  sudo -n /usr/sbin/modprobe v4l2loopback $OPTS || {
    echo 'ensure-camera: modprobe refused. The host needs:' >&2
    echo '  (root) NOPASSWD: /usr/sbin/modprobe v4l2loopback *, /usr/sbin/modprobe -r v4l2loopback' >&2
    exit 1; }
  for _ in \$(seq 1 10); do [ -e $DEV ] && break; sleep 1; done
  [ -e $DEV ] || { echo 'ensure-camera: modprobe succeeded but $DEV never appeared' >&2; exit 1; }
  echo 'ensure-camera: loaded v4l2loopback, $DEV created'
"
