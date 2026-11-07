import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const address = z.string().refine((v) => isAddress(v), "invalid address").transform((v) => getAddress(v) as Address);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((v) => v as Hex);
const uint = z.string().regex(/^\d{1,78}$/, "must be a decimal integer string");

export const poolKeySchema = z.object({
  currency0: address,
  currency1: address,
  fee: z.number().int().min(0).max(1_000_000),
  tickSpacing: z.number().int().min(1).max(32767),
  hooks: address,
});
export type PoolKey = z.infer<typeof poolKeySchema>;

export const swapActionSchema = z.object({
  kind: z.literal("swap"),
  agentName: z.string().min(3).max(255),
  account: address,
  pool: poolKeySchema,
  zeroForOne: z.boolean(),
  amountIn: uint,
  /** The agent's stated reason. Untrusted: it reaches models as data and never reaches rules. */
  reason: z.string().max(2000).optional(),
});
export type SwapAction = z.infer<typeof swapActionSchema>;

export const authorizationSchema = z.object({
  from: address,
  to: address,
  value: uint,
  validAfter: uint,
  validBefore: uint,
  nonce: hex32,
});
export type Authorization = z.infer<typeof authorizationSchema>;

export const paymentActionSchema = z.object({
  kind: z.literal("payment"),
  agentName: z.string().min(3).max(255),
  account: address,
  token: address,
  tokenName: z.string().max(64),
  tokenVersion: z.string().max(16),
  authorization: authorizationSchema,
  reason: z.string().max(2000).optional(),
});
export type PaymentAction = z.infer<typeof paymentActionSchema>;

export const actionSchema = z.discriminatedUnion("kind", [swapActionSchema, paymentActionSchema]);
export type Action = z.infer<typeof actionSchema>;

export const humanProofSchema = z.object({
  idToken: z.string().max(8192),
  salt: hex32,
});
export type HumanProof = z.infer<typeof humanProofSchema>;

export type Verdict = "ALLOW" | "REDUCE" | "BLOCK" | "HUMAN_REQUIRED";
export type ReasonSeverity = "block" | "reduce" | "human" | "info";

export type Reason = {
  code: string;
  severity: ReasonSeverity;
  detail: string;
  source?: string;
};

/** What 0G's Router reports about the run behind a review. */
export type ModelTrace = {
  requestId?: string;
  /** The id 0G's SDK needs to check the TEE signature independently of the Router. */
  chatId?: string;
  /** Onchain address of the 0G provider that served the request. */
  servedBy?: string;
  /** The Router's own check of the TEE signature. Absent means no check was reported. */
  teeVerified?: boolean;
};

export type ModelReview = {
  status: "not_configured" | "ok" | "failed";
  provider: string;
  model?: string;
  summary?: string;
  veto?: boolean;
  error?: string;
  trace?: ModelTrace;
};

export type Evaluation = {
  verifier: Address;
  verdict: Verdict;
  /** The most this verifier will sign for. "0" unless the verdict is ALLOW or REDUCE. */
  maxAmount: string;
  /** The least this verifier accepts for `maxAmount`. "0" unless the verdict is ALLOW or REDUCE. */
  minAmountOut: string;
  reasons: Reason[];
  evidenceHash: Hex;
  review: ModelReview;
  evaluatedAt: number;
};
