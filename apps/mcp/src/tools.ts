export type ToolResult = { ok: boolean; status: number; body: unknown };

export type ClearanceClient = {
  checkSwap(action: unknown, checkpointId?: string): Promise<ToolResult>;
  attest(decisionId: string): Promise<ToolResult>;
  proof(decisionId: string): Promise<ToolResult>;
  checkToken(address: string): Promise<ToolResult>;
  checkpoint(id: string): Promise<ToolResult>;
};

export function clearanceClient(apiUrl: string, apiKey: string, fetcher: typeof fetch = fetch): ClearanceClient {
  // A pasted URL often ends in a slash, and "//v1" would be a 404.
  const base = apiUrl.replace(/\/+$/, "");
  const call = async (path: string, init?: RequestInit): Promise<ToolResult> => {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...init?.headers },
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    checkSwap: (action, checkpointId) => call("/v1/clear/swap", { method: "POST", body: JSON.stringify({ action, checkpointId }) }),
    attest: (id) => call(`/v1/decisions/${encodeURIComponent(id)}/attest`, { method: "POST" }),
    proof: (id) => call(`/v1/proofs/${encodeURIComponent(id)}`),
    checkToken: (address) => call(`/v1/tokens/${encodeURIComponent(address)}/check`),
    checkpoint: (id) => call(`/v1/human/${encodeURIComponent(id)}`),
  };
}
