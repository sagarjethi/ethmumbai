// Generates one narration line per scene from Replicate. The token comes only from the environment.
// Usage: node tts.mjs <script.json> <outDir> [sceneId]
import fs from "node:fs";
const [script, out, only] = process.argv.slice(2);
const MODEL = "minimax/speech-2.8-turbo";
const VOICE = process.env.TTS_VOICE ?? "English_Deep-VoicedGentleman";
const headers = { Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json", Prefer: "wait=60" };
fs.mkdirSync(out, { recursive: true });
for (const s of JSON.parse(fs.readFileSync(script, "utf8"))) {
  if (only && s.id !== only) continue;
  const file = `${out}/${s.id}.mp3`;
  if (fs.existsSync(file)) { continue; }
  const r = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, { method: "POST", headers, body: JSON.stringify({ input: { text: s.text, voice_id: VOICE, emotion: "calm", english_normalization: true, audio_format: "mp3", sample_rate: 44100, language_boost: "English" } }) });
  let p = await r.json();
  while (p.status === "starting" || p.status === "processing") {
    await new Promise((res) => setTimeout(res, 1000));
    p = await (await fetch(p.urls.get, { headers })).json();
  }
  if (p.status !== "succeeded") { console.error(s.id, p.status, String(p.error ?? p.detail).slice(0, 200)); process.exitCode = 1; continue; }
  const url = Array.isArray(p.output) ? p.output[0] : p.output;
  fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log(s.id, "ok", p.metrics?.predict_time ?? "", p.id);
}
