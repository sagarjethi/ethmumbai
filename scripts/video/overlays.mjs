// Renders the end card and caption overlays with the site's own fonts. Usage: node overlays.mjs <buildDir> <script.json>
import fs from "node:fs";
import { connect, sleep } from "./cdp.mjs";
const [out, scriptFile] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
fs.mkdirSync(`${out}/cap`, { recursive: true });
const chunks = (text) => {
  const res = [];
  for (let sent of text.match(/[^.]+(?:\.(?=\d)[^.]+)*\./g)) {
    sent = sent.trim();
    if (sent.length <= 64) { res.push(sent); continue; }
    let cur = "";
    for (const w of sent.split(" ")) {
      if (cur && cur.length + w.length > 58) { res.push(cur); cur = w; } else cur = `${cur} ${w}`.trim();
    }
    res.push(cur);
  }
  return res;
};
const p = await connect();
await p.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await p.go("http://localhost:5184/", 1500);
const png = async (file, alpha) => {
  await p.send("Emulation.setDefaultBackgroundColorOverride", alpha ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
};
const FONT = await p.ev(`getComputedStyle(document.body).fontFamily`);
const HEAD = await p.ev(`getComputedStyle(document.querySelector('h1')).fontFamily`);
await p.ev(`document.head.querySelectorAll('style').length`);
await p.ev(`(() => { document.documentElement.style.background = '#0a0e14'; document.body.style.cssText = 'margin:0;background:#0a0e14;'; document.body.innerHTML = '<div style="width:1920px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;background:#0a0e14;color:#f4f6f8"><div style=\\'font:700 132px ${HEAD.replace(/"/g, "&quot;")};letter-spacing:-.01em\\'>BeforeCoin</div><div style=\\'font:400 44px ${FONT.replace(/"/g, "&quot;")};color:#aeb6c2\\'>A check AI agents can\\'t skip.</div><div style=\\'font:500 40px ${FONT.replace(/"/g, "&quot;")};color:#c9f04d;margin-top:36px\\'>github.com/sagarjethi/ethmumbai</div></div>'; })()`);
await sleep(600);
await png(`${out}/s11.png`, false);
await p.ev(`(() => { document.documentElement.style.background='transparent'; document.body.style.background='transparent'; document.body.innerHTML = '<div style="position:fixed;left:0;right:0;bottom:36px;text-align:center"><span id="c" style=\\'display:inline-block;max-width:1500px;padding:10px 26px;border-radius:10px;background:rgba(6,9,14,.86);color:#fff;font:500 36px/1.25 ${FONT.replace(/"/g, "&quot;")}\\'></span></div>'; })()`);
for (const s of script) {
  if (s.nocap) continue;
  let i = 0;
  for (const c of chunks(s.cap ?? s.text)) {
    await p.ev(`document.getElementById('c').textContent = ${JSON.stringify(c)}`);
    await sleep(40);
    await png(`${out}/cap/${s.id}_${i++}.png`, true);
  }
}
await p.close();
