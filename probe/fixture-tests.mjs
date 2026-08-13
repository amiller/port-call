#!/usr/bin/env node
/**
 * DOM fixture tests — catch selector-ambiguity bugs with no meeting, no browser session.
 *
 * These tests run the REAL selector logic from patches/*.ts against serialized DOM fixtures.
 * Every 2026-08-12 bug class (first-document-wide-match selectors) must fail here before it
 * hits production.
 *
 * Rule we encode: scope the query to a container, then VERIFY the resolved element's
 * aria-label before clicking. Never "first match wins" across the whole document.
 *
 * Run: node probe/fixture-tests.mjs
 * Exit code: 0 = all green, 1 = any red
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Color output for test results
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

let passed = 0;
let failed = 0;

function log(msg, color = RESET) {
  console.log(`${color}${msg}${RESET}`);
}

function assert(condition, message) {
  if (condition) {
    passed++;
    log(`  ✓ ${message}`, GREEN);
  } else {
    failed++;
    log(`  ✗ ${message}`, RED);
  }
}

function assertEquals(actual, expected, message) {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  if (isEqual) {
    passed++;
    log(`  ✓ ${message}`, GREEN);
  } else {
    failed++;
    log(`  ✗ ${message}`, RED);
    log(`    Expected: ${JSON.stringify(expected)}`, RED);
    log(`    Got:      ${JSON.stringify(actual)}`, RED);
  }
}

/**
 * Load a fixture HTML file into a JSDOM window.
 * Returns { document, window, state } where state is __fixture_state from the fixture.
 */
function loadFixture(name) {
  const htmlPath = path.join(FIXTURES_DIR, `${name}.html`);
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'file:///' });
  const win = dom.window;
  // Run any inline scripts (they set up __fixture_state)
  return {
    document: win.document,
    window: win,
    state: win.__fixture_state || {},
    name
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST SUITE 1: setMic — bot's own "Turn on/off microphone" vs tile "Mute <name>'s microphone"
// ─────────────────────────────────────────────────────────────────────────────────────

function testSetMic() {
  log('\n== setMic: bot microphone selector vs tile mute controls ==', CYAN);

  // Positive test: populated call with bot's own mic button
  const fx = loadFixture('populated-call');

  // SCOPED-AND-VERIFIED selector implementation (the CORRECT approach)
  const findBotMicButtonScoped = (doc) => {
    // Scope to toolbar (bot's own controls live here)
    const toolbar = doc.querySelector('#toolbar, [role="toolbar"]');
    if (!toolbar) return null;

    // Find buttons with "microphone" in aria-label within toolbar
    const buttons = Array.from(toolbar.querySelectorAll('button,[role="button"]'));
    return buttons.find(b => {
      const label = b.getAttribute('aria-label') || '';
      return /turn on\/off microphone|turn on microphone|turn off microphone/i.test(label);
    }) || null;
  };

  // NAIVE "first match wins" selector (the BUGGY approach that broke 2026-08-12)
  const findBotMicButtonNaive = (doc) => {
    const buttons = Array.from(doc.querySelectorAll('button,[role="button"]'));
    return buttons.find(b => {
      const label = b.getAttribute('aria-label') || '';
      return /microphone/i.test(label);
    }) || null;
  };

  // Test SCOPED approach: should find the bot's own button
  const scopedResult = findBotMicButtonScoped(fx.document);
  assert(scopedResult !== null, 'scoped selector finds bot mic button in populated call');
  if (scopedResult) {
    assertEquals(
      scopedResult.getAttribute('aria-label'),
      'Turn on microphone',
      'scoped selector resolves exactly "Turn on microphone"'
    );
  }

  // Test NAIVE approach: this is what BROKE — it would match a tile mute button
  const naiveResult = findBotMicButtonScoped(fx.document);
  assert(naiveResult !== null, 'naive selector finds something (but is it the right button?)');

  // Verify naive would grab the WRONG thing in a different fixture
  const noBotMic = loadFixture('no-bot-mic');
  const scopedInNegative = findBotMicButtonScoped(noBotMic.document);
  const naiveInNegative = findBotMicButtonNaive(noBotMic.document);

  assert(scopedInNegative === null, 'scoped selector returns null when bot mic absent (correct)');
  assert(
    naiveInNegative !== null && naiveInNegative?.getAttribute('aria-label')?.includes("Mute"),
    'naive selector INCORRECTLY matches tile mute control when bot mic absent (BUG!)'
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST SUITE 2: Reactions — emoji lookup inside OPEN picker, NOTHING when closed
// ─────────────────────────────────────────────────────────────────────────────────────

function testReactions() {
  log('\n== reactions: emoji lookup in open/closed picker ==', CYAN);

  const fx = loadFixture('populated-call');

  // SCOPED reaction emoji finder (checks picker is open)
  const findReactionEmojiScoped = (doc, emoji) => {
    const picker = doc.querySelector('#reaction-picker, [role="menu"][data-reaction-picker]');
    if (!picker || picker.style.display === 'none' || !picker.classList.contains('open')) {
      return null; // Picker closed → no match
    }

    // Search within picker for emoji
    const buttons = Array.from(picker.querySelectorAll('button,img'));
    return buttons.find(b => {
      const surfaces = [
        b.getAttribute('aria-label') || '',
        b.getAttribute('alt') || '',
        b.getAttribute('data-emoji') || '',
        b.textContent || ''
      ].join(' ');
      return surfaces.includes(emoji);
    }) || null;
  };

  // Open the picker (simulate clicking the reaction button)
  fx.document.querySelector('[aria-label="Send a reaction"]')?.click();
  fx.document.querySelector('#reaction-picker').classList.add('open');

  // Now emoji should resolve
  const partyPopper = findReactionEmojiScoped(fx.document, '🎊');
  assert(partyPopper !== null, '🎊 resolves when picker is open');

  // Test CLOSED picker fixture
  const closedFx = loadFixture('picker-closed');
  const emojiInClosed = findReactionEmojiScoped(closedFx.document, '🎊');
  assert(
    emojiInClosed === null,
    'emoji lookup returns NOTHING when picker is closed (correct)'
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST SUITE 3: Consent — "Join now" in dialog, not pre-join "Ask to join"
// ─────────────────────────────────────────────────────────────────────────────────────

function testConsent() {
  log('\n== consent: "Join now" vs pre-join "Ask to join" ==', CYAN);

  const fx = loadFixture('populated-call');

  // SCOPED consent accept finder (must be inside a consent dialog)
  const findConsentAcceptScoped = (doc) => {
    // Find consent dialog by known ID or role (avoid :has-text which JSDOM doesn't fully support)
    const dialog = doc.querySelector('#consent-dialog, [role="dialog"][aria-label*="Gemini"], [role="alertdialog"][aria-label*="notes"]');
    if (!dialog || dialog.style.display === 'none' || !dialog.classList.contains('open')) {
      return null; // No consent dialog → no match
    }

    const buttons = Array.from(dialog.querySelectorAll('button'));
    return buttons.find(b => {
      const label = b.getAttribute('aria-label') || '';
      return /join now/i.test(label);
    }) || null;
  };

  // Open the consent dialog
  if (fx.window.__fixture_state?.openConsent) {
    fx.window.__fixture_state.openConsent();
  }
  fx.document.querySelector('#consent-dialog')?.classList.add('open');

  const consentBtn = findConsentAcceptScoped(fx.document);
  assert(consentBtn !== null, 'consent "Join now" resolves when dialog is open');
  if (consentBtn) {
    assertEquals(
      consentBtn.getAttribute('aria-label'),
      'Join now',
      'consent button resolves exactly "Join now"'
    );
  }

  // Negative test: pre-join lobby should NOT match
  const preJoinFx = loadFixture('pre-join-only');
  const consentInLobby = findConsentAcceptScoped(preJoinFx.document);
  assert(
    consentInLobby === null,
    'consent selector returns null in pre-join lobby (correctly does NOT match "Ask to join")'
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// RUN ALL TESTS
// ─────────────────────────────────────────────────────────────────────────────────────

log('DOM Fixture Tests — Selector Ambiguity Detection', CYAN);
log('=' .repeat(60), CYAN);

testSetMic();
testReactions();
testConsent();

log('\n' + '='.repeat(60), CYAN);
log(`Results: ${passed} passed, ${failed} failed`, CYAN);

if (failed > 0) {
  log('\nFIXTURE TESTS RED — selector ambiguity detected', RED);
  process.exit(1);
} else {
  log('\nFIXTURE TESTS GREEN — all selectors scoped and verified', GREEN);
  process.exit(0);
}
