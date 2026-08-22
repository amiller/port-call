(async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    const t = s.getVideoTracks()[0];
    const st = t.getSettings ? t.getSettings() : {};
    return { ok: true, label: t.label, w: st.width, h: st.height, patched: /canvas|vexa/i.test(t.label || '') };
  } catch (e) { return { ok: false, err: String(e).slice(0, 200) }; }
})()
