// ACTIONS snippet: native-audio checks. Play 5 s; pause/play the hidden <audio> from outside
// (as the steering wheel would); switch to 1.5x; report states along the way.
(async () => {
  const cp = window.__canvasPlayer, v = document.querySelector("video"), e = cp.engines[0];
  const s = () => ({ t: +e.now().toFixed(2), vPaused: v.paused, aud: e.native ? { paused: e.native.paused, t: +e.native.currentTime.toFixed(2), rate: e.native.playbackRate } : null, mode: e._stats().audio, sinceDraw: e._stats().sinceDraw });
  const out = [];
  await v.play().catch(x => out.push("play-reject " + x));
  await new Promise(r => setTimeout(r, 5000)); out.push(["playing", s()]);
  e.native && e.native.pause();
  await new Promise(r => setTimeout(r, 1500)); out.push(["after-ext-pause", s()]);
  e.native && e.native.play();
  await new Promise(r => setTimeout(r, 2500)); out.push(["after-ext-play", s()]);
  v.playbackRate = 1.5;
  const t0 = e.now(); await new Promise(r => setTimeout(r, 4000)); out.push(["rate1.5", s(), +(e.now() - t0).toFixed(2)]);
  out.push(["ms-handlers", !!navigator.mediaSession && !!navigator.mediaSession.metadata && navigator.mediaSession.metadata.title]);
  return out;
})()
