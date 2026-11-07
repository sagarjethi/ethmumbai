import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createHash, randomBytes } from "node:crypto";

export const TEST_ACR = "https://world.org/oidc/acr/orb";

export type MockWorldConfig = {
  issuer: string;
  clientId: string;
  sub: string;
  /** Where a browser reaches this issuer, when that differs from `issuer`, which stays the name inside tokens. */
  publicUrl?: string;
};

type PendingAuth = {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  state: string;
  sub: string;
};

/**
 * A local stand-in for World ID's OIDC issuer, for tests and the local demo only. It proves nobody's
 * humanity. It exists so the denied path and token checks run without a phone or the sandbox app.
 */
export async function mockWorldApp(config: MockWorldConfig) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
  const pending = new Map<string, PendingAuth>();
  const codes = new Map<string, PendingAuth>();
  const app = new Hono();

  app.get("/.well-known/openid-configuration", (c) =>
    c.json({
      issuer: config.issuer,
      authorization_endpoint: `${config.publicUrl ?? config.issuer}/authorize`,
      token_endpoint: `${config.issuer}/token`,
      jwks_uri: `${config.issuer}/jwks.json`,
    }),
  );

  app.get("/jwks.json", (c) => c.json({ keys: [jwk] }));

  app.get("/authorize", (c) => {
    const q = c.req.query();
    if (q.max_age !== "0" || q.prompt !== "login") return c.text("Step-up requires max_age=0 and prompt=login", 400);
    if (q.client_id !== config.clientId) return c.text("Unknown client", 400);
    const id = randomBytes(12).toString("hex");
    pending.set(id, {
      clientId: q.client_id,
      redirectUri: q.redirect_uri ?? "",
      nonce: q.nonce ?? "",
      codeChallenge: q.code_challenge ?? "",
      state: q.state ?? "",
      sub: q.login_as ?? config.sub,
    });
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test approval</title>
<style>
  :root{color-scheme:light dark}
  body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText;padding:16px}
  main{max-width:420px;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:12px;padding:24px}
  .tag{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;background:#b4530922;color:#b45309}
  h1{font-size:20px;margin:12px 0 8px}
  p{margin:0 0 16px}
  form{display:flex;gap:8px}
  button{flex:1;font:inherit;font-weight:600;padding:10px;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);background:transparent;color:inherit;cursor:pointer}
  button[value=approve]{background:CanvasText;color:Canvas}
</style>
<main><span class="tag">Test issuer, not World ID</span>
<h1>Approve this agent action?</h1>
<p>Local stand-in for a World ID step-up. On Sepolia this screen is the real World ID flow.</p>
<form method="post" action="${config.publicUrl ?? ""}/decide"><input type="hidden" name="id" value="${id}">
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></main>`);
  });

  app.post("/decide", async (c) => {
    const form = await c.req.parseBody();
    const auth = pending.get(String(form.id));
    if (!auth) return c.text("Unknown request", 400);
    pending.delete(String(form.id));
    const url = new URL(auth.redirectUri);
    url.searchParams.set("state", auth.state);
    url.searchParams.set("iss", config.issuer);
    if (form.decision === "approve") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, auth);
      url.searchParams.set("code", code);
    } else {
      url.searchParams.set("error", "access_denied");
    }
    return c.redirect(url.toString());
  });

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const auth = codes.get(String(form.code));
    if (!auth) return c.json({ error: "invalid_grant" }, 400);
    codes.delete(String(form.code));
    const challenge = createHash("sha256").update(String(form.code_verifier)).digest("base64url");
    if (challenge !== auth.codeChallenge) return c.json({ error: "invalid_grant" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: auth.nonce, acr: TEST_ACR, auth_time: now })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(config.issuer)
      .setAudience(auth.clientId)
      .setSubject(auth.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    return c.json({ id_token: idToken, token_type: "Bearer" });
  });

  return app;
}
