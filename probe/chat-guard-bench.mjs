/**
 * CHAT GUARD BENCH — prove the anti-repetition guard is actually WIRED, not just correct.
 *
 * repetition-tests.mjs proves the guard's logic. It cannot see the wiring bug: index.ts builds a
 * NEW ChatController for EVERY chat_send act, so a guard owned by the controller starts empty on
 * every send and suppresses nothing. The unit tests stayed green while chat repeated freely.
 *
 *   node chat-guard-bench.mjs
 */
// Prove the guard survives the per-act controller rebuild.
// With a null page, "reached the page" is observable as a TypeError:
//   send #1 (allowed)    -> MUST throw  (it got past the guard, as it should)
//   send #2 (duplicate)  -> MUST NOT throw, and must log the suppression
// Before the guard moved to module scope, #2 threw too — the history was empty every act.
const { createChatController } = await import('/app/core/meetings/services/bot/dist/chat.js');
const reached = async (c) => { try { await c.send('the same line twice'); return false; } catch { return true; } };

const logs = [];
const orig = console.log; console.log = (m) => logs.push(String(m));
const first = await reached(createChatController(null));
const second = await reached(createChatController(null));
console.log = orig;

const ok = first && !second && logs.some((l) => l.startsWith('[guard] suppressed repeat chat'));
console.log(JSON.stringify({ firstReachedPage: first, secondReachedPage: second, logs }));
console.log(ok ? 'PASS chat guard survives the per-act controller rebuild'
               : 'FAIL chat guard resets between acts');
process.exit(ok ? 0 : 1);
