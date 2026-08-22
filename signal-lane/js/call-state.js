(() => {
  const P = globalThis.__pc;
  return { inCall: P.inCall(), leaveVisible: !!P.btn(/^Leave$/),
           camOn: !!P.btn(/^Turn off camera$/), micOn: !!P.btn(/^Mute mic$/) };
})()
