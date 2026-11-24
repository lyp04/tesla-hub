// ACTIONS snippet: play, then move the mouse over the player so the control bar shows
(async () => {
  await document.querySelector("video").play();
  await new Promise(r => setTimeout(r, 3000));
  const p = document.querySelector(".bpx-player-video-area") || document.querySelector(".bpx-player-container");
  const r = p.getBoundingClientRect();
  for (let i = 0; i < 5; i++) p.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + r.width / 2 + i, clientY: r.top + r.height / 2 }));
  return "ok";
})()
