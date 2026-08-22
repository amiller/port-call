(async () => {
  const list = await navigator.mediaDevices.enumerateDevices();
  return { videoinputs: list.filter(d => d.kind === 'videoinput').map(d => d.label || d.deviceId) };
})()
