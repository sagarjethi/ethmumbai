import type { OwnerDecision } from "./scenarios";

/**
 * Clicks through the local test issuer's approval page. It only works against the test issuer.
 * Those pages link to browser-facing URLs, so `internal` maps them back to where this process reaches them.
 */
export const mockOwnerVia = (internal: (url: string) => string): OwnerDecision => async (checkpointUrl, choice) => {
  const start = await fetch(internal(checkpointUrl), { redirect: "manual" });
  const location = start.headers.get("location");
  if (!location) throw new Error(`Checkpoint didn't redirect: ${start.status}`);
  const authorizeUrl = internal(location);
  const page = await fetch(authorizeUrl);
  const html = await page.text();
  const id = html.match(/name="id" value="([0-9a-f]+)"/)?.[1];
  if (!id) throw new Error(`Approval page had no request: ${html.slice(0, 200)}`);
  const decided = await fetch(new URL("/decide", authorizeUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id, decision: choice === "approve" ? "approve" : "deny" }),
    redirect: "manual",
  });
  const callback = decided.headers.get("location");
  if (!callback) throw new Error(`Issuer didn't redirect back: ${decided.status}`);
  const done = await fetch(internal(callback), { redirect: "manual" });
  if (done.status >= 400) throw new Error(`Callback failed: ${done.status}`);
};

export const mockOwner: OwnerDecision = mockOwnerVia((url) => url);
