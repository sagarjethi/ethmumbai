import { serve } from "@hono/node-server";
import { mockWorldApp } from "./index";

const port = Number(process.env.PORT ?? 8791);
const app = await mockWorldApp({
  issuer: process.env.MOCK_ISSUER ?? `http://127.0.0.1:${port}`,
  clientId: process.env.WORLD_CLIENT_ID ?? "local-client",
  sub: process.env.MOCK_SUB ?? "local-owner",
  publicUrl: process.env.MOCK_PUBLIC_URL,
});
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`mock world on :${port}`));
