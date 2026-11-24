// ACTIONS snippet: start, time the first picture, seek to 100 s, time it, play 6 s, report
(async () => {
  const cp = window.__canvasPlayer, v = document.querySelector("video"), e = cp.engines[cp.engines.length - 1];
  const out = {};
  const t0 = performance.now();
  await v.play().catch(x => out.playErr = String(x));
  while (e.draws === 0 && performance.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50));
  out.firstPictureMs = Math.round(performance.now() - t0); out.startT = +e.now().toFixed(2);
  await new Promise(r => setTimeout(r, 3000));
  const t1 = performance.now(); let seeked = false;
  v.addEventListener("seeked", () => { seeked = true; }, { once: true });
  v.currentTime = 100;
  while (!seeked && performance.now() - t1 < 15000) await new Promise(r => setTimeout(r, 50));
  out.seekMs = Math.round(performance.now() - t1); out.seekLandedAt = +v.currentTime.toFixed(2);
  e.lagMax = 0; e.lagSum = 0; e.lagN = 0;
  await new Promise(r => setTimeout(r, 6000));
  const s = e._stats(); out.after = { t: s.t, lagAvg: s.lagAvg, lagMax: s.lagMax, restarts: s.restarts, audio: s.audio, nat: s.nat, size: s.size, dropped: s.dropped };
  return out;
})()
