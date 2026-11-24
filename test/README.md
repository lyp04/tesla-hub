# Browser test harness

Loads pages in a headless browser (Docker, Playwright 1.49.1), takes a screenshot of each,
and prints a JSON report: console errors, failed requests, HTTP errors, hosts contacted
directly, plus the results of optional scripts run in the page.

```bash
bash test/dev-up.sh                               # dev mirror on 127.0.0.1:18480
VW=804 VH=638 LOCALE=en bash test/run.sh out/a http://127.0.0.1:18480/video/BV1754H64Ej7/
```

`VW=804 VH=638 LOCALE=en` imitates the car: the browser window is about 800 × 640 px and
reports English. Screenshots and `report.json` land in the output directory (`test/out/` is
git-ignored). The first run builds the Chrome image (`chrome.Dockerfile`; Playwright's own
Chromium has no H.264, set `BROWSER=chromium` to use it anyway) and installs Playwright into
`test/node_modules`.

## Settings (environment)

| Variable | Meaning |
| --- | --- |
| `VW`, `VH` | Viewport, default 1600 × 900 |
| `LOCALE` | Browser locale, default `zh-CN` |
| `COLOR` | `dark` (default) or `light` |
| `WAIT` | ms to wait after loading, default 8000 |
| `ACTIONS` | JavaScript run in the page after `WAIT` (may return a promise); then `WAIT2` ms |
| `EVAL` | JavaScript whose result goes into the report, after the screenshot |
| `INIT_FILE` | Script run before any page script, path inside the container (`/t/...`) |
| `CHROME_ARGS` | Extra browser flags, separated by `\|` |
| `MOCK_LYRICS` | Fake the lyrics API (state + 40 placeholder lines) |
| `MOCK_LAST` | JSON answered for the menu's `/bili-last` |
| `CPU_THROTTLE` | Slow the CPU down, e.g. `6` (roughly the car) |
| `PROFILE_MS`, `PROFILE_FN` | Profile the first `PROFILE_MS` ms; self time per script, or per function for URLs containing `PROFILE_FN` |

## Snippets

Ready-made `ACTIONS` / `EVAL` / `INIT_FILE` scripts in `snippets/`, used like
`ACTIONS="$(cat test/snippets/play.js)" EVAL="$(cat test/snippets/box.js)" bash test/run.sh ...`.

| Snippet | Use | What it does |
| --- | --- | --- |
| `play.js` | ACTIONS | Start the first `<video>` |
| `startup.js` | ACTIONS | Time to the first picture, seek to 100 s and time it, then picture-vs-sound lag |
| `stall.js` | ACTIONS | Simulate a decoder that stops giving frames, then a closed decoder; the player must recover |
| `native.js` | ACTIONS | Pause / play the hidden `<audio>` from outside (like the steering wheel), 1.5× speed |
| `quality.js` | ACTIONS | Switch the quality while playing (`window.__wantQ`, default 720P) |
| `hover.js` | ACTIONS | Play, then move the mouse so the control bar shows |
| `webfull.js` | ACTIONS | Enter bilibili's web fullscreen |
| `click-video.js` | ACTIONS | Click the first link to a video (dynamic feed, search, space pages) |
| `gstep.js` | ACTIONS | Lyrics page: open 歌词信息 and press 全局延迟 − twice |
| `box.js` | EVAL | Position, video box vs canvas box, centre pixel, page zoom |
| `state.js` | EVAL | Engine and player state |
| `ctrls.js` | EVAL | Which control-bar buttons are visible |
| `hometab.js` | EVAL | The tab back to the menu: box, link, on top |
| `caps.js` | EVAL | What `mediaCapabilities` answers for H.264 / HEVC / AV1 |
| `playurl.js` | EVAL | Codecs offered to bilibili's player (embedded play info and the API) |
| `longtask-init.js` | INIT_FILE | Collect long tasks from the start (`window.__lt`) |
| `sw-init.js` | INIT_FILE | Force the software video decoder |
