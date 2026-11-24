// EVAL snippet: what mediaCapabilities answers for the codecs bilibili asks about, plus engine state
(async () => {
  const q = c => navigator.mediaCapabilities.decodingInfo({ type: "media-source", video: { contentType: 'video/mp4; codecs="' + c + '"', width: 1920, height: 1080, bitrate: 3e6, framerate: 30 } }).then(r => r.supported);
  const e = window.__canvasPlayer.engines[0];
  return { avc: await q("avc1.640032"), hevc: await q("hev1.1.6.L150.90"), av1: await q("av01.0.08M.08"),
           engine: e && { t: +e.now().toFixed(2), size: e._stats().size, sw: e.preferSW, draws: e.draws, audio: e._stats().audio } };
})()
