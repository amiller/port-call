/**
 * TTS AMPLITUDE BENCH — prove the beak is driven by the AUDIO, not by a timer. No meeting needed.
 *
 * The camera's speaking pose maps TTS RMS to beak opening, so the beak is only honest if
 * `onAmplitude` delivers a real envelope in step with PLAYBACK. It is easy to get this wrong in a
 * way that looks fine: the TTS service answers with a Content-Length body, so 5.9s of PCM lands in
 * ~5ms. Measuring RMS as bytes ARRIVE therefore yields exactly one callback, on the leading-silence
 * chunk — amplitude 0 for the whole utterance, and a beak that falls back to its idle sine. That
 * shipped, and no other check could see it. This one can.
 *
 *   node tts-amplitude-bench.mjs
 */
const { createTtsPlayback } = await import('/app/core/meetings/services/bot/dist/tts-playback.js');

const rms = [];
const tts = createTtsPlayback(() => { /* quiet: paplay chatter is not the subject */ });
tts.onAmplitude((r) => rms.push(r));

const t0 = Date.now();
await tts.speak('Testing the beak amplitude envelope with a sentence long enough to span several seconds of speech.');
const elapsed = Date.now() - t0;

const loud = rms.filter((r) => r > 0.02);
const quiet = rms.filter((r) => r <= 0.02);
const peak = Math.max(0, ...rms);

// An envelope, not a constant and not a single sample: many updates, spread over the playback, with
// both speech and silence in it, and every value a plausible RMS.
const checks = {
  'emits many updates (not one per response)': rms.length >= 10,
  'updates span the playback, not the download': elapsed > 1000,
  'peak is a plausible RMS': peak > 0.01 && peak < 1,
  'envelope contains speech': loud.length >= 5,
  'envelope contains silence (lead-in/tail)': quiet.length >= 1,
  'envelope varies (not a held constant)': new Set(loud.map((r) => r.toFixed(3))).size > 3,
};

console.log(JSON.stringify({ updates: rms.length, elapsedMs: elapsed, peak: +peak.toFixed(4),
                             loud: loud.length, quiet: quiet.length }));
let fail = 0;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) fail++;
}
console.log(fail ? `FAIL tts amplitude — ${fail} check(s)` : 'PASS tts amplitude envelope');
process.exit(fail ? 1 : 0);
