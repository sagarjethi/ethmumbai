import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import { initGate } from "./gate.js";
import { initPlayground } from "./playground.js";

const API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:18787";
const DASHBOARD = import.meta.env.VITE_DASHBOARD_URL ?? "http://localhost:5183/";

for (const link of document.querySelectorAll("[data-dashboard]")) link.href = DASHBOARD;

// ---- Theme: dark by default, whatever the OS says. The toggle's choice is a per-viewer convenience. ----

const themeToggle = document.querySelector("[data-theme-toggle]");
function labelTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  themeToggle?.setAttribute("aria-label", `Switch to ${next} theme`);
}
labelTheme();
themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("clearance-theme", next);
  } catch {
    // Blocked storage only means the choice isn't remembered.
  }
  labelTheme();
});

// ---- Phone menu ----

const nav = document.querySelector("[data-nav]");
const navToggle = document.querySelector("[data-nav-toggle]");
function setMenu(open) {
  nav?.toggleAttribute("data-open", open);
  navToggle?.setAttribute("aria-expanded", String(open));
}
navToggle?.addEventListener("click", () => setMenu(!nav.hasAttribute("data-open")));
nav?.querySelector(".nav-links")?.addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nav?.hasAttribute("data-open")) {
    setMenu(false);
    navToggle.focus();
  }
});

// ---- Copy buttons ----

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  });
}

initGate();
initPlayground();

// ---- Live boxes. Every number and result here comes from the API. ----

const VERDICTS = { ALLOW: "Cleared", REDUCE: "Cleared, reduced", BLOCK: "Refused", HUMAN_REQUIRED: "Needs the owner" };
const TONES = { ALLOW: "ok", REDUCE: "warn", HUMAN_REQUIRED: "warn", BLOCK: "bad" };
const OFFLINE = "The API isn't reachable from this page, so this check can't run. Start it with pnpm start.";

function setApiState(state, text) {
  const element = document.getElementById("api-state");
  if (!element) return;
  element.dataset.state = state;
  element.querySelector("span").textContent = text;
}

function show(element, tone, lines) {
  element.className = `result ${tone}`;
  element.replaceChildren(
    ...lines.map(([label, value, mono]) => {
      const row = document.createElement("div");
      if (label) {
        const name = document.createElement("span");
        name.textContent = label;
        row.append(name);
      }
      const content = document.createElement(mono ? "code" : "b");
      content.textContent = value;
      row.append(content);
      return row;
    }),
  );
}

const offline = (element) => {
  setApiState("down", "API not reachable");
  show(element, "bad", [["", OFFLINE]]);
};

/** Reason codes across all verifiers, without repeats. */
function reasonCodes(evaluations) {
  const codes = evaluations.flatMap((e) => (e.reasons ?? []).map((r) => r.code));
  return [...new Set(codes)].join(", ");
}

/** "3 cleared, reduced" reads better than the same word three times over. */
function tallyVerdicts(evaluations) {
  const counts = new Map();
  for (const e of evaluations) counts.set(e.verdict, (counts.get(e.verdict) ?? 0) + 1);
  return [...counts].map(([verdict, n]) => `${n} ${(VERDICTS[verdict] ?? verdict).toLowerCase()}`).join("; ");
}

const proofForm = document.getElementById("proof-form");
proofForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.getElementById("proof-result");
  const id = document.getElementById("proof-id").value.trim();
  try {
    const response = await fetch(`${API}/v1/proofs/${encodeURIComponent(id)}`);
    const proof = await response.json();
    if (!response.ok) return show(output, "bad", [["", proof.error]]);
    const signed = proof.signatures?.length ?? proof.verifierSignatures?.length ?? 0;
    const reasons = reasonCodes(proof.evaluations);
    show(output, TONES[proof.verdict] ?? "bad", [
      ["Verdict", VERDICTS[proof.verdict] ?? proof.verdict],
      ["Signatures", `${signed} (${proof.required} needed)`],
      ["Verifiers", tallyVerdicts(proof.evaluations)],
      ...(reasons ? [["Reasons", reasons, true]] : []),
      ...(proof.digest ? [["Digest", proof.digest, true]] : []),
      ...(proof.attestation ? [["Independent check", `${proof.attestation.status}, by ${proof.attestation.mode}`]] : []),
    ]);
  } catch {
    offline(output);
  }
});

const tokenForm = document.getElementById("token-form");
tokenForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.getElementById("token-result");
  const address = document.getElementById("token-address").value.trim();
  try {
    const response = await fetch(`${API}/v1/tokens/${encodeURIComponent(address)}/check`);
    const body = await response.json();
    if (!response.ok) return show(output, "bad", [["", body.error]]);
    show(
      output,
      body.hazards.length ? "bad" : "ok",
      body.hazards.length
        ? [["Admin functions found", body.hazards.join(", "), true]]
        : [["", "No admin functions found. That doesn't prove a token is safe."]],
    );
  } catch {
    offline(output);
  }
});

const record = document.getElementById("record");
if (record) {
  const note = document.getElementById("record-note");
  fetch(`${API}/v1/track-record`)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    })
    .then((data) => {
      const values = [
        (data.verdicts.ALLOW ?? 0) + (data.verdicts.REDUCE ?? 0),
        data.verdicts.BLOCK ?? 0,
        data.verdicts.HUMAN_REQUIRED ?? 0,
        data.attested,
      ];
      record.querySelectorAll("dd").forEach((dd, i) => {
        dd.textContent = String(values[i]);
      });
      const total = Object.values(data.verdicts).reduce((sum, count) => sum + count, 0);
      note.textContent = total
        ? "Live counts from this deployment's API. A fresh local chain starts at zero."
        : "Live from this deployment's API, which has no decisions yet. Run pnpm demo and these counts will move.";
      setApiState("up", "API reachable");
    })
    .catch(() => {
      note.textContent = "The API isn't reachable from this page, so there are no counts to show. Start it with pnpm start.";
      setApiState("down", "API not reachable");
    });
}
