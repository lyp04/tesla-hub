# tesla-hub

**[中文说明](#中文说明)** · [Quick start](#quick-start) · [Configuration](#configuration) ·
[Lyrics](#lyrics) · [bilibili mirror](#bilibili-mirror) · [Data and privacy](#data-and-privacy) ·
[Development](#development) · [Security](SECURITY.md)

Pages for the Tesla in-car browser, running next to a [TeslaMate](https://github.com/teslamate-org/teslamate)
installation:

- **Menu** (`menu/`): an app-style launcher with a clock, a 继续观看 (continue watching)
  banner and tiles for the lyrics, the bilibili mirror, TeslaMate and Grafana.
- **Lyrics** (`lyrics/`): synced lyrics for whatever the car is playing, using TeslaMate's
  Tesla token. Formerly the separate `teslamate-lyrics` project.
- **bilibili mirror** (`bili/`): the bilibili desktop site through a reverse proxy, adapted
  to the car's browser: Chinese UI, page scaled to the ~800 px window, wide player, a tab
  back to the menu, and video drawn on a canvas.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> [!IMPORTANT]
> - Neither service has a login of its own. Publish them **only** behind a reverse proxy
>   with authentication (an example with nginx + oauth2-proxy is in `deploy/`). The mirror
>   carries your bilibili login; anyone who can reach it uses your account.
> - The bilibili mirror is for personal use with your own account. Do not host it for
>   others. bilibili's terms of service apply.
> - Do not watch video while driving.

Not affiliated with Tesla, TeslaMate or bilibili.

## Requirements

- TeslaMate v4 with Docker Compose (the lyrics service joins its Docker network and reads
  its database)
- Docker Engine with Compose v2
- A reverse proxy with HTTPS and a login in front (nginx + oauth2-proxy, Cloudflare Access,
  …)
- For the bilibili mirror: a residential internet connection. bilibili answers datacenter
  IP addresses with a 412 risk-control page.

## Quick start

```bash
git clone https://github.com/lyp04/tesla-hub.git /opt/tesla-hub
cd /opt/tesla-hub

cp .env.example .env && chmod 600 .env      # fill in TM_DB_PASS, TM_ENCRYPTION_KEY, ...
sudo install -d -m 700 -o 10001 -g 10001 data/lyrics
sudo install -d -m 700 -o 10002 -g 10002 data/bili

docker compose up -d --build
curl -f http://127.0.0.1:8475/healthz; curl -f http://127.0.0.1:8490/__bili/healthz
```

`TM_ENCRYPTION_KEY` is TeslaMate's `ENCRYPTION_KEY`. Find TeslaMate's network with
`docker network ls | grep teslamate`. Only the mirror? Start just that service:
`docker compose up -d --build bili` (the TeslaMate settings are then not needed).

### Database access

The lyrics service needs to read two things from TeslaMate's database: the stored token
and the car list. Rather than TeslaMate's own database user, give it a read-only role:

```sql
-- in TeslaMate's database (docker compose exec database psql -U teslamate teslamate)
CREATE ROLE tesla_hub LOGIN PASSWORD 'choose-one';
GRANT USAGE ON SCHEMA private TO tesla_hub;
GRANT SELECT (access, updated_at) ON private.tokens TO tesla_hub;
GRANT SELECT (id, vin, display_priority) ON public.cars TO tesla_hub;
```

and set `TM_DB_USER=tesla_hub` and its password in `.env`. The encryption key still
decrypts the stored Tesla token, which controls the Tesla account: keep `.env` private and
the service behind a login.

### Reverse proxy and login

Put a reverse proxy with a login in front, see [`deploy/nginx.conf.example`](deploy/nginx.conf.example):

- one host name (e.g. `car.example.com`) serves the menu at `/`, the lyrics at `/lyrics/`
  and `/bili-last` for the menu's banner; TeslaMate and Grafana can live there too;
- the mirror needs a host name of its own (e.g. `bilibili.example.com`): bilibili's pages
  expect to sit at the root.

With oauth2-proxy and any OpenID Connect provider:

```bash
cp deploy/oauth2-proxy.cfg.example deploy/oauth2-proxy.cfg     # issuer, client id, host names
echo you@example.com > deploy/emails.txt                          # who may sign in
printf 'OAUTH2_PROXY_CLIENT_SECRET=%s\nOAUTH2_PROXY_COOKIE_SECRET=%s\n' \
  'secret-from-your-provider' "$(openssl rand -base64 32 | tr -- '+/' '-_')" > oauth2-proxy.env
chmod 600 oauth2-proxy.env
cp deploy/docker-compose.override.example.yml docker-compose.override.yml
docker compose up -d
```

Register `https://<each host>/oauth2/callback` as redirect URLs with the provider. The
mirror never forwards the login proxy's cookies (`LOCAL_COOKIES`, matched by prefix) or
headers (`X-Forwarded-*`, `X-Auth-Request-*`, `CF-*`, `Authorization`) to bilibili.

### Menu

Copy `menu/menu-config.example.js` to `menu/menu-config.js` and set the links; tiles
without a link are hidden. Set `MENU_URL` in `.env` to the menu's address to get the tab
back to it on bilibili pages.

## Configuration

All settings are in `.env` (see [`.env.example`](.env.example)); each service only receives
its own.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TM_DB_HOST`, `TM_DB_NAME`, `TM_DB_USER` | `database`, `teslamate`, `teslamate` | TeslaMate's Postgres |
| `TM_DB_PASS` | required | TeslaMate database password |
| `TM_ENCRYPTION_KEY` | required | TeslaMate's `ENCRYPTION_KEY` (decrypts its stored Tesla token) |
| `TESLAMATE_NETWORK` | `teslamate_default` | TeslaMate's Docker network |
| `TESLA_VIN` | first car | Car whose media to follow |
| `TRANSLATE_TARGET_LANG` | `zh-CN` | Target language of the optional lyric translation |
| `REPORT_GITHUB_REPO`, `REPORT_GITHUB_TOKEN` | off | "Wrong lyrics" button files GitHub issues, see below |
| `REPORT_GITHUB_LABEL` | `lyrics-mismatch` | Label for those issues |
| `MENU_URL` | off | Menu address for the tab on bilibili pages |
| `LOCAL_COOKIES` | `_oauth2_proxy` | Your login proxy's cookies; never forwarded to bilibili |
| `BIND_ADDR` | `127.0.0.1` | Address the services listen on |
| `LYRICS_PORT`, `BILI_PORT` | `8475`, `8490` | Ports |

Host-specific additions (for example an oauth2-proxy container) go into a
`docker-compose.override.yml`, which Compose loads automatically and Git ignores; see
`deploy/docker-compose.override.example.yml`.

## Lyrics

The lyrics service decrypts TeslaMate's stored Tesla access token with the same
`ENCRYPTION_KEY`, asks Tesla's Owner API for the car's media state, and matches time-coded
lyrics. TeslaMate stays responsible for the Tesla login and token refresh; the service
keeps the decrypted token in memory for a minute at most.

```text
TeslaMate Postgres ── encrypted token ──► lyrics ──► Tesla Owner API ──► what is playing
                                            ├──► lyric providers ──► timed lyrics
                                            ├──► iTunes catalog  ──► native titles
                                            └──► in-car page     ──► local clock, smooth scrolling
```

- **Providers**: Musixmatch, LRCLIB, PetitLyrics, NetEase and KuGou. Results are checked
  against title, artist and duration; no lyrics is preferred over lyrics of the wrong
  recording. 可选歌词源 lists the other usable matches.
- **Native titles**: when the car reports a romanized or translated title, the original
  CJK title and artist are recovered from the iTunes catalog.
- **Furigana** for Japanese lyrics, and an optional **translation** (Google's free
  endpoint) into `TRANSLATE_TARGET_LANG`.
- **Timing**: the page advances its own clock between state polls and holds small backward
  corrections, so lines do not jump back. 微调 shifts one song (stored in the browser);
  全局延迟 in 歌词信息 shifts every song (stored on the server, `data/lyrics/settings.json`).
- **Wrong lyrics** (optional): with `REPORT_GITHUB_REPO` and `REPORT_GITHUB_TOKEN` set,
  歌词信息 gets a 歌词不对 button that opens a GitHub issue with the track as the car reports
  it, the lyric source, the line count and the timing offset. Nothing else: no VIN, account
  or IP address. Values are quoted so track names cannot add links or mentions. At most one
  issue per track and source a day, and ten a day in total. Use a
  [fine-grained token](https://github.com/settings/personal-access-tokens) limited to that
  repository with *Issues: read and write*.

Add `?mock=1` to the page URL for a synthetic demo without a car.

The page asks the service for the car's media state every few seconds while it is open,
and the service asks Tesla's Owner API (`vehicle_data`). A sleeping car is not woken up,
but an open page keeps querying an awake one. Tesla is moving third-party access to its
Fleet API; the Owner API may stop working. The lyric providers are used through their
public web endpoints, not official APIs, and may block or change them at any time.

## bilibili mirror

```text
car browser ── https://bilibili.example.com ── reverse proxy (login) ── bili (127.0.0.1:8490) ── bilibili
```

**URL mapping.** bilibili spreads a page over many hosts; the proxy puts them on one origin.

| real URL | on the mirror |
| --- | --- |
| `https://www.bilibili.com/video/BV…` | `/video/BV…` |
| `https://api.bilibili.com/x/…` | `/__h/api.bilibili.com/x/…` (resource form) |
| `https://search.bilibili.com/all?keyword=…` | `/all?keyword=…&__vh=search.bilibili.com` (page form) |

Pages of non-www hosts sit at the root because their front-end routers read
`location.pathname`; `__vh` tells the proxy which host they belong to. Static files on
`*.hdslb.com` are not proxied: that CDN allows cross-origin use, and the page's referrer
policy is forced to `same-origin` because the CDN rejects foreign referrers.

**Page bootstrap** (`bili/static/boot.js`, injected first into every page) rewrites what
bilibili's scripts do: request URLs, element URLs, `document.cookie`, history and window
navigation (everything stays in one tab). It also adapts the pages to the car's browser:
it reports Chinese as the browser language (the car reports English, and bilibili would
switch to its English site), scales the page to fit windows narrower than 1100 px, keeps
bilibili's control bar intact under that scaling, and adds the tab back to the menu.

**Login.** bilibili's own QR-code login works through the mirror. Its cookies stay in a
server-side jar (`data/bili/cookies.json`, mode 600); HttpOnly cookies such as `SESSDATA`
never reach the browser.

**Canvas player** (`bili/static/player.js`). bilibili's player keeps choosing streams,
fetching segments and drawing its controls and danmaku. Underneath, `MediaSource` is
replaced: video samples are decoded with WebCodecs and drawn onto a canvas over the
`<video>` element; the audio goes unchanged into a real `MediaSource` behind a hidden
`<audio>`, whose clock the picture follows, so media keys and the steering wheel buttons
pause and resume. The proxy offers bilibili only H.264 video and AAC audio streams, which
is what the canvas player decodes. Open a page with `?native=1` to use the browser's own
player; `localStorage["bili-debug"]="1"` logs to the console.

**Continue watching.** The player reports the page and position every 15 s and on pause
(`/__bili/now`, kept in `data/bili/last.json`); `/__bili/last` serves it to the menu's
banner and `/__bili/resume` opens it again. Playback diagnostics (decoder errors, stalls,
a summary every 30 s) are posted to `/__bili/report` and written to the container log:
`docker logs tesla-hub-bili 2>&1 | grep car-report`.

## Data and privacy

| What | Where |
| --- | --- |
| Secrets (TeslaMate database password and key, GitHub token) | `.env` (git-ignored) |
| bilibili login cookies | `data/bili/cookies.json` |
| Last bilibili video and position | `data/bili/last.json` |
| Global lyric offset, Musixmatch guest token, recently reported tracks | `data/lyrics/` |
| Per-song lyric source and offset | the car browser's `localStorage` |

There is no analytics. Normal operation sends track metadata to the lyric providers and
the iTunes catalog, lyric text to the translation endpoint when translation is on, and
reports to GitHub only when that is configured. Keep `data/` private.

## Development

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r lyrics/requirements.txt
python lyrics/tests/run_security_hardening_test.py
python lyrics/tests/run_candidate_filter_test.py
node lyrics/tests/run_lyrics_sync_test.js       # no npm install needed
```

`DISABLE_MXM_WARMUP=1` (set by the tests) skips fetching a Musixmatch guest token at
start-up. `test/` is a headless-browser harness for the menu, the lyrics page and the mirror
(screenshots, console errors, playback checks, CPU profiles); see [`test/README.md`](test/README.md).

## Security

See [SECURITY.md](SECURITY.md).

## 中文说明

tesla-hub 是给特斯拉车机浏览器用的几个页面，和 [TeslaMate](https://github.com/teslamate-org/teslamate)
跑在同一台机器上：

- **车机菜单**（`menu/`）：像手机桌面的启动页，有时钟、「继续观看」横幅，以及歌词、哔哩哔哩、
  TeslaMate、Grafana 几个图标。
- **歌词**（`lyrics/`）：车里正在放的歌的同步歌词。直接用 TeslaMate 存的 Tesla 令牌，不用再登录一次
  Tesla。支持多个歌词源、日文假名注音、可选翻译；「微调」调单首歌，「歌词信息」里的「全局延迟」调所有歌；
  可选的「歌词不对」按钮会自动提一个 GitHub issue（只含歌名、歌手、歌词源和时间偏移）。原来是单独的
  `teslamate-lyrics` 项目。
- **B 站镜像**（`bili/`）：通过反向代理访问 B 站电脑版，并针对车机浏览器做了适配：中文界面、按约 800
  像素的窗口整页缩放、默认宽屏、回菜单的悬浮标签、画布播放画面、声音交给浏览器播放（方向盘可以暂停）。

**必须注意**

- 两个服务都没有自己的登录。只能放在带登录的反向代理后面（`deploy/` 里有 nginx + oauth2-proxy 的例子）。
  B 站镜像带着你的 B 站登录，能访问它的人就是在用你的账号。
- B 站镜像只供自己用自己的账号，不要给别人用，B 站的用户协议照样适用。
- 开车时不要看视频。
- 和特斯拉、TeslaMate、B 站都没有关系；Tesla Owner API 和各歌词源都不是官方开放接口，随时可能变化或失效。

**快速部署**

```bash
git clone https://github.com/lyp04/tesla-hub.git /opt/tesla-hub && cd /opt/tesla-hub
cp .env.example .env && chmod 600 .env      # 填 TM_DB_PASS、TM_ENCRYPTION_KEY 等
sudo install -d -m 700 -o 10001 -g 10001 data/lyrics
sudo install -d -m 700 -o 10002 -g 10002 data/bili
docker compose up -d --build
```

数据库账号建议按上文 [Database access](#database-access) 单独建一个只读的；反向代理和登录见
[Reverse proxy and login](#reverse-proxy-and-login)；菜单链接复制 `menu/menu-config.example.js` 为
`menu/menu-config.js` 后修改。只想用 B 站镜像：`docker compose up -d --build bili`。

## License

MIT, see [LICENSE](LICENSE). bilibili, Tesla, the lyric providers and the translation
endpoint have their own terms; their APIs may change without notice.
