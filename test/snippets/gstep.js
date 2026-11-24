// ACTIONS snippet (lyrics page): open 歌词信息 and press 全局 − twice
(async () => {
  document.getElementById("infobtn").click();
  await new Promise(r => setTimeout(r, 300));
  document.getElementById("gm").click(); document.getElementById("gm").click();
  await new Promise(r => setTimeout(r, 300));
  return { goff: document.getElementById("goff").textContent, panel: document.getElementById("infopanel").classList.contains("show") };
})()
