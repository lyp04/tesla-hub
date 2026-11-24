/* tesla-hub bilibili mirror: page bootstrap. Runs first in <head> of every proxied page.
 *
 * Page scripts are bilibili's own and still think they live on *.bilibili.com. This file
 * keeps their requests and navigations on this origin. URL forms (see app.py):
 *   resource form  /__h/<host>/<path>          APIs, streams, anything fetched by script
 *   page form      /<path>?...&__vh=<host>     pages of non-www hosts (search, space, t, ...)
 *   www pages      /<path>                     www.bilibili.com sits at the root
 * Static assets on *.hdslb.com are left alone (the CDN allows cross-origin use).
 */
(function () {
  "use strict";
  if (window.__biliProxy) return;

  var ROOT = "www.bilibili.com";
  var MAP_RE = /^(?:[a-z0-9-]+\.)*(?:bilibili\.com|biliapi\.net|biliapi\.com|bilivideo\.com|bilivideo\.cn)$|^upos-[a-z0-9-]+\.akamaized\.net$/i;
  var VH_RE = /(^|[?&])__vh=([^&#]*)/;

  function stripVh(search) {
    var q = search.replace(/^\?/, "").replace(/(^|&)__vh=[^&#]*/, "").replace(/^&/, "");
    return q ? "?" + q : "";
  }
  function hostOf(u) {
    // u: URL object on this origin -> real host it stands for
    var m = u.pathname.match(/^\/__h\/([^/]+)/);
    if (m) return m[1].toLowerCase();
    var v = u.search.match(VH_RE);
    return v ? decodeURIComponent(v[2]).toLowerCase() : ROOT;
  }
  // URL on this origin (either form) -> real bilibili URL
  function toReal(input) {
    var u;
    try { u = new URL(String(input), location.href); } catch (e) { return String(input); }
    if (u.origin !== location.origin) return u.href;
    var m = u.pathname.match(/^\/__h\/([^/]+)(\/.*)?$/);
    if (m) return "https://" + m[1] + (m[2] || "/") + u.search + u.hash;
    return "https://" + hostOf(u) + u.pathname + stripVh(u.search) + u.hash;
  }

  var PAGE_HOST = hostOf(location);
  function pageRealURL() { return toReal(location.href); }

  function sameOriginPrefix(u) {
    var proto = u.protocol === "wss:" || u.protocol === "ws:" ? (location.protocol === "https:" ? "wss:" : "ws:") : location.protocol;
    return proto + "//" + location.host;
  }
  // Resource form: what fetch/XHR/script src etc. should use. Non-bilibili URLs pass through.
  function toProxy(input) {
    if (input == null) return input;
    var s = String(input);
    if (!s || /^(data|blob|javascript|about|mailto|chrome-extension):/i.test(s)) return input;
    var u;
    try { u = new URL(s, pageRealURL()); } catch (e) { return input; }
    if (u.origin === location.origin) return u.href;              // already ours (e.g. /__bili/...)
    if (!MAP_RE.test(u.hostname)) return input;
    var host = u.hostname.toLowerCase();
    var pre = host === ROOT && PAGE_HOST === ROOT ? "" : "/__h/" + host;
    return sameOriginPrefix(u) + pre + u.pathname + u.search + u.hash;
  }
  // Page form: where a navigation to a bilibili page should go.
  function toPage(input) {
    var real;
    try { real = new URL(toReal(new URL(String(input), pageRealURL()).href)); } catch (e) { return input; }
    if (real.origin === location.origin) return real.href;
    if (!MAP_RE.test(real.hostname)) return real.href;
    var host = real.hostname.toLowerCase();
    var q = real.search.replace(/^\?/, "");
    if (host !== ROOT) q = (q ? q + "&" : "") + "__vh=" + host;
    return location.origin + real.pathname + (q ? "?" + q : "") + real.hash;
  }

  window.__biliProxy = { toProxy: toProxy, toPage: toPage, toReal: toReal, pageHost: PAGE_HOST, pageRealURL: pageRealURL };

  // ---- Chinese UI: the car browser reports English, and bilibili would switch to its /en site.
  try {
    Object.defineProperty(Navigator.prototype, "language", { configurable: true, get: function () { return "zh-CN"; } });
    Object.defineProperty(Navigator.prototype, "languages", { configurable: true, get: function () { return ["zh-CN", "zh"]; } });
  } catch (e) {}

  // ---- narrow windows: the car shows the browser in about half the screen (~800 px), while
  // bilibili's desktop layout needs 1100 px. Scale the whole page down to fit the width.
  // No scaling while the video player fills the window (web fullscreen / fullscreen): it fits
  // anyway, and bilibili's control bar mixes scaled box sizes with unscaled margins, decides
  // the buttons do not fit and hides quality, speed and fullscreen.
  var MIN_WIDTH = 1100;
  var PLAYER_FILLS = '.bpx-player-container[data-screen="web"], .bpx-player-container[data-screen="full"]';
  var curZoom = 1;
  function fitWidth() {
    var w = window.innerWidth;
    var z = w > 0 && w < MIN_WIDTH && !document.querySelector(PLAYER_FILLS) ? Math.floor(w / MIN_WIDTH * 1000) / 1000 : 1;
    curZoom = z;
    var v = z === 1 ? "" : String(z);
    if (document.documentElement.style.zoom !== v) document.documentElement.style.zoom = v;
    var tab = document.getElementById("tesla-home-tab");
    if (tab) tab.style.zoom = z === 1 ? "" : String(Math.round(1000 / z) / 1000);   // same size at any page scale
  }
  fitWidth();
  window.addEventListener("resize", fitWidth);
  new MutationObserver(fitWidth).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-screen"] });

  // bilibili's control bar decides which buttons fit from getBoundingClientRect (scaled by the
  // zoom) plus margins / paddings / borders from getComputedStyle (unscaled). Mixed units make
  // it think nothing fits, and it hides quality, speed, wide mode and fullscreen. Inside the
  // control bar, report those lengths scaled as well.
  var _gcs = window.getComputedStyle;
  var BOX_PROP = /^(margin|padding|border)(Left|Right|Top|Bottom)(Width)?$/;
  // (computed styles are live objects: one wrapper per control-bar element and zoom is enough)
  var gcsCache = new WeakMap();
  window.getComputedStyle = function (el, pseudo) {
    if (curZoom === 1 || pseudo || !el || !el.closest) return _gcs.apply(window, arguments);
    var hit = gcsCache.get(el);
    if (hit && hit.z === curZoom) return hit.p;
    var cs = _gcs.call(window, el);
    if (!el.closest(".bpx-player-control-wrap")) return cs;     // not cached: it may be moved into the bar later
    var z = curZoom;
    var p = new Proxy(cs, {
      get: function (t, k) {
        var v = t[k];
        if (typeof v === "function") return v.bind(t);
        if (typeof v === "string" && typeof k === "string" && v.charCodeAt(v.length - 1) === 120 && BOX_PROP.test(k)) return parseFloat(v) * z + "px";
        return v;
      },
    });
    gcsCache.set(el, { z: z, p: p });
    return p;
  };

  // Navigations this file starts are already in page form; the navigate handler below must not
  // rewrite them again (a www page at the root looks like a bare path of a non-www page).
  var selfNav = null;
  function go(href) { selfNav = href; location.assign(href); }

  // ---- fetch / XHR / beacon / WebSocket / EventSource / Worker
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      try {
        if (input instanceof Request) {
          var mapped = toProxy(input.url);
          // Referer only ever goes to this origin: the hdslb CDN answers 403 to a foreign Referer.
          input = new Request(mapped, input);
          input = new Request(input, { referrerPolicy: "same-origin" });
        } else {
          input = toProxy(input instanceof URL ? input.href : input);
          init = Object.assign({}, init || {}, { referrerPolicy: "same-origin" });
        }
      } catch (e) { /* fall through with the original input */ }
      return _fetch.call(this, input, init);
    };
  }
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = toProxy(url);
    return _open.apply(this, args);
  };
  if (navigator.sendBeacon) {
    var _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return _beacon(toProxy(url), data); };
  }
  ["WebSocket", "EventSource", "Worker", "SharedWorker"].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function (url, opt) { return opt === undefined ? new Orig(toProxy(url)) : new Orig(toProxy(url), opt); };
    Wrapped.prototype = Orig.prototype;
    Object.keys(Orig).forEach(function (k) { try { Wrapped[k] = Orig[k]; } catch (e) {} });
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) { if (k in Orig) Wrapped[k] = Orig[k]; });
    window[name] = Wrapped;
  });

  // ---- element URL attributes (script/link/iframe/a/form/img/source)
  function patchProp(Ctor, prop) {
    if (!Ctor) return;
    var d = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(Ctor.prototype, prop, {
      configurable: true, enumerable: d.enumerable,
      get: d.get,
      set: function (v) { d.set.call(this, toProxy(v)); },
    });
  }
  patchProp(window.HTMLScriptElement, "src");
  patchProp(window.HTMLLinkElement, "href");
  patchProp(window.HTMLIFrameElement, "src");
  patchProp(window.HTMLAnchorElement, "href");
  patchProp(window.HTMLFormElement, "action");
  patchProp(window.HTMLImageElement, "src");
  patchProp(window.HTMLSourceElement, "src");
  var URL_ATTRS = { src: 1, href: 1, action: 1 };
  var _setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    if (URL_ATTRS[n] && typeof value === "string") value = toProxy(value);
    if (n === "referrerpolicy") value = "same-origin";
    return _setAttr.call(this, name, value);
  };
  [window.HTMLImageElement, window.HTMLScriptElement, window.HTMLLinkElement, window.HTMLIFrameElement, window.HTMLAnchorElement].forEach(function (C) {
    if (!C) return;
    var d = Object.getOwnPropertyDescriptor(C.prototype, "referrerPolicy");
    if (d && d.set) Object.defineProperty(C.prototype, "referrerPolicy", { configurable: true, get: d.get, set: function () { d.set.call(this, "same-origin"); } });
  });

  // ---- document.cookie: bilibili scripts set domain=.bilibili.com, which this origin would reject.
  var cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (cookieDesc && cookieDesc.set) {
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: function () { return cookieDesc.get.call(this); },
      set: function (v) {
        v = String(v).replace(/;\s*domain=[^;]*/ig, "");
        if (!/;\s*path=/i.test(v)) v += "; path=/";
        return cookieDesc.set.call(this, v);
      },
    });
  }

  // ---- navigation: stay on this origin, in this tab
  var _wopen = window.open;
  window.open = function (url, target, features) {
    if (url == null || url === "") return _wopen.apply(window, arguments);
    var dest;
    try { dest = new URL(toPage(url)); } catch (e) { return _wopen.apply(window, arguments); }
    if (dest.origin === location.origin) { go(dest.href); return window; }
    return _wopen.call(window, url, target, features);
  };
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function (state, title, url) {
      // SPA routers push real paths; keep the page's host marker (and map absolute bilibili URLs).
      if (url != null && url !== "") url = toPage(url);
      return orig.call(history, state, title, url);
    };
  });
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var raw = a.getAttribute("href");
    if (!raw || raw.charAt(0) === "#" || /^javascript:/i.test(raw)) return;
    if (a.target && a.target !== "_self") {
      // Same tab: a car browser with a pile of tabs is no fun.
      var dest;
      try { dest = new URL(toPage(a.href)); } catch (err) { return; }
      if (dest.origin !== location.origin) return;
      e.preventDefault();
      go(dest.href);
    }
  }, true);
  if (window.navigation && navigation.addEventListener) {
    navigation.addEventListener("navigate", function (e) {
      if (!e.cancelable || e.hashChange || e.destination.sameDocument) return;
      if (selfNav && e.destination.url === selfNav) { selfNav = null; return; }
      try {
        var dest = new URL(e.destination.url);
        var fixed = null;
        if (dest.origin !== location.origin && MAP_RE.test(dest.hostname)) {
          fixed = toPage(dest.href);
        } else if (dest.origin === location.origin && PAGE_HOST !== ROOT &&
                   !/^\/__(h|bili)\//.test(dest.pathname) && !VH_RE.test(dest.search)) {
          // A bare path from a non-www page means a path on that page's host.
          fixed = toPage("https://" + PAGE_HOST + dest.pathname + dest.search + dest.hash);
        }
        if (fixed && fixed !== dest.href) {
          e.preventDefault();
          go(fixed);
        }
      } catch (err) {}
    });
  }

  // ---- car: a tab on the left edge back to the menu (MENU_URL, set by the proxy)
  // Left edge, middle: the bottom-left corner is the play button in web fullscreen, bilibili
  // keeps its own floating buttons bottom right, and the logo / title sit top left.
  var HOME_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:26px;height:26px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">' +
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  function addHomeTab() {
    var menu = window.__teslaHub && window.__teslaHub.menu;
    if (!menu || !document.body || document.getElementById("tesla-home-tab")) return;
    var a = document.createElement("a");
    a.id = "tesla-home-tab";
    a.href = menu;
    a.setAttribute("aria-label", "返回车机菜单");
    a.title = "车机菜单";
    a.innerHTML = HOME_ICON;
    a.style.cssText = "position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:2147483000;" +
      "width:48px;height:64px;display:flex;align-items:center;justify-content:center;" +
      "border-radius:0 18px 18px 0;background:rgba(20,22,28,.55);border:1px solid rgba(255,255,255,.14);border-left:0;" +
      "-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 6px 18px rgba(0,0,0,.28);" +
      "text-decoration:none;-webkit-tap-highlight-color:transparent;";
    document.body.appendChild(a);
    fitWidth();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addHomeTab); else addHomeTab();
  setInterval(addHomeTab, 2000);                                     // in case a page rebuilds <body>

  // ---- no service workers on the mirror
  if (navigator.serviceWorker && navigator.serviceWorker.register) {
    navigator.serviceWorker.register = function () { return Promise.reject(new Error("disabled on mirror")); };
  }
})();
