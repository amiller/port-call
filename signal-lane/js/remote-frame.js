(async () => {
  // RingRTC paints REMOTE video into the renderer as raw frames on a canvas, so the other seat's
  // camera is readable here. Reports a DISTINCT state for each way this can go wrong, because the
  // previous version collapsed "no canvas", "readback blocked" and "genuinely blank" into spread 0
  // — which reads as "the camera is broken" even when the check itself never ran.
  //
  // NOTE ON WHAT THIS PROVES: pixel spread shows something was drawn, not that it is OUR HUD.
  // Signal's own avatar tile would also pass. The screenshot saved alongside is the real evidence;
  // this exists to fail the run automatically, not to identify the image.
  const cvs = [...document.querySelectorAll('canvas')].filter(c => c.width > 64 && c.height > 64);
  if (!cvs.length) return { state: 'no-canvas' };
  const c = cvs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  let data;
  try { data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
  catch (e) { return { state: 'readback-blocked', w: c.width, h: c.height, err: String(e).slice(0, 120) }; }
  let min = 255, max = 0, sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4 * 97) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; sum += v; n++; }
  const spread = max - min;
  return { state: spread > 20 ? 'drawing' : 'blank', w: c.width, h: c.height, spread, mean: Math.round(sum / n) };
})()
