// ACTIONS snippet: play 4 s, switch to another quality, play 8 s, report the engine
(async () => {
  const v = document.querySelector("video"), cp = window.__canvasPlayer;
  await v.play();
  await new Promise(r => setTimeout(r, 4000));
  const items = [...document.querySelectorAll(".bpx-player-ctrl-quality-menu-item")].map(x => x.getAttribute("data-value") + (x.classList.contains("bpx-state-active") ? "*" : ""));
  const all = [...document.querySelectorAll(".bpx-player-ctrl-quality-menu-item")], want = window.__wantQ || "64"; const target = all.find(x => x.getAttribute("data-value") === want) || all.find(x => !x.classList.contains("bpx-state-active"));
  const before = cp.engines.map(e => e._stats());
  if (target) target.click();
  await new Promise(r => setTimeout(r, 8000));
  const e = cp.engines[cp.engines.length - 1];
  return { items, clicked: target && target.getAttribute("data-value"), engines: cp.engines.length, before: before.map(s => s.size + "@" + s.t), after: e && e._stats(), tracks: e && e.ms._sbs.map(s => s.kind + ":" + s.samples.length + ":" + [...new Set(s.samples.map(x => x.tr.width ? x.tr.width + "x" + x.tr.height : x.tr.codec))].join("|")) };
})()
