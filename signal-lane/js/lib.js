// Page-side helpers shared by every seat action. Prepended to each action script by e2e.sh.
// Signal's UI is React; el.click() reaches its synthetic handlers, so no trusted events needed.
//
// Wrapped in an IIFE deliberately: every action runs through Runtime.evaluate in the SAME
// execution context, so a top-level `const` here would throw "already been declared" on the
// second call. Nothing may leak to global scope except __pc itself.
(() => {
  // Signal wraps user-visible names in Unicode bidi ISOLATES (U+2066..U+2069) — the Calls list row
  // reads "⁨Signal Call⁩", so /^Signal Call$/ never matches and a find-or-create helper
  // silently makes a duplicate call link every run. Strip them before every text comparison.
  const plain = (s) => (s || '').replace(/[⁦-⁩‎‏]/g, '').trim();

  globalThis.__pc = {
    plain,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    // Match aria-label first, innerText second — Signal labels call controls but not list rows.
    btn: (re) => [...document.querySelectorAll('button')]
          .find(b => re.test(plain(b.getAttribute('aria-label') || b.innerText))),
    // Leaf-text lookup: the clickable ancestor is a ListTile, never the element holding the words.
    tile: (re) => { const e = [...document.querySelectorAll('*')]
          .filter(x => x.children.length === 0 && re.test(plain(x.textContent))).pop();
        return e && (e.closest('.ListTile--clickable, button, [role=button], li') || e); },
    // The left rail. Settings has its own "Calls" row, so a plain text match hits the wrong one.
    nav: (name) => [...document.querySelectorAll('[class*=NavTabs__Item]')]
          .find(e => new RegExp('^' + name + '$', 'i').test(plain(e.innerText))),
    sel: (label, re) => { const s = [...document.querySelectorAll('select')]
          .find(x => (x.getAttribute('aria-label') || '') === label);
        if (!s) throw new Error('no ' + label + ' select');
        const opt = [...s.options].find(o => re.test(o.text));
        if (!opt) throw new Error(label + ' has no option matching ' + re + ': ' + [...s.options].map(o => o.text).join(' / '));
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, opt.value);
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return opt.text; },
    // The Calls list is ReactVirtualized: only the rows currently ON SCREEN exist in the DOM. A
    // querySelectorAll therefore silently misses rows further down, which with several stale call
    // links means a follower cannot find the live one and reports "no Active call link" while the
    // leader is plainly in a call. Scroll the grid and re-query at each step.
    findRow: async (pred) => {
      const grid = document.querySelector('.CallsList__List, .ReactVirtualized__Grid');
      const hit = () => [...document.querySelectorAll('.ListTile--clickable')].find(t => pred(plain(t.textContent)));
      if (!grid) return hit();
      grid.scrollTop = 0;
      await new Promise(r => setTimeout(r, 400));
      for (let i = 0; i < 30; i++) {
        const found = hit();
        if (found) return found;
        if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 2) return null;
        grid.scrollTop += Math.max(80, grid.clientHeight * 0.8);
        await new Promise(r => setTimeout(r, 350));
      }
      return null;
    },
    // SCOPED to the calling container on purpose. A body-wide match for "N people" also hits the
    // conversation list and call-link details panels, so the load-bearing join assertion could read
    // 2 while the seat is not in a call at all. No container ⇒ not in a call ⇒ 0.
    inCall: () => {
      const box = document.querySelector('.module-calling__modal-container, .module-calling__container');
      if (!box) return 0;
      const m = plain(box.innerText).match(/(\d+)\s+(?:people|person|in call)/);
      return m ? +m[1] : 0;
    },
  };
})();
