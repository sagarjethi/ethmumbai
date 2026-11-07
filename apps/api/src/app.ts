import {
  RECORD_KEYS,
  accountAbi,
  agentNode,
  erc20Abi,
  ledgerAbi,
  parseLimits,
  readAgentRecords,
  paymentActionSchema,
  resolverAbi,
  swapActionSchema,
  transferAuthorizationDigest,
  verifierSetAbi,
  type Action,
  type Deployment,
  type HumanProof,
  type Limits,
} from "@clearance/shared";
import { createHash, randomBytes } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getAddress, isAddress, recoverAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { z } from "zod";
import type { AttestationOutcome, Attestor } from "./attestor";
import { Coordinator, type Decision } from "./coordinator";
import type { HumanGate } from "./human";
import type { FeedEvent, Store } from "./store";

export type TokenScan = (address: Address) => Promise<{ address: Address; hazards: string[] } | { error: string }>;

export type ApiConfig = {
  client: PublicClient;
  deployment: Deployment;
  verifierUrls: string[];
  store: Store;
  human?: HumanGate;
  paywall?: MiddlewareHandler;
  attestor?: Attestor;
  scanToken?: TokenScan;
  /** With no paywall, refuse callers without a key. Off only in tests that exercise other paths. */
  requireAuth?: boolean;
  /** Protects keys, limits and the private feed. The dashboard's server adds it, never the browser. */
  adminToken?: string;
  /** Lets the dashboard edit limits. Set only in local mode, where the owner key is a public test key. */
  localOwnerWallet?: WalletClient;
  /** Lets the agent report onchain outcomes to the feed. */
  reportToken?: string;
  publicUrl: string;
  monthlyQuota?: number;
  /** Per address. Behind a gateway every caller shares one address, so the gateway limits per client instead. */
  rateLimitPerMinute?: number;
};

type Variables = { keyId?: string; authKind: "api_key" | "x402" | "none"; decision?: Decision };

const swapBody = z.object({ action: swapActionSchema, checkpointId: z.string().max(64).optional() });
const paymentBody = z.object({
  action: paymentActionSchema,
  /** The agent key's signature over this payment, so only the real agent can spend verifier and model time. */
  agentSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((v) => v as Hex),
});
const outcomeBody = z.object({
  scenario: z.string().max(80).optional(),
  label: z.string().max(200),
  result: z.enum(["executed", "reverted", "refused"]),
  detail: z.string().max(500),
  txHash: z.string().max(70).optional(),
  decisionId: z.string().max(40).optional(),
});
const limitsBody = z.object({
  maxSizeUsd: z.number().min(0).optional(),
  humanCapUsd: z.number().min(0).optional(),
  maxImpactBps: z.number().int().min(0).max(10_000).optional(),
  dailyPaymentUsd: z.number().min(0).optional(),
});
const keyBody = z.object({ name: z.string().trim().min(1).max(60) });

const DEFAULT_QUOTA = 1000;
const MONTH_MS = 30 * 24 * 3600 * 1000;

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export function apiApp(config: ApiConfig) {
  const { client, deployment, store, human } = config;
  const quota = config.monthlyQuota ?? DEFAULT_QUOTA;
  const rateLimitPerMinute = config.rateLimitPerMinute ?? 120;
  const app = new Hono<{ Variables: Variables }>();
  const subscribers = new Set<(event: FeedEvent) => void>();
  const attesting = new Map<string, Promise<AttestationOutcome>>();

  const publish = (type: FeedEvent["type"], data: unknown) => {
    const event = store.addEvent(type, data);
    for (const notify of subscribers) notify(event);
    return event;
  };

  async function readLimits(name: string): Promise<Limits | undefined> {
    try {
      return parseLimits(await readAgentRecords(client, deployment.resolver, name));
    } catch {
      return undefined;
    }
  }

  const coordinator = new Coordinator({
    verifierUrls: config.verifierUrls,
    client,
    chainId: deployment.chainId,
    verifierSet: deployment.verifierSet,
    hook: deployment.hook,
    readLimits,
  });

  function checkAgent(action: Action): string | undefined {
    if (action.agentName !== deployment.agentName || action.account !== deployment.account) {
      return "Unknown agent for this deployment";
    }
    return undefined;
  }

  function record(decision: Decision, checkpoint?: { id: string; url: string }) {
    store.saveDecision(decision.id, decision.verdict, { ...decision, checkpoint });
    publish("decision", { ...decision, checkpoint });
  }

  const adminOnly: MiddlewareHandler = async (c, next) => {
    if (!config.adminToken || bearer(c.req.header("authorization")) !== config.adminToken) {
      return c.json({ error: "This needs the dashboard's admin token" }, 401);
    }
    await next();
  };

  /** Requests from one address per minute. Uses the socket's address, because clients can forge forwarding headers. */
  const hits = new Map<string, { windowStart: number; count: number }>();
  const rateLimit: MiddlewareHandler = async (c, next) => {
    const ip = getConnInfo(c).remote.address ?? "unknown";
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart > 60_000) hits.set(ip, { windowStart: now, count: 1 });
    else if (++entry.count > rateLimitPerMinute) return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    await next();
  };

  const logRequest =
    (): MiddlewareHandler<{ Variables: Variables }> =>
    async (c, next) => {
      const start = Date.now();
      await next();
      const decision = c.get("decision");
      store.addRequest({
        at: start,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        latencyMs: Date.now() - start,
        auth: c.get("authKind") ?? "none",
        keyId: c.get("keyId"),
        verdict: decision?.verdict,
        decisionId: decision?.id,
      });
    };

  /** A valid key skips the x402 charge and counts against its quota. Otherwise the caller pays per check. */
  const keyOrPayment: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
    const presented = bearer(c.req.header("authorization"));
    if (presented) {
      const key = store.keyByHash(hashKey(presented));
      if (!key || key.revokedAt) return c.json({ error: "This API key isn't valid. Create one in the dashboard." }, 401);
      if (store.requestCountSince(Date.now() - MONTH_MS, key.id) >= quota) {
        return c.json({ error: `This key has used its ${quota} checks this month. Pay per check with x402 instead.` }, 429);
      }
      store.touchKey(key.id, Date.now());
      c.set("keyId", key.id);
      c.set("authKind", "api_key");
      return next();
    }
    if (config.paywall) {
      c.set("authKind", "x402");
      return (config.paywall as unknown as MiddlewareHandler<{ Variables: Variables }>)(c, next);
    }
    if (config.requireAuth) return c.json({ error: "Send an API key as a bearer token." }, 401);
    return next();
  };

  app.use("/v1/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body is too large" }, 413) }));
  app.use("/v1/proofs/*", cors());
  app.use("/v1/tokens/*", cors());
  app.use("/v1/track-record", cors());
  app.use("/v1/proofs/*", rateLimit);
  app.use("/v1/tokens/*", rateLimit);
  app.use("/v1/track-record", rateLimit);

  app.get("/health", (c) => c.json({ ok: true, chainId: deployment.chainId }));

  // ---- Clearing ----

  app.use("/v1/clear/*", logRequest());
  app.use("/v1/clear/swap", keyOrPayment);

  app.post("/v1/clear/swap", async (c) => {
    const parsed = swapBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { action, checkpointId } = parsed.data;
    const unknown = checkAgent(action);
    if (unknown) return c.json({ error: unknown }, 404);

    let proof: HumanProof | undefined;
    if (checkpointId) {
      const checkpoint = human?.read(checkpointId);
      if (checkpoint?.status === "approved" && checkpoint.idToken) {
        proof = { idToken: checkpoint.idToken, salt: checkpoint.salt as Hex };
      }
    }

    const decision = await coordinator.decide(action, proof);
    c.set("decision", decision);

    // A retry that brought a checkpoint already had its answer, so the owner isn't asked again.
    if (decision.verdict === "HUMAN_REQUIRED" && human && !checkpointId) {
      const open = human.findOrCreate(action);
      const checkpoint = { id: open.id, url: `${config.publicUrl}/v1/human/${open.id}/start` };
      record(decision, checkpoint);
      publish("checkpoint", { id: open.id, status: "pending", decisionId: decision.id, action });
      return c.json({ ...decision, checkpoint });
    }
    record(decision);
    return c.json(decision);
  });

  app.post("/v1/clear/payment", rateLimit, async (c) => {
    const parsed = paymentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    const { action, agentSignature } = parsed.data;
    const unknown = checkAgent(action);
    if (unknown) return c.json({ error: unknown }, 404);

    const digest = transferAuthorizationDigest(deployment.chainId, action.token, action.tokenName, action.tokenVersion, action.authorization);
    const [signer, agentKey] = await Promise.all([
      recoverAddress({ hash: digest, signature: agentSignature }),
      client.readContract({ address: action.account, abi: accountAbi, functionName: "agentKey" }),
    ]);
    if (signer !== agentKey) return c.json({ error: "This payment isn't signed by the account's agent key" }, 401);

    const decision = await coordinator.decide(action);
    c.set("decision", decision);
    record(decision);
    return c.json(decision);
  });

  // ---- Independent checks ----

  app.post("/v1/decisions/:id/attest", rateLimit, async (c) => {
    if (!config.attestor) return c.json({ error: "No attestor is configured" }, 503);
    const stored = store.decision<Decision & { attestation?: AttestationOutcome }>(c.req.param("id"));
    if (!stored) return c.json({ error: "No such decision" }, 404);
    if (stored.attestation && stored.attestation.status !== "failed") return c.json(stored.attestation);
    if (stored.action.kind !== "swap" || !stored.clearance || !stored.digest || !stored.signatures || !stored.attestationRequired) {
      return c.json({ error: "Only a cleared swap that needs a check can be attested" }, 409);
    }
    // One run per decision. An attestation can start a long process, so a repeat joins the one running.
    const id = stored.id;
    let running = attesting.get(id);
    const first = !running;
    if (!running) {
      running = config.attestor
        .attest({ decisionId: id, digest: stored.digest, action: stored.action, clearance: stored.clearance, signatures: stored.signatures })
        .finally(() => attesting.delete(id));
      attesting.set(id, running);
    }
    const attestation = await running;
    if (!first) return c.json(attestation);
    store.saveDecision(stored.id, stored.verdict, { ...stored, attestation });
    publish("outcome", {
      label: attestation.status === "attested" ? "Independent check attested this clearance" : "Independent check refused this clearance",
      result: attestation.status === "attested" ? "executed" : "refused",
      detail: attestation.problems.join("; ") || `Written to the ledger by ${attestation.mode}`,
      txHash: attestation.txHash,
      decisionId: stored.id,
    });
    return c.json(attestation);
  });

  // ---- Public, for anyone checking a decision ----

  app.get("/v1/proofs/:id", (c) => {
    const decision = store.decision<Decision & { attestation?: AttestationOutcome; checkpoint?: unknown }>(c.req.param("id"));
    if (!decision) return c.json({ error: "No decision has this id" }, 404);
    const { checkpoint: _checkpoint, ...proof } = decision;
    return c.json({
      ...proof,
      contracts: {
        chainId: deployment.chainId,
        hook: deployment.hook,
        ledger: deployment.ledger,
        verifierSet: deployment.verifierSet,
      },
    });
  });

  app.get("/v1/tokens/:address/check", async (c) => {
    const raw = c.req.param("address");
    if (!isAddress(raw)) return c.json({ error: "That isn't a valid address" }, 400);
    if (!config.scanToken) return c.json({ error: "Token checks aren't configured" }, 503);
    const result = await config.scanToken(getAddress(raw));
    if ("error" in result) return c.json(result, 422);
    return c.json({ ...result, verdict: result.hazards.length ? "RISKY" : "NO_ADMIN_FUNCTIONS_FOUND" });
  });

  app.get("/v1/attestations/pending", rateLimit, async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const candidates = store
      .recentDecisions<Decision & { attestation?: AttestationOutcome }>(200)
      .filter((d) => d.attestationRequired && !d.attestation && d.digest && (d.clearance?.expiry ?? 0) > now)
      .reverse();
    // The ledger is the record of what's done, because scheduled runs report only to the chain.
    const statuses = await Promise.all(
      candidates.map((d) =>
        client.readContract({ address: deployment.ledger, abi: ledgerAbi, functionName: "attestations", args: [d.digest!] }),
      ),
    );
    return c.json({ ids: candidates.filter((_, i) => statuses[i]![0] === 0).map((d) => d.id) });
  });

  app.get("/v1/track-record", (c) => {
    const decisions = store.recentDecisions<Decision & { attestation?: AttestationOutcome }>(500);
    const agreement = new Map<string, { evaluated: number; dissented: number }>();
    for (const d of decisions) {
      const majority = d.verdict === "REDUCE" ? "ALLOW" : d.verdict;
      for (const e of d.evaluations) {
        const entry = agreement.get(e.verifier) ?? { evaluated: 0, dissented: 0 };
        entry.evaluated++;
        const own = e.verdict === "REDUCE" ? "ALLOW" : e.verdict;
        if (own !== majority) entry.dissented++;
        agreement.set(e.verifier, entry);
      }
    }
    return c.json({
      verdicts: store.verdictCounts(),
      attested: decisions.filter((d) => d.attestation?.status === "attested").length,
      attestationRefused: decisions.filter((d) => d.attestation?.status === "refused").length,
      verifiers: [...agreement].map(([address, stats]) => ({ address, ...stats })),
    });
  });

  // ---- Owner checkpoints ----

  app.get("/v1/human/callback/world", async (c) => {
    if (!human) return c.json({ error: "human gate is not configured" }, 404);
    const limits = await readLimits(deployment.agentName);
    const checkpoint = await human.callback(
      {
        state: c.req.query("state"),
        code: c.req.query("code"),
        error: c.req.query("error"),
        iss: c.req.query("iss"),
      },
      limits?.ownerSub ?? "",
    );
    if (!checkpoint) return c.json({ error: "unknown checkpoint" }, 400);
    publish("checkpoint", { id: checkpoint.id, status: checkpoint.status, detail: checkpoint.detail, action: checkpoint.action });
    if (human.returnUrl) return c.redirect(`${human.returnUrl}?checkpoint=${checkpoint.id}&status=${checkpoint.status}`);
    return c.json({ id: checkpoint.id, status: checkpoint.status, detail: checkpoint.detail });
  });

  app.get("/v1/human/:id", (c) => {
    const checkpoint = human?.read(c.req.param("id"));
    if (!checkpoint) return c.json({ error: "not found" }, 404);
    return c.json({ id: checkpoint.id, status: checkpoint.status, detail: checkpoint.detail, action: checkpoint.action });
  });

  app.get("/v1/human/:id/start", async (c) => {
    const checkpoint = human?.read(c.req.param("id"));
    if (!human || !checkpoint) return c.json({ error: "not found" }, 404);
    if (checkpoint.status !== "pending") return c.json({ error: `checkpoint is ${checkpoint.status}` }, 409);
    return c.redirect(await human.authorizationUrl(checkpoint));
  });

  // ---- Dashboard ----

  app.use("/v1/admin/*", adminOnly);

  app.get("/v1/admin/agent", async (c) => {
    const limits = await readLimits(deployment.agentName);
    const balances = await Promise.all(
      (
        [
          ["USDC", deployment.usdc, 6],
          ["tWETH", deployment.weth, 18],
          ["tMOON", deployment.moon, 18],
          ["RUG", deployment.rug, 18],
        ] as const
      ).map(async ([symbol, token, decimals]) => ({
        symbol,
        decimals,
        raw: (
          await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [deployment.account] })
        ).toString(),
      })),
    );
    const [threshold, verifierCount] = await Promise.all([
      client.readContract({ address: deployment.verifierSet, abi: verifierSetAbi, functionName: "threshold" }),
      client.readContract({ address: deployment.verifierSet, abi: verifierSetAbi, functionName: "verifierCount" }),
    ]);
    return c.json({
      name: deployment.agentName,
      account: deployment.account,
      chainId: deployment.chainId,
      hook: deployment.hook,
      ledger: deployment.ledger,
      tokens: {
        [deployment.usdc]: { symbol: "USDC", decimals: 6 },
        [deployment.weth]: { symbol: "tWETH", decimals: 18 },
        [deployment.moon]: { symbol: "tMOON", decimals: 18 },
        [deployment.rug]: { symbol: "RUG", decimals: 18 },
      },
      limits: limits ?? null,
      balances,
      threshold: Number(threshold),
      verifierCount: Number(verifierCount),
      canEditLimits: Boolean(config.localOwnerWallet),
    });
  });

  app.get("/v1/admin/verifiers", async (c) => {
    const statuses = await Promise.all(
      config.verifierUrls.map(async (url) => {
        try {
          const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
          const body = (await response.json()) as { verifier: string; provider: string };
          return { online: true, address: body.verifier, provider: body.provider };
        } catch {
          return { online: false };
        }
      }),
    );
    return c.json(statuses);
  });

  app.get("/v1/admin/events", (c) => c.json(store.recentEvents()));

  app.get("/v1/admin/feed", (c) =>
    streamSSE(c, async (stream) => {
      const queue: FeedEvent[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (event: FeedEvent) => {
        queue.push(event);
        wake?.();
      };
      subscribers.add(onEvent);
      stream.onAbort(() => {
        subscribers.delete(onEvent);
        wake?.();
      });
      while (!stream.aborted) {
        const event = queue.shift();
        if (event) {
          await stream.writeSSE({ id: String(event.id), event: "event", data: JSON.stringify(event) });
          continue;
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);
        if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      subscribers.delete(onEvent);
    }),
  );

  app.post("/v1/admin/limits", async (c) => {
    const wallet = config.localOwnerWallet;
    if (!wallet?.account) return c.json({ error: "Limits are edited from the owner's wallet in this mode" }, 403);
    const parsed = limitsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    const node = agentNode(deployment.agentName);
    for (const [field, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      const hash = await wallet.writeContract({
        address: deployment.resolver,
        abi: resolverAbi,
        functionName: "setText",
        args: [node, RECORD_KEYS[field as keyof typeof RECORD_KEYS], String(value)],
        account: wallet.account,
        chain: wallet.chain,
      });
      await client.waitForTransactionReceipt({ hash });
    }
    return c.json({ limits: await readLimits(deployment.agentName) });
  });

  app.get("/v1/admin/keys", (c) => c.json({ keys: store.keys(), monthlyQuota: quota }));

  app.post("/v1/admin/keys", async (c) => {
    const parsed = keyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Give the key a name" }, 400);
    const secret = `clr_${randomBytes(24).toString("base64url")}`;
    const key = { id: randomBytes(8).toString("hex"), name: parsed.data.name, hint: secret.slice(-4), createdAt: Date.now() };
    store.addKey({ ...key, hash: hashKey(secret) });
    // The only time the secret leaves the server. Only its hash is stored.
    return c.json({ ...key, secret }, 201);
  });

  app.delete("/v1/admin/keys/:id", (c) => {
    if (!store.revokeKey(c.req.param("id"), Date.now())) return c.json({ error: "No active key has this id" }, 404);
    return c.json({ revoked: true });
  });

  app.get("/v1/admin/requests", (c) => c.json(store.requests(Number(c.req.query("limit") ?? 100))));

  app.get("/v1/admin/decisions/:id", (c) => {
    const decision = store.decision(c.req.param("id"));
    return decision ? c.json(decision) : c.json({ error: "No decision has this id" }, 404);
  });

  app.get("/v1/admin/usage", (c) => {
    const now = Date.now();
    return c.json({
      last15m: store.requestCountSince(now - 15 * 60_000),
      last24h: store.requestCountSince(now - 24 * 3600_000),
      last30d: store.requestCountSince(now - MONTH_MS),
      monthlyQuota: quota,
      hourly: store.hourlyUsage(now - 24 * 3600_000),
    });
  });

  // ---- Agent reporting ----

  app.post("/v1/outcomes", async (c) => {
    if (!config.reportToken || bearer(c.req.header("authorization")) !== config.reportToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parsed = outcomeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);
    publish("outcome", parsed.data);
    return c.json({ ok: true });
  });

  return app;
}
