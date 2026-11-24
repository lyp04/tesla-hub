// EVAL snippet: the home tab's box, link and what is on top at its centre
(() => {
  const a = document.getElementById("tesla-home-tab");
  if (!a) return "no tab";
  const r = a.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { box: [r.left, r.top, r.width, r.height].map(Math.round), href: a.href, onTop: top === a || a.contains(top),
           screen: (document.querySelector(".bpx-player-container") || { getAttribute: () => "" }).getAttribute("data-screen") };
})()
