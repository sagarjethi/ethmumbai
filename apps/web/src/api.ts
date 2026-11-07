export type Reason = { code: string; severity: string; detail: string; source?: string };
export type Evaluation = {
  verifier: string;
  verdict: string;
  maxAmount: string;
  reasons: Reason[];
  evidenceHash: string;
  review: { status: string; provider: string; model?: string; summary?: string; veto?: boolean; error?: string; trace?: { requestId?: string } };
};
export type Decision = {
  id: string;
  verdict: "ALLOW" | "REDUCE" | "BLOCK" | "HUMAN_REQUIRED";
  action: any;
  requested: string;
  required: number;
  evaluations: Evaluation[];
  unreachable: string[];
  clearance?: { maxAmountIn: string; expiry: number; nonce: string; inputsHash: string; poolId: string };
  signatures?: string[];
  verifierSignatures?: unknown[];
  digest?: string;
  attestationRequired?: boolean;
  attestation?: { status: string; mode: string; txHash?: string; problems: string[] };
  checkpoint?: { id: string; url: string };
  decidedAt: number;
};
export type Outcome = { scenario?: string; label: string; result: "executed" | "reverted" | "refused"; detail: string; txHash?: string; decisionId?: string };
export type CheckpointEvent = { id: string; status: string; detail?: string; decisionId?: string; action?: any };
export type FeedEvent = { id: number; at: number } & (
  | { type: "decision"; data: Decision & { checkpoint?: { id: string; url: string } } }
  | { type: "outcome"; data: Outcome }
  | { type: "checkpoint"; data: CheckpointEvent }
);
export type AgentInfo = {
  name: string;
  account: string;
  chainId: number;
  hook: string;
  ledger: string;
  tokens: Record<string, { symbol: string; decimals: number }>;
  limits: null | {
    account: string;
    maxSizeUsd: number;
    humanCapUsd: number;
    maxImpactBps: number;
    requiredVerifiers: number;
    allowedTokens: string[];
    allowedPools: string[];
    dailyPaymentUsd: number;
    maxPaymentUsd: number;
    allowedPayees: string[];
    ownerSub: string;
  };
  balances: { symbol: string; decimals: number; raw: string }[];
  threshold: number;
  verifierCount: number;
  canEditLimits: boolean;
};
export type ApiKey = { id: string; name: string; hint: string; createdAt: number; lastUsedAt?: number; revokedAt?: number; secret?: string };
export type RequestRecord = {
  id: number;
  at: number;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  auth: string;
  keyId?: string;
  verdict?: string;
  decisionId?: string;
};
export type Usage = { last15m: number; last24h: number; last30d: number; monthlyQuota: number; hourly: { hour: number; cleared: number; refused: number; other: number }[] };
export type ScenarioInfo = {
  id: string;
  title: string;
  description: string;
  waitsForOwner: boolean;
  result?: { pass: boolean; error?: string; checks: { label: string; pass: boolean; detail: string }[] };
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
  return body as T;
}

export async function runner<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/runner${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
  return body as T;
}

export function formatAmount(raw: string | bigint, decimals: number): string {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 6 : 2 });
}

export function short(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

export function describeAction(action: any, tokens: AgentInfo["tokens"]): { verb: string; amount: string; detail: string } {
  const symbol = (address: string) => tokens[address]?.symbol ?? short(address);
  const decimals = (address: string) => tokens[address]?.decimals ?? 18;
  if (action.kind === "payment") {
    return {
      verb: "Pay",
      amount: `${formatAmount(action.authorization.value, 6)} USDC`,
      detail: `to ${short(action.authorization.to)}`,
    };
  }
  const tokenIn = action.zeroForOne ? action.pool.currency0 : action.pool.currency1;
  const tokenOut = action.zeroForOne ? action.pool.currency1 : action.pool.currency0;
  return {
    verb: "Swap",
    amount: `${formatAmount(action.amountIn, decimals(tokenIn))} ${symbol(tokenIn)}`,
    detail: `for ${symbol(tokenOut)}`,
  };
}

export const VERDICT_LABEL: Record<string, string> = {
  ALLOW: "Cleared",
  REDUCE: "Cleared, reduced",
  BLOCK: "Refused",
  HUMAN_REQUIRED: "Needs owner",
};
export const VERDICT_CLASS: Record<string, string> = { ALLOW: "ok", REDUCE: "warn", BLOCK: "bad", HUMAN_REQUIRED: "human" };
