(async () => {
  // Signal allows ONE call at a time and blocks a join behind a modal ("You must leave the current
  // call before starting or joining a new call"). A seat left in a call by a previous run therefore
  // fails the NEXT run in a way that looks like a broken join.
  //
  // This LOOPS and VERIFIES rather than clicking once and reporting success: a leave takes a moment
  // to tear down, and a reset that returns before the call is really gone hands the next step a
  // modal it does not expect — which is exactly how a false "joined" gets reported.
  const P = globalThis.__pc;
  const gone = () => !P.btn(/^Leave$/) && !/leave the current call/i.test(P.plain(document.body.innerText));
  for (let i = 0; i < 5 && !gone(); i++) {
    const cancel = [...document.querySelectorAll('button')].find(b => /^Cancel$/i.test(P.plain(b.innerText)));
    if (cancel) { cancel.click(); await P.sleep(700); }
    const leave = P.btn(/^Leave$/)
      || [...document.querySelectorAll('button')].find(b => /^Leave call$/i.test(P.plain(b.innerText)));
    if (leave) { leave.click(); await P.sleep(2500); }
  }
  return { clean: gone(), inCall: P.inCall() };
})()
