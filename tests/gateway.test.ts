import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DISABLED, assertPublicAdminToken, gatewayApp, parsePublicOrigin, type GatewayConfig } from "../apps/gateway/src/app";

// Everything here runs on stub upstreams on free ports. No chain, database or shared service is touched.

const TOKEN = "gateway-test-token-0123456789abcdef-0123456789";
const ORIGIN = "https://demo.invalid";
const CLIENT_TOKEN = "client-supplied-token";

type Seen = { upstream: string; method: string; url: string; authorization?: string; override?: string; body: string };
const seen: Seen[] = [];
const servers: ServerType[] = [];
const feedState = { open: 0, aborted: 0 };

function listen(fetch: (r: Request, env?: never) => Response | Promise<Response>): Promise<{ url: string; port: number; server: ServerType }> {
  return new Promise((done) => {
    const server = serve({ fetch: fetch as never, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      servers.push(server);
      done({ url: `http://127.0.0.1:${info.port}`, port: info.port, server });
    });
  });
}

/** Records every request, then answers with headers a client must never see. */
function stub(name: string) {
  const app = new Hono();
  app.get("/v1/admin/feed", (c) => {
    seen.push({ upstream: name, method: "GET", url: "/v1/admin/feed", authorization: c.req.header("authorization"), body: "" });
    feedState.open++;
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => {
        feedState.open--;
        feedState.aborted++;
      });
      await stream.writeSSE({ id: "1", event: "event", data: '{"first":true}' });
      while (!stream.aborted) await stream.sleep(20);
    });
  });
  app.get("/internal-redirect", (c) => c.redirect("http://127.0.0.1:1/secret"));
  app.get("/v1/human/aaaaaaaaaaaaaaaaaaaaaaaa/start", (c) => {
    seen.push({ upstream: name, method: "GET", url: c.req.path, body: "" });
    return c.redirect(c.req.header("x-never") ?? `${ORIGIN}/world/authorize?state=s`);
  });
  app.get("/v1/human/bbbbbbbbbbbbbbbbbbbbbbbb/start", (c) => c.redirect("http://127.0.0.1:1/authorize"));
  app.all("*", async (c) => {
    const url = new URL(c.req.url);
    seen.push({
      upstream: name,
      method: c.req.method,
      url: url.pathname + url.search,
      authorization: c.req.header("authorization"),
      override: c.req.header("x-http-method-override"),
      body: await c.req.text(),
    });
    c.header("set-cookie", `session=${c.req.header("authorization") ?? "none"}`);
    c.header("x-debug-authorization", c.req.header("authorization") ?? "none");
    if (name === "runner" && c.req.path === "/run/busy") return c.json({ error: "other is still running" }, 409);
    return c.json({ ok: true, upstream: name, path: c.req.path });
  });
  return listen(app.fetch as never);
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** node:http sends the path byte for byte, where fetch would resolve `..` before it left the client. */
function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", fail);
    if (body) req.write(body);
    req.end();
  });
}

/** For what node:http won't send, such as a lowercase method. */
function sendRaw(port: number, text: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (d) => (reply += d));
    socket.on("end", () => done(reply));
    socket.on("close", () => done(reply));
    socket.on("error", fail);
  });
}

function expectNoLeak(reply: Reply) {
  const everything = JSON.stringify(reply);
  expect(everything).not.toContain(TOKEN);
  expect(everything).not.toContain("127.0.0.1");
  expect(reply.headers["set-cookie"]).toBeUndefined();
  expect(reply.headers["x-debug-authorization"]).toBeUndefined();
}

function expectRefused(reply: Reply, method: string) {
  expect(reply.status).toBe(403);
  if (method !== "HEAD") expect(JSON.parse(reply.body)).toEqual({ error: DISABLED });
  expectNoLeak(reply);
}

let port: number;
let config: GatewayConfig;
let dir: string;

async function gateway(overrides: Partial<GatewayConfig>) {
  return (await listen(gatewayApp({ ...config, ...overrides }).fetch as never)).port;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  writeFileSync(join(dir, "outside.txt"), "outside the web roots");
  for (const [sub, marker] of [["site", "site page"], ["web", "dashboard page"]] as const) {
    mkdirSync(join(dir, sub, "assets"), { recursive: true });
    writeFileSync(join(dir, sub, "index.html"), `<!doctype html><title>${marker}</title>`);
    writeFileSync(join(dir, sub, "assets", "app.js"), `// ${marker}`);
  }
  writeFileSync(join(dir, "site", "docs.html"), "<!doctype html><title>docs</title>");
  writeFileSync(join(dir, "site", ".env"), "SECRET=1");
  const [api, runner, world] = await Promise.all([stub("api"), stub("runner"), stub("world")]);
  config = {
    publicOrigin: ORIGIN,
    apiUrl: api.url,
    runnerUrl: runner.url,
    worldUrl: world.url,
    adminToken: TOKEN,
    siteDir: join(dir, "site"),
    dashboardDir: join(dir, "web"),
  };
  port = await gateway({ limits: { requestsPerMinute: 1_000_000, runsPerMinute: 1_000_000, totalRunsPerMinute: 1_000_000 } });
});

afterAll(() => {
  for (const server of servers) server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

const WRITES: [string, string][] = [
  ["POST", "/v1/admin/keys"],
  ["DELETE", "/v1/admin/keys/abc123"],
  ["POST", "/v1/admin/limits"],
  ["POST", "/v1/outcomes"],
];

describe("admin writes", () => {
  it.each(WRITES)("refuses %s %s without reaching the API", async (method, path) => {
    // Node sends a DELETE without framing for a body, so only the others carry one.
    const body = method === "DELETE" ? undefined : '{"name":"x"}';
    expectRefused(await send(port, method, `/api${path}`, { "content-type": "application/json" }, body), method);
    expect(seen).toEqual([]);
  });

  it("refuses them even with a valid-looking token from the client", async () => {
    const reply = await send(port, "POST", "/api/v1/admin/keys", { authorization: `Bearer ${TOKEN}` }, '{"name":"x"}');
    expectRefused(reply, "POST");
    expect(seen).toEqual([]);
  });

  const TRICKS = [
    "/api/v1/admin/keys/",
    "/api/v1/admin/keys//",
    "//api/v1/admin/keys",
    "/api//v1/admin/keys",
    "/api/v1//admin/keys",
    "/api/./v1/admin/keys",
    "/api/v1/admin/./keys",
    "/api/v1/proofs/../admin/keys",
    "/api/v1/proofs/x/../../admin/keys",
    "/runner/../api/v1/admin/keys",
    "/world/../api/v1/admin/keys",
    "/dashboard/../api/v1/admin/keys",
    "/api/v1/proofs/..%2fadmin%2fkeys",
    "/api/v1/proofs/%2e%2e/admin/keys",
    "/api/v1/proofs/%2E%2E%2Fadmin%2Fkeys",
    "/api/v1/proofs/%252e%252e%252fadmin%252fkeys",
    "/api/v1%2fadmin%2fkeys",
    "/api%2fv1%2fadmin%2fkeys",
    "/api/v1/admin%2fkeys",
    "/api/v1/admin/keys%2f",
    "/api/v1/admin/keys%00",
    "/api/v1/admin/keys%20",
    "/api/v1/admin/%6beys",
    "/api/v1/admin/keys;x=1",
    "/api/v1/admin/keys.json",
    "/API/V1/ADMIN/KEYS",
    "/Api/v1/admin/keys",
    "/api/V1/admin/keys",
    "/api/v1/ADMIN/keys",
    "/api/v1/admin/KEYS",
    "/api/v1/admin/keys?x=1",
    "/api/v1/admin/keys?_method=GET",
    "/api/v1/admin/keys#frag",
    "http://evil.invalid/api/v1/admin/keys",
    "/api/v1/admin/limits/",
    "/API/V1/ADMIN/LIMITS",
    "/api/v1/proofs/../admin/limits",
    "/api/v1/outcomes/",
    "/api/v1/proofs/..%2foutcomes",
  ];

  it.each(TRICKS)("refuses POST %s", async (path) => {
    const reply = await send(port, "POST", path, { "content-type": "application/json" }, '{"name":"x"}');
    expectRefused(reply, "POST");
    expect(seen).toEqual([]);
  });

  it.each(["/api/v1/admin/keys/abc", "/api/v1/admin/keys/abc/", "/API/V1/ADMIN/KEYS/ABC", "/api/v1/admin/keys/%2e%2e", "/api/v1/proofs/../admin/keys/abc", "/api/v1/admin/keys%2fabc"])(
    "refuses DELETE %s",
    async (path) => {
      expectRefused(await send(port, "DELETE", path), "DELETE");
      expect(seen).toEqual([]);
    },
  );

  it("drops a backslash path before the app sees it", async () => {
    const reply = await send(port, "POST", "/api\\v1\\admin\\keys");
    expect(reply.status).toBe(400);
    expectNoLeak(reply);
    expect(seen).toEqual([]);
  });

  it("refuses a lowercase method without forwarding it", async () => {
    const reply = await sendRaw(port, "post /api/v1/admin/keys HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    expect(reply).not.toContain(TOKEN);
    expect(reply).not.toMatch(/ 20\d /);
    expect(seen).toEqual([]);
  });

  it("doesn't let an override header turn a read into a write", async () => {
    const reply = await send(port, "GET", "/api/v1/admin/keys?_method=POST", { "x-http-method-override": "POST", "x-method-override": "POST" });
    expect(reply.status).toBe(200);
    expect(seen).toEqual([{ upstream: "api", method: "GET", url: "/v1/admin/keys", authorization: `Bearer ${TOKEN}`, override: undefined, body: "" }]);
  });

  it("doesn't let an override header get a write past the allowlist", async () => {
    expectRefused(await send(port, "POST", "/api/v1/admin/keys", { "x-http-method-override": "GET" }), "POST");
    expect(seen).toEqual([]);
  });
});

describe("HEAD, OPTIONS and other methods", () => {
  const READS = ["/api/v1/admin/keys", "/api/v1/admin/agent", "/api/v1/admin/feed", "/api/v1/track-record", "/api/v1/human/aaaaaaaaaaaaaaaaaaaaaaaa", "/runner/scenarios", "/runner/run/basic", "/world/authorize", "/world/decide"];
  const METHODS = ["HEAD", "OPTIONS", "TRACE", "PUT", "PATCH", "DELETE"];
  const cases = READS.flatMap((path) => METHODS.map((method) => [method, path] as const));

  it.each(cases)("refuses %s %s", async (method, path) => {
    const reply = await send(port, method, path, { origin: "https://evil.invalid", "access-control-request-method": "POST" });
    expectRefused(reply, method);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("everything not on the list", () => {
  it.each([
    ["GET", "/api/health"],
    ["GET", "/api"],
    ["GET", "/api/"],
    ["GET", "/api/v1/admin"],
    ["GET", "/api/v1/admin/nope"],
    ["GET", "/api/v1/attestations/pending"],
    ["POST", "/api/v1/clear/swap"],
    ["POST", "/api/v1/clear/payment"],
    ["POST", "/api/v1/decisions/abc/attest"],
    ["GET", "/api/v1/proofs/"],
    ["GET", "/api/v1/human/not-an-id"],
    ["POST", "/api/v1/human/aaaaaaaaaaaaaaaaaaaaaaaa"],
    ["GET", "/runner"],
    ["GET", "/runner/run/basic"],
    ["GET", "/runner/health"],
    ["POST", "/runner/run/a/b"],
    ["POST", "/runner/scenarios"],
    ["GET", "/world/token"],
    ["POST", "/world/token"],
    ["GET", "/world/jwks.json"],
    ["GET", "/world/.well-known/openid-configuration"],
    ["POST", "/"],
    ["DELETE", "/docs.html"],
  ])("refuses %s %s", async (method, path) => {
    expectRefused(await send(port, method, path), method);
    expect(seen).toEqual([]);
  });
});

describe("the allowlist", () => {
  it.each(["agent", "verifiers", "events", "keys", "requests", "usage", "decisions/abc123"])("adds the token server-side for GET /v1/admin/%s", async (path) => {
    const reply = await send(port, "GET", `/api/v1/admin/${path}`);
    expect(reply.status).toBe(200);
    expectNoLeak(reply);
    expect(seen).toMatchObject([{ upstream: "api", method: "GET", url: `/v1/admin/${path}`, authorization: `Bearer ${TOKEN}` }]);
  });

  it.each(["/v1/proofs/abc123", "/v1/tokens/0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238/check", "/v1/track-record", "/v1/human/aaaaaaaaaaaaaaaaaaaaaaaa", "/v1/human/callback/world"])(
    "forwards %s with no token, even if the client sends one",
    async (path) => {
      const reply = await send(port, "GET", `/api${path}`, { authorization: `Bearer ${CLIENT_TOKEN}` });
      expect(reply.status).toBe(200);
      expectNoLeak(reply);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization).toBeUndefined();
    },
  );

  it("replaces a token sent by the client on admin reads", async () => {
    await send(port, "GET", "/api/v1/admin/usage", { authorization: `Bearer ${CLIENT_TOKEN}` });
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("passes the callback's query and drops others", async () => {
    await send(port, "GET", "/api/v1/human/callback/world?state=s&code=c&iss=i");
    await send(port, "GET", "/api/v1/track-record?x=1");
    expect(seen.map((s) => s.url)).toEqual(["/v1/human/callback/world?state=s&code=c&iss=i", "/v1/track-record"]);
  });

  it("forwards the runner's list and a run", async () => {
    expect((await send(port, "GET", "/runner/scenarios")).status).toBe(200);
    expect((await send(port, "POST", "/runner/run/basic-swap", {}, "ignored")).status).toBe(200);
    expect(seen).toMatchObject([
      { upstream: "runner", method: "GET", url: "/scenarios", authorization: undefined },
      { upstream: "runner", method: "POST", url: "/run/basic-swap", authorization: undefined, body: "" },
    ]);
  });

  it("passes the runner's refusal when a run is already going", async () => {
    const reply = await send(port, "POST", "/runner/run/busy");
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body).error).toContain("still running");
  });
});

describe("the feed", () => {
  it("streams SSE as it happens, with the token added, and hangs up with the client", async () => {
    const before = feedState.aborted;
    const chunk = await new Promise<string>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/v1/admin/feed", headers: { accept: "text/event-stream" } }, (res) => {
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.headers["x-accel-buffering"]).toBe("no");
        expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
        res.setEncoding("utf8");
        res.once("data", (d) => {
          done(d);
          req.destroy();
        });
      });
      req.on("error", (error) => (req.destroyed ? undefined : fail(error)));
      req.end();
    });
    expect(chunk).toContain('{"first":true}');
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    await expect.poll(() => feedState.aborted).toBe(before + 1);
  });

  it("caps open feeds per client, and frees a slot when one closes", async () => {
    const capped = await gateway({ limits: { feedsPerClient: 1 } });
    const open = () =>
      new Promise<{ status: number; close: () => void }>((done, fail) => {
        const req = request({ host: "127.0.0.1", port: capped, path: "/api/v1/admin/feed" }, (res) => {
          res.resume();
          done({ status: res.statusCode ?? 0, close: () => req.destroy() });
        });
        req.on("error", () => undefined);
        req.on("timeout", fail);
        req.end();
      });
    const first = await open();
    expect(first.status).toBe(200);
    const second = await open();
    expect(second.status).toBe(429);
    first.close();
    await expect
      .poll(async () => {
        const next = await open();
        next.close();
        return next.status;
      })
      .toBe(200);
  });
});

describe("rate limits", () => {
  it("limits runs per client", async () => {
    const limited = await gateway({ limits: { runsPerMinute: 2 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await send(limited, "POST", "/runner/run/basic")).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect(seen.filter((s) => s.url === "/run/basic")).toHaveLength(2);
  });

  it("limits runs across all clients", async () => {
    const limited = await gateway({ trustProxy: true, limits: { runsPerMinute: 100, totalRunsPerMinute: 1 } });
    expect((await send(limited, "POST", "/runner/run/basic", { "x-real-ip": "198.51.100.1" })).status).toBe(200);
    expect((await send(limited, "POST", "/runner/run/basic", { "x-real-ip": "198.51.100.2" })).status).toBe(429);
  });

  it("uses the proxy's X-Real-IP only when told to trust it", async () => {
    const trusting = await gateway({ trustProxy: true, limits: { runsPerMinute: 1 } });
    expect((await send(trusting, "POST", "/runner/run/a", { "x-real-ip": "198.51.100.1" })).status).toBe(200);
    expect((await send(trusting, "POST", "/runner/run/a", { "x-real-ip": "198.51.100.2" })).status).toBe(200);
    expect((await send(trusting, "POST", "/runner/run/a", { "x-real-ip": "198.51.100.2" })).status).toBe(429);

    const direct = await gateway({ limits: { runsPerMinute: 1 } });
    expect((await send(direct, "POST", "/runner/run/a", { "x-real-ip": "198.51.100.1" })).status).toBe(200);
    expect((await send(direct, "POST", "/runner/run/a", { "x-real-ip": "198.51.100.2" })).status).toBe(429);
  });

  it("ignores a forged X-Forwarded-For", async () => {
    const limited = await gateway({ trustProxy: true, limits: { runsPerMinute: 1 } });
    expect((await send(limited, "POST", "/runner/run/a", { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
    expect((await send(limited, "POST", "/runner/run/a", { "x-forwarded-for": "198.51.100.2" })).status).toBe(429);
  });
});

describe("the test issuer", () => {
  const callback = encodeURIComponent(`${ORIGIN}/api/v1/human/callback/world`);

  it("opens the approval page only for this demo's own callback, and drops login_as", async () => {
    const reply = await send(port, "GET", `/world/authorize?client_id=c&login_as=someone&redirect_uri=${callback}`);
    expect(reply.status).toBe(200);
    expect(seen[0]!.url).toContain("client_id=c");
    expect(seen[0]!.url).not.toContain("login_as");
  });

  it.each(["https://evil.invalid/", "javascript:alert(1)", `${ORIGIN}.evil.invalid/api/v1/human/callback/world`, `${ORIGIN}/dashboard/`, ""])("refuses a redirect to %s", async (target) => {
    expectRefused(await send(port, "GET", `/world/authorize?redirect_uri=${encodeURIComponent(target)}`), "GET");
    expect(seen).toEqual([]);
  });

  it("forwards the approval form and nothing else", async () => {
    const form = { "content-type": "application/x-www-form-urlencoded" };
    expect((await send(port, "POST", "/world/decide", form, "id=abc&decision=approve")).status).toBe(200);
    expect(seen).toMatchObject([{ upstream: "world", method: "POST", url: "/decide", body: "id=abc&decision=approve" }]);
    seen.length = 0;
    expectRefused(await send(port, "POST", "/world/decide", { "content-type": "application/json" }, "{}"), "POST");
    expectRefused(await send(port, "POST", "/world/decide", form, "x".repeat(5000)), "POST");
    expect(seen).toEqual([]);
  });

  it("passes a redirect to the public origin and stops one to an internal address", async () => {
    const good = await send(port, "GET", "/api/v1/human/aaaaaaaaaaaaaaaaaaaaaaaa/start");
    expect(good.status).toBe(302);
    expect(good.headers.location).toBe(`${ORIGIN}/world/authorize?state=s`);

    const bad = await send(port, "GET", "/api/v1/human/bbbbbbbbbbbbbbbbbbbbbbbb/start");
    expect(bad.status).toBe(502);
    expectNoLeak(bad);
    expect(bad.headers.location).toBeUndefined();
  });
});

describe("the built pages", () => {
  it("serves the site at the root and the dashboard under its path", async () => {
    expect((await send(port, "GET", "/")).body).toContain("site page");
    expect((await send(port, "GET", "/docs.html")).body).toContain("docs");
    expect((await send(port, "GET", "/assets/app.js")).body).toContain("site page");
    expect((await send(port, "GET", "/dashboard/")).body).toContain("dashboard page");
    expect((await send(port, "GET", "/dashboard/assets/app.js")).body).toContain("dashboard page");
    const redirect = await send(port, "GET", "/dashboard");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe("/dashboard/");
    expect((await send(port, "HEAD", "/")).status).toBe(200);
  });

  it("sets headers that stop framing and sniffing", async () => {
    const reply = await send(port, "GET", "/");
    expect(reply.headers["x-frame-options"]).toBe("DENY");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it.each(["/../outside.txt", "/dashboard/../../outside.txt", "/assets/../../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/dashboard/%2e%2e/%2e%2e/outside.txt", "/assets/..%5c..%5coutside.txt"])("won't leave the web root with %s", async (path) => {
    const reply = await send(port, "GET", path);
    expect(reply.status).toBe(403);
    expect(reply.body).not.toContain("outside the web roots");
  });

  it("doesn't serve dotfiles and answers unknown paths with 404", async () => {
    expect((await send(port, "GET", "/.env")).status).toBe(404);
    expect((await send(port, "GET", "/nope.html")).status).toBe(404);
  });
});

describe("when the backend is down", () => {
  it("answers with a plain 502 that names no internal address", async () => {
    const down = await gateway({ apiUrl: "http://127.0.0.1:1" });
    const reply = await send(down, "GET", "/api/v1/admin/agent");
    expect(reply.status).toBe(502);
    expectNoLeak(reply);
    expect((await send(down, "GET", "/healthz")).status).toBe(503);
    expect((await send(port, "GET", "/healthz")).status).toBe(200);
  });
});

describe("start-up checks", () => {
  it.each([undefined, "", "local-admin-token", "test-admin-token", "short"])("refuses the admin token %s", (token) => {
    expect(() => assertPublicAdminToken(token)).toThrow(/ADMIN_TOKEN/);
  });

  it("accepts a long random token", () => {
    expect(() => assertPublicAdminToken(TOKEN)).not.toThrow();
  });

  it.each([undefined, "", "demo.example.com", "ftp://demo.example.com", "https://demo.example.com/path", "https://demo.example.com/?x=1", "https://user:pw@demo.example.com"])("refuses the origin %s", (value) => {
    expect(() => parsePublicOrigin(value)).toThrow();
  });

  it("normalises a good origin", () => {
    expect(parsePublicOrigin("https://demo.example.com/")).toBe("https://demo.example.com");
  });
});
