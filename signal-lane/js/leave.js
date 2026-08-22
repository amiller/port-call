(async () => { const P = globalThis.__pc; const l = P.btn(/^Leave$/); if (l) { l.click(); await P.sleep(2000); } return { left: !!l }; })()
