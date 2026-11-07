import { describe, expect } from "bun:test";
import { bytesToHex, getNetwork } from "@chainlink/cre-sdk";
import { EvmMock, HttpActionsMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, parseAbi, toBytes, type Hex } from "viem";
import { attestDecision, attestNextPending, type Config } from "./attest";
import { inputsHash } from "../../packages/shared/src/canonical";
import { poolId } from "../../packages/shared/src/eip712";
import { resolveAbi } from "../../packages/shared/src/ensv2";
import { parseLimits, type RawRecords } from "../../packages/shared/src/limits";
import type { SwapAction } from "../../packages/shared/src/actions";

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const CURRENCY0 = "0x00000000000000000000000000000000000000c1" as const;
const CURRENCY1 = "0x00000000000000000000000000000000000000c2" as const;
const POOL_KEY = { currency0: CURRENCY0, currency1: CURRENCY1, fee: 3000, tickSpacing: 60, hooks: "0x00000000000000000000000000000000000000c3" as const };
const DIGEST = `0x${"ab".repeat(32)}` as const;
const records: RawRecords = {
  account: ACCOUNT,
  allowedPools: poolId(POOL_KEY),
  dailyPaymentUsd: "5",
  maxSizeUsd: "1000",
  humanCapUsd: "25000",
  maxImpactBps: "300",
  requiredVerifiers: "2",
  allowedTokens: `${CURRENCY0},${CURRENCY1}`,
  maxPaymentUsd: "1",
  allowedPayees: "",
  ownerSub: "owner",
};
const FIELD_BY_KEY = Object.fromEntries(Object.keys(records).map((f) => [`clearance.${f}`, f]));

const config: Config = {
  schedule: "0 * * * * *",
  apiUrl: "https://api.test",
  chainSelectorName: "ethereum-testnet-sepolia",
  chainId: 11155111,
  gasLimit: "500000",
  resolver: "0x00000000000000000000000000000000000000b1",
  hook: "0x00000000000000000000000000000000000000b6",
  verifierSet: "0x00000000000000000000000000000000000000b2",
  quoter: "0x00000000000000000000000000000000000000b3",
  stateView: "0x00000000000000000000000000000000000000b4",
  ledger: "0x00000000000000000000000000000000000000b5",
  maxSourceDeviationBps: 100,
};

const KEYS = { COINGECKO_API_KEY: "test-cg-key", COINMARKETCAP_API_KEY: "test-cmc-key" };

function runtimeWith(secrets: Record<string, string> = KEYS, overrides: Partial<Config> = {}) {
  const runtime = newTestRuntime(new Map([["main", new Map(Object.entries(secrets))]])) as any;
  runtime.config = { ...config, ...overrides };
  return runtime;
}

/** What each source's real API replies, shaped as its docs and live replies show. */
const REPLIES = {
  coingecko: (price: unknown) => ({ ethereum: { usd: price } }),
  coinmarketcap: (price: unknown) => ({ status: { error_code: 0 }, data: { "1027": { id: 1027, symbol: "ETH", quote: { USD: { price } } } } }),
  coinbase: (price: unknown) => ({ data: { amount: price, base: "ETH", currency: "USD" } }),
};
type Reply = { status?: number; body?: unknown; raw?: string };
const healthy: Record<keyof typeof REPLIES, Reply> = {
  coingecko: { body: REPLIES.coingecko(2245.36) },
  coinmarketcap: { body: REPLIES.coinmarketcap(2246.1) },
  coinbase: { body: REPLIES.coinbase("2245.365") },
};

const action: SwapAction = {
  kind: "swap",
  agentName: "alice.agents.clearance.eth",
  account: ACCOUNT,
  pool: POOL_KEY,
  zeroForOne: true,
  amountIn: "1000000",
};

function proofFor(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    action,
    digest: DIGEST,
    signatures: [`0x${"11".repeat(65)}`, `0x${"22".repeat(65)}`],
    clearance: {
      agent: ACCOUNT,
      poolId: poolId(action.pool),
      zeroForOne: true,
      maxAmountIn: "1000000",
      minAmountOut: "985000",
      expiry: Math.floor(Date.now() / 1000) + 60,
      chainId: 11155111,
      nonce: "1",
      inputsHash: inputsHash(action, parseLimits(records)),
    },
    ...overrides,
  };
}

function proofWithLimits(raw: RawRecords) {
  const proof = proofFor();
  return { ...proof, clearance: { ...proof.clearance, inputsHash: inputsHash(action, parseLimits(raw)) } };
}

const allAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function clearanceDigest((address agent,bytes32 poolId,bool zeroForOne,uint256 maxAmountIn,uint256 minAmountOut,uint64 expiry,uint64 chainId,uint256 nonce,bytes32 inputsHash) c) view returns (bytes32)",
  "function hasQuorum(bytes32 digest, bytes[] signatures) view returns (bool)",
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

type World = { computedDigest?: Hex; quorum?: boolean; quoteOut?: bigint; quoteFails?: boolean; records?: RawRecords; proof?: unknown; pending?: string[]; market?: Partial<typeof healthy> };

function setup(world: World) {
  const selector = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true })!.chainSelector.selector;
  const evm = EvmMock.testInstance(selector);
  let written: Hex | undefined;
  let receiver: Hex | undefined;
  const requests: any[] = [];
  let chainReads = 0;
  evm.callContract = (req: any) => {
    chainReads++;
    const data = bytesToHex(req.call.data) as Hex;
    const decoded = decodeFunctionData({ abi: allAbi, data });
    let result: Hex;
    if (decoded.functionName === "resolve") {
      const inner = decodeFunctionData({ abi: resolveAbi, data: decoded.args[1] as Hex });
      const key = inner.args[1] as string;
      const value = (world.records ?? records)[FIELD_BY_KEY[key] as keyof RawRecords];
      result = encodeFunctionResult({
        abi: allAbi,
        functionName: "resolve",
        result: encodeFunctionResult({ abi: resolveAbi, functionName: "text", result: value }),
      });
    } else if (decoded.functionName === "clearanceDigest") {
      result = encodeFunctionResult({ abi: allAbi, functionName: "clearanceDigest", result: world.computedDigest ?? DIGEST });
    } else if (decoded.functionName === "hasQuorum") {
      result = encodeFunctionResult({ abi: allAbi, functionName: "hasQuorum", result: world.quorum ?? true });
    } else if (decoded.functionName === "getSlot0") {
      result = encodeFunctionResult({ abi: allAbi, functionName: "getSlot0", result: [2n ** 96n, 0, 0, 3000] });
    } else {
      if (world.quoteFails) throw new Error("quote reverted");
      result = encodeFunctionResult({ abi: allAbi, functionName: "quoteExactInputSingle", result: [world.quoteOut ?? 995_000n, 1n] });
    }
    return { data: toBytes(result) } as any;
  };
  evm.writeReport = (req: any) => {
    receiver = bytesToHex(req.receiver) as Hex;
    written = bytesToHex(req.report.rawReport) as Hex;
    return { txStatus: "TX_STATUS_SUCCESS", txHash: toBytes(`0x${"cd".repeat(32)}`) } as any;
  };
  const http = HttpActionsMock.testInstance();
  http.sendRequest = (req: any) => {
    requests.push(req);
    const source = (Object.keys(REPLIES) as (keyof typeof REPLIES)[]).find((name) => req.url.includes(name));
    if (source) {
      const reply = { ...healthy, ...world.market }[source];
      const raw = reply.raw ?? JSON.stringify(reply.body);
      return { statusCode: reply.status ?? 200, body: new TextEncoder().encode(raw), headers: {} } as any;
    }
    const body = req.url.endsWith("/pending") ? { ids: world.pending ?? [] } : (world.proof ?? proofFor());
    return { statusCode: 200, body: new TextEncoder().encode(JSON.stringify(body)), headers: {} } as any;
  };
  return { written: () => written, receiver: () => receiver, requests, chainReads: () => chainReads };
}

/** The report's payload follows CRE's fixed metadata header, or stands alone in the test runtime. */
function statusOf(raw: Hex): number {
  const [, status] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint8" }, { type: "uint32" }, { type: "bytes32" }],
    `0x${raw.slice(-256)}` as Hex,
  );
  return status;
}

describe("attest workflow", () => {
  test("attests a clearance when limits, quorum and market all check out", () => {
    const m = setup({});
    const runtime = runtimeWith();
    expect(attestDecision(runtime, "d1")).toBe(`0x${"cd".repeat(32)}`);
    expect(statusOf(m.written()!)).toBe(1);
    expect(m.receiver()!.toLowerCase()).toBe(config.ledger.toLowerCase());
  });

  test("refuses when the proof's digest isn't this clearance's digest", () => {
    const m = setup({ computedDigest: `0x${"ee".repeat(32)}` });
    const runtime = runtimeWith();
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses a pool the owner hasn't approved", () => {
    const m = setup({ records: { ...records, allowedPools: "" }, proof: proofWithLimits({ ...records, allowedPools: "" }) });
    const runtime = runtimeWith();
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the chain says there is no quorum", () => {
    const m = setup({ quorum: false });
    const runtime = runtimeWith();
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the owner changed a limit since the clearance", () => {
    const m = setup({ records: { ...records, maxSizeUsd: "5" } });
    const runtime = runtimeWith();
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the market moved past the limit", () => {
    const m = setup({ quoteOut: 900_000n });
    const runtime = runtimeWith();
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("refuses when the market can't be re-checked", () => {
    const m = setup({ quoteFails: true });
    const runtime = runtimeWith();
    attestDecision(runtime, "d1");
    expect(statusOf(m.written()!)).toBe(2);
  });

  test("writes nothing for a decision with no clearance", () => {
    const m = setup({ proof: { id: "d2", action } });
    const runtime = runtimeWith();
    expect(attestDecision(runtime, "d2")).toBe("nothing to attest");
    expect(m.written()).toBeUndefined();
  });

  test("the scheduled path takes the next pending decision, and idles when there is none", () => {
    const m = setup({ pending: ["d1"] });
    const runtime = runtimeWith();
    expect(attestNextPending(runtime)).toBe(`0x${"cd".repeat(32)}`);
    expect(statusOf(m.written()!)).toBe(1);

    setup({ pending: [] });
    expect(attestNextPending(runtime)).toBe("idle");
  });

  describe("external price sources", () => {
    const expectNoAttestation = (result: string, m: ReturnType<typeof setup>, reason: string) => {
      expect(result).toStartWith("no attestation:");
      expect(result).toContain(reason);
      expect(m.written()).toBeUndefined();
    };

    test("attests when the sources agree, sending each key only to its own source", () => {
      const m = setup({});
      expect(attestDecision(runtimeWith(), "d1")).toBe(`0x${"cd".repeat(32)}`);
      expect(statusOf(m.written()!)).toBe(1);
      const headersFor = (name: string) => m.requests.find((r) => r.url.includes(name))?.multiHeaders;
      expect(headersFor("coingecko")["x-cg-demo-api-key"].values).toEqual([KEYS.COINGECKO_API_KEY]);
      expect(headersFor("coinmarketcap")["X-CMC_PRO_API_KEY"].values).toEqual([KEYS.COINMARKETCAP_API_KEY]);
      expect(Object.keys(headersFor("coinbase") ?? {})).toEqual([]);
    });

    test("still needs the chain's answers when the sources agree", () => {
      const m = setup({ quorum: false });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(m.written()!)).toBe(2);
      expect(m.chainReads()).toBe(15);
    });

    test("writes a refusal when two required sources disagree past the limit", () => {
      const m = setup({ market: { coinmarketcap: { body: REPLIES.coinmarketcap(2400) } } });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(m.written()!)).toBe(2);
    });

    test("writes a refusal when the optional source disagrees", () => {
      const m = setup({ market: { coinbase: { body: REPLIES.coinbase("3000") } } });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(m.written()!)).toBe(2);
    });

    test("attests at exactly the limit and refuses one step past it", () => {
      const at = setup({ market: { coingecko: { body: REPLIES.coingecko(2000) }, coinmarketcap: { body: REPLIES.coinmarketcap(2020) }, coinbase: { status: 503, raw: "" } } });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(at.written()!)).toBe(1);
      const past = setup({ market: { coingecko: { body: REPLIES.coingecko(2000) }, coinmarketcap: { body: REPLIES.coinmarketcap(2020.2) }, coinbase: { status: 503, raw: "" } } });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(past.written()!)).toBe(2);
    });

    test("writes nothing when a key is absent, and never reaches the chain", () => {
      for (const absent of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
        const m = setup({});
        const { [absent]: _dropped, ...rest } = KEYS;
        expectNoAttestation(attestDecision(runtimeWith(rest), "d1"), m, absent);
        expect(m.chainReads()).toBe(0);
      }
    });

    test("writes nothing when no keys are set at all", () => {
      const m = setup({});
      expectNoAttestation(attestDecision(runtimeWith({}), "d1"), m, "Required price sources are missing");
    });

    test("writes nothing when a key is empty", () => {
      const m = setup({});
      expectNoAttestation(attestDecision(runtimeWith({ ...KEYS, COINGECKO_API_KEY: "" }), "d1"), m, "COINGECKO_API_KEY is empty");
    });

    test("writes nothing when a required source rejects the key", () => {
      const m = setup({ market: { coinmarketcap: { status: 401, body: { status: { error_code: 1002 } } } } });
      expectNoAttestation(attestDecision(runtimeWith(), "d1"), m, "coinmarketcap");
    });

    const malformed: [string, Reply][] = [
      ["isn't JSON", { raw: "<html>rate limited</html>" }],
      ["has another shape", { body: { price: 2245 } }],
      ["has a zero price", { body: REPLIES.coingecko(0) }],
      ["has a negative price", { body: REPLIES.coingecko(-1) }],
      ["has a price that isn't a number", { body: REPLIES.coingecko("soon") }],
      ["has an empty price", { body: REPLIES.coingecko("") }],
      ["has a null price", { body: REPLIES.coingecko(null) }],
    ];
    for (const [what, reply] of malformed) {
      test(`writes nothing when a required source's reply ${what}`, () => {
        const m = setup({ market: { coingecko: reply } });
        expectNoAttestation(attestDecision(runtimeWith(), "d1"), m, "coingecko");
      });
    }

    test("carries on when only the optional source is down", () => {
      const m = setup({ market: { coinbase: { status: 503, raw: "" } } });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(m.written()!)).toBe(1);
    });

    test("ignores a Coinbase reply for another pair", () => {
      const m = setup({ market: { coinbase: { body: { data: { amount: "90000", base: "BTC", currency: "USD" } } } } });
      attestDecision(runtimeWith(), "d1");
      expect(statusOf(m.written()!)).toBe(1);
    });

    test("writes nothing when the limit isn't configured", () => {
      const m = setup({});
      const runtime = runtimeWith(KEYS, { maxSourceDeviationBps: undefined as never });
      expectNoAttestation(attestDecision(runtime, "d1"), m, "deviation limit");
    });

    test("never logs a key", () => {
      const m = setup({ market: { coinmarketcap: { status: 401, raw: "" } } });
      const runtime = runtimeWith();
      const result = attestDecision(runtime, "d1");
      const logged = [result, ...runtime.getLogs()].join("\n");
      for (const key of Object.values(KEYS)) expect(logged).not.toContain(key);
      expect(m.written()).toBeUndefined();
    });
  });
});
