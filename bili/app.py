"""A reverse proxy of the bilibili desktop site for the Tesla in-car browser (tesla-hub).

The site is forwarded as-is. The proxy only does three things:

1. Maps bilibili hosts onto this origin, so pages, APIs and video streams are
   same-origin: www.bilibili.com at the root, other hosts' pages at the root with a
   `__vh=<host>` query parameter, everything else under /__h/<host>/ (see "host mapping").
2. Keeps the bilibili login (HttpOnly cookies such as SESSDATA) in a server-side cookie
   jar. The browser only receives the cookies that page scripts need to read.
3. Injects /__bili/boot.js into every HTML page. It rewrites requests made by page
   scripts and replaces the video output with canvas decoding (static/player.js).

Static assets on *.hdslb.com are NOT proxied: the CDN sends `Access-Control-Allow-Origin: *`
and images load fine without a Referer, so the browser fetches them directly.
"""

import asyncio
import collections
import json
import logging
import os
import re
import time
import zlib
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import aiohttp
from aiohttp import web

try:
    import brotli  # type: ignore
except ImportError:  # pragma: no cover
    brotli = None

log = logging.getLogger("bili")

ROOT_HOST = os.environ.get("BILI_ROOT_HOST", "www.bilibili.com")
LISTEN_HOST = os.environ.get("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
STATIC_DIR = Path(__file__).with_name("static")
# Cookies that belong to this proxy (SSO in front of it) and must never reach bilibili.
LOCAL_COOKIES = {c.strip() for c in os.environ.get("LOCAL_COOKIES", "_oauth2_proxy").split(",") if c.strip()}
# Optional: the in-car menu's address. Pages then get a small tab on the left edge back to it.
MENU_URL = os.environ.get("MENU_URL", "").strip()

# Hosts this proxy is willing to talk to. hdslb.com is listed so that the few
# requests that do come through (e.g. from a mapped page) still work.
PROXY_HOST_RE = re.compile(
    r"^(?:[a-z0-9-]+\.)*(?:bilibili\.com|biliapi\.net|biliapi\.com|bilivideo\.com|bilivideo\.cn|hdslb\.com|biliimg\.com)$"
    r"|^upos-[a-z0-9-]+\.akamaized\.net$",
    re.I,
)
# Hosts whose URLs get rewritten to this origin inside proxied HTML/JS/CSS.
REWRITE_HOST = r"(?:[a-z0-9-]+\.)*(?:bilibili\.com|biliapi\.net|biliapi\.com|bilivideo\.com|bilivideo\.cn)"
URL_IN_TEXT_RE = re.compile(
    r"(?P<scheme>https?:)?(?P<sep>//|\\/\\/|\\u002F\\u002F)(?P<host>" + REWRITE_HOST + r")(?![a-z0-9.-])",
    re.I,
)
TEXT_TYPES = ("text/html", "javascript", "text/css")
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "host", "content-length",
}
DROP_REQ_HEADERS = HOP_BY_HOP | {
    "cookie", "origin", "referer", "accept-encoding", "authorization", "forwarded", "via",
    "x-real-ip", "true-client-ip", "cdn-loop",
}
# Whatever the reverse proxy / login layer in front adds (oauth2-proxy, Cloudflare Access,
# client addresses, ...) must not reach bilibili.
DROP_REQ_HEADER_PREFIXES = ("x-forwarded-", "x-auth-request-", "x-original-", "cf-", "x-amzn-")
# Hosts that get the bilibili login (cookies); CDNs (hdslb, biliimg, akamaized) do not need it.
COOKIE_HOST_RE = re.compile(r"^(?:[a-z0-9-]+\.)*(?:bilibili\.com|biliapi\.net|biliapi\.com|bilivideo\.com|bilivideo\.cn)$", re.I)
REPORTS_PER_MINUTE = 60
DROP_RESP_HEADERS = HOP_BY_HOP | {
    "content-security-policy", "content-security-policy-report-only", "x-frame-options",
    "strict-transport-security", "report-to", "nel", "alt-svc", "set-cookie",
    "access-control-allow-origin", "access-control-allow-credentials",
    "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers",
    "referrer-policy",
    "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
}
BOOT_VERSION = str(int(time.time()))
UPSTREAM_LANG = os.environ.get("UPSTREAM_LANG", "zh-CN,zh;q=0.9")
EN_PREFIX_RE = re.compile(r"^/en(/|$)")


# ---------------------------------------------------------------- host mapping
# Two URL forms on this origin:
#   resource form  /__h/<host>/<path>?<q>          any bilibili host (APIs, streams, scripts)
#   page form      /<path>?<q>&__vh=<host>         a page of a non-www host (search, space, t, ...)
#   www pages      /<path>?<q>                     www.bilibili.com sits at the root
# Pages of other hosts must live at the root path too: their front-end routers read
# location.pathname and break under a /__h/<host> prefix. A navigation that arrives in
# resource form is redirected to page form.
VH = "__vh"
VH_RE = re.compile(r"(?:^|&)__vh=([^&]*)")


def strip_vh(qs: str) -> tuple[str | None, str]:
    m = VH_RE.search(qs or "")
    if not m:
        return None, qs or ""
    rest = (qs[: m.start()] + "&" + qs[m.end():]).strip("&").replace("&&", "&")
    return unquote(m.group(1)).lower(), rest


def resolve(path: str, qs: str) -> tuple[str, str, str, bool]:
    """-> (host, upstream path, upstream query, came in resource form)."""
    if path.startswith("/__h/"):
        host, _, rest = path[5:].partition("/")
        return host.lower(), "/" + rest, qs, True
    vh, rest = strip_vh(qs)
    if vh and PROXY_HOST_RE.fullmatch(vh):
        return vh, path, rest, False
    return ROOT_HOST, path, qs, False


def resource_form(real: str, page_host: str = ROOT_HOST) -> str:
    """Absolute bilibili URL -> resource form. Non-bilibili URLs are returned unchanged."""
    parts = urlsplit(real)
    host = (parts.hostname or "").lower()
    if not parts.netloc or not PROXY_HOST_RE.fullmatch(host):
        return real
    pre = "" if (host == ROOT_HOST and page_host == ROOT_HOST) else "/__h/" + host
    out = pre + (parts.path or "/")
    if parts.query:
        out += "?" + parts.query
    if parts.fragment:
        out += "#" + parts.fragment
    return out


def page_form(real: str) -> str:
    parts = urlsplit(real)
    host = (parts.hostname or "").lower()
    if not parts.netloc or not PROXY_HOST_RE.fullmatch(host):
        return real
    q = parts.query
    if host != ROOT_HOST:
        q = (q + "&" if q else "") + f"{VH}={host}"
    out = (parts.path or "/") + ("?" + q if q else "")
    if parts.fragment:
        out += "#" + parts.fragment
    return out


def proxy_to_real(url: str) -> str | None:
    """URL on this origin (absolute or path, either form) -> real bilibili URL."""
    parts = urlsplit(url)
    host, path, qs, _ = resolve(parts.path or "/", parts.query)
    if not PROXY_HOST_RE.fullmatch(host):
        return None
    return f"https://{host}{path}" + ("?" + qs if qs else "")


def rewrite_text(text: str, page_host: str, is_html: bool) -> str:
    """Rewrite bilibili URLs in proxied HTML/JS/CSS to resource form.

    `page_host` is the host of the HTML page (None for JS/CSS, which may be shared by
    pages of several hosts). Only www HTML may map www URLs to bare root paths; anywhere
    else a bare root path would be read as relative to the page's own host.
    """
    root_bare = page_host == ROOT_HOST

    def sub(m: re.Match) -> str:
        host = m.group("host").lower()
        sep = m.group("sep")
        slash = "/" if sep == "//" else ("\\/" if sep.startswith("\\/") else "\\u002F")
        if host == ROOT_HOST and root_bare:
            # "https://www.bilibili.com/video" -> "/video"; a bare origin becomes "/"
            nxt = m.string[m.end():m.end() + 6]
            if nxt.startswith(("/", "\\/", "\\u002F")):
                return ""
            return slash
        return slash + "__h" + slash + host

    text = URL_IN_TEXT_RE.sub(sub, text)
    if is_html:
        # Only our injected referrer policy may apply (see inject_boot).
        text = re.sub(r'<meta[^>]+name=["\']?referrer["\']?[^>]*>', "", text, flags=re.I)
        text = re.sub(r'\sreferrerpolicy=["\'][^"\']*["\']', "", text, flags=re.I)
    if is_html and page_host and page_host != ROOT_HOST:
        # Root-relative attribute URLs on a non-www page belong to that page's host.
        pre = "/__h/" + page_host
        text = re.sub(
            r'(\s(?:src|href|action)=["\'])/(?![/_])',
            lambda m: m.group(1) + pre + "/",
            text,
        )
    return text


# ---------------------------------------------------------------- streams the canvas player can play
# The canvas player decodes H.264 + AAC only. bilibili offers every quality also as HEVC and
# AV1 (and sometimes Dolby / FLAC audio) and may pick those (from remembered preferences),
# which leaves a picture-less page. Drop them from play info before bilibili sees it.
PLAYURL_RE = re.compile(r"/playurl", re.I)
PLAYINFO_RE = re.compile(r"(window\.__playinfo__\s*=\s*)(\{.*?\})(\s*</script>)", re.S)


def _is_avc(c) -> bool:
    return str(c or "").lower().startswith(("avc1", "avc3"))


def _keep_playable(d: dict) -> None:
    dash = d.get("dash")
    if isinstance(dash, dict):
        vids = dash.get("video")
        if isinstance(vids, list):
            avc = [v for v in vids if isinstance(v, dict) and (_is_avc(v.get("codecs")) or v.get("codecid") == 7)]
            if avc:
                dash["video"] = avc
        auds = dash.get("audio")
        if isinstance(auds, list):
            aac = [a for a in auds if isinstance(a, dict) and str(a.get("codecs", "")).lower().startswith("mp4a")]
            if aac:
                dash["audio"] = aac
        if isinstance(dash.get("dolby"), dict):
            dash["dolby"]["audio"] = None
            dash["dolby"]["type"] = 0
        if "flac" in dash:
            dash["flac"] = None
    for f in d.get("support_formats") or []:
        if isinstance(f, dict) and isinstance(f.get("codecs"), list):
            avc = [c for c in f["codecs"] if _is_avc(c)]
            if avc:
                f["codecs"] = avc
    if d.get("video_codecid") in (12, 13):
        d["video_codecid"] = 7


def keep_playable(node, depth: int = 0) -> None:
    """Apply _keep_playable to every object that carries a `dash` play list."""
    if depth > 6:
        return
    if isinstance(node, dict):
        if isinstance(node.get("dash"), dict):
            _keep_playable(node)
        for v in node.values():
            if isinstance(v, (dict, list)):
                keep_playable(v, depth + 1)
    elif isinstance(node, list):
        for v in node:
            keep_playable(v, depth + 1)


def filter_playinfo_html(html: str) -> str:
    def sub(m: re.Match) -> str:
        try:
            d = json.loads(m.group(2))
        except ValueError:
            return m.group(0)
        keep_playable(d)
        return m.group(1) + json.dumps(d, ensure_ascii=False, separators=(",", ":")) + m.group(3)
    return PLAYINFO_RE.sub(sub, html, count=1)


def inject_boot(html: str) -> str:
    cfg = json.dumps({"menu": MENU_URL} if MENU_URL else {}).replace("</", "<\\/")
    tag = (
        '<meta name="referrer" content="same-origin">'
        f'<script>window.__teslaHub={cfg};</script>'
        f'<script src="/__bili/boot.js?v={BOOT_VERSION}"></script>'
        f'<script src="/__bili/player.js?v={BOOT_VERSION}"></script>'
    )
    m = re.search(r"<head[^>]*>", html, re.I)
    if m:
        return html[: m.end()] + tag + html[m.end():]
    return tag + html


# ---------------------------------------------------------------- cookie jar
class CookieJar:
    """bilibili cookies, keyed by name only (bilibili sets nearly all on .bilibili.com, path /).

    HttpOnly cookies (SESSDATA) stay here; the rest are mirrored to the browser so page
    scripts can read them (bili_jct is the CSRF token, DedeUserID the user id, ...).
    """

    def __init__(self, path: Path):
        self.path = path
        self.items: dict[str, dict] = {}
        self._dirty = False
        try:
            self.items = json.loads(path.read_text())
        except FileNotFoundError:
            pass
        except Exception:
            log.exception("cookie jar unreadable, starting empty")

    def _expired(self, c: dict) -> bool:
        return c.get("expires") is not None and c["expires"] < time.time()

    def header_for(self, browser_cookies: dict[str, str]) -> str:
        out: dict[str, str] = {}
        for name, c in self.items.items():
            if not self._expired(c):
                out[name] = c["value"]
        for name, value in browser_cookies.items():
            if any(name.startswith(p) for p in LOCAL_COOKIES):
                continue      # the login proxy's cookies (prefix: oauth2-proxy splits them as _0, _1, _csrf)
            c = self.items.get(name)
            if c and c.get("httponly"):
                continue  # server copy wins for HttpOnly cookies
            out[name] = value
        return "; ".join(f"{k}={v}" for k, v in out.items())

    def update(self, set_cookie_headers: list[str]) -> list[str]:
        """Store upstream Set-Cookie headers; return Set-Cookie headers for the browser."""
        to_browser = []
        for raw in set_cookie_headers:
            parsed = parse_set_cookie(raw)
            if not parsed:
                continue
            name, value, attrs = parsed
            expires = attrs.get("expires")
            deleted = expires is not None and expires < time.time()
            httponly = attrs.get("httponly", False)
            if deleted:
                self.items.pop(name, None)
            else:
                self.items[name] = {"value": value, "expires": expires, "httponly": httponly}
            self._dirty = True
            if not httponly:
                parts = [f"{name}={value}", "Path=/", "Secure", "SameSite=Lax"]
                if expires is not None:
                    parts.append("Max-Age=%d" % max(0, int(expires - time.time())))
                to_browser.append("; ".join(parts))
        return to_browser

    def save(self) -> None:
        if not self._dirty:
            return
        self._dirty = False
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self.items, f)
        os.replace(tmp, self.path)


def parse_set_cookie(raw: str):
    from email.utils import parsedate_to_datetime

    pieces = raw.split(";")
    name, sep, value = pieces[0].strip().partition("=")
    if not sep or not name:
        return None
    attrs: dict = {}
    max_age = None
    for p in pieces[1:]:
        k, _, v = p.strip().partition("=")
        k = k.lower()
        if k == "expires":
            try:
                attrs["expires"] = parsedate_to_datetime(v.strip()).timestamp()
            except Exception:
                pass
        elif k == "max-age":
            try:
                max_age = int(v)
            except ValueError:
                pass
        elif k == "httponly":
            attrs["httponly"] = True
    if max_age is not None:
        attrs["expires"] = time.time() + max_age
    return name.strip(), value.strip(), attrs


# ---------------------------------------------------------------- proxy
def browser_cookies(request: web.Request) -> dict[str, str]:
    return {k: v for k, v in request.cookies.items()}


def decode_body(body: bytes, encoding: str) -> bytes | None:
    encoding = (encoding or "").lower().strip()
    if not encoding or encoding == "identity":
        return body
    if encoding == "gzip":
        return zlib.decompress(body, 16 + zlib.MAX_WBITS)
    if encoding == "deflate":
        try:
            return zlib.decompress(body)
        except zlib.error:
            return zlib.decompress(body, -zlib.MAX_WBITS)
    if encoding == "br" and brotli:
        return brotli.decompress(body)
    return None


async def proxy(request: web.Request) -> web.StreamResponse:
    app = request.app
    host, path, qs, resource = resolve(request.path, request.query_string)
    if not PROXY_HOST_RE.fullmatch(host):
        raise web.HTTPForbidden(text="host not allowed")
    target = f"https://{host}{path}" + ("?" + qs if qs else "")
    nav = is_navigation(request)
    if nav and resource:
        raise web.HTTPFound(page_form(target))
    if nav and host == ROOT_HOST and EN_PREFIX_RE.match(path):
        # English-site URLs left in the browser history: open the same page without /en.
        raise web.HTTPFound((path[3:] or "/") + ("?" + qs if qs else ""))

    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await proxy_ws(request, target)

    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in DROP_REQ_HEADERS and not k.lower().startswith(DROP_REQ_HEADER_PREFIXES)}
    headers["Accept-Encoding"] = "gzip, deflate, br" if brotli else "gzip, deflate"
    # The car browser reports English; bilibili would then serve its /en site and machine-
    # translate titles. Always ask for Chinese.
    headers["Accept-Language"] = UPSTREAM_LANG
    jar: CookieJar = app["jar"]
    cookie = jar.header_for(browser_cookies(request)) if COOKIE_HOST_RE.fullmatch(host) else ""
    if cookie:
        headers["Cookie"] = cookie
    # Origin / Referer: present the page the request came from as the real bilibili page.
    ref = request.headers.get("Referer")
    real_ref = proxy_to_real(ref) if ref else None
    if real_ref:
        headers["Referer"] = real_ref
    elif host.endswith(("bilivideo.com", "bilivideo.cn", "akamaized.net")):
        headers["Referer"] = "https://www.bilibili.com/"
    if request.headers.get("Origin"):
        src = urlsplit(real_ref) if real_ref else None
        headers["Origin"] = f"https://{src.hostname}" if src and src.hostname else "https://www.bilibili.com"

    body = await request.read() if request.body_exists else None
    session: aiohttp.ClientSession = app["session"]
    try:
        upstream = await session.request(
            request.method, target, headers=headers, data=body, allow_redirects=False,
        )
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        log.warning("upstream %s %s: %s", request.method, target, e)
        raise web.HTTPBadGateway(text="upstream error")

    async with upstream:
        to_browser_cookies = jar.update(upstream.headers.getall("Set-Cookie", []))
        out_headers = [
            (k, v) for k, v in upstream.headers.items() if k.lower() not in DROP_RESP_HEADERS
        ]
        loc = upstream.headers.get("Location")
        if loc:
            out_headers = [(k, v) for k, v in out_headers if k.lower() != "location"]
            real = urljoin(target, loc)
            # Non-navigation redirects stay in explicit resource form (page_host="" keeps www prefixed).
            out_headers.append(("Location", page_form(real) if nav else resource_form(real, "")))
        ctype = upstream.headers.get("Content-Type", "")
        is_text = any(t in ctype for t in TEXT_TYPES) and host != "s1.hdslb.com"

        if is_text and request.method != "HEAD":
            raw = await upstream.read()
            decoded = decode_body(raw, upstream.headers.get("Content-Encoding", ""))
            if decoded is not None:
                charset = upstream.charset or "utf-8"
                text = decoded.decode(charset, errors="replace")
                is_html = "text/html" in ctype
                text = rewrite_text(text, host if is_html else None, is_html)
                if is_html:
                    if "__playinfo__" in text:
                        text = filter_playinfo_html(text)
                    text = inject_boot(text)
                out_headers = [
                    (k, v) for k, v in out_headers
                    if k.lower() not in ("content-encoding", "etag", "last-modified", "cache-control")
                ]
                out_headers.append(("Cache-Control", "no-store, no-transform" if is_html else "private, no-transform, max-age=300"))
                resp = web.Response(status=upstream.status, body=text.encode(charset, errors="replace"))
                for k, v in out_headers:
                    resp.headers.add(k, v)
                for c in to_browser_cookies:
                    resp.headers.add("Set-Cookie", c)
                return resp

        if PLAYURL_RE.search(path) and "json" in ctype and request.method == "GET":
            raw = await upstream.read()
            decoded = decode_body(raw, upstream.headers.get("Content-Encoding", ""))
            body = None
            if decoded is not None:
                try:
                    d = json.loads(decoded)
                    keep_playable(d)
                    body = json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode()
                except ValueError:
                    body = None
            if body is None:
                body, keep_enc = raw, True
            else:
                keep_enc = False
            out_headers = [(k, v) for k, v in out_headers
                           if k.lower() not in ("etag", "last-modified") and (keep_enc or k.lower() != "content-encoding")]
            resp = web.Response(status=upstream.status, body=body)
            for k, v in out_headers:
                resp.headers.add(k, v)
            resp.headers["Cache-Control"] = "no-store, no-transform"
            for c in to_browser_cookies:
                resp.headers.add("Set-Cookie", c)
            return resp

        resp = web.StreamResponse(status=upstream.status)
        for k, v in out_headers:
            resp.headers.add(k, v)
        if upstream.headers.get("Content-Length") and not upstream.headers.get("Transfer-Encoding"):
            resp.content_length = int(upstream.headers["Content-Length"])
        resp.headers["Cache-Control"] = _no_transform(upstream.headers.get("Cache-Control"))
        for c in to_browser_cookies:
            resp.headers.add("Set-Cookie", c)
        try:
            await resp.prepare(request)
            async for chunk in upstream.content.iter_chunked(64 * 1024):
                await resp.write(chunk)
            await resp.write_eof()
        except (ConnectionResetError, aiohttp.ClientError, asyncio.CancelledError):
            pass  # the browser went away (navigation, seek, closed tab)
        return resp


def is_navigation(request: web.Request) -> bool:
    mode = request.headers.get("Sec-Fetch-Mode")
    if mode:
        return mode == "navigate"
    return request.method == "GET" and request.headers.get("Accept", "").startswith("text/html")


def _no_transform(cc: str | None) -> str:
    if not cc:
        return "no-transform"
    return cc if "no-transform" in cc else cc + ", no-transform"


async def proxy_ws(request: web.Request, target: str) -> web.StreamResponse:
    ws_target = "wss://" + target[len("https://"):]
    protocols = [p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if p.strip()]
    client = web.WebSocketResponse(protocols=protocols)
    await client.prepare(request)
    headers = {"User-Agent": request.headers.get("User-Agent", ""), "Origin": "https://www.bilibili.com"}
    try:
        async with request.app["session"].ws_connect(ws_target, headers=headers, heartbeat=30, protocols=protocols) as up:
            async def pump(src, dst):
                async for msg in src:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await dst.send_str(msg.data)
                    elif msg.type == aiohttp.WSMsgType.BINARY:
                        await dst.send_bytes(msg.data)
                    else:
                        break
            await asyncio.wait(
                [asyncio.create_task(pump(client, up)), asyncio.create_task(pump(up, client))],
                return_when=asyncio.FIRST_COMPLETED,
            )
    except Exception as e:
        log.info("ws %s: %s", ws_target, e)
    await client.close()
    return client


# ---------------------------------------------------------------- local endpoints
async def healthz(request: web.Request) -> web.Response:
    return web.Response(text="ok")


VIDEO_PATH_RE = re.compile(r"^(?:/[a-z]{2}(?:-[A-Za-z]{2,4})?)?/(?:video|bangumi/play|list|medialist|festival|cheese/play)/")
KEEP_QUERY = ("p", "bvid", "oid")


async def now_playing(request: web.Request) -> web.Response:
    """The canvas player reports the page it is playing and the position (menu: 继续观看)."""
    try:
        d = json.loads(await request.content.read(4096))
        url = urlsplit(str(d.get("url", "")))
        if not VIDEO_PATH_RE.match(url.path):
            return web.Response(status=204)
        q = "&".join(kv for kv in url.query.split("&") if kv.split("=", 1)[0] in KEEP_QUERY)
        cover = str(d.get("cover") or "")
        if cover.startswith("//"):
            cover = "https:" + cover
        if not re.match(r"^https?://[a-z0-9.-]+\.(?:hdslb\.com|biliimg\.com)/", cover, re.I):
            cover = ""
        dur = float(d.get("dur") or 0)
        last = {"path": url.path, "query": q, "t": max(0, int(float(d.get("t", 0)))),
                "dur": int(dur) if dur == dur and dur < 1e7 else 0,
                "title": re.sub(r"_哔哩哔哩.*$", "", str(d.get("title", "")))[:200],
                "cover": cover.replace("http://", "https://", 1), "at": int(time.time())}
        tmp = DATA_DIR / "last.json.tmp"
        tmp.write_text(json.dumps(last, ensure_ascii=False))
        os.replace(tmp, DATA_DIR / "last.json")
    except Exception as e:  # a bad report must never break playback
        log.info("now-playing: %s", e)
    return web.Response(status=204)


async def last_played(request: web.Request) -> web.Response:
    """The last video, for the menu's 继续观看 banner (the menu's site proxies /bili-last here)."""
    try:
        last = json.loads((DATA_DIR / "last.json").read_text())
    except Exception:
        return web.Response(status=204, headers={"Cache-Control": "no-store"})
    out = {k: last.get(k) for k in ("title", "t", "dur", "cover", "at")}
    return web.json_response(out, headers={"Cache-Control": "no-store"})


async def resume(request: web.Request) -> web.Response:
    """Open the last video at the last position, or the home page when there is none."""
    try:
        last = json.loads((DATA_DIR / "last.json").read_text())
    except Exception:
        raise web.HTTPFound("/")
    q = last.get("query") or ""
    t = int(last.get("t") or 0)
    if t > 5:
        q = (q + "&" if q else "") + f"t={t - 3}"
    raise web.HTTPFound(last["path"] + ("?" + q if q else ""), headers={"Cache-Control": "no-store"})


async def car_report(request: web.Request) -> web.Response:
    """Warnings and playback stats from the canvas player (the car has no console)."""
    now = time.monotonic()
    times = request.app["report_times"]
    while times and now - times[0] > 60:
        times.popleft()
    if len(times) >= REPORTS_PER_MINUTE:
        return web.Response(status=429)
    times.append(now)
    body = await request.content.read(32 * 1024)
    try:
        data = json.loads(body)
    except ValueError:
        return web.Response(status=400)
    # one JSON line (no raw text: a body with newlines must not forge log lines)
    log.info("car-report %s", json.dumps(data, ensure_ascii=False, separators=(",", ":"))[:16000])
    return web.Response(status=204)


@web.middleware
async def no_transform_static(request: web.Request, handler):
    resp = await handler(request)
    if request.path.startswith("/__bili/"):
        resp.headers["Cache-Control"] = "no-cache, no-transform"
    return resp


async def on_startup(app: web.Application):
    timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_read=60)
    app["session"] = aiohttp.ClientSession(
        timeout=timeout, auto_decompress=False, cookie_jar=aiohttp.DummyCookieJar(),
        connector=aiohttp.TCPConnector(limit=200, ttl_dns_cache=300),
    )

    async def saver():
        while True:
            await asyncio.sleep(5)
            app["jar"].save()

    app["saver"] = asyncio.create_task(saver())


async def on_cleanup(app: web.Application):
    app["jar"].save()
    app["saver"].cancel()
    await app["session"].close()


def make_app() -> web.Application:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    app = web.Application(middlewares=[no_transform_static], client_max_size=16 * 1024 * 1024)
    app["jar"] = CookieJar(DATA_DIR / "cookies.json")
    app["report_times"] = collections.deque()
    app.router.add_get("/__bili/healthz", healthz)
    app.router.add_post("/__bili/report", car_report)
    app.router.add_post("/__bili/now", now_playing)
    app.router.add_get("/__bili/resume", resume)
    app.router.add_get("/__bili/last", last_played)
    app.router.add_static("/__bili/", STATIC_DIR, show_index=False)
    app.router.add_route("*", "/{tail:.*}", proxy)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    web.run_app(make_app(), host=LISTEN_HOST, port=LISTEN_PORT, access_log=None)
