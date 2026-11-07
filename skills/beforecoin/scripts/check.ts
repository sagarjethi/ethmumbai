#!/usr/bin/env node
// Asks BeforeCoin to check one swap and prints the verdict. It holds no wallet key and sends no transaction.
//
//   CLEARANCE_API_URL=http://127.0.0.1:18787 CLEARANCE_API_KEY=clr_... node check.ts swap.json
//
// Anything other than a complete ALLOW exits non-zero, so a failed check can't fall through to a swap.
import { readFileSync } from "node:fs";

const EXIT = { ERROR: 1, USAGE: 2 };
const VERDICT_EXIT = new Map([["ALLOW", 0], ["REDUCE", 10], ["HUMAN_REQUIRED", 11], ["BLOCK", 12]]);
const USAGE = `Usage: node check.ts <swap.json | -> [--checkpoint <id>] [--json]

Needs CLEARANCE_API_URL and CLEARANCE_API_KEY.
swap.json holds agentName, account, pool, zeroForOne, amountIn and optionally reason. Use - to read it from stdin.

Exit codes: 0 ALLOW, 10 REDUCE, 11 HUMAN_REQUIRED, 12 BLOCK, 1 no usable answer, 2 bad usage.`;

type Reason = { code: string; detail: string };
type Decision = {
  id: string;
  verdict: string;
  requested: string;
  required: number;
  evaluations?: { verdict: string; reasons?: Reason[] }[];
  unreachable?: string[];
  clearance?: { maxAmountIn: string; minAmountOut: string; expiry: number };
  signatures?: string[];
  hookData?: string;
  attestationRequired?: boolean;
  checkpoint?: { id: string; url: string };
};

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  let file: string | undefined;
  let checkpointId: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--checkpoint") checkpointId = argv[++i] ?? fail(EXIT.USAGE, USAGE);
    else if (arg?.startsWith("--") || file) fail(EXIT.USAGE, USAGE);
    else file = arg;
  }
  return { file: file ?? fail(EXIT.USAGE, USAGE), checkpointId, json };
}

function readSwap(file: string): Record<string, unknown> {
  try {
    const swap: unknown = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
    if (swap && typeof swap === "object" && !Array.isArray(swap)) return swap as Record<string, unknown>;
  } catch (error) {
    fail(EXIT.USAGE, `Couldn't read a swap from ${file}: ${(error as Error).message}`);
  }
  fail(EXIT.USAGE, `${file} must hold one JSON object`);
}

/** Only a verdict with what it needs counts. Anything else is treated as no clearance. */
function problemWith(decision: Decision): string | undefined {
  if (!VERDICT_EXIT.has(decision.verdict)) return `unknown verdict ${decision.verdict}`;
  const signed = decision.verdict === "ALLOW" || decision.verdict === "REDUCE";
  if (signed && (!decision.hookData || !decision.clearance)) return `${decision.verdict} arrived without a signed clearance`;
  if (decision.verdict === "HUMAN_REQUIRED" && decision.hookData) return "HUMAN_REQUIRED arrived with a clearance";
  if (decision.verdict === "BLOCK" && decision.hookData) return "BLOCK arrived with a clearance";
  return undefined;
}

function nextStep(decision: Decision): string {
  switch (decision.verdict) {
    case "ALLOW":
      return decision.attestationRequired
        ? "Ask for the independent check, wait for status attested, then send swapCleared with hookData."
        : "Send swapCleared from the agent key with hookData before the clearance expires.";
    case "REDUCE":
      return `Send swapCleared for ${decision.clearance?.maxAmountIn} or less, or drop the trade. The requested amount will revert.`;
    case "HUMAN_REQUIRED":
      return decision.checkpoint
        ? `Send the owner to ${decision.checkpoint.url}, wait for approved, then repeat this same swap with --checkpoint ${decision.checkpoint.id}.`
        : "Not approved. Stop and tell the owner. The checkpoint didn't clear this exact swap.";
    default:
      return "Stop. Don't retry, resize, split or reroute this. Tell the owner the reasons above.";
  }
}

function print(decision: Decision) {
  const evaluations = decision.evaluations ?? [];
  const signers = decision.signatures?.length ?? 0;
  const lines = [`verdict: ${decision.verdict}`, `decision: ${decision.id}`, `requested: ${decision.requested}`, `signatures: ${signers} (${decision.required} required)`];
  if (decision.clearance) {
    lines.push(`cleared: ${decision.clearance.maxAmountIn}`, `min out: ${decision.clearance.minAmountOut}`);
    lines.push(`expires: ${new Date(decision.clearance.expiry * 1000).toISOString()}`, `attestation required: ${Boolean(decision.attestationRequired)}`);
  }
  if (decision.unreachable?.length) lines.push(`unreachable verifiers: ${decision.unreachable.length}`);
  lines.push(`verifiers: ${evaluations.map((e) => e.verdict).join(", ") || "none answered"}`);
  const reasons = new Map(evaluations.flatMap((e) => e.reasons ?? []).map((r) => [r.code, r.detail]));
  for (const [code, detail] of reasons) lines.push(`reason: ${code} - ${detail}`);
  lines.push(`next: ${nextStep(decision)}`);
  if (decision.hookData) lines.push(`hookData: ${decision.hookData}`);
  console.log(lines.join("\n"));
}

const { file, checkpointId, json } = parseArgs(process.argv.slice(2));
const apiUrl = process.env.CLEARANCE_API_URL?.replace(/\/+$/, "") ?? fail(EXIT.USAGE, `CLEARANCE_API_URL is required.\n\n${USAGE}`);
const apiKey = process.env.CLEARANCE_API_KEY || fail(EXIT.USAGE, `CLEARANCE_API_KEY is required.\n\n${USAGE}`);
const action = { ...readSwap(file), kind: "swap" };

let response: Response;
try {
  response = await fetch(`${apiUrl}/v1/clear/swap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ action, checkpointId }),
    signal: AbortSignal.timeout(120_000),
  });
} catch (error) {
  fail(EXIT.ERROR, `No clearance: couldn't reach ${apiUrl}: ${(error as Error).message}. Don't swap.`);
}
const body = (await response.json().catch(() => null)) as (Decision & { error?: string }) | null;
if (!response.ok) fail(EXIT.ERROR, `No clearance: the API returned ${response.status}: ${body?.error ?? "no details"}. Don't swap.`);
if (!body) fail(EXIT.ERROR, "No clearance: the API's answer wasn't JSON. Don't swap.");

const problem = problemWith(body);
if (problem) fail(EXIT.ERROR, `No clearance: ${problem}. Don't swap.`);

if (json) console.log(JSON.stringify(body, null, 2));
else print(body);
process.exit(VERDICT_EXIT.get(body.verdict));
