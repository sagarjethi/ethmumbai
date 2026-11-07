/**
 * `pnpm cre:simulate` runs the real CRE workflow through `cre workflow simulate` against a real clearance.
 * Everything it touches is its own: a throwaway fork of Sepolia on a fixed port, a temporary database and
 * contracts deployed to that fork. The shared stack is never used, and a broadcast never leaves the fork.
 * `--prepare` stops before the CLI and checks the same clearance with the local attestor instead.
 */
import { LocalAttestor } from "@clearance/api";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Hex } from "viem";
import { ledgerAbi, type ClearanceRecord, type SwapAction } from "@clearance/shared";
import { startHarness } from "../tests/harness";
import { ACCOUNTS, ROOT, testKey } from "./local";

const prepareOnly = process.argv.includes("--prepare");
const CRE = process.env.CRE_BIN ?? resolve(homedir(), ".cre/bin/cre");
const CRE_ROOT = resolve(ROOT, "cre");
const FORK_PORT = 18645;
// CRE's MockKeystoneForwarder on Sepolia, from https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory
const MOCK_FORWARDER = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88";
const KEY_NAMES = ["COINGECKO_API_KEY"];
const OUTPUT = resolve(ROOT, "docs/cre-simulation.txt");
const STATUS = ["no report", "attested", "refused"];

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

function cre(args: string[], env: Record<string, string> = {}) {
  return spawnSync(CRE, args, { cwd: CRE_ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 170_000 });
}

/** Takes out every value the run was given, and the home directory, before anything is saved. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("<redacted>");
  return out.split(homedir()).join("~");
}

if (!existsSync(CRE)) fail(`No CRE CLI at ${CRE}. Install it, or set CRE_BIN.`);
if (!prepareOnly) {
  const whoami = cre(["whoami", "--non-interactive"]);
  if (whoami.status !== 0) fail("The CRE CLI isn't logged in. Run `~/.cre/bin/cre login` (or set CRE_API_KEY), then run this again.");
}
const absent = KEY_NAMES.filter((name) => !process.env[name]);
if (absent.length > 0) console.warn(`Not in this shell: ${absent.join(", ")}. Unless cre/.env has them, the workflow will write no attestation.`);

// A clearance lasts 90 seconds, so the workflow is compiled before there is one.
console.log("Compiling the workflow to WASM");
const wasm = resolve(CRE_ROOT, "attest/binary.wasm");
const build = cre(["workflow", "build", "./attest", "--target", "fork-simulation", "--non-interactive", "--output", wasm]);
if (build.status !== 0) fail(`Build failed:\n${build.stdout}${build.stderr}`);

console.log("Starting a throwaway Sepolia fork and deploying to it");
const harness = await startHarness({
  forkUrl: process.env.SEPOLIA_FORK_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  anvilPort: FORK_PORT,
  attestForwarder: MOCK_FORWARDER,
  x402: false,
});

let exitCode = 1;
try {
  const { deployment, rpcUrl, apiUrl, ctx } = harness;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const forwarderCode = await client.getCode({ address: MOCK_FORWARDER });
  if (!forwarderCode || forwarderCode === "0x") throw new Error("CRE's mock forwarder isn't on this fork");

  const config = {
    schedule: "0 */1 * * * *",
    apiUrl,
    chainSelectorName: "ethereum-testnet-sepolia",
    chainId: deployment.chainId,
    gasLimit: "500000",
    maxSourceDeviationBps: 100,
    hook: deployment.hook,
    resolver: deployment.resolver,
    verifierSet: deployment.verifierSet,
    quoter: deployment.quoter,
    stateView: deployment.stateView,
    ledger: deployment.ledger,
  };
  // Addresses and a local URL, and still gitignored because they only mean something during this run.
  writeFileSync(resolve(CRE_ROOT, "attest/config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const pool = deployment.wethPool;
  const zeroForOne = pool.currency0.toLowerCase() === deployment.usdc.toLowerCase();
  const decision = await ctx.agent.clearSwap(ctx.agent.swapAction(pool, zeroForOne, 50_000_000n, "Small rebalance"));
  // The same public record the workflow fetches.
  const proof = (await (await fetch(`${apiUrl}/v1/proofs/${decision.id}`)).json()) as { action: SwapAction; clearance?: ClearanceRecord; digest?: Hex; signatures?: Hex[] };
  if (!proof.clearance || !proof.digest || !proof.signatures) throw new Error(`No clearance came back: ${JSON.stringify(decision)}`);
  const digest = proof.digest;
  console.log(`Real decision ${decision.id}, verdict ${decision.verdict}, digest ${digest}`);

  const readStatus = async () =>
    (await client.readContract({ address: deployment.ledger, abi: ledgerAbi, functionName: "attestations", args: [digest] }))[0];

  if (prepareOnly) {
    // Delivers from the forwarder's address, so this exercises everything except the CLI, WASM and price sources.
    const chain = { id: deployment.chainId, name: "sepolia fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
    const test = createTestClient({ mode: "anvil", chain, transport: http(rpcUrl) });
    await test.impersonateAccount({ address: MOCK_FORWARDER });
    await test.setBalance({ address: MOCK_FORWARDER, value: parseEther("1") });
    const wallet = createWalletClient({ account: MOCK_FORWARDER, chain, transport: http(rpcUrl) });
    const outcome = await new LocalAttestor(client as never, wallet as never, deployment).attest({
      decisionId: decision.id,
      digest,
      action: proof.action,
      clearance: proof.clearance,
      signatures: proof.signatures,
    });
    console.log(`Local attestor on this clearance: ${JSON.stringify(outcome)}`);
    console.log(`Ledger status: ${STATUS[await readStatus()]}`);
    exitCode = outcome.status === "attested" ? 0 : 1;
  } else {
    const args = ["workflow", "simulate", "./attest", "--target", "fork-simulation", "--non-interactive", "--trigger-index", "0", "--http-payload", JSON.stringify({ decisionId: decision.id }), "--wasm", wasm, "--broadcast"];
    console.log(`\n$ cd cre && cre ${args.join(" ")}\n`);
    // A well-known Anvil key, only ever funded on this fork. The broadcast goes to the fork's RPC and nowhere else.
    const broadcastKey = testKey(ACCOUNTS.attestor).replace(/^0x/, "");
    const run = cre(args, { CRE_ETH_PRIVATE_KEY: broadcastKey });
    const secrets = [broadcastKey, ...KEY_NAMES.map((name) => process.env[name] ?? ""), process.env.CRE_API_KEY ?? ""];
    const output = scrub(`${run.stdout}${run.stderr}`, secrets);
    console.log(output);
    const status = await readStatus();
    console.log(`Ledger status for this clearance: ${STATUS[status]}`);
    writeFileSync(resolve(CRE_ROOT, ".last-simulation.txt"), output);

    if (run.status === 0 && STATUS[status] === "attested") {
      writeFileSync(
        OUTPUT,
        [
          `# Real output of \`pnpm cre:simulate\`, ${new Date().toISOString()}`,
          "# Target: a throwaway fork of Sepolia. A local run on one node, not a deployment to a DON.",
          `$ cre ${scrub(args.join(" "), [wasm])}`,
          "",
          output.trim(),
          "",
          `Ledger status read from the fork afterwards: ${STATUS[status]}`,
          "",
        ].join("\n"),
      );
      console.log(`Saved to ${OUTPUT}. Commit it, then update the README's CRE status.`);
      exitCode = 0;
    } else {
      console.error(`No attestation, so nothing was saved to docs. See cre/.last-simulation.txt.`);
    }
  }
} catch (error) {
  console.error((error as Error).message);
} finally {
  await harness.stop();
}
process.exit(exitCode);
