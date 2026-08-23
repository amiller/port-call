(async () => {
  // A coarse 3x3 mean-RGB signature of what this seat is SENDING (source:'hud', from the canvas
  // __vexaCam owns) or RECEIVING (source:'remote', the largest canvas RingRTC paints into).
  //
  // Exists because "the remote canvas has pixel spread" cannot tell our HUD from Chromium's
  // synthetic --use-fake-device pattern, and that difference is the entire claim. Comparing the two
  // seats' signatures can: if B is not showing roughly what A is drawing, the HUD did not travel.
  const P = globalThis.__pc;
  const src = globalThis.__pcSigSource || 'remote';
  let cv;
  if (src === 'hud') {
    const t = globalThis.__vexaCam?.stream?.getVideoTracks?.()[0];
    if (!t) return { source: src, state: 'no-hud-track' };
    const v = document.createElement('video');
    v.srcObject = new MediaStream([t]); v.muted = true;
    await v.play(); await P.sleep(400);
    cv = document.createElement('canvas'); cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    v.pause(); v.srcObject = null;
  } else {
    const all = [...document.querySelectorAll('canvas')].filter(c => c.width > 64 && c.height > 64);
    if (!all.length) return { source: src, state: 'no-canvas' };
    cv = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  }
  let data;
  try { data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; }
  catch (e) { return { source: src, state: 'readback-blocked', err: String(e).slice(0, 100) }; }
  const sig = [];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
    let r = 0, g = 0, b = 0, n = 0;
    const x0 = Math.floor(cv.width * gx / 3), x1 = Math.floor(cv.width * (gx + 1) / 3);
    const y0 = Math.floor(cv.height * gy / 3), y1 = Math.floor(cv.height * (gy + 1) / 3);
    for (let y = y0; y < y1; y += 7) for (let x = x0; x < x1; x += 7) {
      const i = (y * cv.width + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    sig.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
  }
  return { source: src, state: 'ok', w: cv.width, h: cv.height, sig };
})()
