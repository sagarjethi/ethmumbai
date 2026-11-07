import { loadDeployment } from "@clearance/shared";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Hex, Address } from "viem";
import { Agent } from "./agent";
import { mockOwnerVia } from "./mockOwner";
import { runScenario, scenarios, type ScenarioResult } from "./scenarios";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiUrl = required("API_URL");
const agent = new Agent({
  apiUrl,
  rpcUrl: required("RPC_URL"),
  deployment: loadDeployment(required("DEPLOYMENT_FILE")),
  agentKey: required("AGENT_KEY") as Hex,
  reportToken: process.env.REPORT_TOKEN,
});

/** Pairs of [browser-facing prefix, internal prefix], so the stub owner never leaves this machine. */
const ownerUrlRewrites = JSON.parse(process.env.OWNER_URL_REWRITES ?? "[]") as [string, string][];
const mockOwner = mockOwnerVia((url) => {
  const rewrite = ownerUrlRewrites.find(([from]) => url.startsWith(`${from}/`));
  return rewrite ? `${rewrite[1]}${url.slice(rewrite[0].length)}` : url;
});

/** The approval scenario waits for the person at the dashboard. The rest run unattended. */
const WAITS_FOR_OWNER = new Set(["human-approved"]);

let running: string | undefined;
const results = new Map<string, ScenarioResult>();
const app = new Hono();

app.get("/scenarios", (c) =>
  c.json({
    running,
    scenarios: scenarios.map(({ id, title, description }) => ({
      id,
      title,
      description,
      waitsForOwner: WAITS_FOR_OWNER.has(id),
      result: results.get(id),
    })),
  }),
);

app.post("/run/:id", (c) => {
  const scenario = scenarios.find((s) => s.id === c.req.param("id"));
  if (!scenario) return c.json({ error: "unknown scenario" }, 404);
  if (running) return c.json({ error: `${running} is still running` }, 409);
  running = scenario.id;
  results.delete(scenario.id);
  void runScenario(scenario, {
    agent,
    owner: WAITS_FOR_OWNER.has(scenario.id) ? undefined : mockOwner,
    apiUrl,
    thiefKey: required("THIEF_KEY") as Hex,
    evilPayee: required("EVIL_PAYEE") as Address,
  })
    .then((result) => results.set(scenario.id, result))
    .finally(() => {
      running = undefined;
    });
  return c.json({ started: scenario.id }, 202);
});

const port = Number(required("PORT"));
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`runner on :${port}`));
