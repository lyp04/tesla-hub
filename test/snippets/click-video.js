// ACTIONS snippet: click the first link to a video page (dynamic feed / space page)
(() => {
  const a = document.querySelector(".bili-dyn-card-video") || [...document.querySelectorAll("a[href]")].find(x => /\/video\/BV/.test(x.href));
  if (!a) return "no video link";
  const r = { href: a.href, target: a.target };
  a.click();
  return r;
})()
