(async () => {
  // RingRTC delivers REMOTE video into the renderer as raw frames painted to a canvas, so the
  // other seat's camera is readable here — this is the far end of the video loopback.
  const cvs = [...document.querySelectorAll('canvas')].filter(c => c.width > 64 && c.height > 64);
  if (!cvs.length) return { canvases: 0 };
  const c = cvs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const ctx = c.getContext('2d');
  let data;
  try { data = ctx.getImageData(0, 0, c.width, c.height).data; }
  catch (e) { return { canvases: cvs.length, w: c.width, h: c.height, readback: 'blocked: ' + e.message }; }
  let min = 255, max = 0, sum = 0;
  for (let i = 0; i < data.length; i += 4 * 97) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; sum += v; }
  return { canvases: cvs.length, w: c.width, h: c.height, min, max, spread: max - min, mean: Math.round(sum / (data.length / (4 * 97))) };
})()
