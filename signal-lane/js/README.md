`hud.js` is GENERATED, not authored: it is `installHud()` lifted verbatim out of the bot image's
`/app/core/meetings/services/bot/dist/camera.js` and wrapped in an IIFE. It is the same HUD the
Meet bot draws, and it works unmodified in Signal because Signal Desktop's video capture goes
through the renderer's `getUserMedia` — the patch never has to know which app it is fooling.

Regenerate after any change to `patches/bot-camera.ts`:

    ssh fractal 'docker exec vexa-rig4-vexa-lite-1 cat \
      /app/core/meetings/services/bot/dist/camera.js' > /tmp/camera.js
    # then extract the installHud function body and wrap it as an IIFE ending in `installHud();`

## The set

**Used by `e2e.sh`:** `lib.js` (helpers, prepended to every action), `link-state.js`,
`set-devices.js`, `create-link.js`, `reset.js`, `lobby-join.js`, `cancel-modal.js`,
`call-state.js`, `remote-frame.js`, `leave.js`.

**Diagnostics**, for driving a seat by hand: `dump.js` (what is on screen), `rows.js` (the Calls
list), `video-devices.js` (what Signal thinks the cameras are), `test-gum.js` (what `getUserMedia`
actually returns).
