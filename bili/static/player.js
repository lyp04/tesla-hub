/* tesla-hub bilibili mirror: canvas player.
 *
 * bilibili's own player stays in charge: it picks streams, fetches segments and draws the
 * control bar and danmaku. Only the media pipeline underneath is swapped out:
 *
 *   - MediaSource / SourceBuffer are replaced by JS objects that keep the appended fMP4
 *     samples (FakeMediaSource / FakeSourceBuffer);
 *   - a <video> element whose src is such a MediaSource is driven by an Engine instead of
 *     the browser: it decodes the video with WebCodecs and draws it onto a <canvas> laid
 *     over the element, and answers the element's properties (currentTime, paused,
 *     buffered, ...) and fires its events itself;
 *   - the audio goes, untouched, into a real MediaSource behind a hidden <audio> element,
 *     whose clock the picture follows (localStorage["bili-audio"] = "webaudio" decodes it
 *     into Web Audio instead).
 *
 * The Tesla browser refuses <video> playback outside Park; a canvas and Web Audio are not
 * covered by that lock. Do not watch while driving.
 *
 * Disable for one page with ?native=1, or for this browser with
 * localStorage["bili-native"] = "1". localStorage["bili-debug"] = "1" logs to the console.
 */
(function () {
  "use strict";

  var VIDEO_PAGE = /^(?:\/[a-z]{2}(?:-[A-Za-z]{2,4})?)?\/(?:video|bangumi\/play|list|medialist|festival|cheese\/play)\//;
  function store(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  if (!VIDEO_PAGE.test(location.pathname)) return;
  if (/[?&]native=1(&|$)/.test(location.search) || store("bili-native") === "1") return;
  if (typeof VideoDecoder !== "function" || typeof AudioDecoder !== "function" ||
      typeof EncodedVideoChunk !== "function" || typeof (window.AudioContext || window.webkitAudioContext) !== "function") return;

  var DEBUG = store("bili-debug") === "1";
  // Sound through a native <audio> fed by a real MediaSource (default), or decoded by us into
  // Web Audio ("webaudio": the earlier path, kept as a fallback).
  var RealMediaSource = window.MediaSource;
  var NATIVE_AUDIO = store("bili-audio") !== "webaudio" && typeof RealMediaSource === "function";
  function log() { if (DEBUG) console.log.apply(console, ["[canvas-player]"].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ["[canvas-player]"].concat([].slice.call(arguments))); }

  // ------------------------------------------------------------------ codec capability answers
  // bilibili picks its streams with navigator.mediaCapabilities.decodingInfo. The car's
  // browser can decode HEVC / AV1 in hardware and says so; this player only takes H.264 +
  // AAC, so a "yes" there left the first video of a session with sound only (no video
  // SourceBuffer could be created). Answer for what this player plays.
  if (window.MediaCapabilities && MediaCapabilities.prototype.decodingInfo) {
    var origDecodingInfo = MediaCapabilities.prototype.decodingInfo;
    MediaCapabilities.prototype.decodingInfo = function (cfg) {
      try {
        var vt = cfg && cfg.video && cfg.video.contentType, at = cfg && cfg.audio && cfg.audio.contentType;
        if ((vt && !typeSupported(vt)) || (at && !typeSupported(at))) {
          return Promise.resolve({ supported: false, smooth: false, powerEfficient: false, configuration: cfg });
        }
      } catch (e) {}
      return origDecodingInfo.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------------ bytes & boxes
  function u16(d, o) { return (d[o] << 8) | d[o + 1]; }
  function u24(d, o) { return (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]; }
  function u32(d, o) { return ((d[o] << 24) >>> 0) + ((d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]); }
  function i32(d, o) { return (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]; }
  function u64(d, o) { return u32(d, o) * 4294967296 + u32(d, o + 4); }
  function fourcc(d, o) { return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]); }
  function hex2(n) { return (n < 16 ? "0" : "") + n.toString(16); }
  function concat(a, b) { var c = new Uint8Array(a.length + b.length); c.set(a, 0); c.set(b, a.length); return c; }
  function copyBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }

  // Walk the boxes in d[s, e). fn(type, boxStart, payloadStart, boxEnd); returning false stops.
  // Returns the offset of the first incomplete box (== e when everything was complete).
  function boxes(d, s, e, fn) {
    var o = s;
    while (o + 8 <= e) {
      var size = u32(d, o), hs = 8;
      if (size === 1) { if (o + 16 > e) return o; size = u64(d, o + 8); hs = 16; }
      else if (size === 0) size = e - o;
      if (size < hs || o + size > e) return o;
      if (fn(fourcc(d, o + 4), o, o + hs, o + size) === false) return o + size;
      o += size;
    }
    return o;
  }

  var AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function parseMoov(d, s, e) {
    var tracks = [], trex = {};
    boxes(d, s, e, function (t, b, p, end) {
      if (t === "trak") tracks.push(parseTrak(d, p, end));
      else if (t === "mvex") boxes(d, p, end, function (t2, b2, p2) {
        if (t2 === "trex") trex[u32(d, p2 + 4)] = { dur: u32(d, p2 + 12), size: u32(d, p2 + 16), flags: u32(d, p2 + 20) };
      });
    });
    tracks.forEach(function (tr) { tr.trex = trex[tr.id] || { dur: 0, size: 0, flags: 0 }; });
    return tracks;
  }

  function parseTrak(d, s, e) {
    var tr = { id: 0, timescale: 1000, kind: "", codec: "", description: null };
    boxes(d, s, e, function (t, b, p, end) {
      if (t === "tkhd") tr.id = u32(d, p + (d[p] === 1 ? 20 : 12));
      else if (t === "mdia") boxes(d, p, end, function (t2, b2, p2, end2) {
        if (t2 === "mdhd") tr.timescale = u32(d, p2 + (d[p2] === 1 ? 20 : 12));
        else if (t2 === "hdlr") { var h = fourcc(d, p2 + 8); tr.kind = h === "vide" ? "video" : h === "soun" ? "audio" : h; }
        else if (t2 === "minf") boxes(d, p2, end2, function (t3, b3, p3, end3) {
          if (t3 === "stbl") boxes(d, p3, end3, function (t4, b4, p4, end4) {
            if (t4 === "stsd") parseStsd(d, p4 + 8, end4, tr);
          });
        });
      });
    });
    return tr;
  }

  function parseStsd(d, s, e, tr) {
    boxes(d, s, e, function (t, b, p, end) {
      tr.entry = t;
      if (t === "avc1" || t === "avc3") {
        tr.width = u16(d, p + 24); tr.height = u16(d, p + 26);
        boxes(d, p + 78, end, function (t2, b2, p2, end2) {
          if (t2 === "avcC") {
            var c = d.slice(p2, end2);
            tr.codec = "avc1." + hex2(c[1]) + hex2(c[2]) + hex2(c[3]);
            tr.description = c;
          }
        });
      } else if (t === "mp4a") {
        tr.channels = u16(d, p + 16); tr.sampleRate = u32(d, p + 24) >>> 16;
        boxes(d, p + 28, end, function (t2, b2, p2, end2) {
          if (t2 === "esds") {
            var asc = parseEsds(d, p2 + 4, end2);
            if (asc && asc.length >= 2) {
              tr.description = asc;
              tr.codec = "mp4a.40." + (asc[0] >> 3);
              var idx = ((asc[0] & 7) << 1) | (asc[1] >> 7), ch = (asc[1] >> 3) & 15;
              if (AAC_RATES[idx]) tr.sampleRate = AAC_RATES[idx];
              if (ch) tr.channels = ch;
            }
          }
        });
      } else {
        tr.codec = t; // hvc1 / av01 / ec-3 / encv ...: not decodable here
      }
      return false;
    });
  }

  function parseEsds(d, s, e) {
    var o = s;
    function len() { var n = 0, c, i = 0; do { c = d[o++]; n = (n << 7) | (c & 0x7f); } while ((c & 0x80) && ++i < 4); return n; }
    while (o < e) {
      var tag = d[o++], n = len(), next = o + n;
      if (tag === 3) { o += 2; var f = d[o++]; if (f & 0x80) o += 2; if (f & 0x40) o += 1 + d[o]; if (f & 0x20) o += 2; continue; }
      if (tag === 4) { o += 13; continue; }
      if (tag === 5) return d.slice(o, o + n);
      o = next;
    }
    return null;
  }

  function parseMoof(d, b, s, e) {
    var out = [];
    boxes(d, s, e, function (t, b2, p, end) {
      if (t !== "traf") return;
      var tf = { id: 0, dur: null, size: null, flags: null, bmdt: 0, runs: [] };
      boxes(d, p, end, function (t3, b3, p3) {
        if (t3 === "tfhd") {
          var fl = u24(d, p3 + 1), o = p3 + 4;
          tf.id = u32(d, o); o += 4;
          if (fl & 1) o += 8;            // base_data_offset: MSE segments use moof-relative offsets
          if (fl & 2) o += 4;
          if (fl & 8) { tf.dur = u32(d, o); o += 4; }
          if (fl & 0x10) { tf.size = u32(d, o); o += 4; }
          if (fl & 0x20) { tf.flags = u32(d, o); o += 4; }
        } else if (t3 === "tfdt") {
          tf.bmdt = d[p3] === 1 ? u64(d, p3 + 4) : u32(d, p3 + 4);
        } else if (t3 === "trun") {
          var fl2 = u24(d, p3 + 1), n = u32(d, p3 + 4), o2 = p3 + 8, run = { off: null, first: null, s: [] };
          if (fl2 & 1) { run.off = i32(d, o2); o2 += 4; }
          if (fl2 & 4) { run.first = u32(d, o2); o2 += 4; }
          for (var i = 0; i < n; i++) {
            var smp = {};
            if (fl2 & 0x100) { smp.dur = u32(d, o2); o2 += 4; }
            if (fl2 & 0x200) { smp.size = u32(d, o2); o2 += 4; }
            if (fl2 & 0x400) { smp.flags = u32(d, o2); o2 += 4; }
            if (fl2 & 0x800) { smp.cto = i32(d, o2); o2 += 4; }
            run.s.push(smp);
          }
          tf.runs.push(run);
        }
      });
      out.push(tf);
    });
    return out;
  }

  // ------------------------------------------------------------------ TimeRanges
  function Ranges(list) { this._r = list || []; }
  Object.defineProperty(Ranges.prototype, "length", { get: function () { return this._r.length; } });
  Ranges.prototype.start = function (i) { if (i < 0 || i >= this._r.length) throw new DOMException("index", "IndexSizeError"); return this._r[i][0]; };
  Ranges.prototype.end = function (i) { if (i < 0 || i >= this._r.length) throw new DOMException("index", "IndexSizeError"); return this._r[i][1]; };
  function intersect(a, b) {
    var out = [], i = 0, j = 0;
    while (i < a.length && j < b.length) {
      var s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
      if (s < e) out.push([s, e]);
      if (a[i][1] < b[j][1]) i++; else j++;
    }
    return out;
  }

  // ------------------------------------------------------------------ events helper
  function fireOn(target, name) {
    var ev = new Event(name);
    target.dispatchEvent(ev);
    var h = target["on" + name];
    if (typeof h === "function") { try { h.call(target, ev); } catch (e) { warn(e); } }
  }

  // ------------------------------------------------------------------ codec support
  function typeSupported(t) {
    t = String(t || "").toLowerCase();
    if (!/^(video|audio)\/mp4/.test(t)) return false;
    var m = t.match(/codecs\s*=\s*"?([^";]*)/);
    if (!m) return true;
    return m[1].split(",").every(function (c) {
      c = c.trim();
      return /^avc[13]\./.test(c) || /^mp4a\.40\./.test(c) || c === "mp4a";
    });
  }

  // ------------------------------------------------------------------ native audio mirror
  // Everything bilibili appends to its audio SourceBuffer is passed on, in order, to a real
  // SourceBuffer behind a hidden <audio>: the browser decodes and plays the sound itself
  // (no seams between decoded chunks, pitch kept at other speeds, media keys and the
  // steering wheel reach it). Only the picture goes through the canvas.
  class AudioMirror {
    constructor() {
      var self = this;
      this.el = document.createElement("audio");
      this.el.preload = "auto";
      this.ms = new RealMediaSource(); this.sb = null; this.q = []; this.type = null; this.dead = false;
      this.ms.addEventListener("sourceopen", function () { self._open(); });
      this.el.src = createURL.call(URL, this.ms);
    }
    setType(type) { this.type = type; this._open(); }
    _open() {
      if (this.sb || this.dead || !this.type || this.ms.readyState !== "open") return;
      try {
        this.sb = this.ms.addSourceBuffer(this.type);
        var self = this;
        this.sb.addEventListener("updateend", function () { self._next(); });
        this._next();
      } catch (e) { this.dead = true; report("audio-mirror", { msg: String(e && e.message || e).slice(0, 160), type: this.type }); }
    }
    op(fn) { if (this.dead) return; this.q.push(fn); this._next(); }
    _next() {
      if (!this.sb || this.dead) return;
      while (this.q.length && !this.sb.updating) {
        var fn = this.q.shift();
        try { fn(this.sb, this.ms); } catch (e) { warn("audio mirror", e); report("audio-mirror-op", { msg: String(e && e.message || e).slice(0, 160) }); }
      }
    }
    append(bytes) { this.op(function (sb) { sb.appendBuffer(bytes); }); }
    remove(s, e) { this.op(function (sb, ms) { if (e > s && !isNaN(ms.duration)) sb.remove(s, Math.min(e, ms.duration)); }); }
    set(prop, v) { this.op(function (sb) { sb[prop] = v; }); }
    abort() { this.op(function (sb, ms) { if (ms.readyState === "open") sb.abort(); }); }
    changeType(t) { this.op(function (sb) { if (sb.changeType) sb.changeType(t); }); }
    duration(d) { if (isFinite(d)) this.op(function (sb, ms) { if (ms.readyState === "open") ms.duration = d; }); }
    end() { this.op(function (sb, ms) { if (ms.readyState === "open") ms.endOfStream(); }); }
    destroy() {
      this.dead = true; this.q = [];
      try { this.el.pause(); this.el.removeAttribute("src"); this.el.load(); } catch (e) {}
    }
  }

  // ------------------------------------------------------------------ SourceBuffer
  class FakeSourceBuffer extends EventTarget {
    constructor(ms, type) {
      super();
      this._ms = ms; this._type = type;
      this.kind = /^audio/i.test(type) ? "audio" : "video";
      this.updating = false; this.mode = "segments";
      this._tso = 0; this._aws = 0; this._awe = Infinity; this._mirror = null;
      this.samples = []; this.track = null; this.bytes = 0;
      this._pending = null; this._ranges = null;
      this.onupdatestart = this.onupdate = this.onupdateend = this.onerror = this.onabort = null;
    }
    get buffered() { return new Ranges(this.ranges()); }
    get timestampOffset() { return this._tso; }
    set timestampOffset(v) { this._tso = +v; if (this._mirror) this._mirror.set("timestampOffset", +v); }
    get appendWindowStart() { return this._aws; }
    set appendWindowStart(v) { this._aws = +v; if (this._mirror) this._mirror.set("appendWindowStart", +v); }
    get appendWindowEnd() { return this._awe; }
    set appendWindowEnd(v) { this._awe = +v; if (this._mirror) this._mirror.set("appendWindowEnd", +v); }
    _async(work) {
      if (this.updating) throw new DOMException("SourceBuffer is updating", "InvalidStateError");
      var ms = this._ms;
      if (ms.readyState === "ended") { ms.readyState = "open"; fireOn(ms, "sourceopen"); }
      this.updating = true; fireOn(this, "updatestart");
      var self = this;
      setTimeout(function () {
        var ok = true;
        try { work(); } catch (e) { ok = false; warn("append/remove failed", e); }
        self.updating = false; self._ranges = null;
        if (ok) fireOn(self, "update"); else fireOn(self, "error");
        fireOn(self, "updateend");
        ms._changed(self);
      }, 0);
    }
    appendBuffer(data) {
      var bytes = copyBytes(data), self = this;
      this._async(function () { self._append(bytes); });
      if (this._mirror) this._mirror.append(bytes);
    }
    remove(start, end) {
      var self = this;
      this._async(function () { self._remove(start, end); });
      if (this._mirror) this._mirror.remove(start, end);
    }
    abort() { this._pending = null; if (this._mirror) this._mirror.abort(); }
    changeType(type) { this._type = type; if (this._mirror) this._mirror.changeType(type); }

    _append(bytes) {
      var d = this._pending ? concat(this._pending, bytes) : bytes;
      this._pending = null;
      var self = this, added = [], moof = null;
      var stop = boxes(d, 0, d.length, function (t, b, p, end) {
        if (t === "moov") {
          var tr = parseMoov(d, p, end).filter(function (x) { return x.kind === self.kind; })[0] || parseMoov(d, p, end)[0];
          if (tr) { self.track = tr; log(self.kind, "init", tr.codec, tr.width || tr.sampleRate); }
        } else if (t === "moof") {
          moof = { b: b, trafs: parseMoof(d, b, p, end) };
        } else if (t === "mdat" && moof) {
          added = added.concat(self._samples(d, moof, p));
          moof = null;
        }
      });
      var keepFrom = moof ? moof.b : stop;
      if (keepFrom < d.length) this._pending = d.subarray(keepFrom);
      if (added.length) this._insert(added);
    }

    _samples(d, moof, mdatPayload) {
      var tr = this.track, out = [];
      if (!tr) return out;
      var ts = tr.timescale, def = tr.trex, off = this.timestampOffset;
      var ws = this.appendWindowStart, we = this.appendWindowEnd, kind = this.kind;
      moof.trafs.forEach(function (tf) {
        var dts = tf.bmdt, pos = mdatPayload;
        tf.runs.forEach(function (run) {
          if (run.off != null) pos = moof.b + run.off;
          run.s.forEach(function (sm, i) {
            var dur = sm.dur != null ? sm.dur : (tf.dur != null ? tf.dur : def.dur);
            var size = sm.size != null ? sm.size : (tf.size != null ? tf.size : def.size);
            var flags = i === 0 && run.first != null ? run.first : (sm.flags != null ? sm.flags : (tf.flags != null ? tf.flags : def.flags));
            var pts = (dts + (sm.cto || 0)) / ts + off;
            if (pts >= ws && pts < we && pos + size <= d.length) {
              out.push({
                dts: dts / ts + off, pts: pts, dur: dur / ts,
                key: kind === "audio" || !(flags & 0x10000),
                data: d.subarray(pos, pos + size), tr: tr,
              });
            }
            dts += dur; pos += size;
          });
        });
      });
      return out;
    }

    _insert(added) {
      var s = Infinity, e = -Infinity;
      added.forEach(function (x) { if (x.pts < s) s = x.pts; if (x.pts + x.dur > e) e = x.pts + x.dur; });
      this._remove(s, e);                       // new coded frames replace overlapping old ones
      var arr = this.samples, first = added[0].dts;
      var at = lowerBound(arr, first);
      Array.prototype.splice.apply(arr, [at, 0].concat(added));
      var b = 0; added.forEach(function (x) { b += x.data.length; });
      this.bytes += b;
    }

    _remove(start, end) {
      var arr = this.samples, kept = [], removing = false, b = 0;
      for (var i = 0; i < arr.length; i++) {
        var x = arr[i];
        if (x.pts >= start && x.pts < end) { removing = true; b += x.data.length; continue; }
        // frames that depend on removed ones go too, up to the next key frame
        if (removing && !x.key && x.pts >= end) { b += x.data.length; continue; }
        if (x.pts >= end) removing = false;
        kept.push(x);
      }
      this.samples = kept; this.bytes -= b; this._ranges = null;
    }

    // Buffered ranges by presentation time. Samples are kept in decode order and B-frame
    // reordering can put pts far ahead of dts, so sort the spans before merging.
    ranges() {
      if (this._ranges) return this._ranges;
      var spans = this.samples.map(function (x) { return [x.pts, x.pts + x.dur]; });
      spans.sort(function (a, b) { return a[0] - b[0]; });
      var out = [], cur = null;
      for (var i = 0; i < spans.length; i++) {
        var s = spans[i][0], e = spans[i][1];
        if (cur && s <= cur[1] + 0.15) { if (e > cur[1]) cur[1] = e; }
        else { cur = [s, e]; out.push(cur); }
      }
      return (this._ranges = out);
    }

    // index of the first sample with dts >= t
    indexFrom(t) { return lowerBound(this.samples, t); }

    // Key frame to start decoding from so that t can be shown: the last key frame at or
    // before t within the buffered range around t, or the range's first key frame when t
    // sits just before it (streams with B-frames often start a little after 0).
    // -1 when t is not buffered.
    keyIndexAt(t) {
      var arr = this.samples, r = this.ranges(), range = null;
      for (var k = 0; k < r.length; k++) if (t >= r[k][0] - 0.25 && t < r[k][1]) { range = r[k]; break; }
      if (!range || !arr.length) return -1;
      var i = Math.min(arr.length - 1, lowerBound(arr, t + 0.0005));
      for (; i >= 0; i--) {
        if (arr[i].pts < range[0] - 0.01) break;
        if (arr[i].key && arr[i].pts <= t + 0.0005) return i;
      }
      for (i = Math.max(0, i); i < arr.length; i++) if (arr[i].key && arr[i].pts >= range[0] - 0.01) return i;
      return -1;
    }
  }
  function lowerBound(arr, dts) {
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid].dts < dts) lo = mid + 1; else hi = mid; }
    return lo;
  }

  class FakeSourceBufferList extends EventTarget {
    constructor(arr) { super(); this._a = arr; this.onaddsourcebuffer = this.onremovesourcebuffer = null; }
    get length() { return this._a.length; }
    _sync() { for (var i = 0; i < 8; i++) { if (i < this._a.length) this[i] = this._a[i]; else delete this[i]; } }
  }

  // ------------------------------------------------------------------ MediaSource
  var fakeURLs = Object.create(null), urlSeq = 0;
  class FakeMediaSource extends EventTarget {
    constructor() {
      super();
      this._sbs = []; this.readyState = "closed"; this._duration = NaN; this._engine = null; this._mirror = null;
      this.sourceBuffers = new FakeSourceBufferList(this._sbs);
      this.activeSourceBuffers = this.sourceBuffers;
      this.onsourceopen = this.onsourceended = this.onsourceclose = null;
    }
    static isTypeSupported(t) { return typeSupported(t); }
    get duration() { return this._duration; }
    set duration(v) { this._duration = +v; if (this._mirror) this._mirror.duration(+v); if (this._engine) this._engine._fire("durationchange"); }
    addSourceBuffer(type) {
      if (this.readyState !== "open") throw new DOMException("MediaSource not open", "InvalidStateError");
      if (!typeSupported(type)) { report("sb-reject", { type: String(type).slice(0, 120) }); throw new DOMException("unsupported " + type, "NotSupportedError"); }
      var sb = new FakeSourceBuffer(this, type);
      if (sb.kind === "audio" && NATIVE_AUDIO && RealMediaSource.isTypeSupported(type)) {
        if (!this._mirror) { this._mirror = new AudioMirror(); this._mirror.duration(this._duration); }
        this._mirror.setType(type);
        sb._mirror = this._mirror;
      }
      this._sbs.push(sb); this.sourceBuffers._sync();
      fireOn(this.sourceBuffers, "addsourcebuffer");
      return sb;
    }
    removeSourceBuffer(sb) {
      var i = this._sbs.indexOf(sb);
      if (i >= 0) { this._sbs.splice(i, 1); this.sourceBuffers._sync(); fireOn(this.sourceBuffers, "removesourcebuffer"); }
    }
    endOfStream() { this.readyState = "ended"; if (this._mirror) this._mirror.end(); fireOn(this, "sourceended"); if (this._engine) this._engine._changed(); }
    setLiveSeekableRange() {}
    clearLiveSeekableRange() {}
    _changed() { if (this._engine) this._engine._changed(); }
    _sb(kind) { for (var i = 0; i < this._sbs.length; i++) if (this._sbs[i].kind === kind) return this._sbs[i]; return null; }
  }

  // ------------------------------------------------------------------ audio output (shared)
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null, gainNode = null, engines = [];
  // The context runs at the stream's sample rate when one is known: every decoded AAC frame
  // (~21 ms) is its own buffer source, and resampling each one separately leaves a click at
  // every seam — a constant buzz when the car's output rate differs from the stream's.
  var wantRate = 0;
  function newCtx(rate) {
    var opts = { latencyHint: "playback" };
    if (rate) opts.sampleRate = rate;
    try { return new AC(opts); } catch (e) { try { return new AC({ latencyHint: "playback" }); } catch (e2) { return new AC(); } }
  }
  function useCtx(ctx) {
    actx = ctx;
    gainNode = actx.createGain(); gainNode.connect(actx.destination);
    actx.addEventListener("statechange", function () {
      if (ctx !== actx) return;
      log("audio context", actx.state);
      engines.forEach(function (e) { e._audioStateChanged(); });
    });
  }
  function audioCtx(rate) {
    if (rate) wantRate = rate;
    if (!actx) useCtx(newCtx(rate));
    else if (rate && actx.sampleRate !== rate) {
      // Outside a user gesture the new context may not be allowed to start; then keep the
      // old (running) one and switch on the next tap.
      var n = newCtx(rate);
      if (n.state === "running" || actx.state !== "running") {
        try { actx.close(); } catch (e) {}
        useCtx(n);
      } else {
        try { n.close(); } catch (e) {}
      }
    }
    if (actx.state === "suspended") actx.resume().catch(function () {});
    return actx;
  }

  // ------------------------------------------------------------------ field reports
  // The car has no console: warnings and a periodic summary go to the proxy's log.
  var reportQ = [], reportTimer = 0;
  function report(kind, data) {
    reportQ.push(Object.assign({ k: kind, at: Math.round(performance.now()) }, data || {}));
    if (reportQ.length > 40) reportQ.shift();
    if (!reportTimer) reportTimer = setTimeout(flushReports, 2000);
  }
  function flushReports() {
    reportTimer = 0;
    if (!reportQ.length) return;
    var body = JSON.stringify({ page: location.pathname, w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio, items: reportQ.splice(0) });
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon("/__bili/report", new Blob([body], { type: "application/json" })))) {
        fetch("/__bili/report", { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(function () {});
      }
    } catch (e) {}
  }
  addEventListener("pagehide", flushReports);

  // What is playing and where (the menu's 继续观看 opens it again, e.g. after the car killed
  // the browser).
  function nowPlaying(t) {
    if (!(t > 0)) return;
    var e = engines[0], st = window.__INITIAL_STATE__, vd = st && st.videoData;
    var meta = document.querySelector('meta[property="og:image"], meta[itemprop="image"]');
    var cover = (vd && vd.pic) || (meta && meta.getAttribute("content")) || "";
    var body = JSON.stringify({ url: location.pathname + location.search, t: t, title: (vd && vd.title) || document.title,
                                dur: e ? e.duration() : 0, cover: cover });
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon("/__bili/now", new Blob([body], { type: "application/json" })))) {
        fetch("/__bili/now", { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(function () {});
      }
    } catch (e) {}
  }
  addEventListener("pagehide", function () { var e = engines[0]; if (e) nowPlaying(e.now()); });
  ["pointerdown", "touchstart", "keydown", "click"].forEach(function (t) {
    document.addEventListener(t, function () {
      if (!actx) return;
      if (wantRate && actx.sampleRate !== wantRate) {
        // stop the clocks while the old context still tells the time; _startClock switches
        var run = engines.filter(function (e) { return e.running; });
        run.forEach(function (e) { e._stopClock(); });
        audioCtx(wantRate);
        run.forEach(function (e) { e._startClock(); });
      } else if (actx.state !== "running") actx.resume().catch(function () {});
    }, true);
  });

  // ------------------------------------------------------------------ the engine behind one <video>
  var NATIVE = {};
  function nativeGet(el, name) {
    var d = NATIVE[name];
    return d && d.get ? d.get.call(el) : undefined;
  }

  class Engine {
    constructor(el, ms) {
      this.el = el; this.ms = ms; ms._engine = this;
      this.paused = true; this.seeking = false; this.ended = false; this.readyState = 0;
      this.rate = 1; this.defaultRate = 1;
      this.volume = nativeGet(el, "volume"); if (typeof this.volume !== "number") this.volume = 1;
      this.muted = !!nativeGet(el, "muted");
      this.t = 0; this.running = false; this.anchorMedia = 0; this.anchorWall = 0; this.anchorCtx = 0; this.audioMaster = false;
      this.waiting = false; this.loadedData = false; this.lastTU = 0; this.lastProgress = 0; this.seekTarget = null;
      this.frames = []; this.drawnTs = -1; this.decoded = 0; this.dropped = 0; this.vw = 0; this.vh = 0;
      this.vdec = null; this.vTrack = null; this.vFeed = 0; this.vGen = 0; this.vNeedKey = true; this.dropBefore = -1; this.vErrors = 0;
      this.adec = null; this.aTrack = null; this.aFeed = 0; this.aGen = 0; this.aQueued = 0; this.sources = [];
      this.aNext = 0; this.aLate = 0; this.vRetryAt = 0; this.lastDrawWall = 0; this.restarts = 0; this.lastStats = performance.now();
      this.aLateMax = 0; this.aShift = 0; this.waits = 0; this.draws = 0; this.firstCheck = false; this.maxGap = 0; this.lastLoop = 0;
      this.native = null; this.expectPlay = 0; this.expectPause = 0; this._msDone = false; this.lastNow = 0;
      this.created = performance.now(); this.lastOutWall = 0; this.lagMax = 0; this.lagSum = 0; this.lagN = 0;
      this.ro = null; this.lastMeasure = 0; this.cssW = 0; this.cssH = 0;
      this.preferSW = store("bili-decoder") === "software"; this.silentStalls = 0; this.decodedAtRestart = 0;
      this.canvas = null; this.cx = null; this.box = "";
      this.destroyed = false;
      engines.push(this);
      audioCtx();
      this._loop = this._loop.bind(this);
      this.raf = requestAnimationFrame(this._loop);
      this._fire("loadstart");
      setTimeout(function () { ms.readyState = "open"; fireOn(ms, "sourceopen"); }, 0);
    }

    _fire(name) {
      if (this.destroyed) return;
      if (DEBUG && name !== "timeupdate" && name !== "progress") log("event", name, "t=" + this.now().toFixed(2));
      this.el.dispatchEvent(new Event(name));
    }

    // ---- clock
    now() {
      if (!this.running) return this.t;
      if (this.native) return this.native.currentTime;                  // the <audio> is the clock
      var t = this.audioMaster
        ? this.anchorMedia + Math.max(0, actx.currentTime - this.anchorCtx) * this.rate
        : this.anchorMedia + (performance.now() - this.anchorWall) / 1000 * this.rate;
      return t;
    }
    _audioEl() { var m = this.ms._mirror; return m && !m.dead && m.sb ? m.el : null; }
    _startClock() {
      this.anchorMedia = this.t; this.anchorWall = performance.now();
      var a = this._audioEl();
      if (a) { this._startNative(a); return; }
      this.native = null;
      var asb = this.ms._sb("audio");
      if (asb && asb.track && asb.track.sampleRate) audioCtx(asb.track.sampleRate);
      this.audioMaster = !!(this.ms._sb("audio") && actx && actx.state === "running");
      if (this.audioMaster) this.anchorCtx = actx.currentTime + 0.25;    // headroom for the first decodes on a slow car CPU
      this.running = true;
      this._restartAudio();
    }
    _startNative(a) {
      var self = this;
      this.native = a; this.audioMaster = false; this._stopAudio();
      if (!a.__engineHooked) this._hookNative(a);
      if (Math.abs(a.currentTime - this.t) > 0.05) a.currentTime = this.t;
      a.playbackRate = this.rate; a.volume = this.volume; a.muted = this.muted;
      this.running = true;
      if (a.paused) {
        this.expectPlay++;
        var p = a.play();
        if (p && p.catch) p.catch(function (e) {
          self.expectPlay = Math.max(0, self.expectPlay - 1);
          report("audio-play", { msg: String(e && (e.name + ": " + e.message) || e).slice(0, 160) });
          if (e && e.name === "NotAllowedError") self.pause();             // like a real element: stays paused
        });
      }
      this._mediaSession();
    }
    // Pause / play from outside (steering wheel, media keys, the OS): tell bilibili's player.
    _hookNative(a) {
      var self = this;
      a.__engineHooked = true;
      a.addEventListener("pause", function () {
        if (self.native !== a || self.destroyed) return;
        if (self.expectPause > 0) { self.expectPause--; return; }
        if (!self.paused && !a.ended) { report("ext-pause", { t: +a.currentTime.toFixed(2) }); self.pause(); }
      });
      a.addEventListener("play", function () {
        if (self.native !== a || self.destroyed) return;
        if (self.expectPlay > 0) { self.expectPlay--; return; }
        if (self.paused) { report("ext-play", { t: +a.currentTime.toFixed(2) }); self.play(); }
      });
      a.addEventListener("error", function () {
        report("audio-error", { code: a.error && a.error.code, msg: a.error && String(a.error.message).slice(0, 160) });
      });
    }
    _mediaSession() {
      var ms = navigator.mediaSession, self = this;
      if (!ms || this._msDone) return;
      this._msDone = true;
      try {
        ms.metadata = new MediaMetadata({ title: document.title.replace(/_哔哩哔哩.*$/, ""), artist: "哔哩哔哩" });
        var click = function (sel) { return function () { var b = document.querySelector(sel); if (b) b.click(); }; };
        var acts = {
          play: function () { self.el.play(); },
          pause: function () { self.el.pause(); },
          seekbackward: function () { self.seek(self.now() - 10); },
          seekforward: function () { self.seek(self.now() + 10); },
          previoustrack: click(".bpx-player-ctrl-prev"),
          nexttrack: click(".bpx-player-ctrl-next"),
        };
        Object.keys(acts).forEach(function (k) { try { ms.setActionHandler(k, acts[k]); } catch (e) {} });
      } catch (e) {}
    }
    _stopClock() {
      this.t = this.now(); this.running = false;
      if (this.native) {
        if (!this.native.paused) { this.expectPause++; this.native.pause(); }
      } else this._stopAudio();
    }
    _reclock() { if (this.running) { this._stopClock(); this._startClock(); } }
    _audioStateChanged() { if (!this.native && this.running && !!(actx.state === "running") !== this.audioMaster) this._reclock(); }

    // ---- public API used by the element hooks
    play() {
      log("play() paused=" + this.paused + " rs=" + this.readyState + " seeking=" + this.seeking);
      audioCtx();
      if (this.ended) this.seek(0);
      if (this.paused) {
        this.paused = false; this._fire("play");
        if (this.readyState >= 3 && !this.seeking) { this._fire("playing"); this._startClock(); }
        else { this.waiting = true; this._fire("waiting"); }
      }
      return Promise.resolve();
    }
    pause() {
      log("pause() paused=" + this.paused + " t=" + this.now().toFixed(2));
      if (this.paused) return;
      this.paused = true; this.waiting = false;
      if (this.running) this._stopClock();
      nowPlaying(this.t);
      this._fire("timeupdate"); this._fire("pause");
    }
    seek(target) {
      log("seek(" + target + ")");
      target = +target; if (!isFinite(target)) return;
      var dur = this.ms.duration;
      if (isFinite(dur)) target = Math.min(target, dur);
      target = Math.max(0, target);
      if (this.running) this._stopClock();
      this.t = target; this.seeking = true; this.seekTarget = target; this.ended = false;
      this._fire("seeking");
      this._restartVideo(target);
      this._stopAudio();
      this._changed();
    }
    setRate(v) {
      v = +v; if (!(v > 0) || v === this.rate) return; this.rate = v;
      if (this.native) this.native.playbackRate = v; else this._reclock();
      this._fire("ratechange");
    }
    setVolume(v) { this.volume = Math.max(0, Math.min(1, +v)); this._applyGain(); this._fire("volumechange"); }
    setMuted(v) { this.muted = !!v; this._applyGain(); this._fire("volumechange"); }
    _applyGain() {
      if (gainNode) gainNode.gain.value = this.muted ? 0 : this.volume;
      var a = this._audioEl(); if (a) { a.volume = this.volume; a.muted = this.muted; }
    }
    duration() { return this.ms.duration; }
    bufferedRanges() {
      var v = this.ms._sb("video"), a = this.ms._sb("audio");
      if (v && a) return intersect(v.ranges(), a.ranges());
      return (v || a) ? (v || a).ranges() : [];
    }
    bufferedEnd(t) {
      var r = this.bufferedRanges();
      for (var i = 0; i < r.length; i++) if (t >= r[i][0] - 0.1 && t < r[i][1]) return r[i][1];
      return t;
    }
    quality() {
      return { creationTime: performance.now(), totalVideoFrames: this.decoded, droppedVideoFrames: this.dropped, corruptedVideoFrames: 0 };
    }
    destroy() {
      if (this.destroyed) return;
      this._stopAudio();
      this._closeVideo();
      if (this.ms._mirror) { this.ms._mirror.destroy(); this.ms._mirror = null; }
      this.native = null;
      this.destroyed = true;
      cancelAnimationFrame(this.raf);
      if (this.canvas) this.canvas.remove();
      if (this.ro) { this.ro.disconnect(); this.ro = null; }
      this.ms._engine = null;
      var i = engines.indexOf(this); if (i >= 0) engines.splice(i, 1);
    }

    // ---- data arrived / MediaSource changed
    _changed() {
      var now = performance.now();
      if (now - this.lastProgress > 350) { this.lastProgress = now; this._fire("progress"); }
      this._step();
    }

    _msEnded() { return this.ms.readyState === "ended"; }

    // HAVE_ENOUGH_DATA, with the events a real element fires on the way there.
    _ready() {
      if (this.readyState >= 4) return;
      this.readyState = 4;
      if (!this.loadedData) { this.loadedData = true; this._fire("loadeddata"); }
      this._fire("canplay"); this._fire("canplaythrough");
    }

    // ---- state machine, run on every frame and whenever data arrives
    _step() {
      if (this.destroyed) return;
      var ms = this.ms, v = ms._sb("video"), a = ms._sb("audio");
      // metadata
      if (this.readyState < 1) {
        var sbs = ms._sbs;
        // bilibili sometimes adds the audio SourceBuffer a moment before the video one: a
        // <video> is not ready until its video track is there (audio-only after 5 s).
        var waitVideo = this.el instanceof HTMLVideoElement && !v && performance.now() - this.created < 5000;
        if (sbs.length && !waitVideo && sbs.every(function (s) { return s.track; })) {
          this.readyState = 1;
          if (v && v.track) { this.vw = v.track.width; this.vh = v.track.height; }
          this._fire("durationchange"); this._fire("loadedmetadata"); this._fire("resize");
        } else return;
      }
      var t = this.seeking ? this.seekTarget : this.now();
      var ahead = this.bufferedEnd(t) - t;
      var enough = ahead > 0.3 || (this._msEnded() && ahead > 0);

      if (this.seeking) {
        var haveFrame = !v || this.frames.length > 0;
        if (enough && haveFrame) {
          this.seeking = false; this.seekTarget = null;
          this._ready();
          this._fire("timeupdate"); this._fire("seeked");
          // (a canplay handler may already have called play() and started the clock)
          if (!this.paused && !this.running) { this.waiting = false; this._fire("playing"); this._startClock(); }
        }
      } else if (this.running) {
        if (!enough && !this._msEnded() && ahead < 0.05) {
          this._stopClock(); this.waiting = true; this.readyState = 2; this.waits++; this._fire("waiting");
        }
      } else if (this.readyState < 4 || this.waiting) {
        if (enough) {
          this._ready();
          if (!this.paused && !this.running) { this.waiting = false; this._fire("playing"); this._startClock(); }
        }
      }

      // ended
      var dur = ms.duration;
      if (this.running && ((this.native && this.native.ended) ||
          (isFinite(dur) && this.now() >= dur - 0.05 && (this._msEnded() || this.bufferedEnd(this.now()) >= dur - 0.2)))) {
        this._stopClock(); this.t = dur;
        this._fire("timeupdate");
        this.paused = true; this._fire("pause");
        this.ended = true; this._fire("ended");
      }

      this._feedVideo(v);
      this._feedAudio(a);
    }

    // ---- video
    _closeVideo() {
      this.vGen++;
      if (this.vdec) { try { this.vdec.close(); } catch (e) {} }
      this.vdec = null; this.vTrack = null;
      this.frames.forEach(function (f) { f.close(); }); this.frames = [];
    }
    _restartVideo(target) {
      this._closeVideo();
      this.vNeedKey = true; this.vFeed = target; this.dropBefore = target - 0.002; this.drawnTs = -1;
    }
    _makeVideoDecoder(track) {
      var self = this, gen = this.vGen;
      var dec = new VideoDecoder({
        output: function (f) { self._onFrame(f, gen); },
        error: function (e) {
          warn("video decoder", e && e.message);
          if (gen !== self.vGen) return;
          // Start over from a key frame (e.g. the browser reclaimed a hardware decoder). Never
          // give up for good: that left the picture black while sound and danmaku went on.
          self.vErrors++;
          report("vdec-error", { msg: e && String(e.message || e).slice(0, 160), n: self.vErrors, t: +self.now().toFixed(2), codec: track.codec, size: track.width + "x" + track.height });
          self._restartVideo(self.seeking ? self.seekTarget : self.now());
          self.vRetryAt = performance.now() + Math.min(5000, 250 * self.vErrors);
        },
      });
      dec.configure({ codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height, optimizeForLatency: false,
                      hardwareAcceleration: this.preferSW ? "prefer-software" : "no-preference" });
      this.vTrack = track;
      return dec;
    }
    _onFrame(f, gen) {
      if (gen !== this.vGen || this.destroyed) { f.close(); return; }
      this.decoded++; this.lastOutWall = performance.now();
      if (f.timestamp / 1e6 < this.dropBefore) { f.close(); return; }
      var fr = this.frames;
      fr.push(f);
      if (fr.length > 1 && fr[fr.length - 2].timestamp > f.timestamp) fr.sort(function (x, y) { return x.timestamp - y.timestamp; });
      if (f.displayWidth !== this.vw || f.displayHeight !== this.vh) {
        this.vw = f.displayWidth; this.vh = f.displayHeight; this._fire("resize");
      }
      if (this.seeking) this._step();
    }
    _feedVideo(sb) {
      if (!sb || !sb.track || performance.now() < this.vRetryAt) return;
      var t = this.seeking ? this.seekTarget : this.now();
      if (this.vNeedKey) {
        var k = sb.keyIndexAt(Math.max(this.vFeed, 0));
        if (k < 0) return;
        // Seeking (also resuming at the history position): start at the key frame when it is
        // at most 3 s earlier, instead of decoding everything from there and throwing it away.
        // On a car CPU that is seconds of 1080p, while the sound would already run ahead.
        var kp = sb.samples[k].pts;
        if (this.seeking && kp < this.seekTarget && this.seekTarget - kp <= 3) {
          this.seekTarget = this.t = kp; this.dropBefore = kp - 0.002; t = kp;
        }
        this.vFeed = sb.samples[k].dts; this.vNeedKey = false;
        if (this.vdec) { this._closeVideo(); }
      }
      var limit = t + 2.5;
      while (this.frames.length < 12) {
        var dec = this.vdec;
        if (dec && dec.decodeQueueSize > 5) break;
        var i = sb.indexFrom(this.vFeed);
        if (i >= sb.samples.length) break;
        var s = sb.samples[i];
        if (s.dts > limit) break;
        if (s.dts > this.vFeed + 1.0 && i > 0) break;                 // gap: wait for the missing segment
        if (!dec || s.tr !== this.vTrack) {
          if (!s.key) { this.vFeed = s.dts + 1e-6; continue; }        // can only (re)start on a key frame
          if (dec) {
            // Quality switch: a fresh decoder for the new stream (reconfiguring a hardware
            // decoder in place is where the car went black). The old one drains, then closes.
            var old = dec;
            report("track-switch", { from: this.vTrack && this.vTrack.width + "x" + this.vTrack.height, to: s.tr.width + "x" + s.tr.height, t: +t.toFixed(2) });
            try { old.flush().then(function () { old.close(); }, function () {}); } catch (e) {}
          }
          dec = this.vdec = this._makeVideoDecoder(s.tr);
        }
        try {
          dec.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: Math.round(s.pts * 1e6), duration: Math.round(s.dur * 1e6), data: s.data }));
        } catch (e) {
          warn("decode", e && e.message);
          report("decode-throw", { msg: e && String(e.message || e).slice(0, 160), t: +t.toFixed(2) });
          this.vNeedKey = true; this.vFeed = s.dts + 1e-6; this._closeVideo(); return;
        }
        this.vFeed = s.dts + 1e-6;
      }
      if (this._msEnded() && this.vdec && sb.indexFrom(this.vFeed) >= sb.samples.length && !this._flushed) {
        this._flushed = true; this.vdec.flush().catch(function () {});
      } else if (!this._msEnded()) this._flushed = false;
    }

    // ---- audio
    _stopAudio() {
      this.aGen++;
      this.sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
      this.sources = []; this.aNext = 0;
      if (this.adec) { try { this.adec.close(); } catch (e) {} }
      this.adec = null; this.aTrack = null;
    }
    _restartAudio() {
      this._stopAudio();
      if (!this.audioMaster) return;
      var sb = this.ms._sb("audio"); if (!sb) return;
      // start from the sample that contains t
      var i = sb.indexFrom(this.t); if (i > 0) i--;
      while (i < sb.samples.length - 1 && sb.samples[i].pts + sb.samples[i].dur <= this.t) i++;
      this.aFeed = i < sb.samples.length ? sb.samples[i].dts : this.t;
      this.aQueued = this.t;
      this._applyGain();
    }
    _makeAudioDecoder(track) {
      var self = this, gen = this.aGen;
      var dec = new AudioDecoder({
        output: function (data) { self._onAudio(data, gen); },
        error: function (e) { warn("audio decoder", e && e.message); if (gen === self.aGen) self.adec = null; },
      });
      dec.configure({ codec: track.codec, sampleRate: track.sampleRate, numberOfChannels: track.channels, description: track.description });
      this.aTrack = track;
      return dec;
    }
    _onAudio(data, gen) {
      if (gen !== this.aGen || this.destroyed || !this.running || !this.audioMaster) { data.close(); return; }
      var n = data.numberOfFrames, ch = data.numberOfChannels, sr = data.sampleRate, pts = data.timestamp / 1e6;
      var buf = actx.createBuffer(ch, n, sr);
      try {
        for (var c = 0; c < ch; c++) {
          var arr = new Float32Array(n);
          data.copyTo(arr, { planeIndex: c, format: "f32-planar" });
          buf.copyToChannel(arr, c);
        }
      } catch (e) { warn("audio copy", e && e.message); data.close(); return; }
      data.close();
      var when = this.anchorCtx + (pts - this.anchorMedia) / this.rate;
      // Butt each buffer against the previous one: timestamp rounding would leave tiny gaps.
      if (this.aNext && Math.abs(when - this.aNext) < 0.01) when = this.aNext;
      var nowc = actx.currentTime, src = actx.createBufferSource();
      src.buffer = buf; src.playbackRate.value = this.rate; src.connect(gainNode);
      var late = nowc + 0.01 - when;
      if (late > 0) { this.aLateMax = Math.max(this.aLateMax, late); }
      if (late > 0 && late < 0.3) {
        // A little late (busy CPU): move the whole timeline back instead of cutting the start
        // of this buffer, which clicks. The picture waits a moment; the sound stays whole.
        this.anchorCtx += late + 0.04; when += late + 0.04; this.aShift++;
      }
      if (when < nowc) {
        var off = (nowc - when) * this.rate;
        this.aLate++;
        if (off >= buf.duration) return;
        src.start(nowc, off);
        this.aNext = nowc + (buf.duration - off) / this.rate;
      } else {
        src.start(when);
        this.aNext = when + buf.duration / this.rate;
      }
      var list = this.sources; list.push(src);
      src.onended = function () { var k = list.indexOf(src); if (k >= 0) list.splice(k, 1); };
    }
    _feedAudio(sb) {
      if (!sb || !sb.track || !this.running || !this.audioMaster) return;
      var t = this.now(), limit = t + 1.5;
      while (this.aQueued < limit) {
        var dec = this.adec;
        if (dec && dec.decodeQueueSize > 8) break;
        var i = sb.indexFrom(this.aFeed);
        if (i >= sb.samples.length) break;
        var s = sb.samples[i];
        if (s.dts > this.aFeed + 1.0 && i > 0) break;
        if (!dec || s.tr !== this.aTrack) {
          if (dec) { try { dec.close(); } catch (e) {} }
          dec = this.adec = this._makeAudioDecoder(s.tr);
        }
        try {
          dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(s.pts * 1e6), duration: Math.round(s.dur * 1e6), data: s.data }));
        } catch (e) { warn("audio decode", e && e.message); this.adec = null; return; }
        this.aFeed = s.dts + 1e-6; this.aQueued = s.pts + s.dur;
      }
    }

    // ---- drawing
    _ensureCanvas() {
      var el = this.el, parent = el.parentNode;
      if (!parent) return false;
      if (!this.canvas || this.canvas.parentNode !== parent) {
        if (this.canvas) this.canvas.remove();
        var c = document.createElement("canvas");
        c.className = "tesla-canvas-video";
        c.style.cssText = "position:absolute;pointer-events:none;background:#000;display:block;";
        parent.insertBefore(c, el.nextSibling);
        this.canvas = c; this.cx = c.getContext("2d"); this.box = ""; this.cssW = 0; this.cssH = 0;
        this._observeBox(parent);
        this._measure();
      }
      // Reading offset* every frame forced a full layout of bilibili's busy page each frame
      // (the biggest piece of this script's main-thread time while a video starts). Measure
      // when the box resizes (ResizeObserver) instead; every frame only without one.
      if (!this.ro) this._measure();
      return true;
    }
    _observeBox(parent) {
      var self = this;
      if (this.ro) this.ro.disconnect();
      this.ro = null;
      if (!window.ResizeObserver) return;
      this.ro = new ResizeObserver(function () { if (!self.destroyed && self.canvas) self._measure(); });
      this.ro.observe(this.el); this.ro.observe(parent);
    }
    // mirror the element's box (it is usually absolutely positioned inside the player)
    _measure() {
      var el = this.el;
      this.lastMeasure = performance.now();
      var l = el.offsetLeft, t = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
      var box = l + "," + t + "," + w + "," + h;
      if (box === this.box) return;
      this.box = box; this.cssW = w; this.cssH = h;
      var s = this.canvas.style;
      s.left = l + "px"; s.top = t + "px"; s.width = w + "px"; s.height = h + "px";
      var z = getComputedStyle(el).zIndex; s.zIndex = z === "auto" ? "" : z;
      this.drawnTs = -1;
    }
    _draw(f) {
      // at most 1.5 device pixels per CSS pixel: the car screen is ~2x and every pixel costs
      var c = this.canvas, dpr = Math.min(1.5, window.devicePixelRatio || 1);
      this.draws++;
      var cw = Math.max(1, Math.round(this.cssW * dpr)), ch = Math.max(1, Math.round(this.cssH * dpr));
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      var vw = f.displayWidth, vh = f.displayHeight, k = Math.min(cw / vw, ch / vh), w = vw * k, h = vh * k;
      var x = this.cx;
      x.fillStyle = "#000"; x.fillRect(0, 0, cw, ch);
      x.drawImage(f, (cw - w) / 2, (ch - h) / 2, w, h);
    }
    _loop() {
      if (this.destroyed) return;
      this.raf = requestAnimationFrame(this._loop);
      this._step();
      if (!this._ensureCanvas()) return;
      var t = this.now(), fr = this.frames;
      if (this.running) {
        while (fr.length > 1 && fr[1].timestamp / 1e6 <= t) {
          var old = fr.shift();
          if (old.timestamp !== this.drawnTs) this.dropped++;
          old.close();
        }
      }
      var f = fr[0], wall = performance.now();
      if (this.lastLoop && this.running) this.maxGap = Math.max(this.maxGap, wall - this.lastLoop);
      this.lastLoop = wall;
      if (f && f.timestamp !== this.drawnTs && (!this.running || f.timestamp / 1e6 <= t + 0.03)) {
        this._draw(f); this.drawnTs = f.timestamp; this.lastDrawWall = wall;
        if (this.running) { var lag = t - f.timestamp / 1e6; this.lagMax = Math.max(this.lagMax, lag); this.lagSum += lag; this.lagN++; }
      }
      if (this.running) {
        if (wall - this.lastTU > 250) { this.lastTU = wall; this._fire("timeupdate"); }
        this._watchdog(wall, t);
        if (wall - this.lastStats > 30000) { this.lastStats = wall; report("stats", this._stats()); this.maxGap = 0; this.lagMax = 0; this.lagSum = 0; this.lagN = 0; }
        if (!this.firstCheck && wall - this.anchorWall > 4000) { this.firstCheck = true; report("first", this._look()); }
        if (wall - this.lastNow > 15000) { this.lastNow = wall; nowPlaying(t); }
      }
    }

    // Playing but no new picture for a while (decoder stuck or lost): restart the video
    // pipeline at the current position. The clock, sound and bilibili's player are untouched.
    _watchdog(wall, t) {
      var v = this.ms._sb("video");
      if (!v || !v.track || this.seeking || this.paused) return;
      if (this.native && (this.native.paused || this.native.readyState < 3)) return;   // the sound itself is waiting
      // frames still coming out (catching up after a start or seek) is progress, not a stall
      var since = Math.max(this.lastDrawWall, this.anchorWall, this.lastOutWall);
      if (wall - since < 1500 || wall < this.vRetryAt) return;
      if (this.bufferedEnd(t) - t < 0.3) return;                       // simply not downloaded yet
      this.restarts++;
      var st = this._stats(); st.held = this.frames.map(function (x) { return +(x.timestamp / 1e6).toFixed(2); }).slice(0, 4);
      st.vFeed = +this.vFeed.toFixed(2); st.vbuf = v.ranges().slice(0, 3).map(function (r) { return [+r[0].toFixed(1), +r[1].toFixed(1)]; });
      st.vsamples = v.samples.length; st.sw = !!this.preferSW;
      // A decoder that took input and gave nothing back twice: use the software decoder from
      // now on (the car's hardware decoder sometimes sits on its first frames for seconds).
      if (this.decoded === this.decodedAtRestart) this.silentStalls++;
      this.decodedAtRestart = this.decoded;
      if (this.silentStalls >= 2 && !this.preferSW) { this.preferSW = true; st.switchToSW = true; }
      report("stall", st);
      this._restartVideo(t);
      this.lastDrawWall = wall;
    }
    _stats() {
      var v = this.ms._sb("video"), a = this.ms._sb("audio");
      return {
        t: +this.now().toFixed(2), rate: this.rate, vcodec: v && v.track && v.track.codec,
        size: v && v.track && v.track.width + "x" + v.track.height, frames: this.frames.length,
        q: this.vdec ? this.vdec.decodeQueueSize : -1, vstate: this.vdec ? this.vdec.state : "none",
        decoded: this.decoded, dropped: this.dropped, vErrors: this.vErrors, restarts: this.restarts,
        arate: a && a.track && a.track.sampleRate, ctxRate: actx && actx.sampleRate, ctx: actx && actx.state,
        audioMaster: this.audioMaster, aLate: this.aLate, sources: this.sources.length,
        canvas: this.canvas ? this.canvas.width + "x" + this.canvas.height : "none",
        sinceDraw: Math.round(performance.now() - this.lastDrawWall),
        draws: this.draws, waits: this.waits, aShift: this.aShift, aLateMax: +this.aLateMax.toFixed(3), maxGap: Math.round(this.maxGap),
        lagAvg: this.lagN ? +(this.lagSum / this.lagN).toFixed(3) : null, lagMax: +this.lagMax.toFixed(3),
        audio: this.native ? "native" : (this.ms._mirror ? "native-pending" : "webaudio"),
        nat: this.native ? { rs: this.native.readyState, paused: this.native.paused, t: +this.native.currentTime.toFixed(2), buf: this.native.buffered.length ? +this.native.buffered.end(this.native.buffered.length - 1).toFixed(1) : 0 } : null,
      };
    }
    // What the viewer should be seeing: the canvas centre pixel and what is on top there.
    _look() {
      var st = this._stats(), c = this.canvas;
      if (!c) return st;
      var r = c.getBoundingClientRect(), cs = getComputedStyle(c);
      st.crect = [r.left, r.top, r.width, r.height].map(Math.round);
      st.cvis = cs.display + "/" + cs.visibility + "/" + cs.opacity + "/z" + cs.zIndex;
      try { var d = this.cx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data; st.px = [d[0], d[1], d[2]]; } catch (e) { st.px = String(e).slice(0, 80); }
      try {
        c.style.pointerEvents = "auto";                                  // hit-testing skips pointer-events:none
        var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        st.top = top ? (top === c ? "canvas" : top.tagName.toLowerCase() + "." + String(top.className).split(" ")[0]) : "none";
      } catch (e) {} finally { c.style.pointerEvents = "none"; }
      st.sbs = this.ms._sbs.map(function (b) { return b.kind + ":" + (b.track ? b.track.codec : "-"); });
      st.sw = !!this.preferSW;
      st.screen = (document.querySelector(".bpx-player-container") || { getAttribute: function () { return ""; } }).getAttribute("data-screen");
      return st;
    }
  }

  // ------------------------------------------------------------------ element hooks
  var ME = HTMLMediaElement.prototype, VE = HTMLVideoElement.prototype;
  function hook(proto, name, get, set) {
    var d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d) return;
    NATIVE[name] = d;
    var desc = { configurable: true, enumerable: d.enumerable };
    if (d.get || d.set) {
      desc.get = function () { var e = this.__cm; return e && get ? get(e, this) : (d.get ? d.get.call(this) : undefined); };
      desc.set = function (v) { var e = this.__cm; if (e && set) set(e, v, this); else if (d.set) d.set.call(this, v); };
    } else if (typeof d.value === "function") {
      desc.writable = true;
      desc.value = function () { var e = this.__cm; return e && get ? get(e, this, arguments) : d.value.apply(this, arguments); };
    }
    Object.defineProperty(proto, name, desc);
  }
  var EMPTY = new Ranges([]);
  hook(ME, "currentTime", function (e) { return e.seeking ? e.seekTarget : e.now(); }, function (e, v) { e.seek(v); });
  hook(ME, "duration", function (e) { return e.duration(); });
  hook(ME, "paused", function (e) { return e.paused; });
  hook(ME, "ended", function (e) { return e.ended; });
  hook(ME, "seeking", function (e) { return e.seeking; });
  hook(ME, "readyState", function (e) { return e.readyState; });
  hook(ME, "networkState", function (e) { return e._msEnded() ? 1 : 2; });
  hook(ME, "buffered", function (e) { return new Ranges(e.bufferedRanges()); });
  hook(ME, "seekable", function (e) { var d = e.duration(); return new Ranges(isFinite(d) ? [[0, d]] : []); });
  hook(ME, "played", function () { return EMPTY; });
  hook(ME, "error", function () { return null; });
  hook(ME, "playbackRate", function (e) { return e.rate; }, function (e, v) { e.setRate(v); });
  hook(ME, "defaultPlaybackRate", function (e) { return e.defaultRate; }, function (e, v) { e.defaultRate = +v || 1; });
  hook(ME, "volume", function (e) { return e.volume; }, function (e, v, el) { e.setVolume(v); NATIVE.volume.set.call(el, e.volume); });
  hook(ME, "muted", function (e) { return e.muted; }, function (e, v, el) { e.setMuted(v); NATIVE.muted.set.call(el, !!v); });
  hook(ME, "currentSrc", function (e, el) { return el.__cmSrc; });
  hook(ME, "play", function (e) { return e.play(); });
  hook(ME, "pause", function (e) { e.pause(); });
  hook(ME, "load", function () {});
  hook(ME, "fastSeek", function (e, el, args) { e.seek(args[0]); });
  hook(VE, "videoWidth", function (e) { return e.vw; });
  hook(VE, "videoHeight", function (e) { return e.vh; });
  hook(VE, "getVideoPlaybackQuality", function (e) { return e.quality(); });
  hook(VE, "webkitDecodedFrameCount", function (e) { return e.decoded; });
  hook(VE, "webkitDroppedFrameCount", function (e) { return e.dropped; });
  hook(VE, "requestVideoFrameCallback", function (e, el, args) {
    var cb = args[0];
    return requestAnimationFrame(function (now) { cb(now, { mediaTime: e.now(), presentedFrames: e.decoded, width: e.vw, height: e.vh }); });
  });

  // Only H.264 + AAC: steer the player away from HEVC / AV1 / Dolby streams.
  var canPlay = ME.canPlayType;
  ME.canPlayType = function (t) {
    if (/hev1|hvc1|av01|vp09|vp9|ec-3|ac-3|flac/i.test(String(t))) return "";
    return canPlay.call(this, t);
  };

  var srcDesc = Object.getOwnPropertyDescriptor(ME, "src");
  var removeAttr = Element.prototype.removeAttribute;
  function detach(el) {
    if (el.__cm) { el.__cm.destroy(); el.__cm = null; el.__cmSrc = null; el.__msrc = null; }
  }
  Object.defineProperty(ME, "src", {
    configurable: true, enumerable: srcDesc.enumerable,
    get: function () { return this.__cmSrc || srcDesc.get.call(this); },
    set: function (v) {
      var ms = fakeURLs[String(v)];
      detach(this);
      if (ms) {
        if (srcDesc.get.call(this)) { removeAttr.call(this, "src"); }
        this.__cmSrc = String(v);
        this.__cm = new Engine(this, ms);
        log("attached engine to", this);
      } else {
        srcDesc.set.call(this, v);
      }
    },
  });
  Element.prototype.removeAttribute = function (name) {
    if (this.__cm && String(name).toLowerCase() === "src") detach(this);
    return removeAttr.call(this, name);
  };

  var createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    if (obj instanceof FakeMediaSource) {
      var u = "blob:" + location.origin + "/canvas-media-" + (++urlSeq);
      fakeURLs[u] = obj;
      return u;
    }
    return createURL.call(URL, obj);
  };
  URL.revokeObjectURL = function (u) {
    if (fakeURLs[u]) { delete fakeURLs[u]; return; }
    return revokeURL.call(URL, u);
  };

  // ------------------------------------------------------------------ car: videos open in wide mode
  // The car's window is ~800 px; bilibili's wide mode gives the player the full page width.
  // Once per page; leaving it is up to the viewer.
  if (window.innerWidth < 1100) {
    var wdClicks = 0, wdTicks = 0;
    var wdTimer = setInterval(function () {
      var c = document.querySelector(".bpx-player-container"), b = document.querySelector(".bpx-player-ctrl-wide");
      if (++wdTicks > 120 || (c && c.getAttribute("data-screen") !== "normal" && c.getAttribute("data-screen"))) { clearInterval(wdTimer); return; }
      if (!c || !b || wdTicks % 4) return;                                // try once a second
      if (wdClicks++ >= 5) { clearInterval(wdTimer); return; }
      b.click();
    }, 250);
  }

  window.MediaSource = FakeMediaSource;
  window.WebKitMediaSource = FakeMediaSource;
  try { delete window.ManagedMediaSource; } catch (e) {}
  window.__canvasPlayer = { engines: engines, FakeMediaSource: FakeMediaSource, ctx: function () { return actx; } };
  log("installed");
})();
