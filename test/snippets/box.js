// EVAL snippet: playback position, video vs canvas boxes, centre pixel, page zoom
(() => {
  const v = document.querySelector("video"), c = v && v.parentNode.querySelector("canvas");
  const r = x => { const b = x.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); };
  let px = null;
  try { const d = c.getContext("2d").getImageData(c.width >> 1, c.height >> 1, 1, 1).data; px = [d[0], d[1], d[2]]; } catch (e) { px = String(e); }
  return { t: v && v.currentTime, paused: v && v.paused, vbox: v && r(v), cbox: c && r(c), cwh: c && [c.width, c.height], px,
           zoom: document.documentElement.style.zoom, sw: document.documentElement.scrollWidth, url: location.pathname + location.search };
})()
