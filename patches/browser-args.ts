/**
 * Canonical browser launch args for joining a meeting — the SINGLE source of truth
 * for the browser environment the join layer requires.
 *
 * Who consumes this (so it never drifts):
 *  - the `vexa-bot` service builds its real meeting launches on top of these
 *    (services/vexa-bot/core/src/constans.ts → baseBrowserArgs), then layers on
 *    bot-only concerns (voice-agent audio, CDP debug exposure);
 *  - the standalone debug harness (scripts/debug-join.ts) launches with these
 *    verbatim, so the hot-debug container reproduces production exactly.
 *
 * The isolation law (modules never import services) makes this the only place the
 * set can live without drift: the service imports FROM here, never the reverse.
 *
 * Pack F (2026-06-06): deliberately NO --ignore-certificate-errors / --ignore-ssl-errors
 * / --disable-web-security / --allow-running-insecure-content — those are detectable by
 * Google's bot-detection layer and directly cause the "You can't join this meeting"
 * interstitial on datacenter egress IPs. Meet uses valid TLS; init-scripts inject via
 * CDP (unaffected by CSP). --disable-blink-features=AutomationControlled replaces them.
 */
export const JOIN_BROWSER_ARGS: readonly string[] = [
  "--incognito",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-infobars",
  "--disable-gpu",
  // Collapse Chromium's gpu-process work into the renderer — no separate
  // gpu-process at all. 2026-04-27 measurement (Zoom Web): the gpu-process ran
  // SwiftShader software-WebGL + the software video decoder at ~357% CPU;
  // --in-process-gpu folds that into the renderer and drops per-bot demand from
  // ~4.4 cores to ~115%. --disable-webgl/--disable-3d-apis were all inert (the
  // gpu-process hosts the decoder, not just the compositor); this is the only
  // flag that actually killed it. Belongs to the launch ENV the bot runs join in,
  // so it lives here to keep the debug harness byte-for-byte with production.
  "--in-process-gpu",
  // This flag auto-answers every media prompt INCLUDING getDisplayMedia, and it answers with the
  // screen — `Create(source=screen:0:0)` — which cannot start in this image, so Meet renders
  // "Can't share your screen." Removing it was tried and REVERTED 2026-08-11: without it Chrome's
  // pre-join page renders differently and upstream's "humanized" clicker misses every control
  // ("click target verification FAILED after 4 corrections", dy=130), so the bot never joins.
  // Keeping it means getDisplayMedia is auto-answered with the SCREEN, which cannot start in
  // this image — so screen_share currently cannot work. The two are in direct conflict until
  // either X11 desktop capture is fixed or the humanized clicker is bypassed.
  "--use-fake-ui-for-media-stream",
  // Start AudioContexts in 'running', not 'suspended' — the capture taps remote participant audio
  // via createMediaStreamSource; without this the worklet never fires and no PCM flows. (L4.)
  "--autoplay-policy=no-user-gesture-required",
  "--use-file-for-fake-video-capture=/dev/null",
  // Screenshare: auto-answer Chrome's tab picker with the bot's own stage tab, so a share can be
  // driven headlessly. Measured 2026-08-11 in this image: X11 DESKTOP capture (screen AND window)
  // fails at device launch — `Create(source=screen:0:0)` → `OnDeviceLaunchFailed`, error 31 — with
  // the X capturer itself initialising fine (XShm + XRandR v1.6). Ruled out as causes: missing X
  // extensions (same failure on a fresh Xvfb with +COMPOSITE +DAMAGE), GPU flags (fails with and
  // without --disable-gpu/--in-process-gpu), /dev/shm size (2 GB). TAB capture takes a different,
  // in-process path (web-contents-media-stream://) and works. Also note --auto-select-desktop-
  // capture-source does NOT match windows by title — it silently falls through to screen:0:0.
  "--auto-select-tab-capture-source-by-title=VEXA-STAGE",
  // Meet COLLAPSES toolbar controls at narrow widths — at the default ~945px window there is no
  // chat button in the DOM at all (dumped live: mic/camera/share/reaction/captions/raise-hand and
  // nothing else), which makes chat automation impossible rather than merely fiddly. A wide window
  // renders the full toolbar. 2026-08-11.
  "--window-size=1600,900",
  "--window-position=0,0",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=VizDisplayCompositor",
  "--disable-site-isolation-trials",
];

/** The canonical join launch args, as a fresh mutable array per call. */
export function getJoinBrowserArgs(): string[] {
  return [...JOIN_BROWSER_ARGS];
}
