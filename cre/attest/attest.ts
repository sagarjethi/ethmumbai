import {
  LATEST_BLOCK_NUMBER,
  bytesToHex,
  consensusIdenticalAggregation,
  consensusMedianAggregation,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  ok,
  text,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, parseAbi, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { compareSources, encodeAttestationReport, evaluateAttestation, type ClearanceRecord, type PriceReading } from "../../packages/shared/src/attestation";
import type { SwapAction } from "../../packages/shared/src/actions";
import { decodeTextLookup, resolveAbi, textLookupArgs } from "../../packages/shared/src/ensv2";
import { parseLimits, RECORD_KEYS, type RawRecords } from "../../packages/shared/src/limits";

export type Config = {
  schedule: string;
  apiUrl: string;
  chainSelectorName: string;
  chainId: number;
  gasLimit: string;
  resolver: Address;
  hook: Address;
  verifierSet: Address;
  quoter: Address;
  stateView: Address;
  ledger: Address;
  /** The widest spread allowed between external ETH/USD sources. */
  maxSourceDeviationBps: number;
};

type Proof = {
  id: string;
  action: SwapAction;
  clearance?: ClearanceRecord;
  signatures?: Hex[];
  digest?: Hex;
};

const hookAbi = parseAbi([
  "function clearanceDigest((address agent,bytes32 poolId,bool zeroForOne,uint256 maxAmountIn,uint256 minAmountOut,uint64 expiry,uint64 chainId,uint256 nonce,bytes32 inputsHash) c) view returns (bytes32)",
]);
const verifierSetAbi = parseAbi(["function hasQuorum(bytes32 digest, bytes[] signatures) view returns (bool)"]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);
const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

const Q192 = 2n ** 192n;

function evmClient(config: Config) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`Unknown chain ${config.chainSelectorName}`);
  return new cre.capabilities.EVMClient(network.chainSelector.selector);
}

function read<const TAbi extends Abi>(
  runtime: Runtime<Config>,
  client: ReturnType<typeof evmClient>,
  to: Address,
  abi: TAbi,
  functionName: string,
  args: readonly unknown[],
): unknown {
  const data = encodeFunctionData({ abi: abi as Abi, functionName, args });
  const reply = client
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to, data }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  return decodeFunctionResult({ abi: abi as Abi, functionName, data: bytesToHex(reply.data) });
}

function fetchText(runtime: Runtime<Config>, url: string): string {
  const http = new cre.capabilities.HTTPClient();
  return http
    .sendRequest(
      runtime,
      (sender, target: string) => {
        const response = sender.sendRequest({ url: target, method: "GET" }).result();
        if (!ok(response)) throw new Error(`${target} returned ${response.statusCode}`);
        return text(response);
      },
      consensusIdenticalAggregation<string>(),
    )(url)
    .result();
}

type PriceSource = {
  name: string;
  /** The ID in secrets.yaml, for sources that need a key. */
  secretId?: string;
  keyHeader?: string;
  required: boolean;
  url: string;
  price: (body: any) => unknown;
};

/** ETH/USD, because testnet pool tokens have no market of their own. The keys live in CRE secrets, never in config. */
export const PRICE_SOURCES: PriceSource[] = [
  {
    name: "coingecko",
    secretId: "COINGECKO_API_KEY",
    keyHeader: "x-cg-demo-api-key",
    required: true,
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    price: (body) => body?.ethereum?.usd,
  },
  {
    name: "coinmarketcap",
    secretId: "COINMARKETCAP_API_KEY",
    keyHeader: "X-CMC_PRO_API_KEY",
    required: true,
    url: "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=1027&convert=USD",
    price: (body) => body?.data?.["1027"]?.quote?.USD?.price,
  },
  {
    name: "coinbase",
    required: false,
    url: "https://api.coinbase.com/v2/prices/ETH-USD/spot",
    price: (body) => (body?.data?.base === "ETH" && body?.data?.currency === "USD" ? body.data.amount : undefined),
  },
];

function toMicroUsd(value: unknown): bigint {
  const price = typeof value === "string" ? Number(value) : value;
  if (typeof price !== "number" || !Number.isFinite(price)) throw new Error("no valid price in the reply");
  const microUsd = BigInt(Math.round(price * 1_000_000));
  if (microUsd <= 0n) throw new Error("no valid price in the reply");
  return microUsd;
}

/** Each node fetches on its own and the DON takes the median, since prices differ between requests. */
function readSource(runtime: Runtime<Config>, source: PriceSource): PriceReading {
  const { name, required } = source;
  let apiKey: string | undefined;
  if (source.secretId) {
    try {
      apiKey = runtime.getSecret({ id: source.secretId }).result().value;
    } catch {
      return { source: name, required, problem: `secret ${source.secretId} is missing` };
    }
    if (!apiKey) return { source: name, required, problem: `secret ${source.secretId} is empty` };
  }
  try {
    const http = new cre.capabilities.HTTPClient();
    const microUsd = http
      .sendRequest(
        runtime,
        (sender, key: string) => {
          const response = sender
            .sendRequest({
              url: source.url,
              method: "GET",
              multiHeaders: source.keyHeader ? { [source.keyHeader]: { values: [key] } } : {},
            })
            .result();
          if (!ok(response)) throw new Error(`status ${response.statusCode}`);
          return toMicroUsd(source.price(JSON.parse(text(response))));
        },
        consensusMedianAggregation<bigint>(),
      )(apiKey ?? "")
      .result();
    return { source: name, required, microUsd };
  } catch (error) {
    // Only the message of an error thrown above, or the capability's own, and neither holds the key.
    return { source: name, required, problem: (error as Error).message };
  }
}

/** Every node re-derives the facts from the chain. The API only supplies what to check. */
export function attestDecision(runtime: Runtime<Config>, decisionId: string): string {
  const config = runtime.config;
  const proof = JSON.parse(fetchText(runtime, `${config.apiUrl}/v1/proofs/${decisionId}`)) as Proof;
  if (proof.action.kind !== "swap" || !proof.clearance || !proof.signatures || !proof.digest) {
    runtime.log(`Decision ${decisionId} has no clearance to attest`);
    return "nothing to attest";
  }

  // Not being able to check isn't a finding. No report is written, so the hook keeps refusing and a later run can retry.
  const market = compareSources(PRICE_SOURCES.map((source) => readSource(runtime, source)), config.maxSourceDeviationBps);
  if (!market.ok) {
    runtime.log(`Decision ${decisionId}: no attestation. ${market.problem}`);
    return `no attestation: ${market.problem}`;
  }
  runtime.log(`Price sources ${market.used.join(", ")} agree within ${market.deviationBps} bps`);

  const client = evmClient(config);

  const records = Object.fromEntries(
    Object.entries(RECORD_KEYS).map(([field, key]) => [
      field,
      decodeTextLookup(read(runtime, client, config.resolver, resolveAbi, "resolve", textLookupArgs(proof.action.agentName, key)) as Hex),
    ]),
  ) as RawRecords;
  const limits = parseLimits(records);

  const quorum = read(runtime, client, config.verifierSet, verifierSetAbi, "hasQuorum", [proof.digest, proof.signatures]) as boolean;

  const computedDigest = read(runtime, client, config.hook, hookAbi, "clearanceDigest", [
    {
      ...proof.clearance,
      maxAmountIn: BigInt(proof.clearance.maxAmountIn),
      minAmountOut: BigInt(proof.clearance.minAmountOut),
      expiry: BigInt(proof.clearance.expiry),
      chainId: BigInt(proof.clearance.chainId),
      nonce: BigInt(proof.clearance.nonce),
    },
  ]) as Hex;

  let impactBps: number | undefined;
  try {
    const slot0 = read(runtime, client, config.stateView, stateViewAbi, "getSlot0", [proof.clearance.poolId]) as readonly [bigint, ...unknown[]];
    const amountIn = BigInt(proof.clearance.maxAmountIn);
    const quote = read(runtime, client, config.quoter, quoterAbi, "quoteExactInputSingle", [
      { poolKey: proof.action.pool, zeroForOne: proof.action.zeroForOne, exactAmount: amountIn, hookData: "0x" },
    ]) as readonly [bigint, bigint];
    const price = slot0[0] * slot0[0];
    const ideal = proof.action.zeroForOne ? (amountIn * price) / Q192 : (amountIn * Q192) / price;
    impactBps = ideal === 0n ? undefined : quote[0] >= ideal ? 0 : Number(((ideal - quote[0]) * 10_000n) / ideal);
  } catch (error) {
    runtime.log(`Market re-check failed: ${(error as Error).message}`);
  }

  const result = evaluateAttestation({
    action: proof.action,
    clearance: proof.clearance,
    limits,
    quorum,
    claimedDigest: proof.digest,
    computedDigest,
    impactBps,
    market: { deviationBps: market.deviationBps, maxDeviationBps: market.maxDeviationBps },
    now: Math.floor(runtime.now().getTime() / 1000),
    chainId: config.chainId,
  });
  runtime.log(`Decision ${decisionId}: status ${result.status}. ${result.problems.join("; ") || "All checks passed"}`);

  const payload = encodeAttestationReport(proof.digest, result, proof.clearance.inputsHash);
  const report = runtime
    .report({
      encodedPayload: hexToBase64(payload),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();
  const write = client
    .writeReport(runtime, {
      receiver: config.ledger,
      report,
      gasConfig: { gasLimit: config.gasLimit },
    })
    .result();
  const txHash = write.txHash ? bytesToHex(write.txHash) : "none";
  runtime.log(`Report written in ${txHash}`);
  return txHash;
}

/** The scheduled path: finds the oldest clearance still waiting for a check, so none get missed. */
export function attestNextPending(runtime: Runtime<Config>): string {
  const pending = JSON.parse(fetchText(runtime, `${runtime.config.apiUrl}/v1/attestations/pending`)) as { ids: string[] };
  const next = pending.ids[0];
  if (!next) {
    runtime.log("No clearances are waiting");
    return "idle";
  }
  return attestDecision(runtime, next);
}
