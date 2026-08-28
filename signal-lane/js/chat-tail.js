(() => {
  const P = globalThis.__pc;
  const box = document.querySelector('[data-testid="CompositionInput"], .ql-editor, [contenteditable="true"][role="textbox"]');
  const msgs = [...document.querySelectorAll('[class*=module-message__text], [class*=MessageTextRenderer]')]
        .map(m => P.plain(m.textContent).slice(0, 70));
  return { composer: box ? P.plain(box.textContent).slice(0, 60) : '(none)',
           lastMessages: msgs.slice(-4) };
})()
