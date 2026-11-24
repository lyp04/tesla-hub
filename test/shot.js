// node shot.js <outdir> <url> [url...]   — load pages through the dev proxy, screenshot, report errors
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const [outdir, ...urls] = process.argv.slice(2);
  fs.mkdirSync(outdir, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required"].concat(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split("|") : []) });
  const ctx = await browser.newContext({ viewport: { width: +(process.env.VW || 1600), height: +(process.env.VH || 900) }, locale: process.env.LOCALE || "zh-CN", colorScheme: process.env.COLOR || "dark",
    storageState: fs.existsSync(outdir + "/state.json") ? outdir + "/state.json" : undefined });
  if (process.env.INIT_FILE) await ctx.addInitScript({ path: process.env.INIT_FILE });
  const report = [];
  let i = 0;
  for (const url of urls) {
    const page = await ctx.newPage();
    if (process.env.MOCK_LYRICS) {
      const lines = []; for (let i = 0; i < 40; i++) lines.push([i * 4, "这是第 " + (i + 1) + " 行示例歌词，用来看排版"]);
      const t0 = Date.now() / 1000;
      await page.route("**/api/**", route => {
        const u = route.request().url();
        let body = { ok: true };
        if (u.includes("/api/state")) body = { ok: true, online: true, playing: true, status: "Playing", title: "示例歌曲", artist: "示例歌手", album: "示例专辑", source: "", elapsed: 41 + (Date.now() / 1000 - t0), duration: 200, ts: Date.now() / 1000 };
        else if (u.includes("/api/lyrics")) body = { ok: true, found: true, instrumental: false, source: "lrclib", lines, translatable: true, furigana: null };
        else if (u.includes("/api/candidates")) body = { ok: true, candidates: [] };
        route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      });
    }
    if (process.env.MOCK_LAST) {
      // the menu's 继续观看 banner: pretend tesla-hub reported a last video
      await page.route("**/bili-last", route => route.fulfill({ contentType: "application/json", body: process.env.MOCK_LAST }));
    }
    const r = { url, console: [], failed: [], bad: [], direct: new Set() };
    page.on("console", m => {
      const t = m.text();
      if ((m.type() === "error" || t.includes("[canvas-player]")) && r.console.length < 30) r.console.push(m.type() + ": " + t.slice(0, 220));
    });
    page.on("pageerror", e => { if (r.console.length < 12) r.console.push("PAGEERROR " + String(e).slice(0, 200)); });
    page.on("requestfailed", q => { if (r.failed.length < 15) r.failed.push(q.url().slice(0, 140) + " " + (q.failure() || {}).errorText); });
    page.on("response", s => {
      const u = new URL(s.url());
      if (!u.host.startsWith("127.0.0.1") && !u.host.endsWith("hdslb.com")) r.direct.add(u.host);
      if (s.status() >= 400 && r.bad.length < 15) r.bad.push(s.status() + " " + s.url().slice(0, 110) + " ref=" + (s.request().headers().referer || "-") + " rt=" + s.request().resourceType());
    });
    let cdp = null;
    if (process.env.CPU_THROTTLE || process.env.PROFILE_MS) {
      // CPU_THROTTLE=6 roughly imitates the car; PROFILE_MS=10000 profiles the start and reports
      // self time per script
      cdp = await page.context().newCDPSession(page);
      if (process.env.CPU_THROTTLE) await cdp.send("Emulation.setCPUThrottlingRate", { rate: +process.env.CPU_THROTTLE });
      if (process.env.PROFILE_MS) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); await cdp.send("Profiler.start"); }
    }
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch (e) { r.gotoErr = String(e).slice(0, 200); }
    if (cdp && process.env.PROFILE_MS) {
      await page.waitForTimeout(+process.env.PROFILE_MS);
      const { profile } = await cdp.send("Profiler.stop");
      const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
      const dt = profile.timeDeltas || [];
      (profile.samples || []).forEach((id, i) => {
        const n = byId.get(id), f = n.callFrame;
        let key = f.url ? f.url.replace(/^.*\/\/[^/]+/, "").replace(/\?.*$/, "").slice(-60) : "(" + (f.functionName || "native") + ")";
        if (process.env.PROFILE_FN && f.url && f.url.includes(process.env.PROFILE_FN)) key += " " + (f.functionName || "anon") + ":" + f.lineNumber;
        self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
      });
      r.profile = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => k + " " + Math.round(v) + "ms");
    }
    await page.waitForTimeout(+process.env.WAIT || 8000);
    if (process.env.ACTIONS) { r.actions = await page.evaluate(process.env.ACTIONS).catch(e => "ACTERR " + e); await page.waitForTimeout(+process.env.WAIT2 || 5000); }
    r.final = page.url(); r.title = await page.title().catch(() => "");
    const name = String(++i).padStart(2, "0");
    await page.screenshot({ path: `${outdir}/${name}.png` }).catch(() => {});
    if (process.env.EVAL) r.eval = await page.evaluate(process.env.EVAL).catch(e => "EVALERR " + e);
    r.direct = [...r.direct];
    report.push(r);
    await page.close();
  }
  await ctx.storageState({ path: outdir + "/state.json" });
  fs.writeFileSync(outdir + "/report.json", JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  await browser.close();
})();
