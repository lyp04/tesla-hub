// Links for the in-car menu. Copy to menu-config.js (served next to index.html) and adjust.
// An empty link ("") hides that tile.
window.TESLA_HUB_MENU = {
  lyrics: "/lyrics/",                          // tesla-hub lyrics, proxied by the menu's site
  bilibili: "https://bilibili.example.com/",   // tesla-hub bilibili mirror (its own host name)
  teslamate: "/mate/",                         // TeslaMate, if it runs with URL_PATH=/mate
  grafana: "/grafana/",                        // TeslaMate's Grafana
  lastVideo: "/bili-last",                     // the menu's site proxying the mirror's /__bili/last
};
