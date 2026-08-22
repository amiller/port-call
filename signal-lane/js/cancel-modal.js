(async () => {
  const P = globalThis.__pc;
  const c = [...document.querySelectorAll('button')].find(b => /^Cancel$/i.test(P.plain(b.innerText)));
  if (c) { c.click(); await P.sleep(1500); }
  return { cancelled: !!c, inCall: P.inCall() };
})()
