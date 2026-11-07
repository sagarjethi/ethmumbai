// Records the real product scene by scene in real time, with the pointer cued to the narration.
// Usage: node record.mjs <rawDir> <audioDurations.json> <script.json> [sceneIds...]
import fs from "node:fs";
import { connect, sleep } from "./cdp.mjs";
const [raw, durFile, scriptFile, ...only] = process.argv.slice(2);
const audio = JSON.parse(fs.readFileSync(durFile, "utf8"));
const script = Object.fromEntries(JSON.parse(fs.readFileSync(scriptFile, "utf8")).map((s) => [s.id, s.text]));
export const LEAD = 0.3; // Seconds into a scene's action before its narration starts.
const SITE = "http://localhost:5184/";
const DASH = "http://localhost:5183/";
const p = await connect();
const card = (t) => `[...document.querySelectorAll('.scenario')].find(x => x.querySelector('h2').textContent.startsWith(${JSON.stringify(t)}))`;
const leaf = (scope, text) => `[...document.querySelectorAll(${JSON.stringify(scope + " *")})].find(e => e.children.length === 0 && e.textContent.trim().startsWith(${JSON.stringify(text)}))`;

function clock(id) {
  const t0 = Date.now();
  const at = async (frag, early = 0) => {
    const i = script[id].indexOf(frag);
    if (i < 0) throw new Error(`cue not in script: ${frag}`);
    const when = (LEAD + audio[id] * (i / script[id].length) - early) * 1000;
    const left = when - (Date.now() - t0);
    if (left > 0) await sleep(left);
  };
  const end = async () => { const left = (LEAD + audio[id] + 0.5) * 1000 - (Date.now() - t0); if (left > 0) await sleep(left); };
  return { at, end, t0 };
}
const point = async (expr, ms = 500) => { const c = await p.center(expr); if (c) await p.moveTo(c.x, c.y, ms); return c; };
const running = () => p.ev(`!!document.querySelector('.scenario.running')`);
const row = (title, i) => `${card(title)}.querySelectorAll('.checks > li')[${i}]`;
const pointRow = async (title, i) => { const c = await p.center(row(title, i)); if (c) await p.moveTo(420, c.y, 450); };
const finish = async (title) => {
  const t = Date.now();
  while (Date.now() - t < 120000 && (await running())) await sleep(150);
  for (let i = 0; i < 40 && !(await p.ev(`${card(title)}.querySelectorAll('.checks > li').length > 0`)); i++) await sleep(150);
};
const press = async (title) => {
  await p.clickEl(`${card(title)}.querySelector('button')`);
  for (let i = 0; i < 30 && !(await running()); i++) await sleep(100);
};
const checks = (title) => p.ev(`[...${card(title)}.querySelectorAll('.checks > li')].map(l => l.className + ' ' + l.innerText.replace(/\\n/g,' | '))`);

const scenes = {
  async s01() {
    const c = clock("s01");
    await sleep(1500);
    await p.clickEl(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Hijacked')`);
    await c.end();
  },
  async s02() {
    const c = clock("s02");
    await p.scrollEl(`document.getElementById('how')`, 56, 1000);
    await point(leaf("#how", "Verifiers check separately"));
    await c.at("Two must sign");
    await point(leaf("#how", "A quorum signs"));
    await c.at("Without those");
    await p.scrollEl(`document.getElementById('difference')`, 56, 900);
    await point(leaf("#difference", "A hijacked agent skips the question, and the transaction"));
    await c.end();
  },
  async s03() {
    const c = clock("s03");
    await c.at("The limits are");
    await point(leaf("main", "Limits read from ENS").replace("main *", "body *"));
    await c.at("Trades up to");
    await point(leaf("body", "Up to $1,000"));
    await c.at("Three verifiers");
    await point(leaf("body", "2 must sign"));
    await c.end();
  },
  async s04() {
    const c = clock("s04");
    const t = "Honest";
    await c.at("First, an honest");
    await point(`${card(t)}.querySelector('h2')`);
    await c.at("The verifiers allow", 2.2);
    await press(t);
    await finish(t);
    await c.at("The verifiers allow");
    await pointRow(t, 0);
    await c.at("and the swap");
    await pointRow(t, 1);
    await c.end();
    return checks(t);
  },
  async s05() {
    const c = clock("s05");
    const t = "Prompt-injected";
    await p.scrollEl(card(t), 66, 800);
    await c.at("The verifiers refuse", 2.2);
    await press(t);
    await finish(t);
    await p.scrollEl(card(t), 66, 300);
    await c.at("The verifiers refuse");
    await pointRow(t, 0);
    await c.at("It sends the swap");
    await pointRow(t, 1);
    await c.at("It tries an outside");
    await pointRow(t, 2);
    await c.at("It tries a direct");
    await pointRow(t, 3);
    await c.end();
    return checks(t);
  },
  async s06a() {
    const c = clock("s06a");
    const t = "Over the limit: the owner says yes";
    await p.scrollEl(card(t), 66, 800);
    await sleep(300);
    await press(t);
    for (let i = 0; i < 200 && !(await p.ev(`!!document.querySelector('.notice.human a.button')`)); i++) await sleep(100);
    await p.scrollTo(0, 700);
    await c.at("The verifiers won't");
    await point(`document.querySelector('.notice.human a.button')`);
    await c.end();
  },
  async s06b() {
    const c = clock("s06b");
    await p.clickEl(`document.querySelector('.notice.human a.button')`);
    await sleep(900);
    await p.cursor();
    await p.moveTo(640, 170, 300);
    await c.at("Here, it's a local");
    await point(`document.querySelector('form').parentElement.firstElementChild`, 400);
    await sleep(Math.max(0, (LEAD + audio.s06b - 0.9) * 1000 - (Date.now() - c.t0)));
    await p.clickEl(`document.querySelector('button[value=approve]')`);
    await sleep(1000);
    return { url: await p.ev("location.href") };
  },
  async s06c() {
    const c = clock("s06c");
    const t = "Over the limit: the owner says yes";
    await p.cursor();
    await sleep(900);
    await p.ev(`location.hash='#lab'`);
    for (let i = 0; i < 40 && !(await p.ev(`!!${card(t)}`)); i++) await sleep(100);
    await finish(t);
    await p.scrollEl(card(t), 66, 500);
    await pointRow(t, 2);
    await c.at("The verifiers now");
    await pointRow(t, 3);
    await c.at("but the hook");
    await pointRow(t, 4);
    await c.at("until an independent");
    await pointRow(t, 5);
    await c.at("Then the trade");
    await pointRow(t, 6);
    await c.at("And the same");
    await pointRow(t, 7);
    await c.end();
    return checks(t);
  },
  async s07() {
    const c = clock("s07");
    const t = "Agent payment";
    await p.scrollEl(card(t), 66, 800);
    await c.at("The verifiers refuse", 1.8);
    await press(t);
    await finish(t);
    await c.at("The verifiers refuse");
    await pointRow(t, 0);
    await c.at("The agent's key");
    await pointRow(t, 1);
    await c.end();
    return checks(t);
  },
  async s08() {
    const c = clock("s08");
    const go = async (t, cue) => {
      await c.at(cue, 1.6);
      await p.scrollEl(card(t), 66, 500);
      await press(t);
      await finish(t);
    };
    await go("Stolen", "A stolen");
    await go("Thin pool", "A thin pool");
    await go("Over the limit: the owner says no", "When the owner");
    await c.at("Seven of seven", 0.6);
    await p.scrollTo(0, 500);
    await point(`document.querySelector('.head-note')`);
    await c.end();
    return p.ev(`document.querySelector('.head-note').textContent`);
  },
  async s09() {
    const c = clock("s09");
    const strip = `[...document.querySelectorAll('.strip')].find(s => /RUG/.test(s.innerText))`;
    await c.at("Open the hijacked");
    await p.scrollEl(strip, 70, 800);
    await p.clickEl(`${strip}.querySelector('.strip-main')`);
    await c.at("Its stated reason");
    await p.scrollEl(`${strip}.querySelector('.quote')`, 150, 400);
    await point(`${strip}.querySelector('.quote')`);
    await c.end();
    return p.ev(`${strip}.querySelector('.quote').innerText`);
  },
  async s10() {
    const c = clock("s10");
    await p.scrollEl(`document.getElementById('status')`, 56, 1000);
    await c.at("It runs on");
    await point(leaf("#status", "Real v4, ENSv2"));
    await c.at("World ID ran");
    await point(leaf("#status", "World ID"));
    await c.at("0G has");
    await point(leaf("#status", "0G review"));
    await c.end();
  },
};
const reload = async (ms = 1800) => { await p.send("Page.reload"); await sleep(ms); await p.cursor(); };
const setup = {
  s01: () => p.go(SITE, 2500),
  s02: () => p.go(SITE, 1500),
  s03: () => p.go(DASH + "#overview", 2000),
  s04: () => p.go(DASH + "#lab", 2000),
  s07: () => reload(),
  s09: async () => { await p.go(DASH + "#live", 800); await reload(); },
  s10: () => p.go(SITE, 1500),
};
for (const id of Object.keys(scenes)) {
  if (only.length && !only.includes(id)) continue;
  if (setup[id]) await setup[id]();
  const t = Date.now();
  const r = await p.record(`${raw}/${id}`, scenes[id]);
  console.log(id, ((Date.now() - t) / 1000).toFixed(1) + "s", audio[id], JSON.stringify(r ?? null));
}
await p.close();
