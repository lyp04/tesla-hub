// ACTIONS snippet: play, then simulate a decoder that stops producing pictures for 3 s,
// then a decoder closed under us (like a reclaimed hardware decoder). Returns after 12 s.
(async () => {
  const v = document.querySelector("video"), e = window.__canvasPlayer.engines[0];
  await v.play();
  await new Promise(r => setTimeout(r, 3000));
  const keep = e._onFrame; e._onFrame = (f) => f.close();
  await new Promise(r => setTimeout(r, 3000));
  e._onFrame = keep;
  await new Promise(r => setTimeout(r, 3000));
  try { e.vdec && e.vdec.close(); } catch (x) {}
  await new Promise(r => setTimeout(r, 3000));
  return e._stats();
})()
