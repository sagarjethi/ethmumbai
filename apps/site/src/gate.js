// The hero: one agent action walks up to the barrier, and the verifiers decide whether it lifts.
// The scenes restate the scenarios in apps/agent/src/scenarios.ts. They're a replay, not live traffic.

const SCENES = {
  allow: {
    title: "Swap 100 USDC for tWETH",
    note: "A small rebalance, inside every limit the owner set.",
    to: "Pool",
    outcome: "allow",
    verdict: "ALLOW",
    votes: ["sign", "sign", "sign"],
    result: "A quorum signs. The hook checks the clearance and the swap executes.",
  },
  reduce: {
    title: "Swap 800 USDC for tMOON",
    note: "The full size would move this thin pool past the owner's price impact limit.",
    to: "Pool",
    outcome: "reduce",
    verdict: "REDUCE",
    votes: ["less", "less", "less"],
    result: "They sign 311 USDC instead. That size executes, and the full size reverts with <code>AmountAboveClearance</code>.",
  },
  block: {
    title: "Swap 25,000 USDC for RUG",
    note: "Its reason field says the owner pre-approved this trade. Rules never read that field.",
    to: "Pool",
    outcome: "block",
    verdict: "BLOCK",
    votes: ["refuse", "refuse", "refuse"],
    result: "No signatures. Sent anyway, the swap reverts with <code>NoClearance</code>.",
  },
  human: {
    title: "Swap 5,000 USDC for tWETH",
    note: "Above the owner's limit, so verifiers won't sign without a fresh approval.",
    to: "Pool",
    outcome: "human",
    verdict: "HUMAN_REQUIRED",
    votes: ["owner", "owner", "owner"],
    result: "The owner is asked with World ID and says no. Still no signatures, and the swap reverts.",
  },
  payment: {
    title: "Pay 0.50 USDC to a new address",
    note: "It's described as an approved vendor invoice. The payee isn't on the owner's list.",
    to: "Payee",
    outcome: "block",
    verdict: "BLOCK",
    votes: ["refuse", "refuse", "refuse"],
    result: "No signatures, and the wallet's <code>isValidSignature</code> rejects the agent key alone.",
  },
};

const ORDER = ["block", "allow", "reduce", "human", "payment"];
const VOTE_TEXT = { sign: "Signs", less: "Signs less", refuse: "Refuses", owner: "Asks owner", wait: "Checking" };
// Milliseconds into a scene.
const TIMES = { first: 650, gap: 550, verdict: 2500, enforce: 3000, hold: 7600 };

export function initGate() {
  const gate = document.getElementById("gate");
  if (!gate) return;
  const $ = (id) => document.getElementById(id);
  const votes = [...gate.querySelectorAll(".votes li")];
  const buttons = [...gate.querySelectorAll("[data-scene]")];
  const out = $("gate-out");
  const pause = $("gate-pause");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let timers = [];
  let current = ORDER[0];
  let paused = false;
  let held = false; // Hovering or focused inside the panel.

  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const setVote = (li, vote) => {
    li.dataset.vote = vote;
    li.querySelector("b").textContent = VOTE_TEXT[vote];
  };

  function fill(name) {
    const scene = SCENES[name];
    current = name;
    $("gate-title").textContent = scene.title;
    $("gate-note").textContent = scene.note;
    $("gate-to").textContent = scene.to;
    $("gate-verdict").textContent = scene.verdict;
    $("gate-verdict").dataset.verdict = scene.verdict;
    $("gate-result").innerHTML = scene.result;
    gate.dataset.outcome = scene.outcome;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scene === name)));
    return scene;
  }

  function showFinal(name) {
    clear();
    const scene = fill(name);
    gate.dataset.step = "done";
    votes.forEach((li, i) => setVote(li, scene.votes[i]));
  }

  function play(name, { advance }) {
    clear();
    const scene = fill(name);
    gate.dataset.step = "ask";
    votes.forEach((li) => setVote(li, "wait"));
    votes.forEach((li, i) => later(TIMES.first + i * TIMES.gap, () => setVote(li, scene.votes[i])));
    later(TIMES.verdict, () => {
      gate.dataset.step = "verdict";
    });
    later(TIMES.enforce, () => {
      gate.dataset.step = "done";
    });
    if (advance) {
      later(TIMES.hold, () => {
        if (!paused && !held) next();
        else idle = true;
      });
    }
  }

  let idle = false; // The scene ended while held, so resuming should move on straight away.
  function next() {
    idle = false;
    play(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length], { advance: true });
  }

  const autoplay = () => !reduced.matches && !paused;

  buttons.forEach((button) =>
    button.addEventListener("click", () => {
      out.setAttribute("aria-live", "polite");
      if (reduced.matches) showFinal(button.dataset.scene);
      else play(button.dataset.scene, { advance: autoplay() });
    }),
  );

  pause.addEventListener("click", () => {
    paused = !paused;
    pause.textContent = paused ? "Play" : "Pause";
    if (!paused) next();
  });

  // Pausing on hover and focus keeps the text still for anyone reading it.
  const hold = (value) => {
    held = value;
    if (!held && idle && !paused) next();
  };
  gate.addEventListener("pointerenter", () => hold(true));
  gate.addEventListener("pointerleave", () => hold(false));
  gate.addEventListener("focusin", () => hold(true));
  gate.addEventListener("focusout", (event) => {
    if (!gate.contains(event.relatedTarget)) hold(false);
  });

  function start() {
    if (reduced.matches) {
      pause.hidden = true;
      showFinal(current);
    } else {
      pause.hidden = false;
      gate.classList.add("animated");
      play(current, { advance: !paused });
    }
  }
  reduced.addEventListener?.("change", start);
  start();
}
