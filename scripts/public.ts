import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPublicAdminToken, parsePublicOrigin } from "../apps/gateway/src/app";
import { ACCOUNTS, ROOT, deployLocal, startAnvil, testAddress, testKey } from "./local";

// The public demo: one gateway in front of a throwaway chain and a test issuer. It holds no real funds.
// Only the gateway's port is meant to be reachable, and everything behind it binds to 127.0.0.1.

const publicOrigin = parsePublicOrigin(process.env.PUBLIC_ORIGIN);
// With none given, each start gets its own. Nothing outside this process tree ever needs to know it.
const adminToken = process.env.ADMIN_TOKEN ?? randomBytes(32).toString("hex");
assertPublicAdminToken(adminToken);
const reportToken = randomBytes(32).toString("hex");
const gatewayPort = process.env.GATEWAY_PORT ?? "28080";
const gatewayHost = process.env.GATEWAY_HOST ?? "127.0.0.1";
const trustProxy = process.env.TRUST_PROXY ?? "1";
const base = Number(process.env.INTERNAL_PORT_BASE ?? 28500);
const PORTS = { anvil: base, world: base + 1, verifiers: [base + 2, base + 3, base + 4], api: base + 5, runner: base + 6 };

// Keys in an operator's shell or .env must not reach a demo: no model providers, no real RPC, no real deploy settings.
const KEEP = /^(PATH|HOME|USER|SHELL|TMPDIR|TEMP|TMP|LANG|LC_.*|TERM|FOUNDRY_.*)$/;
for (const name of Object.keys(process.env)) if (!KEEP.test(name)) delete process.env[name];

const children: ChildProcess[] = [];
const pidFile = resolve(ROOT, "data/public.pid");
let stopping = false;

function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  // Only the processes this script started, by handle.
  for (const child of children) child.kill();
  rmSync(pidFile, { force: true });
  process.exit(code);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

function run(name: string, command: string, args: string[], env: Record<string, string>, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  // A half-running demo looks broken in confusing ways. Better to stop, so a supervisor starts a clean one.
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`[${name}] exited with ${code}, so stopping everything`);
    stopAll(1);
  });
  children.push(child);
  return child;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function build(): { siteDir: string; dashboardDir: string } {
  const siteDir = resolve(ROOT, "apps/site/dist");
  const dashboardDir = resolve(ROOT, "apps/web/dist");
  const vite = (app: string, env: Record<string, string>) =>
    execFileSync(resolve(ROOT, `apps/${app}/node_modules/.bin/vite`), ["build", "--emptyOutDir", "--logLevel", "warn"], {
      cwd: resolve(ROOT, `apps/${app}`),
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ...env },
    });
  console.log("building the website and dashboard");
  // Same-origin paths, so a hostname change needs no rebuild of the site.
  vite("site", { VITE_API_URL: "/api", VITE_DASHBOARD_URL: "/dashboard/" });
  vite("web", { DASHBOARD_BASE: "/dashboard/", PUBLIC_API_URL: `${publicOrigin}/api` });

  // The site's script sets these links when it loads. This makes them right without it, too.
  for (const page of ["index.html", "docs.html"]) {
    const path = join(siteDir, page);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("http://localhost:5183/", "/dashboard/"));
  }

  for (const file of [...filesUnder(siteDir), ...filesUnder(dashboardDir)]) {
    if (/\.(woff2?|png|jpe?g|webp|ico|mp4|gif)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(adminToken)) throw new Error(`The admin token is in a built file: ${file}`);
    if (/https?:\/\/(127\.0\.0\.1|localhost)/.test(text)) throw new Error(`A local URL is in a built file: ${file}`);
  }
  return { siteDir, dashboardDir };
}

const { siteDir, dashboardDir } = build();
mkdirSync(resolve(ROOT, "data/public"), { recursive: true });

const { child: anvil, rpcUrl } = await startAnvil(PORTS.anvil);
children.push(anvil);
anvil.on("exit", () => {
  if (!stopping) stopAll(1);
});

const deploymentFile = resolve(ROOT, "deployments/public.json");
console.log("deploying contracts to the throwaway local chain");
deployLocal(rpcUrl, deploymentFile);

const issuer = `http://127.0.0.1:${PORTS.world}`;
const clientId = "public-demo-client";
const world = { WORLD_ISSUER: issuer, WORLD_JWKS_URI: `${issuer}/jwks.json`, WORLD_CLIENT_ID: clientId };
const common = { DEPLOYMENT_FILE: deploymentFile, RPC_URL: rpcUrl, ...world };
const tsx = resolve(ROOT, "node_modules/.bin/tsx");

// The issuer's name stays internal, so tokens and server-side checks never depend on the public DNS.
// Only the pages a browser opens use the public address.
run("world", tsx, ["apps/mock-world/src/main.ts"], { PORT: String(PORTS.world), MOCK_ISSUER: issuer, MOCK_PUBLIC_URL: `${publicOrigin}/world`, WORLD_CLIENT_ID: clientId });

const verifierAccounts = [ACCOUNTS.verifier1, ACCOUNTS.verifier2, ACCOUNTS.verifier3];
PORTS.verifiers.forEach((port, i) => {
  run(`verifier${i + 1}`, tsx, ["apps/verifier/src/main.ts"], {
    ...common,
    PORT: String(port),
    VERIFIER_KEY: testKey(verifierAccounts[i]!),
    MODEL_PROVIDER: "none",
    MODEL_NAME: "",
    MODEL_API_KEY: "",
  });
});

const apiUrl = `http://127.0.0.1:${PORTS.api}`;
const runnerUrl = `http://127.0.0.1:${PORTS.runner}`;
run("api", tsx, ["apps/api/src/main.ts"], {
  ...common,
  PORT: String(PORTS.api),
  PUBLIC_URL: `${publicOrigin}/api`,
  DASHBOARD_URL: `${publicOrigin}/dashboard/`,
  // A new chain gets a new history file, so nothing old is ever overwritten.
  CLEARANCE_DB: resolve(ROOT, `data/public/run-${Date.now()}.db`),
  VERIFIER_URLS: PORTS.verifiers.map((p) => `http://127.0.0.1:${p}`).join(","),
  REPORT_TOKEN: reportToken,
  // No LOCAL_OWNER_KEY, so limits are read-only here as well as blocked at the gateway.
  X402_PRICE_RAW: "10000",
  X402_FACILITATOR_KEY: testKey(ACCOUNTS.facilitator),
  LOCAL_ATTESTOR_KEY: testKey(ACCOUNTS.attestor),
  ADMIN_TOKEN: adminToken,
  // Every visitor arrives from the gateway's address. The gateway limits per client.
  API_RATE_LIMIT_PER_MINUTE: "60000",
});

async function waitFor(url: string) {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} didn't start`);
}
await waitFor(`${apiUrl}/health`);

run("runner", tsx, ["apps/agent/src/runner.ts"], {
  ...common,
  PORT: String(PORTS.runner),
  API_URL: apiUrl,
  AGENT_KEY: testKey(ACCOUNTS.agent),
  THIEF_KEY: testKey(ACCOUNTS.thief),
  EVIL_PAYEE: testAddress(ACCOUNTS.evilPayee),
  REPORT_TOKEN: reportToken,
  OWNER_URL_REWRITES: JSON.stringify([
    [`${publicOrigin}/api`, apiUrl],
    [`${publicOrigin}/world`, issuer],
  ]),
});

run("gateway", tsx, ["apps/gateway/src/main.ts"], {
  PORT: gatewayPort,
  GATEWAY_HOST: gatewayHost,
  PUBLIC_ORIGIN: publicOrigin,
  TRUST_PROXY: trustProxy,
  ADMIN_TOKEN: adminToken,
  API_URL: apiUrl,
  RUNNER_URL: runnerUrl,
  WORLD_URL: issuer,
  SITE_DIR: siteDir,
  DASHBOARD_DIR: dashboardDir,
});

await waitFor(`http://127.0.0.1:${gatewayPort}/healthz`);
writeFileSync(pidFile, String(process.pid));
console.log(`\nPublic demo is up, on a throwaway chain with a test issuer.\nWebsite: ${publicOrigin}/\nDashboard: ${publicOrigin}/dashboard/\nGateway: ${gatewayHost}:${gatewayPort}\nStop it with: kill $(cat data/public.pid)\n`);
