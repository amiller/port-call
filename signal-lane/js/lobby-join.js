(async () => {
  // Returns CLICKED, never "joined": this script can only establish that a button was pressed.
  // Whether the seat is in the call is call-state.js's job. The earlier version returned
  // joined:true while inCall was 0, which is the precise shape of a false green.
  //
  // There are TWO "Join" buttons on screen — the call-link DETAILS panel's and the LOBBY's inside
  // the calling modal. A document-order find picks the details one, which merely reopens the lobby.
  const P = globalThis.__pc;
  const box = document.querySelector('.module-calling__modal-container, .module-calling__container');
  if (!box) return { clicked: false, why: 'no calling container — lobby not open' };
  if (globalThis.__pcCam) {
    const c = [...box.querySelectorAll('button')].find(b => /^Turn on camera$/i.test(P.plain(b.getAttribute('aria-label') || b.innerText)));
    if (c) { c.click(); await P.sleep(1200); }
  }
  const go = [...box.querySelectorAll('button')].find(b => /^(Join|Start call)$/i.test(P.plain(b.innerText || b.getAttribute('aria-label'))));
  if (!go) return { clicked: false, why: 'no Join inside calling container',
                    btns: [...box.querySelectorAll('button')].map(b => P.plain(b.getAttribute('aria-label') || b.innerText)).filter(Boolean) };
  go.click(); await P.sleep(5000);
  return { clicked: true, inCall: P.inCall() };
})()
