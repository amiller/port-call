#!/usr/bin/env node
/**
 * Opt-out: the chat commands, the registry, what gets written and what never does.
 *
 *   node probe/optout-tests.mjs        (no meeting, no container; node strips the types)
 *
 * The one rule every case below checks from a different side: a level-2 name is written
 * NOWHERE, and a level-1 name is written exactly once, as the marker line.
 */
import { createOptOut, parseOptOut, optOutLevel, claims, roster, resetOptOut, MARKER, REPLY }
  from '../patches/bot-optout.ts';

const GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';
let passed = 0, failed = 0;
async function test(name, fn) {
  resetOptOut();
  try { await fn(); console.log(`${GREEN}✓${RESET} ${name}`); passed++; }
  catch (e) { console.log(`${RED}✗${RESET} ${name}\n    ${e.message}`); failed++; }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
};

/** A bot with a notebook: everything it would publish, post or log, in order. */
function rig(botName = 'Port Call') {
  const published = [], posted = [], logged = [];
  const oo = createOptOut({
    publish: async (seg) => { published.push(seg); },
    post: async (t) => { posted.push(t); },
    log: (m) => logged.push(m),
    botName, now: () => 1_700_000_000_000,
  });
  return { oo, published, posted, logged, everything: () => [...published.map((s) => `${s.speaker} ${s.text}`), ...posted, ...logged].join('\n') };
}

await test('the command is the whole message, in its spellings', () => {
  for (const t of ['opt-out', 'Opt out', 'optout', 'OPT-OUT', 'opt-out 1', ' opt-out. ', 'opt out 1!']) eq(parseOptOut(t), 1, t);
  for (const t of ['opt-out 2', 'opt out 2', 'optout 2']) eq(parseOptOut(t), 2, t);
  for (const t of ['opt-in', 'opt in', 'optin']) eq(parseOptOut(t), 0, t);
  for (const t of ['I want to opt-out', 'opt-out please', 'opt-out 3', 'out', 'hello']) eq(parseOptOut(t), null, t);
});

await test('level 1: the words are cut, the name is written once, as the marker', async () => {
  const r = rig();
  eq(await r.oo.onChat('Bob Example', 'opt-out'), 1, 'level');
  eq(optOutLevel('bob example'), 1, 'registry is case-blind');
  eq(r.published.map((s) => [s.speaker, s.text, s.completed]), [['Bob Example', MARKER.out, true]], 'the marker');
  eq(r.posted, [REPLY[1]], 'the confirmation');
  eq(roster(), { named: ['Bob Example'], unnamed: 0 }, 'roster');
  eq(r.logged, ['[optout] {"named":["Bob Example"],"unnamed":0}'], 'the console line');
  eq(r.posted.join('\n').includes('Bob'), false, 'the reply names nobody');
});

await test('level 2: nothing carries the name, not even the count', async () => {
  const r = rig();
  eq(await r.oo.onChat('Carol Example', 'opt-out 2'), 2, 'level');
  eq(optOutLevel('Carol Example'), 2, 'registry');
  eq(r.published, [], 'no marker');
  eq(roster(), { named: [], unnamed: 1 }, 'roster counts, does not name');
  eq(r.everything().includes('Carol'), false, 'the name appears nowhere');
  eq(r.logged.length, 1, 'one console line');
  eq(JSON.parse(r.logged[0].slice('[optout] '.length)).note.length > 0, true, 'with a note, since the transcript shows nothing');
});

await test('opt-in lifts the cut and says so in the transcript', async () => {
  const r = rig();
  await r.oo.onChat('Bob', 'opt-out');
  eq(await r.oo.onChat('bob', 'opt-in'), 0, 'level');
  eq(optOutLevel('Bob'), 0, 'registry');
  eq(r.published.map((s) => s.text), [MARKER.out, MARKER.in], 'out, then back in');
  eq(roster(), { named: [], unnamed: 0 }, 'roster');
});

await test('opt-in from level 2 names them in the marker: they chose to be back', async () => {
  const r = rig();
  await r.oo.onChat('Carol', 'opt-out 2');
  await r.oo.onChat('Carol', 'opt-in');
  eq(r.published.map((s) => [s.speaker, s.text]), [['Carol', MARKER.in]], 'one marker, the return');
});

await test('repeating opt-out does not repeat the marker; moving 1 -> 2 un-names them', async () => {
  const r = rig();
  await r.oo.onChat('Bob', 'opt-out');
  await r.oo.onChat('Bob', 'opt-out');
  eq(r.published.length, 1, 'one marker');
  eq(r.posted.length, 2, 'but each message is answered');
  await r.oo.onChat('Bob', 'opt-out 2');
  eq(roster(), { named: [], unnamed: 1 }, 'now unnamed');
  eq(r.logged.at(-1).includes('Bob'), false, 'the latest console line has dropped the name');
});

await test('the bot ignores itself, and ordinary chat', async () => {
  const r = rig('Port Call');
  eq(await r.oo.onChat('You', 'opt-out'), null, 'Meet shows our own messages as You');
  eq(await r.oo.onChat('port call', 'opt-out'), null, 'or under the bot name');
  eq(await r.oo.onChat('Bob', 'can I opt-out later?'), null, 'a sentence is not a command');
  eq(r.posted, [], 'no replies');
  eq(roster(), { named: [], unnamed: 0 }, 'nothing registered');
});

await test('a command with no readable sender is answered, not applied', async () => {
  const r = rig();
  eq(await r.oo.onChat('', 'opt-out'), null, 'not applied');
  eq(r.posted, [REPLY.unknown], 'told to try again');
  eq(roster(), { named: [], unnamed: 0 }, 'nothing registered');
});

await test('an opted-out tile lit anywhere in the span claims it', async () => {
  const r = rig();
  await r.oo.onChat('Bob', 'opt-out');
  eq(claims(['Alice', 'Bob']), 'Bob', 'Bob was lit: the whole utterance goes');
  eq(claims(['Alice']), undefined, 'Alice alone keeps hers');
  eq(claims([]), undefined, 'nobody lit');
});

await test('the sink rule: a line from an opted-out speaker is dropped, others pass', async () => {
  const r = rig();
  await r.oo.onChat('Bob', 'opt-out 2');
  const keep = (seg) => !optOutLevel(seg.speaker);
  eq(keep({ speaker: 'BOB', text: 'hi' }), false, 'dropped, case-blind');
  eq(keep({ speaker: 'Alice', text: 'hi' }), true, 'kept');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
