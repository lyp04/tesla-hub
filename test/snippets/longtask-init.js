// INIT_FILE: collect long tasks (main thread blocked > 50 ms) from page start
window.__lt = [];
try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: "longtask", buffered: true }); } catch (e) {}
