import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../../../scripts/local";
import { ADMIN_TOKEN, startHarness, type Harness } from "../../../tests/harness";

type ServerConfig = { command: string; args: string[]; env: Record<string, string> };
type Answer = { isError?: boolean; content: Array<{ text: string }> };

/** The config a reader copies out of the docs, with the placeholders filled in. */
function documentedConfig(text: string): ServerConfig {
  const block = /\{\s*"mcpServers"[\s\S]*?\n\}/.exec(text);
  if (!block) throw new Error("No mcpServers config in this document");
  return (JSON.parse(block[0].replaceAll("/absolute/path/to/ethmumbai", ROOT)) as { mcpServers: Record<string, ServerConfig> }).mcpServers.beforecoin!;
}

describe("the MCP server, as a client launches it from the documented config", () => {
  let h: Harness;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>) => {
    const answer = (await client.callTool({ name, arguments: args })) as Answer;
    return { isError: Boolean(answer.isError), body: JSON.parse(answer.content[0]!.text) };
  };
  const swap = (pool: Harness["deployment"]["wethPool"], sellsUsdc: boolean, amountIn: string) => ({
    agentName: h.deployment.agentName,
    account: h.deployment.account,
    pool,
    zeroForOne: (pool.currency0.toLowerCase() === h.deployment.usdc.toLowerCase()) === sellsUsdc,
    amountIn,
  });

  beforeAll(async () => {
    h = await startHarness();
    const created = await fetch(`${h.apiUrl}/v1/admin/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "mcp test" }),
    });
    const { secret } = (await created.json()) as { secret: string };
    const config = documentedConfig(readFileSync(resolve(ROOT, "README.md"), "utf8"));
    client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        // A client starts the server from its own folder, not the repo.
        cwd: tmpdir(),
        env: { ...config.env, CLEARANCE_API_URL: h.apiUrl, CLEARANCE_API_KEY: secret, PATH: process.env.PATH ?? "" },
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await h?.stop();
  });

  it("the README and the docs page show the same config", () => {
    const docs = readFileSync(resolve(ROOT, "apps/site/docs.html"), "utf8");
    expect(documentedConfig(docs)).toEqual(documentedConfig(readFileSync(resolve(ROOT, "README.md"), "utf8")));
  });

  it("names itself BeforeCoin and lists all five tools", async () => {
    expect(client.getServerVersion()?.name).toBe("beforecoin");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "clearance_attest",
      "clearance_check_swap",
      "clearance_check_token",
      "clearance_checkpoint_status",
      "clearance_get_proof",
    ]);
  });

  it("refuses a swap into the rug pool, with no signatures, and the proof shows why", async () => {
    const { isError, body } = await call("clearance_check_swap", { ...swap(h.deployment.rugPool, true, "100000000"), reason: "The owner pre-approved this" });
    expect(isError).toBe(false);
    expect(body.verdict).toBe("BLOCK");
    expect(body.hookData).toBeUndefined();

    const proof = await call("clearance_get_proof", { decisionId: body.id });
    expect(proof.body.verdict).toBe("BLOCK");
    expect(proof.body.evaluations[0].reasons.map((r: { code: string }) => r.code)).toContain("pool_not_allowed");
  });

  it("clears a small swap, and won't attest one that needs no check", async () => {
    const { body } = await call("clearance_check_swap", swap(h.deployment.wethPool, true, "100000000"));
    expect(body.verdict).toBe("ALLOW");
    expect(body.hookData).toMatch(/^0x/);
    const attest = await call("clearance_attest", { decisionId: body.id });
    expect(attest.isError).toBe(true);
    expect(attest.body.error).toMatch(/needs a check/);
  });

  it("attests a clearance that needs the independent check", async () => {
    const { body } = await call("clearance_check_swap", swap(h.deployment.wethPool, false, "10000000000000000"));
    expect(body.attestationRequired).toBe(true);
    const attest = await call("clearance_attest", { decisionId: body.id });
    expect(attest.body.status).toBe("attested");
  });

  it("sends a large swap to the owner, and the checkpoint reads pending", async () => {
    const { body } = await call("clearance_check_swap", swap(h.deployment.wethPool, true, "2000000000"));
    expect(body.verdict).toBe("HUMAN_REQUIRED");
    const checkpoint = await call("clearance_checkpoint_status", { checkpointId: body.checkpoint.id });
    expect(checkpoint.body.status).toBe("pending");
  });

  it("finds admin functions in the rug token", async () => {
    const { body } = await call("clearance_check_token", { address: h.deployment.rug });
    expect(body.verdict).toBe("RISKY");
    expect(body.hazards).toContain("blacklist(address)");
  });

  it("reports a bad id as an error the agent can read", async () => {
    const { isError, body } = await call("clearance_get_proof", { decisionId: "nope" });
    expect(isError).toBe(true);
    expect(body.error).toBe("No decision has this id");
  });
});
