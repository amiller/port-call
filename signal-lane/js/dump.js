(() => {
  const P = globalThis.__pc;
  return { text: P.plain(document.body.innerText).replace(/\n+/g,' | ').slice(-300),
           btns: [...document.querySelectorAll('button')].map(b => P.plain(b.getAttribute('aria-label')||b.innerText)).filter(Boolean).slice(-14) };
})()
