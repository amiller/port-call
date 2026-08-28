(async () => {
  // Open a conversation by the name shown in the chat list. Matches on the row's text rather than
  // a contact id, because the list is what synced — and refuses on ambiguity rather than guessing
  // which person to message.
  const P = globalThis.__pc;
  const want = (globalThis.__pcWho || '').toLowerCase();
  P.nav('Chats').click(); await P.sleep(1400);
  const rows = [...document.querySelectorAll('[class*=ListTile], [class*=ConversationList] [role=button], [class*=module-conversation-list__item]')]
        .filter(t => P.plain(t.textContent).toLowerCase().includes(want));
  if (!rows.length) return { opened: false, why: 'no conversation matching ' + want };
  const names = rows.map(r => P.plain(r.textContent).slice(0, 40));
  rows[0].click(); await P.sleep(1600);
  return { opened: true, matched: names.length, names };
})()
