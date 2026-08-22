(async () => {
  const P = globalThis.__pc;
  P.nav('Settings').click(); await P.sleep(1000);
  P.tile(/^Calls$/).click(); await P.sleep(1400);
  // virtual_mic, NOT tts_sink.monitor: RingRTC's enumeration drops monitor sources entirely, and
  // it enumerates ONCE at startup — a device added after launch is invisible until restart.
  // Patterns are overridable so the harness can be dry-run against a differently-named host
  // PulseAudio graph without editing the script the containers use.
  const micRe = globalThis.__pcMicRe ? new RegExp(globalThis.__pcMicRe, 'i') : /VirtualMicrophone|virtual_mic/i;
  const spkRe = globalThis.__pcSpkRe ? new RegExp(globalThis.__pcSpkRe, 'i') : /CallOut|call_out/i;
  const mic = P.sel('Microphone', micRe); await P.sleep(500);
  const spk = P.sel('Speakers', spkRe);
  return { mic, spk };
})()
