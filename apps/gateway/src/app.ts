import { getConnInfo } from "@hono/node-server/conninfo";
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getMimeType } from "hono/utils/mime";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** The dashboard's api() and runner() helpers throw `error`, and the page shows it as a notice. */
export const DISABLED = "Disabled in the public demo";

export const DEFAULT_LIMITS = {
  /** Requests to proxied routes, per client, per minute. A dashboard tab polls about 150 times a minute. */
  requestsPerMinute: 1200,
  runsPerMinute: 10,
  /** All clients together, because a per-client limit alone doesn't protect one shared chain. */
  totalRunsPerMinute: 30,
  feedsPerClient: 20,
  totalFeeds: 200,
};

export type GatewayConfig = {
  publicOrigin: string;
  apiUrl: string;
  runnerUrl: string;
  worldUrl: string;
  adminToken: string;
  siteDir: string;
  dashboardDir: string;
  /** Believe X-Real-IP, and only from a loopback socket, which means a reverse proxy on this machine. */
  trustProxy?: boolean;
  limits?: Partial<typeof DEFAULT_LIMITS>;
};

type Upstream = "api" | "runner" | "world";
type Route = {
  method: "GET" | "POST";
  upstream: Upstream;
  /** Matched against the whole path after the prefix. Parameters can't hold a dot, a slash or a percent sign. */
  path: RegExp;
  /** The only routes that get the admin token, and all of them are reads. */
  admin?: true;
  query?: true;
  feed?: true;
  run?: true;
  form?: true;
};

const SEGMENT = "[A-Za-z0-9_-]{1,64}";

/** Everything the public can reach. A request that matches nothing here is refused. */
export const ROUTES: Route[] = [
  { method: "GET", upstream: "api", path: new RegExp(`^/v1/proofs/${SEGMENT}$`) },
  { method: "GET", upstream: "api", path: new RegExp(`^/v1/tokens/${SEGMENT}/check$`) },
  { method: "GET", upstream: "api", path: /^\/v1\/track-record$/ },

  { method: "GET", upstream: "api", path: /^\/v1\/admin\/agent$/, admin: true },
  { method: "GET", upstream: "api", path: /^\/v1\/admin\/verifiers$/, admin: true },
  { method: "GET", upstream: "api", path: /^\/v1\/admin\/events$/, admin: true },
  { method: "GET", upstream: "api", path: /^\/v1\/admin\/feed$/, admin: true, feed: true },
  { method: "GET", upstream: "api", path: /^\/v1\/admin\/keys$/, admin: true },
  { method: "GET", upstream: "api", path: /^\/v1\/admin\/requests$/, admin: true },
  { method: "GET", upstream: "api", path: /^\/v1\/admin\/usage$/, admin: true },
  { method: "GET", upstream: "api", path: new RegExp(`^/v1/admin/decisions/${SEGMENT}$`), admin: true },

  { method: "GET", upstream: "api", path: /^\/v1\/human\/callback\/world$/, query: true },
  { method: "GET", upstream: "api", path: /^\/v1\/human\/[a-f0-9]{24}$/ },
  { method: "GET", upstream: "api", path: /^\/v1\/human\/[a-f0-9]{24}\/start$/ },

  { method: "GET", upstream: "runner", path: /^\/scenarios$/ },
  { method: "POST", upstream: "runner", path: new RegExp(`^/run/${SEGMENT}$`), run: true },

  { method: "GET", upstream: "world", path: /^\/authorize$/, query: true },
  { method: "POST", upstream: "world", path: /^\/decide$/, form: true },
];

const PREFIXES: Record<string, Upstream> = { "/api": "api", "/runner": "runner", "/world": "world" };
const FORWARDED_RESPONSE_HEADERS = ["content-type"];

/** Refuses the shared defaults and anything guessable. Public mode must not start with them. */
export function assertPublicAdminToken(token: string | undefined): asserts token is string {
  if (!token) throw new Error("ADMIN_TOKEN is required in public mode");
  if (/^(local|test)-admin-token$/.test(token)) throw new Error("ADMIN_TOKEN is a known default, which public mode refuses");
  if (token.length < 32) throw new Error("ADMIN_TOKEN must be at least 32 characters in public mode");
}

/** The browser-facing origin, such as https://demo.example.com, with no path. */
export function parsePublicOrigin(value: string | undefined): string {
  if (!value) throw new Error("PUBLIC_ORIGIN is required in public mode, such as https://demo.example.com");
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`PUBLIC_ORIGIN must be only a scheme and host, not ${value}`);
  }
  return url.origin;
}

class Window {
  private hits = new Map<string, { start: number; count: number }>();
  constructor(private max: number) {}

  /** True if this hit is over the limit. */
  over(key: string): boolean {
    const now = Date.now();
    if (this.hits.size > 50_000) this.hits.clear();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > 60_000) {
      this.hits.set(key, { start: now, count: 1 });
      return false;
    }
    return ++entry.count > this.max;
  }
}

/** Plain characters only, so nothing below ever has to reason about how a proxy or a URL parser decodes a path. */
function isCanonical(path: string): boolean {
  return /^\/[A-Za-z0-9._~/-]*$/.test(path) && !path.includes("//") && !/\/\.\.?(\/|$)/.test(path);
}

export function gatewayApp(config: GatewayConfig) {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const origins: Record<Upstream, string> = { api: config.apiUrl, runner: config.runnerUrl, world: config.worldUrl };
  const callback = `${config.publicOrigin}/api/v1/human/callback/world`;
  const requests = new Window(limits.requestsPerMinute);
  const runs = new Window(limits.runsPerMinute);
  const allRuns = new Window(limits.totalRunsPerMinute);
  const feeds = new Map<string, number>();
  let feedCount = 0;

  type Env = { Bindings: HttpBindings };
  const app = new Hono<Env>();

  const refuse = (c: Context<Env>) => c.json({ error: DISABLED }, 403);
  const tooMany = (c: Context<Env>, error = "Too many requests. Try again in a minute.") => c.json({ error }, 429);

  /** The path as the client sent it. c.req.url has been through a URL parser, which resolves `..`. */
  const rawPath = (c: Context<Env>) => (c.env?.incoming?.url ?? new URL(c.req.url).pathname).split("?")[0]!;

  function clientOf(c: Context<Env>): string {
    const socket = getConnInfo(c).remote.address ?? "unknown";
    const loopback = socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1";
    return (config.trustProxy && loopback && c.req.header("x-real-ip")) || socket;
  }

  function holdFeed(client: string): (() => void) | undefined {
    const held = feeds.get(client) ?? 0;
    if (feedCount >= limits.totalFeeds || held >= limits.feedsPerClient) return undefined;
    feedCount++;
    feeds.set(client, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      feedCount--;
      const left = (feeds.get(client) ?? 1) - 1;
      if (left > 0) feeds.set(client, left);
      else feeds.delete(client);
    };
  }

  async function proxy(c: Context<Env>, route: Route, path: string): Promise<Response> {
    const client = clientOf(c);
    if (route.run && (runs.over(client) || allRuns.over("all"))) return tooMany(c, "Too many attack runs. Try again in a minute.");

    const query = new URLSearchParams(route.query ? new URL(c.req.url).search : "");
    if (route.upstream === "world" && path === "/authorize") {
      // The issuer redirects wherever it's told. Here that can only be this demo's own callback.
      if (query.get("redirect_uri") !== callback) return refuse(c);
      query.delete("login_as");
    }

    const headers = new Headers({ accept: c.req.header("accept") ?? "*/*" });
    if (route.admin) headers.set("authorization", `Bearer ${config.adminToken}`);
    let body: string | undefined;
    if (route.form) {
      if (!c.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) return refuse(c);
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = await c.req.text();
    }

    const release = route.feed ? holdFeed(client) : undefined;
    if (route.feed && !release) return tooMany(c, "Too many open feeds. Close a tab and try again.");

    const search = query.size ? `?${query}` : "";
    let upstream: Response;
    try {
      upstream = await fetch(`${origins[route.upstream]}${path}${search}`, {
        method: route.method,
        headers,
        body,
        redirect: "manual",
        signal: c.req.raw.signal,
      });
    } catch {
      release?.();
      return c.json({ error: "The demo backend isn't reachable" }, 502);
    }

    const out = new Headers({ "cache-control": "no-store" });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    const location = upstream.headers.get("location");
    if (location) {
      // An internal address must never reach a browser.
      if (!location.startsWith(`${config.publicOrigin}/`)) return c.json({ error: "The demo backend redirected somewhere unexpected" }, 502);
      out.set("location", location);
    }
    if (route.feed) {
      out.set("x-accel-buffering", "no");
      c.req.raw.signal.addEventListener("abort", () => release?.());
      const stream = upstream.body?.pipeThrough(new TransformStream({ flush: () => release?.() }));
      return new Response(stream, { status: upstream.status, headers: out });
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  async function file(c: Context<Env>, root: string, relative: string): Promise<Response> {
    const notFound = () => c.json({ error: "Not found" }, 404);
    if (relative.split("/").some((segment) => segment.startsWith("."))) return notFound();
    const base = resolve(root);
    const target = resolve(base, relative);
    if (!target.startsWith(base + sep)) return notFound();
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile()) return notFound();
    const headers = {
      "content-type": getMimeType(target) ?? "application/octet-stream",
      "cache-control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (c.req.method === "HEAD") return new Response(null, { headers });
    return new Response(new Uint8Array(await readFile(target)), { headers });
  }

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("x-frame-options", "DENY");
    c.res.headers.set("referrer-policy", "same-origin");
  });
  app.onError((_error, c) => c.json({ error: "Something went wrong" }, 500));

  app.use("/world/decide", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: DISABLED }, 403) }));

  app.all("*", async (c) => {
    const path = rawPath(c);
    if (!isCanonical(path)) return refuse(c);

    const prefix = Object.keys(PREFIXES).find((p) => path.toLowerCase() === p || path.toLowerCase().startsWith(`${p}/`));
    if (prefix) {
      if (requests.over(clientOf(c))) return tooMany(c);
      const upstream = PREFIXES[prefix];
      const inner = path.slice(prefix.length);
      const route = path.startsWith(prefix)
        ? ROUTES.find((r) => r.upstream === upstream && r.method === c.req.method && r.path.test(inner))
        : undefined;
      return route ? proxy(c, route, inner) : refuse(c);
    }

    if (c.req.method !== "GET" && c.req.method !== "HEAD") return refuse(c);
    if (path === "/healthz") {
      const ok = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
      return c.json({ ok }, ok ? 200 : 503);
    }
    if (path === "/dashboard") return c.redirect("/dashboard/");
    if (path === "/dashboard/") return file(c, config.dashboardDir, "index.html");
    if (path.startsWith("/dashboard/")) return file(c, config.dashboardDir, path.slice("/dashboard/".length));
    return file(c, config.siteDir, path === "/" ? "index.html" : path.slice(1));
  });

  return app;
}
