// EVAL snippet: codecs offered by the embedded play info and by a playurl API call through the proxy
(async () => {
  const pi = window.__playinfo__, d = pi && pi.data;
  const codecs = x => x && x.dash ? [...new Set(x.dash.video.map(v => v.codecid + ":" + v.codecs))] : null;
  const st = window.__INITIAL_STATE__, vd = st && st.videoData;
  let api = null;
  if (vd) {
    const r = await fetch("https://api.bilibili.com/x/player/playurl?bvid=" + vd.bvid + "&cid=" + vd.cid + "&qn=80&fnval=4048&fourk=1", { credentials: "include" }).then(r => r.json()).catch(e => ({ err: String(e) }));
    api = r.data ? { codecs: codecs(r.data), fmt: (r.data.support_formats || []).map(f => f.quality + ":" + (f.codecs || []).join("|")).slice(0, 3), audio: (r.data.dash.audio || []).map(a => a.codecs) } : r;
  }
  const e = window.__canvasPlayer && window.__canvasPlayer.engines[0];
  return { embedded: codecs(d), api, sbs: e && e.ms._sbs.map(b => b.kind + ":" + (b.track ? b.track.codec : "-")) };
})()
