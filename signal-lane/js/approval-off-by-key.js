(async () => {
  // Match the link by ROOT KEY, not by row position. The Calls list holds many links and the first
  // one is not ours — picking by index silently edits somebody else's meeting settings.
  const P = globalThis.__pc;
  const want = globalThis.__pcKey;
  P.nav('Calls').click(); await P.sleep(1400);
  const grid = document.querySelector('.CallsList__List, .ReactVirtualized__Grid');
  if (grid) { grid.scrollTop = 0; await P.sleep(400); }
  for (let pass = 0; pass < 20; pass++) {
    const rows = [...document.querySelectorAll('.ListTile--clickable')]
          .filter(t => /Call link/i.test(P.plain(t.textContent)));
    for (const row of rows) {
      row.click(); await P.sleep(1500);
      const key = (P.plain(document.body.innerText).match(/#key=([a-z-]+)/) || [])[1];
      if (key !== want) continue;
      const sel = [...document.querySelectorAll('select')]
            .find(s => [...s.options].some(o => /^Off$/i.test(o.text)));
      if (!sel) return { ok: false, why: 'found the link but no approval control', key };
      const opt = [...sel.options].find(o => /^Off$/i.test(o.text));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await P.sleep(1500);
      return { ok: true, key, approval: sel.selectedOptions[0].text };
    }
    if (!grid || grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 2) break;
    grid.scrollTop += Math.max(80, grid.clientHeight * 0.8);
    await P.sleep(350);
  }
  return { ok: false, why: 'no row with key ' + want };
})()
