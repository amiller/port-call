(async () => {
  // Type into the open conversation's composer and send. Signal's composer is a contenteditable
  // draft editor, not an <input>, so value-setting does nothing — text has to be inserted the way
  // a keyboard would, which is what execCommand('insertText') does through the editor's own
  // handling.
  const P = globalThis.__pc;
  const text = globalThis.__pcMsg || '';
  if (!text) return { sent: false, why: 'no message set' };
  const box = document.querySelector('[data-testid="CompositionInput"], .ql-editor, [contenteditable="true"][role="textbox"]');
  if (!box) return { sent: false, why: 'no composer found' };
  box.focus();
  document.execCommand('insertText', false, text);
  await P.sleep(900);
  const typed = P.plain(box.textContent);
  if (!typed.includes(text.slice(0, 24))) return { sent: false, why: 'text did not land in composer', typed: typed.slice(0, 60) };
  box.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true}));
  await P.sleep(1800);
  return { sent: true, composerNowEmpty: P.plain(box.textContent).length === 0 };
})()
