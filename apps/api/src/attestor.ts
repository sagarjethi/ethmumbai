import {
  ATTESTED,
  encodeAttestationReport,
  evaluateAttestation,
  hookAbi,
  ledgerAbi,
  parseLimits,
  readAgentRecords,
  quoterAbi,
  stateViewAbi,
  verifierSetAbi,
  type ClearanceRecord,
  type Deployment,
  type SwapAction,
} from "@clearance/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Hex, PublicClient, WalletClient } from "viem";

export type AttestationOutcome = {
  mode: "local-attestor" | "cre-simulation";
  status: "attested" | "refused" | "failed";
  problems: string[];
  impactBps?: number;
  txHash?: Hex;
  at: number;
};

export type AttestRequest = {
  decisionId: string;
  digest: Hex;
  action: SwapAction;
  clearance: ClearanceRecord;
  signatures: Hex[];
};

export interface Attestor {
  attest(request: AttestRequest): Promise<AttestationOutcome>;
}

const Q192 = 2n ** 192n;

/** The CRE workflow's on-chain checks, run in-process so local mode needs no CRE account. External price sources need CRE secrets, so they run only in the workflow. */
export class LocalAttestor implements Attestor {
  constructor(
    private client: PublicClient,
    private wallet: WalletClient,
    private deployment: Deployment,
  ) {}

  private async impactBps(request: AttestRequest): Promise<number | undefined> {
    const { client, deployment } = this;
    const { action, clearance } = request;
    try {
      const [sqrtPriceX96] = await client.readContract({
        address: deployment.stateView,
        abi: stateViewAbi,
        functionName: "getSlot0",
        args: [clearance.poolId],
      });
      const amountIn = BigInt(clearance.maxAmountIn);
      const { result } = await client.simulateContract({
        address: deployment.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: action.pool, zeroForOne: action.zeroForOne, exactAmount: amountIn, hookData: "0x" }],
      });
      const price = sqrtPriceX96 * sqrtPriceX96;
      const ideal = action.zeroForOne ? (amountIn * price) / Q192 : (amountIn * Q192) / price;
      if (ideal === 0n) return undefined;
      return result[0] >= ideal ? 0 : Number(((ideal - result[0]) * 10_000n) / ideal);
    } catch {
      return undefined;
    }
  }

  async attest(request: AttestRequest): Promise<AttestationOutcome> {
    const { client, wallet, deployment } = this;
    const at = Math.floor(Date.now() / 1000);
    try {
      const limits = parseLimits(await readAgentRecords(client, deployment.resolver, request.action.agentName));
      const [computedDigest, quorum, impactBps] = await Promise.all([
        client.readContract({
          address: deployment.hook,
          abi: hookAbi,
          functionName: "clearanceDigest",
          args: [
            {
              ...request.clearance,
              maxAmountIn: BigInt(request.clearance.maxAmountIn),
              minAmountOut: BigInt(request.clearance.minAmountOut),
              expiry: BigInt(request.clearance.expiry),
              chainId: BigInt(request.clearance.chainId),
              nonce: BigInt(request.clearance.nonce),
            },
          ],
        }),
        client.readContract({
          address: deployment.verifierSet,
          abi: verifierSetAbi,
          functionName: "hasQuorum",
          args: [request.digest, request.signatures],
        }),
        this.impactBps(request),
      ]);
      const result = evaluateAttestation({
        action: request.action,
        clearance: request.clearance,
        limits,
        quorum,
        claimedDigest: request.digest,
        computedDigest,
        impactBps,
        now: at,
        chainId: deployment.chainId,
      });
      const report = encodeAttestationReport(request.digest, result, request.clearance.inputsHash);
      const hash = await wallet.writeContract({
        address: deployment.ledger,
        abi: ledgerAbi,
        functionName: "onReport",
        args: ["0x", report],
        account: wallet.account!,
        chain: wallet.chain,
      });
      await client.waitForTransactionReceipt({ hash });
      return {
        mode: "local-attestor",
        status: result.status === ATTESTED ? "attested" : "refused",
        problems: result.problems,
        impactBps: result.impactBps,
        txHash: hash,
        at,
      };
    } catch (error) {
      return { mode: "local-attestor", status: "failed", problems: [(error as Error).message.split("\n")[0] ?? "failed"], at };
    }
  }
}

const execFileAsync = promisify(execFile);

/** Runs the real CRE workflow through `cre workflow simulate --broadcast`. Needs `cre login` first. */
export class CreSimulationAttestor implements Attestor {
  constructor(
    private config: { workflowDir: string; projectRoot: string; client: PublicClient; ledger: `0x${string}`; creBin?: string },
  ) {}

  async attest(request: AttestRequest): Promise<AttestationOutcome> {
    const at = Math.floor(Date.now() / 1000);
    try {
      const { stdout } = await execFileAsync(
        this.config.creBin ?? "cre",
        [
          "workflow",
          "simulate",
          this.config.workflowDir,
          "--target",
          "local-simulation",
          "--non-interactive",
          "--trigger-index",
          "0",
          "--http-payload",
          JSON.stringify({ decisionId: request.decisionId }),
          "--broadcast",
        ],
        { cwd: this.config.projectRoot, timeout: 180_000 },
      );
      const txHash = stdout.match(/0x[0-9a-f]{64}/)?.[0] as Hex | undefined;
      const [status, , impactBps] = await this.config.client.readContract({
        address: this.config.ledger,
        abi: ledgerAbi,
        functionName: "attestations",
        args: [request.digest],
      });
      if (status === 0) return { mode: "cre-simulation", status: "failed", problems: ["The workflow wrote no report"], txHash, at };
      return { mode: "cre-simulation", status: status === ATTESTED ? "attested" : "refused", problems: [], impactBps, txHash, at };
    } catch (error) {
      return { mode: "cre-simulation", status: "failed", problems: [(error as Error).message.split("\n")[0] ?? "failed"], at };
    }
  }
}
