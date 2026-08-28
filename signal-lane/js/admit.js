(async () => {
  // Call links with "Require admin approval" park joiners in a pending queue; Signal shows a
  // CallLinkPendingParticipantModal with Approve/Deny to the link's admin. The bot is on the admin
  // account, so it can let someone in.
  const P = globalThis.__pc;
  const btns = [...document.querySelectorAll('button')];
  const label = b => P.plain(b.getAttribute('aria-label') || b.innerText);
  const approve = btns.find(b => /^(Approve|Admit|Let in)$/i.test(label(b)));
  if (approve) { approve.click(); await P.sleep(1500); return { admitted: true, via: label(approve), inCall: P.inCall() }; }
  return { admitted: false,
           pendingUI: !!document.querySelector('[class*=PendingParticipant]'),
           buttons: btns.map(label).filter(Boolean).slice(-16),
           text: P.plain(document.body.innerText).replace(/\n+/g, ' | ').slice(-220) };
})()
