import { encodeAbiParameters, isAddressEqual, type Address, type Hex } from "viem";
import type { SwapAction } from "./actions";
import { inputsHash } from "./canonical";
import { poolId } from "./eip712";
import type { Limits } from "./limits";

export const ATTESTED = 1;
export const REFUSED = 2;

export const ledgerAbi = [
  {
    type: "function",
    name: "attestations",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "at", type: "uint64" },
      { name: "impactBps", type: "uint32" },
      { name: "inputsHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "onReport",
    stateMutability: "nonpayable",
    inputs: [
      { name: "metadata", type: "bytes" },
      { name: "report", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export type ClearanceRecord = {
  agent: Address;
  poolId: Hex;
  zeroForOne: boolean;
  maxAmountIn: string;
  minAmountOut: string;
  expiry: number;
  chainId: number;
  nonce: string;
  inputsHash: Hex;
};

export type AttestationInput = {
  action: SwapAction;
  clearance: ClearanceRecord;
  /** Read from the chain by the attestor, not taken from the API. */
  limits: Limits;
  /** The chain's own answer to VerifierSet.hasQuorum for these signatures. */
  quorum: boolean;
  /** The digest the proof claims, and the one the hook computes from this clearance. They must match. */
  claimedDigest: Hex;
  computedDigest: Hex;
  /** Re-quoted by the attestor at the cleared size. Undefined when the quote failed. */
  impactBps: number | undefined;
  now: number;
  chainId: number;
  /** How far external price sources spread, when the attestor reads them. Only the CRE workflow does. */
  market?: { deviationBps: number; maxDeviationBps: number };
};

export type AttestationResult = { status: typeof ATTESTED | typeof REFUSED; problems: string[]; impactBps: number };

/** An independent second look at a clearance. It trusts nothing the API says about limits or market. */
export function evaluateAttestation(input: AttestationInput): AttestationResult {
  const { action, clearance, limits } = input;
  const problems: string[] = [];
  if (input.claimedDigest.toLowerCase() !== input.computedDigest.toLowerCase()) {
    problems.push("The digest isn't the one this clearance produces");
  }
  const id = poolId(action.pool);
  if (!limits.allowedPools.includes(id.toLowerCase() as Hex)) problems.push("The owner hasn't approved this pool");
  for (const token of [action.pool.currency0, action.pool.currency1]) {
    if (!limits.allowedTokens.some((allowed) => isAddressEqual(allowed, token))) problems.push(`${token} isn't on the owner's token list`);
  }
  if (!isAddressEqual(clearance.agent, action.account)) problems.push("Clearance agent isn't the action's account");
  if (!isAddressEqual(limits.account, action.account)) problems.push("ENS record binds this name to another account");
  if (clearance.poolId !== id) problems.push("Clearance pool isn't the action's pool");
  if (clearance.zeroForOne !== action.zeroForOne) problems.push("Clearance direction isn't the action's direction");
  if (clearance.chainId !== input.chainId) problems.push("Clearance is for another chain");
  if (clearance.expiry <= input.now) problems.push("Clearance has expired");
  if (BigInt(clearance.maxAmountIn) > BigInt(action.amountIn)) problems.push("Cleared amount is above the request");
  if (clearance.inputsHash !== inputsHash(action, limits)) problems.push("Owner limits changed since the clearance");
  if (!input.quorum) problems.push("Signatures don't reach quorum on the chain");
  if (input.impactBps === undefined) problems.push("Market re-check failed");
  else if (input.impactBps > limits.maxImpactBps) {
    problems.push(`Price impact is now ${input.impactBps} bps against a limit of ${limits.maxImpactBps}`);
  }
  if (input.market && input.market.deviationBps > input.market.maxDeviationBps) {
    problems.push(`Price sources disagree by ${input.market.deviationBps} bps against a limit of ${input.market.maxDeviationBps}`);
  }
  return { status: problems.length === 0 ? ATTESTED : REFUSED, problems, impactBps: input.impactBps ?? 0 };
}

/** One external source's price in micro-USD, or why there's no usable one. */
export type PriceReading = { source: string; required: boolean; microUsd?: bigint; problem?: string };

export type SourceComparison =
  | { ok: true; deviationBps: number; maxDeviationBps: number; used: string[] }
  | { ok: false; problem: string };

/** Fails closed: a missing required source, too few readings or a bad threshold means no verdict at all. */
export function compareSources(readings: PriceReading[], maxDeviationBps: unknown): SourceComparison {
  if (typeof maxDeviationBps !== "number" || !Number.isInteger(maxDeviationBps) || maxDeviationBps <= 0) {
    return { ok: false, problem: "The source deviation limit isn't configured" };
  }
  const missing = readings.filter((r) => r.required && r.microUsd === undefined);
  if (missing.length > 0) {
    return { ok: false, problem: `Required price sources are missing: ${missing.map((r) => `${r.source} (${r.problem ?? "no price"})`).join(", ")}` };
  }
  const usable = readings.filter((r) => r.microUsd !== undefined && r.microUsd > 0n);
  if (usable.length < 2) return { ok: false, problem: `Only ${usable.length} price source answered, and at least 2 must` };
  const prices = usable.map((r) => r.microUsd!);
  const low = prices.reduce((a, b) => (b < a ? b : a));
  const high = prices.reduce((a, b) => (b > a ? b : a));
  return { ok: true, deviationBps: Number(((high - low) * 10_000n) / low), maxDeviationBps, used: usable.map((r) => r.source) };
}

export function encodeAttestationReport(digest: Hex, result: AttestationResult, clearanceInputsHash: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint32" }, { type: "bytes32" }],
    [digest, result.status, Math.min(result.impactBps, 2 ** 32 - 1), clearanceInputsHash],
  );
}
