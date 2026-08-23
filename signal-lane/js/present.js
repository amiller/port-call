(async () => {
  // Start / stop presenting.
  //
  // Signal's screenshare is NOT the camera path: it goes through the renderer's getUserMedia with
  // chromeMediaSource:'desktop' and a screenShareSourceId that Signal obtains from its OWN
  // in-app source picker (Electron desktopCapturer), not Chromium's. So "Start presenting" opens a
  // chooser that has to be answered — clicking the control alone leaves the call exactly as it was
  // while reporting nothing, which is what the first attempt did.
  const P = globalThis.__pc;
  const box = () => document.querySelector('.module-calling__modal-container, .module-calling__container');
  const b = (re, root) => [...(root || box() || document).querySelectorAll('button')]
        .find(x => re.test(P.plain(x.getAttribute('aria-label') || x.innerText)));

  if (globalThis.__pcStopPresenting) {
    const stop = b(/^Stop presenting$/i);
    if (stop) { stop.click(); await P.sleep(2000); }
    return { presenting: !!b(/^Stop presenting$/i), stopped: !!stop };
  }
  if (!box()) return { presenting: false, why: 'not in a call' };
  const start = b(/^Start presenting$/i);
  if (!start) return { presenting: false, why: 'no Start presenting control' };
  start.click(); await P.sleep(2500);

  // The chooser: Signal lists screens/windows as selectable tiles. Take the first, then confirm if
  // the dialog has a confirm step. Report what was on screen when nothing matched, so a wording
  // change is diagnosable instead of just "did not start".
  const sources = [...document.querySelectorAll('[class*=CallingScreenSharing] button, [class*=ScreenShar] button, [class*=SourceList] button, [class*=source] button')];
  let picked = null;
  if (sources.length) { picked = P.plain(sources[0].innerText) || '(unlabelled source)'; sources[0].click(); await P.sleep(1500); }
  const confirm = b(/^(Share|Share screen|Allow|Start sharing)$/i, document);
  if (confirm) { confirm.click(); await P.sleep(2500); }
  await P.sleep(2000);

  const on = !!b(/^Stop presenting$/i);
  return on ? { presenting: true, picked }
            : { presenting: false, picked, sources: sources.length,
                onscreen: P.plain(document.body.innerText).replace(/\n+/g, ' | ').slice(-260) };
})()
