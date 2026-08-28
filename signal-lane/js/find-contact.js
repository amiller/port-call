(async () => {
  const P = globalThis.__pc;
  P.nav('Chats').click(); await P.sleep(1200);
  const q = globalThis.__pcQuery || '';
  const box = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
  if (!box) return { ok: false, why: 'no search box' };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(box, q); box.dispatchEvent(new Event('input', { bubbles: true }));
  await P.sleep(1800);
  const rows = [...document.querySelectorAll('.ListTile--clickable, [class*=ContactListItem]')]
        .map(t => P.plain(t.textContent).slice(0, 60)).filter(Boolean);
  return { ok: true, query: q, matches: rows.slice(0, 8) };
})()
