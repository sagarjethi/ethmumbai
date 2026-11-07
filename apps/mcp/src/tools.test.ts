import { describe, expect, it, vi } from "vitest";
import { clearanceClient } from "./tools";

describe("the MCP tools' client", () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ verdict: "BLOCK" }), { status: 200 }));
  const client = clearanceClient("https://api.test", "clr_key", fetcher as never);

  it("sends the key and the exact action", async () => {
    await client.checkSwap({ kind: "swap" }, "cp1");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/clear/swap");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer clr_key");
    expect(JSON.parse(init.body as string)).toEqual({ action: { kind: "swap" }, checkpointId: "cp1" });
  });

  it("escapes ids in paths", async () => {
    await client.proof("../admin/keys");
    expect((fetcher.mock.calls.at(-1) as unknown as [string])[0]).toBe("https://api.test/v1/proofs/..%2Fadmin%2Fkeys");
  });

  it("accepts an API URL ending in a slash", async () => {
    const seen = vi.fn(async () => new Response("{}", { status: 200 }));
    await clearanceClient("https://api.test/", "k", seen as never).proof("d1");
    expect((seen.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/v1/proofs/d1");
  });

  it("reports a failure status instead of throwing", async () => {
    const failing = clearanceClient("https://api.test", "k", (async () => new Response("nope", { status: 500 })) as never);
    expect(await failing.checkToken("0x0")).toEqual({ ok: false, status: 500, body: null });
  });
});
