(async () => {
  // Always OPEN the row's details panel before reading the URL — the link text only exists in that
  // panel, so a "reuse" path that skips the click silently returns null and the caller cannot tell
  // "no link" from "did not look".
  const P = globalThis.__pc;
  P.nav('Calls').click(); await P.sleep(1500);
  let row = await P.findRow(t => /Call link/i.test(t));
  if (!row) {
    const create = P.tile(/Create a Call Link/i);
    if (!create) return { url: null, why: 'no call link and no Create tile' };
    create.click(); await P.sleep(2800);
  } else {
    row.click(); await P.sleep(2000);
  }
  const url = (P.plain(document.body.innerText).match(/https:\/\/signal\.link\/call\/#key=[a-z-]+/) || [])[0] || null;
  const done = [...document.querySelectorAll('button')].find(b => /^Done$/i.test(P.plain(b.innerText)));
  if (done) { done.click(); await P.sleep(800); }
  return { url, reused: !!row };
})()
