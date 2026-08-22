(() => {
  // A POSITIVE marker, not the absence of the QR screen. "no 'Scan this code'" is also true of a
  // blank page, a crashed renderer, an update screen and the pre-QR startup window — and both the
  // e2e precondition and watch-and-run.sh trust this, so a false positive fires the whole run
  // against a seat that is still booting.
  const P = globalThis.__pc;
  const nav = !!P.nav('Calls') && !!P.nav('Chats');
  const qr = /Scan this code/i.test(document.body.innerText);
  return { linked: nav && !qr, nav, qr };
})()
