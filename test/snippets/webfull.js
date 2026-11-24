// ACTIONS snippet: switch bilibili's player to web fullscreen
(async () => { const b = document.querySelector(".bpx-player-ctrl-web"); if (b) b.click(); await new Promise(r => setTimeout(r, 800)); return !!b; })()
