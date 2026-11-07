import {
  accountAbi,
  hookAbi,
  packPaymentSignature,
  routerAbi,
  type Deployment,
  type ModelReview,
  type PaymentAction,
  type PoolKey,
  type SwapAction,
} from "@clearance/shared";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export type DecisionResponse = {
  id: string;
  verdict: "ALLOW" | "REDUCE" | "BLOCK" | "HUMAN_REQUIRED";
  requested: string;
  required: number;
  hookData?: Hex;
  clearance?: { maxAmountIn: string; minAmountOut: string; expiry: number; nonce: string };
  attestationRequired?: boolean;
  verifierSignatures?: { signer: Address; signature: Hex }[];
  evaluations: { verifier: Address; verdict: string; maxAmount: string; minAmountOut: string; reasons: { code: string; detail: string }[]; review: ModelReview }[];
  checkpoint?: { id: string; url: string };
  error?: string;
};

export type TxResult =
  | { status: "executed"; hash: Hex }
  | { status: "reverted"; reason: string; hash?: Hex };

const wrappedErrorAbi = parseAbi(["error WrappedError(address target, bytes4 selector, bytes reason, bytes details)"]);

/** Finds the hook's real reason inside v4's WrappedError, or the contract's own error. */
export function revertReason(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const data = reverted.data;
      if (data?.errorName === "WrappedError") {
        const reason = data.args?.[2] as Hex;
        try {
          return decodeErrorResult({ abi: hookAbi, data: reason }).errorName;
        } catch {
          return "WrappedError";
        }
      }
      if (data?.errorName) return data.errorName;
      const raw = reverted.raw;
      if (raw) {
        try {
          const wrapped = decodeErrorResult({ abi: wrappedErrorAbi, data: raw });
          return decodeErrorResult({ abi: hookAbi, data: wrapped.args[2] as Hex }).errorName;
        } catch {
          return raw.slice(0, 10);
        }
      }
    }
    return error.shortMessage;
  }
  return (error as Error).message;
}

const allAbi = [...accountAbi, ...routerAbi, ...hookAbi, ...wrappedErrorAbi] as const;

export type AgentConfig = {
  apiUrl: string;
  rpcUrl: string;
  deployment: Deployment;
  agentKey: Hex;
  reportToken?: string;
  apiKey?: string;
};

export class Agent {
  readonly key: PrivateKeyAccount;
  readonly client: PublicClient;
  readonly deployment: Deployment;
  private paidFetch: typeof fetch;

  constructor(private config: AgentConfig) {
    this.key = privateKeyToAccount(config.agentKey);
    this.client = createPublicClient({ transport: http(config.rpcUrl) });
    this.deployment = config.deployment;
    const payments = new x402Client()
      .register(`eip155:${this.deployment.chainId}`, new ExactEvmScheme(this.paymentSigner()))
      .setSpendControls({
        allowedAssets: [
          { network: `eip155:${this.deployment.chainId}`, asset: this.deployment.usdc, maxAmountPerPayment: "1000000" },
        ],
      });
    this.paidFetch = wrapFetchWithPayment(fetch, payments);
  }

  /** The x402 client calls this for each attempt. It's where verifiers get asked to clear the payment. */
  private paymentSigner() {
    const { deployment, key } = this;
    return {
      address: deployment.account,
      signTypedData: async (typed: {
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
      }): Promise<Hex> => {
        const m = typed.message;
        const action: PaymentAction = {
          kind: "payment",
          agentName: deployment.agentName,
          account: deployment.account,
          token: typed.domain.verifyingContract as Address,
          tokenName: String(typed.domain.name),
          tokenVersion: String(typed.domain.version),
          authorization: {
            from: m.from as Address,
            to: m.to as Address,
            value: String(m.value),
            validAfter: String(m.validAfter),
            validBefore: String(m.validBefore),
            nonce: m.nonce as Hex,
          },
          reason: "Pay for a clearance check",
        };
        const agentSignature = await key.signTypedData(typed as never);
        const decision = await this.clearPayment(action, agentSignature);
        if (decision.verdict !== "ALLOW" || !decision.verifierSignatures) {
          throw new PaymentRefused(decision);
        }
        return packPaymentSignature(agentSignature, decision.verifierSignatures);
      },
    };
  }

  private async asJson(response: Response): Promise<DecisionResponse> {
    const body = (await response.json().catch(() => ({}))) as DecisionResponse;
    if (!response.ok) throw new Error(`API returned ${response.status}: ${body.error ?? JSON.stringify(body).slice(0, 200)}`);
    return body;
  }

  /** Paid through x402 when the API charges for checks. */
  async clearSwap(action: SwapAction, checkpointId?: string): Promise<DecisionResponse> {
    return this.asJson(
      await (this.config.apiKey ? fetch : this.paidFetch)(`${this.config.apiUrl}/v1/clear/swap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ action, checkpointId }),
      }),
    );
  }

  /** Asks for the independent check that large clearances need before the hook accepts them. */
  async attest(decisionId: string): Promise<{ status: string; problems: string[]; txHash?: Hex; mode: string }> {
    const response = await fetch(`${this.config.apiUrl}/v1/decisions/${decisionId}/attest`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(`Attestation failed: ${JSON.stringify(body)}`);
    return body;
  }

  async clearPayment(action: PaymentAction, agentSignature: Hex): Promise<DecisionResponse> {
    return this.asJson(
      await fetch(`${this.config.apiUrl}/v1/clear/payment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, agentSignature }),
      }),
    );
  }

  swapAction(pool: PoolKey, zeroForOne: boolean, amountIn: bigint, reason?: string): SwapAction {
    return {
      kind: "swap",
      agentName: this.deployment.agentName,
      account: this.deployment.account,
      pool,
      zeroForOne,
      amountIn: amountIn.toString(),
      reason,
    };
  }

  /** Sends a real transaction even when it will revert, so the refusal is on the chain to inspect. */
  private async send(from: PrivateKeyAccount, to: Address, data: Hex): Promise<TxResult> {
    let reason: string | undefined;
    try {
      await this.client.call({ account: from, to, data });
    } catch (error) {
      reason = await this.decodeCallError(error, from, to, data);
    }
    const wallet = createWalletClient({
      account: from,
      chain: {
        id: this.deployment.chainId,
        name: "clearance",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [this.config.rpcUrl] } },
      },
      transport: http(this.config.rpcUrl),
    });
    const hash = await wallet.sendTransaction({ to, data, gas: 2_000_000n });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") return { status: "executed", hash };
    return { status: "reverted", reason: reason ?? "reverted", hash };
  }

  private async decodeCallError(error: unknown, _from: PrivateKeyAccount, _to: Address, _data: Hex): Promise<string> {
    let raw: Hex | undefined;
    if (error instanceof BaseError) {
      const withData = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
      raw = withData?.data;
    }
    if (!raw) return revertReason(error);
    try {
      const decoded = decodeErrorResult({ abi: allAbi, data: raw });
      if (decoded.errorName === "WrappedError") {
        return decodeErrorResult({ abi: hookAbi, data: decoded.args[2] as Hex }).errorName;
      }
      return decoded.errorName;
    } catch {
      return raw.slice(0, 10);
    }
  }

  /** The only path the agent key has to move funds. */
  swap(pool: PoolKey, zeroForOne: boolean, amountIn: bigint, hookData: Hex = "0x"): Promise<TxResult> {
    return this.send(
      this.key,
      this.deployment.account,
      encodeFunctionData({ abi: accountAbi, functionName: "swapCleared", args: [pool, zeroForOne, amountIn, 0n, hookData] }),
    );
  }

  /** What a compromised agent would try: moving tokens straight out of the wallet. */
  drain(token: Address, to: Address, amount: bigint): Promise<TxResult> {
    const transfer = encodeFunctionData({
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [to, amount],
    });
    return this.send(
      this.key,
      this.deployment.account,
      encodeFunctionData({ abi: accountAbi, functionName: "execute", args: [token, 0n, transfer] }),
    );
  }

  /** What a thief does with a copied clearance: calling the router from their own address. */
  swapFrom(thief: PrivateKeyAccount, pool: PoolKey, zeroForOne: boolean, amountIn: bigint, hookData: Hex): Promise<TxResult> {
    return this.send(
      thief,
      this.deployment.router,
      encodeFunctionData({ abi: routerAbi, functionName: "swapExactIn", args: [pool, zeroForOne, amountIn, 0n, hookData, thief.address] }),
    );
  }

  async report(outcome: {
    scenario?: string;
    label: string;
    result: "executed" | "reverted" | "refused";
    detail: string;
    txHash?: string;
    decisionId?: string;
  }): Promise<void> {
    if (!this.config.reportToken) return;
    await fetch(`${this.config.apiUrl}/v1/outcomes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.reportToken}` },
      body: JSON.stringify(outcome),
    }).catch(() => undefined);
  }
}

export class PaymentRefused extends Error {
  constructor(readonly decision: DecisionResponse) {
    super(`Payment refused: ${decision.evaluations.flatMap((e) => e.reasons.map((r) => r.code)).join(", ") || decision.verdict}`);
  }
}
