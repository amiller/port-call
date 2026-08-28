(async () => {
  const P = globalThis.__pc;
  P.nav('Chats').click(); await P.sleep(1500);
  const box = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
  const rows = [...document.querySelectorAll('.ListTile--clickable')].map(t => P.plain(t.textContent).slice(0,44));
  return { searchBoxFound: !!box, searchPlaceholder: box ? box.placeholder : null,
           conversations: rows.length, sample: rows.slice(0,6),
           text: P.plain(document.body.innerText).replace(/\n+/g,' | ').slice(0,200) };
})()
