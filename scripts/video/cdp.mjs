// Minimal Chrome DevTools driver for recording the demo. Screencast frames keep their real timestamps.
import fs from "node:fs";
import path from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(port = 9444) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener("message", (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method && handlers.has(d.method)) handlers.get(d.method)(d.params);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  // 1280x720 CSS pixels at 1.5x gives 1920x1080 frames with text large enough to read.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });

  // A visible pointer, because headless Chrome draws none. It only follows real mouse events.
  const CURSOR = `(() => { if (document.getElementById('__c')) return; const c = document.createElement('div'); c.id='__c';
    c.style.cssText='position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,255,255,.85);border:2px solid #0a0e14;box-shadow:0 0 0 2px rgba(255,255,255,.35);z-index:2147483647;pointer-events:none;transform:translate(${"${window.__x||-40}"}px,${"${window.__y||-40}"}px)';
    document.documentElement.appendChild(c); addEventListener('mousemove',e=>{window.__x=e.clientX;window.__y=e.clientY;c.style.transform='translate('+e.clientX+'px,'+e.clientY+'px)'},true); })()`;
  let mx = 640, my = 450;
  const cursor = () => ev(CURSOR);
  const moveTo = async (x, y, ms = 700) => {
    await cursor();
    const n = Math.max(2, Math.round(ms / 16));
    const sx = mx, sy = my;
    for (let i = 1; i <= n; i++) {
      const t = i / n, e = t * t * (3 - 2 * t);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx + (x - sx) * e, y: sy + (y - sy) * e });
      await sleep(16);
    }
    mx = x; my = y;
  };
  const center = (expr) => ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, h: r.height }; })()`);
  const clickEl = async (expr) => {
    const c = await center(expr);
    if (!c) throw new Error("nothing to click: " + expr);
    await moveTo(c.x, c.y);
    await sleep(180);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    await sleep(60);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
  };
  // Scrolls at a steady reading pace in real time.
  const scrollTo = (y, ms = 1500) => ev(`new Promise(res => { const s = scrollY, t0 = performance.now(); const f = n => { const t = Math.min(1,(n-t0)/${ms}); const e = t*t*(3-2*t); scrollTo(0, s+(${y}-s)*e); t<1?requestAnimationFrame(f):res(); }; requestAnimationFrame(f); })`);
  const scrollEl = async (expr, offset = 90, ms = 1200) => {
    const y = await ev(`(() => { const el = ${expr}; return el ? el.getBoundingClientRect().top + scrollY - ${offset} : null; })()`);
    if (y !== null && y !== undefined) await scrollTo(Math.max(0, y), ms);
  };
  const go = async (url, wait = 1500) => { await send("Page.navigate", { url }); await sleep(wait); await cursor(); };

  const record = async (dir, fn) => {
    fs.mkdirSync(dir, { recursive: true });
    const frames = [];
    let n = 0;
    handlers.set("Page.screencastFrame", (p) => {
      const file = `${String(n++).padStart(6, "0")}.jpg`;
      fs.writeFileSync(path.join(dir, file), Buffer.from(p.data, "base64"));
      frames.push({ file, t: p.metadata.timestamp });
      send("Page.screencastFrameAck", { sessionId: p.sessionId });
    });
    await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    await sleep(300);
    const started = Date.now() / 1000;
    let notes;
    try { notes = await fn(); } finally {
      await sleep(200);
      await send("Page.stopScreencast");
      const stopped = Date.now() / 1000;
      handlers.delete("Page.screencastFrame");
      fs.writeFileSync(path.join(dir, "frames.json"), JSON.stringify({ started, stopped, frames, notes }));
    }
    return notes;
  };
  return { send, ev, moveTo, clickEl, scrollTo, scrollEl, go, record, cursor, center, close: () => { ws.close(); return fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } };
}
