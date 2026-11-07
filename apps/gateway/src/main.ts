import { serve } from "@hono/node-server";
import { assertPublicAdminToken, gatewayApp, parsePublicOrigin } from "./app";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const adminToken = process.env.ADMIN_TOKEN;
assertPublicAdminToken(adminToken);
const publicOrigin = parsePublicOrigin(process.env.PUBLIC_ORIGIN);
const port = Number(required("PORT"));
const hostname = process.env.GATEWAY_HOST ?? "127.0.0.1";

const app = gatewayApp({
  publicOrigin,
  apiUrl: required("API_URL"),
  runnerUrl: required("RUNNER_URL"),
  worldUrl: required("WORLD_URL"),
  adminToken,
  siteDir: required("SITE_DIR"),
  dashboardDir: required("DASHBOARD_DIR"),
  trustProxy: process.env.TRUST_PROXY === "1",
});

serve({ fetch: app.fetch, port, hostname }, () => console.log(`gateway on ${hostname}:${port} for ${publicOrigin}`));
