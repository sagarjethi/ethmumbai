import { WORLD_ACR, loadDeployment } from "@clearance/shared";
import { serve } from "@hono/node-server";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { apiApp } from "./app";
import { CreSimulationAttestor, LocalAttestor, type Attestor } from "./attestor";
import { HumanGate } from "./human";
import { Store } from "./store";
import { scanTokenFor } from "./tokens";
import { x402Paywall } from "./x402";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const deployment = loadDeployment(required("DEPLOYMENT_FILE"));
const rpcUrl = required("RPC_URL");
const port = Number(required("PORT"));
const publicUrl = process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const store = new Store(required("CLEARANCE_DB"));
const chain = {
  id: deployment.chainId,
  name: "clearance",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const human = process.env.WORLD_ISSUER
  ? new HumanGate(
      {
        issuer: process.env.WORLD_ISSUER,
        clientId: required("WORLD_CLIENT_ID"),
        clientSecret: process.env.WORLD_CLIENT_SECRET,
        redirectUri: `${publicUrl}/v1/human/callback/world`,
        acceptedAcr: process.env.WORLD_ACCEPTED_ACR?.split(",") ?? WORLD_ACR,
        returnUrl: process.env.DASHBOARD_URL,
      },
      store,
    )
  : undefined;

const paywall = process.env.X402_PRICE_RAW
  ? x402Paywall(
      {
        network: `eip155:${deployment.chainId}`,
        chainId: deployment.chainId,
        usdc: deployment.usdc,
        payTo: deployment.treasury,
        priceRaw: process.env.X402_PRICE_RAW,
        facilitatorUrl: process.env.X402_FACILITATOR_URL,
        facilitatorKey: process.env.X402_FACILITATOR_KEY as Hex | undefined,
        rpcUrl,
      },
      "POST /v1/clear/swap",
      "One clearance check",
    )
  : undefined;

const client = createPublicClient({ transport: http(rpcUrl) });

let attestor: Attestor | undefined;
if (process.env.CRE_WORKFLOW_DIR) {
  attestor = new CreSimulationAttestor({
    workflowDir: process.env.CRE_WORKFLOW_DIR,
    projectRoot: required("CRE_PROJECT_ROOT"),
    client: client as never,
    ledger: deployment.ledger,
    creBin: process.env.CRE_BIN,
  });
} else if (process.env.LOCAL_ATTESTOR_KEY) {
  const wallet = createWalletClient({ account: privateKeyToAccount(process.env.LOCAL_ATTESTOR_KEY as Hex), chain, transport: http(rpcUrl) });
  attestor = new LocalAttestor(client as never, wallet, deployment);
}

const app = apiApp({
  client,
  deployment,
  verifierUrls: required("VERIFIER_URLS").split(","),
  store,
  human,
  paywall,
  publicUrl,
  attestor,
  requireAuth: !paywall,
  adminToken: process.env.ADMIN_TOKEN,
  scanToken: (address) => scanTokenFor(client as never, address),
  reportToken: process.env.REPORT_TOKEN,
  rateLimitPerMinute: process.env.API_RATE_LIMIT_PER_MINUTE ? Number(process.env.API_RATE_LIMIT_PER_MINUTE) : undefined,
  localOwnerWallet: process.env.LOCAL_OWNER_KEY
    ? createWalletClient({ account: privateKeyToAccount(process.env.LOCAL_OWNER_KEY as Hex), chain, transport: http(rpcUrl) })
    : undefined,
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`api on :${port}`));
