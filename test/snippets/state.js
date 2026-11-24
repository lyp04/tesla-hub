// EVAL snippet: engine + player state
(() => {
  const cp = window.__canvasPlayer, e = cp && cp.engines[0], v = document.querySelector("video");
  const c = document.querySelector("canvas.tesla-canvas-video");
  let px = null;
  if (c) { try { const x = c.getContext("2d").getImageData(c.width >> 1, c.height >> 1, 1, 1).data; px = [x[0], x[1], x[2]]; } catch (err) { px = String(err); } }
  return {
    installed: !!cp, engines: cp ? cp.engines.length : 0,
    v: v && { t: v.currentTime, paused: v.paused, rs: v.readyState, dur: v.duration, w: v.videoWidth, h: v.videoHeight, buf: v.buffered.length ? [v.buffered.start(0), v.buffered.end(0)] : [] },
    e: e && { running: e.running, audioMaster: e.audioMaster, decoded: e.decoded, dropped: e.dropped, frames: e.frames.length, seeking: e.seeking, waiting: e.waiting,
              vs: e.ms._sb("video") && { n: e.ms._sb("video").samples.length, codec: e.ms._sb("video").track && e.ms._sb("video").track.codec },
              as: e.ms._sb("audio") && { n: e.ms._sb("audio").samples.length, codec: e.ms._sb("audio").track && e.ms._sb("audio").track.codec },
              srcs: e.sources.length, actx: window.AudioContext && e.audioMaster },
    canvas: c && { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, px },
    time: document.querySelector(".bpx-player-ctrl-time-current") && document.querySelector(".bpx-player-ctrl-time-current").textContent,
  };
})()
