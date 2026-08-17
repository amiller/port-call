#!/usr/bin/env node
/**
 * Anti-repetition guard test suite — red on unguarded behavior, green on guarded.
 *
 * Run with: node probe/repetition-tests.mjs
 *
 * Tests:
 * 1. Exact repeat suppressed within window
 * 2. Allowed again after window expiry (time-based)
 * 3. Allowed again after window expiry (line-count-based)
 * 4. Near-duplicate (case/whitespace) suppressed
 * 5. Distinct lines always allowed
 * 6. Sound effects (! prefix) always allowed
 * 7. Per-channel independence (same line in chat then speech is allowed once each)
 */

import { createRepetitionGuard, normalize, isSoundEffect } from '../patches/bot-repetition-guard.ts';

// ANSI colors for terminal output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`${GREEN}✓${RESET} ${name}`);
    passed++;
  } catch (e) {
    console.log(`${RED}✗${RESET} ${name}`);
    console.log(`  ${RED}${e.message}${RESET}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEquals(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

// Mock Date.now for time-sensitive tests
let now = 1000000;
const originalDateNow = Date.now;
Date.now = () => now;

function advanceTime(ms) {
  now += ms;
}

// Cleanup mock Date.now after tests
process.on('exit', () => {
  Date.now = originalDateNow;
});

console.log('=== Anti-repetition guard tests ===\n');

// Test 1: Exact repeat suppressed within window
test('exact repeat suppressed within window', () => {
  const guard = createRepetitionGuard('speak', { minLines: 10, minTimeMs: 60000 });
  const line = 'Hello world';

  const v1 = guard.check(line);
  assert(v1.allowed, 'first utterance should be allowed');

  const v2 = guard.check(line);
  assert(!v2.allowed, 'exact repeat should be suppressed');
  assertEquals(v2.reason, 'duplicate', 'reason should be duplicate');
  assertEquals(v2.normalized, normalize(line), 'normalized text should match');
});

// Test 2: Allowed again after time-based window expiry
test('allowed again after time-based window expiry', () => {
  const guard = createRepetitionGuard('speak', { minLines: 10, minTimeMs: 1000 });
  const line = 'After some time';

  const v1 = guard.check(line);
  assert(v1.allowed, 'first utterance should be allowed');

  advanceTime(1100); // Move past the time window

  const v2 = guard.check(line);
  assert(v2.allowed, 'line should be allowed after time window expires');
});

// Test 3: Allowed again after line-count-based window expiry
test('allowed again after line-count-based window expiry', () => {
  const guard = createRepetitionGuard('speak', { minLines: 3, minTimeMs: 100000 });
  const line = 'Repeat after many lines';

  const v1 = guard.check(line);
  assert(v1.allowed, 'first utterance should be allowed');

  // Fill the buffer with distinct lines to push the first one out
  for (let i = 0; i < 5; i++) {
    guard.check(`Distinct line ${i}`);
  }

  const v2 = guard.check(line);
  assert(v2.allowed, 'line should be allowed after line-count window expires');
});

// Test 4: Near-duplicate (case/whitespace) suppressed
test('near-duplicate (case/whitespace) suppressed', () => {
  const guard = createRepetitionGuard('chat', { minLines: 10, minTimeMs: 60000 });

  const v1 = guard.check('Hello World');
  assert(v1.allowed, 'first utterance should be allowed');

  const v2 = guard.check('  hello   world  ');
  assert(!v2.allowed, 'whitespace variant should be suppressed');

  const v3 = guard.check('HELLO WORLD');
  assert(!v3.allowed, 'case variant should be suppressed');
});

// Test 5: Distinct lines always allowed
test('distinct lines always allowed', () => {
  const guard = createRepetitionGuard('speak', { minLines: 10, minTimeMs: 60000 });

  for (let i = 0; i < 20; i++) {
    const v = guard.check(`Distinct line ${i}`);
    assert(v.allowed, `distinct line ${i} should be allowed`);
  }
});

// Test 6: Sound effects always allowed
test('sound effects (! prefix) always allowed', () => {
  const guard = createRepetitionGuard('speak', { minLines: 10, minTimeMs: 60000 });

  const sfx = '!airhorn';

  const v1 = guard.check(sfx);
  assert(v1.allowed, 'sound effect should be allowed first time');

  const v2 = guard.check(sfx);
  assert(v2.allowed, 'sound effect should be allowed even when repeated');
});

// Test 7: Per-channel independence
test('per-channel independence', () => {
  const speakGuard = createRepetitionGuard('speak', { minLines: 10, minTimeMs: 60000 });
  const chatGuard = createRepetitionGuard('chat', { minLines: 10, minTimeMs: 60000 });
  const line = 'Same line different channel';

  const vSpeak = speakGuard.check(line);
  assert(vSpeak.allowed, 'line should be allowed in speak channel');

  const vChat = chatGuard.check(line);
  assert(vChat.allowed, 'same line should be allowed in chat channel independently');

  const vSpeak2 = speakGuard.check(line);
  assert(!vSpeak2.allowed, 'repeat in speak should be suppressed');

  const vChat2 = chatGuard.check(line);
  assert(!vChat2.allowed, 'repeat in chat should be suppressed');
});

// Test 8: Window is larger of lines or time (both must fail to expire)
test('window is larger of lines or time (both must fail to expire)', () => {
  const guard = createRepetitionGuard('speak', { minLines: 5, minTimeMs: 2000 });
  const line = 'Window test line';

  const v1 = guard.check(line);
  assert(v1.allowed, 'first utterance should be allowed');

  // Add 4 distinct lines (still within line window: 1 original + 4 = 5 total, at limit)
  for (let i = 0; i < 4; i++) {
    guard.check(`Line ${i}`);
  }

  // Advance time but stay within line window
  advanceTime(1500); // Less than time window

  const v2 = guard.check(line);
  assert(!v2.allowed, 'line should still be suppressed (within line window even though time passed)');

  // Add one more line to EXCEED line window (pushes out the original)
  guard.check('Line 4'); // Now have 6 entries, evicts oldest

  const v3 = guard.check(line);
  assert(v3.allowed, 'line should be allowed (pushed out by line count even though time window still valid)');

  // Test the other dimension: same line within time window but not pushed out
  guard.clear();
  const line2 = 'Time window test';
  guard.check(line2);
  advanceTime(1000); // Well within time window

  const v4 = guard.check(line2);
  assert(!v4.allowed, 'line should be suppressed (within time window)');

  // Advance past time window
  advanceTime(1100); // Total 2100ms > 2000ms window

  const v5 = guard.check(line2);
  assert(v5.allowed, 'line should be allowed (past time window even though line count is low)');
});

// Test 9: normalize function
test('normalize function', () => {
  assertEquals(normalize('  Hello   World  '), 'hello world', 'should trim and collapse whitespace');
  assertEquals(normalize('HELLO WORLD'), 'hello world', 'should lowercase');
  assertEquals(normalize('Hello  World'), 'hello world', 'should collapse multiple spaces');
});

// Test 10: isSoundEffect function
test('isSoundEffect function', () => {
  assert(isSoundEffect('!airhorn'), '!airhorn should be a sound effect');
  assert(isSoundEffect('  !airhorn  '), '!airhorn with spaces should be a sound effect');
  assert(!isSoundEffect('airhorn'), 'airhorn without ! should not be a sound effect');
  assert(!isSoundEffect(' not ! prefixed'), 'line not starting with ! should not be a sound effect');
});

// Test 11: Sound effect with variations (always allowed)
test('sound effect variations are always allowed', () => {
  const guard = createRepetitionGuard('chat', { minLines: 10, minTimeMs: 60000 });

  const v1 = guard.check('!airhorn');
  assert(v1.allowed, '!airhorn should be allowed');

  const v2 = guard.check('  !airhorn  ');
  assert(v2.allowed, '!airhorn with spaces should be allowed (different normalized form)');
});

// Test 12: Empty and edge cases
test('empty and edge cases', () => {
  const guard = createRepetitionGuard('speak', { minLines: 10, minTimeMs: 60000 });

  const v1 = guard.check('');
  assert(v1.allowed, 'empty string should be allowed first time');

  const v2 = guard.check('');
  assert(!v2.allowed, 'empty string repeat should be suppressed');

  const v3 = guard.check('   ');
  assert(!v3.allowed, 'whitespace-only should normalize to empty and be suppressed');
});

// Test 13: Clear function
test('clear function', () => {
  const guard = createRepetitionGuard('chat', { minLines: 10, minTimeMs: 60000 });

  guard.check('Hello');
  guard.check('World');
  assert(guard.size === 2, 'guard should have 2 entries');

  guard.clear();
  assert(guard.size === 0, 'guard should be empty after clear');

  const v = guard.check('Hello');
  assert(v.allowed, 'line should be allowed after clear');
});

// Summary
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
