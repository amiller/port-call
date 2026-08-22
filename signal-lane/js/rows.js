(() => {
  const P = globalThis.__pc;
  P.nav('Calls').click();
  return [...document.querySelectorAll('.ListTile--clickable')]
    .map(t => P.plain(t.textContent).slice(0, 60));
})()
