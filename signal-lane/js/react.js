(async () => {
  // Send an in-call reaction. The picker is NOT in the DOM until the React button is pressed, and
  // its buttons carry no aria-label — they are .module-ReactionPickerPicker__button with the emoji
  // as text content, which is why this matches on class rather than label.
  const P = globalThis.__pc;
  const box = document.querySelector('.module-calling__modal-container, .module-calling__container');
  if (!box) return { sent: false, why: 'not in a call' };
  const react = [...box.querySelectorAll('button')]
        .find(b => /^React$/i.test(P.plain(b.getAttribute('aria-label') || b.innerText)));
  if (!react) return { sent: false, why: 'no React control' };
  react.click(); await P.sleep(1200);

  const picks = [...document.querySelectorAll('.module-ReactionPickerPicker__button')];
  if (!picks.length) return { sent: false, why: 'picker did not open' };
  const want = globalThis.__pcEmojiIndex ?? 0;
  const btn = picks[Math.min(want, picks.length - 1)];
  const emoji = P.plain(btn.innerText) || '(unlabelled)';
  btn.click(); await P.sleep(1800);
  return { sent: true, emoji, choices: picks.length };
})()
