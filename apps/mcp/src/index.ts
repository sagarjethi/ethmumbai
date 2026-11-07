import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { clearanceClient, type ToolResult } from "./tools";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const client = clearanceClient(required("CLEARANCE_API_URL"), required("CLEARANCE_API_KEY"));
const server = new McpServer({ name: "beforecoin", version: "0.1.0" });

const reply = (result: ToolResult) => ({
  isError: !result.ok,
  content: [{ type: "text" as const, text: JSON.stringify(result.body) }],
});

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

server.tool(
  "clearance_check_swap",
  "Ask verifiers to clear a swap before making it. On ALLOW or REDUCE, the response has the hookData the swap needs. On BLOCK, don't retry: the chain will refuse it. On HUMAN_REQUIRED, send the owner to checkpoint.url.",
  {
    agentName: z.string(),
    account: address,
    pool: z.object({ currency0: address, currency1: address, fee: z.number(), tickSpacing: z.number(), hooks: address }),
    zeroForOne: z.boolean(),
    amountIn: z.string().describe("Smallest token units, as a decimal string"),
    reason: z.string().optional().describe("Why the agent wants this. Shown to the owner. Rules never read it."),
    checkpointId: z.string().optional().describe("The checkpoint, once the owner has answered it"),
  },
  async ({ checkpointId, ...rest }) => reply(await client.checkSwap({ kind: "swap", ...rest }, checkpointId)),
);

server.tool(
  "clearance_attest",
  "Request the independent check when a clearance says attestationRequired. The hook refuses that swap until this passes.",
  { decisionId: z.string() },
  async ({ decisionId }) => reply(await client.attest(decisionId)),
);

server.tool(
  "clearance_get_proof",
  "Read a decision's public proof: its signatures, each verifier's reasons and evidence hash, and any attestation.",
  { decisionId: z.string() },
  async ({ decisionId }) => reply(await client.proof(decisionId)),
);

server.tool(
  "clearance_check_token",
  "List admin functions, such as blacklist or mint, in a token's bytecode. Finding none doesn't prove a token is safe.",
  { address },
  async (args) => reply(await client.checkToken(args.address)),
);

server.tool(
  "clearance_checkpoint_status",
  "See whether the owner has answered a checkpoint: pending, approved, denied or expired.",
  { checkpointId: z.string() },
  async ({ checkpointId }) => reply(await client.checkpoint(checkpointId)),
);

await server.connect(new StdioServerTransport());
