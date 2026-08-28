(async () => {
  // "Require admin approval" lives in the call-link details panel as an Off/On control. With the
  // admin not present in the call, a pending joiner cannot be let in by anyone — turning it off is
  // the only way to unblock someone who is already waiting.
  const P = globalThis.__pc;
  P.nav('Calls').click(); await P.sleep(1400);
  const row = await P.findRow(t => /Call link/i.test(t));
  if (!row) return { ok: false, why: 'no call-link row' };
  row.click(); await P.sleep(1800);
  const key = (P.plain(document.body.innerText).match(/#key=([a-z-]+)/) || [])[1];
  const offs = [...document.querySelectorAll('button, [role=radio], option')]
        .filter(b => /^Off$/i.test(P.plain(b.getAttribute('aria-label') || b.innerText)));
  const sel = [...document.querySelectorAll('select')]
        .find(s => [...s.options].some(o => /^Off$/i.test(o.text)));
  if (sel) {
    const opt = [...sel.options].find(o => /^Off$/i.test(o.text));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await P.sleep(1500);
    return { ok: true, via: 'select', key, now: sel.selectedOptions[0].text };
  }
  if (offs.length) { offs[0].click(); await P.sleep(1500); return { ok: true, via: 'button', key }; }
  return { ok: false, why: 'no Off control found', key,
           text: P.plain(document.body.innerText).replace(/\n+/g,' | ').slice(-200) };
})()
