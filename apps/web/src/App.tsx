import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  VERDICT_CLASS,
  VERDICT_LABEL,
  api,
  describeAction,
  formatAmount,
  runner,
  short,
  timeOf,
  type AgentInfo,
  type ApiKey,
  type CheckpointEvent,
  type Decision,
  type FeedEvent,
  type Outcome,
  type RequestRecord,
  type ScenarioInfo,
  type Usage,
} from "./api";

type View = "overview" | "live" | "lab" | "requests" | "keys" | "limits" | "verifiers";
const NAV: { id: View; label: string; hint: string }[] = [
  { id: "overview", label: "Overview", hint: "The agent, its usage and its limits" },
  { id: "live", label: "Live strips", hint: "Every action, as it happens" },
  { id: "lab", label: "Attack lab", hint: "Try to get past it" },
  { id: "requests", label: "Requests", hint: "The API log" },
  { id: "keys", label: "API keys", hint: "Create and revoke" },
  { id: "limits", label: "Owner limits", hint: "What the agent may do" },
  { id: "verifiers", label: "Verifiers", hint: "Who signs" },
];

/** An unknown hash falls back to the overview, so a stale link never shows a blank page. */
function viewFromHash(): View {
  const id = location.hash.slice(1);
  return NAV.some((item) => item.id === id) ? (id as View) : "overview";
}

type Theme = "dark" | "light";
const THEME_KEY = "clearance-theme";

/** Dark is the default. The inline script in index.html applies a saved choice before first paint. */
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "light" ? "light" : "dark"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be blocked. The theme still applies for this visit.
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

/** Reads an endpoint on a timer. Keeps the last good answer while the API is away. */
function usePolled<T>(path: string, everyMs: number, refreshKey?: unknown): T | undefined {
  const [data, setData] = useState<T>();
  useEffect(() => {
    const load = () => api<T>(path).then(setData, () => undefined);
    load();
    const timer = setInterval(load, everyMs);
    return () => clearInterval(timer);
  }, [path, everyMs, refreshKey]);
  return data;
}

function useAgent() {
  const [agent, setAgent] = useState<AgentInfo>();
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => {
    api<AgentInfo>("/v1/admin/agent").then(
      (a) => {
        setAgent(a);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    refresh();
    // Keeps trying, so the dashboard recovers by itself when the API comes back.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { agent, error, refresh };
}

function useFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const merge = (incoming: FeedEvent[]) =>
      setEvents((current) => {
        const known = new Set(current.map((e) => e.id));
        const added = incoming.filter((e) => !known.has(e.id));
        return added.length ? [...current, ...added].sort((a, b) => a.id - b.id) : current;
      });

    // EventSource stops for good after an error status, so this reconnects itself and refills what it missed.
    const connect = () => {
      if (cancelled) return;
      api<FeedEvent[]>("/v1/admin/events").then((initial) => {
        if (!cancelled) merge(initial);
      }, () => undefined);
      source = new EventSource("/api/v1/admin/feed");
      source.addEventListener("event", (message) => merge([JSON.parse((message as MessageEvent).data) as FeedEvent]));
      source.onerror = () => {
        source?.close();
        retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
  return events;
}

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const { agent, error, refresh } = useAgent();
  const events = useFeed();
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const onHash = () => {
      setView(viewFromHash());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // Balances change whenever something lands on the chain.
  useEffect(refresh, [events.length, refresh]);

  const pending = useMemo(() => pendingCheckpoints(events), [events]);

  return (
    <div className="shell">
      <TopBar view={view} agent={agent} offline={Boolean(error)} theme={theme} onToggleTheme={toggle} />
      <main className="stage">
        {error && <div className="notice bad" role="alert"><div><strong>The API isn't reachable.</strong> Start it with <code>pnpm start</code>. This page reconnects by itself.</div></div>}
        {pending[0] && <CheckpointBanner checkpoint={pending[0]} waiting={pending.length - 1} agent={agent} />}
        <Returned />
        {view === "overview" && <Account events={events} agent={agent} />}
        {view === "live" && <LiveStrips events={events} agent={agent} />}
        {view === "lab" && <Lab />}
        {view === "requests" && <Requests agent={agent} />}
        {view === "keys" && <Keys />}
        {view === "limits" && <Limits agent={agent} onChange={refresh} />}
        {view === "verifiers" && <Verifiers />}
      </main>
    </div>
  );
}

function TopBar({ view, agent, offline, theme, onToggleTheme }: { view: View; agent?: AgentInfo; offline: boolean; theme: Theme; onToggleTheme: () => void }) {
  const tabs = useRef<HTMLElement>(null);
  // On a phone the tabs scroll sideways, so keep the current one in sight.
  useEffect(() => {
    const row = tabs.current;
    const active = row?.querySelector<HTMLElement>(".active");
    if (row && active && row.scrollWidth > row.clientWidth) row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
  }, [view]);

  const state = offline ? "offline" : agent ? "live" : "waiting";
  return (
    <header className="topbar">
      <a className="mark" href="#overview">
        <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" /><path d="M8 17l5 5 11-12" /></svg>
        BeforeCoin
      </a>
      <nav aria-label="Dashboard" className="tabs" ref={tabs}>
        {NAV.map((item) => (
          <a key={item.id} href={`#${item.id}`} title={item.hint} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined}>
            {item.label}
          </a>
        ))}
      </nav>
      <div className="topbar-end">
        <span className={`conn ${state}`} role="status">
          <i aria-hidden="true" />
          <span>{offline ? "API offline" : agent ? "Live" : "Connecting"}</span>
        </span>
        {agent && <code className="topbar-agent" title={agent.name}>{agent.name}</code>}
        <button type="button" className="icon-button" onClick={onToggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          {theme === "dark" ? (
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></svg>
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7z" /></svg>
          )}
        </button>
      </div>
    </header>
  );
}

function PageHead({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {action}
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="button quiet small" onClick={() => { navigator.clipboard.writeText(value); setCopied(true); }}>
      {copied ? "Copied" : label}
    </button>
  );
}

function pendingCheckpoints(events: FeedEvent[]) {
  const latest = new Map<string, CheckpointEvent & { url?: string }>();
  for (const event of events) {
    if (event.type === "checkpoint") latest.set(event.data.id, { ...latest.get(event.data.id), ...event.data });
    if (event.type === "decision" && event.data.checkpoint) {
      latest.set(event.data.checkpoint.id, { ...latest.get(event.data.checkpoint.id), id: event.data.checkpoint.id, status: "pending", url: event.data.checkpoint.url, action: event.data.action });
    }
  }
  const fresh = events.filter((e) => Date.now() - e.at < 300_000);
  const freshIds = new Set(fresh.flatMap((e) => (e.type === "checkpoint" ? [e.data.id] : e.type === "decision" && e.data.checkpoint ? [e.data.checkpoint.id] : [])));
  return [...latest.values()].filter((c) => c.status === "pending" && freshIds.has(c.id) && c.url).reverse();
}

function CheckpointBanner({ checkpoint, waiting, agent }: { checkpoint: CheckpointEvent & { url?: string }; waiting: number; agent?: AgentInfo }) {
  const action = checkpoint.action && agent ? describeAction(checkpoint.action, agent.tokens) : undefined;
  return (
    <div className="notice human" role="status">
      <div>
        <strong>Your approval is needed.</strong>{" "}
        {action ? `The agent wants to ${action.verb.toLowerCase()} ${action.amount} ${action.detail}, which is over your limit.` : "The agent's request is over your limit."}
        {waiting > 0 && ` ${waiting} more waiting.`}
      </div>
      <a className="button human" href={checkpoint.url}>Review with World ID</a>
    </div>
  );
}

function Returned() {
  const [status] = useState(() => new URLSearchParams(location.search).get("status"));
  // Clear the address bar, so a reload doesn't repeat the message.
  useEffect(() => {
    if (status) history.replaceState(null, "", location.pathname + location.hash);
  }, [status]);
  if (!status) return null;
  return (
    <div className={`notice ${status === "approved" ? "ok" : "bad"}`} role="status">
      {status === "approved" ? "Approved. This one action can now go ahead." : "Not approved, so the action stays refused."}
    </div>
  );
}

// ---- Account overview ----

type VerifierStatus = { online: boolean; address?: string; provider?: string };

function Account({ events, agent }: { events: FeedEvent[]; agent?: AgentInfo }) {
  const usage = usePolled<Usage>("/v1/admin/usage", 5000, events.length);
  const keys = usePolled<{ keys: ApiKey[]; monthlyQuota: number }>("/v1/admin/keys", 5000);
  const verifiers = usePolled<VerifierStatus[]>("/v1/admin/verifiers", 5000);
  const strips = useStrips(events);

  const day = usage?.hourly.reduce((sum, h) => ({ cleared: sum.cleared + h.cleared, refused: sum.refused + h.refused, other: sum.other + h.other }), { cleared: 0, refused: 0, other: 0 });
  const activeKeys = keys?.keys.filter((k) => !k.revokedAt).length;
  const revokedKeys = keys ? keys.keys.length - (activeKeys ?? 0) : 0;
  const online = verifiers?.filter((v) => v.online).length;
  const limits = agent?.limits;
  const needed = agent ? Math.max(limits?.requiredVerifiers ?? 0, agent.threshold) : undefined;
  const paidToday = useMemo(() => clearedPaymentsUsd(events), [events]);

  return (
    <>
      <PageHead title="Overview" action={strips.length > 0 ? <a className="button quiet" href="#lab">Open the attack lab</a> : undefined}>
        The agent, what it has asked for, and how close it is to its limits.
      </PageHead>

      {agent ? (
        <section className="panel account" aria-label="Agent">
          <div className="account-id">
            <span className="eyebrow">Agent</span>
            <h2 className="account-name">{agent.name}</h2>
            <div className="account-wallet">
              <code title={agent.account}>{agent.account}</code>
              <CopyButton value={agent.account} />
            </div>
            <span className={`pill ${limits ? "ok" : "bad"}`}>{limits ? "Limits read from ENS" : "Limit record missing, refusing everything"}</span>
          </div>
          <div className="account-side">
            <span className="eyebrow">Wallet balances</span>
            {agent.balances.some((b) => b.raw !== "0") ? (
              <ul className="balances">
                {agent.balances.filter((b) => b.raw !== "0").map((b) => (
                  <li key={b.symbol}><span>{b.symbol}</span><b>{formatAmount(b.raw, b.decimals)}</b></li>
                ))}
              </ul>
            ) : <p className="muted">This wallet holds nothing. Fund it to let the agent trade.</p>}
            <p className="account-chain">Chain {agent.chainId}</p>
          </div>
        </section>
      ) : (
        <div className="empty"><h2>Waiting for the agent</h2><p>Its name, wallet and limits appear once the API answers. Start it with <code>pnpm start</code>.</p></div>
      )}

      <section className="tiles" aria-label="Summary">
        <Tile label="Cleared" value={day?.cleared} note="Last 24 hours" tone="ok" />
        <Tile label="Refused" value={day?.refused} note="Last 24 hours" tone="bad" />
        <Tile label="Other requests" value={day?.other} note="Last 24 hours" />
        <Tile label="Active API keys" value={activeKeys} note={activeKeys === 0 ? <a href="#keys">Create one</a> : revokedKeys ? `${revokedKeys} revoked` : <a href="#keys">Manage</a>} />
        <Tile label="Verifiers online" value={online} suffix={verifiers ? `of ${verifiers.length}` : undefined} note={needed ? `${needed} must sign` : undefined} tone={online !== undefined && needed !== undefined && online < needed ? "bad" : undefined} />
      </section>

      <div className="columns">
        <section className="panel" aria-labelledby="usage-limits">
          <header className="panel-head"><h2 id="usage-limits">Usage against limits</h2></header>
          <div className="meters">
            {usage && (
              <Meter
                label="API requests, last 30 days"
                value={usage.last30d}
                max={usage.monthlyQuota}
                format={(n) => n.toLocaleString()}
                note={`Each key includes ${usage.monthlyQuota.toLocaleString()} a month. This counts every request, x402 included.`}
              />
            )}
            {limits && (
              <Meter
                label="Payments cleared, last 24 hours"
                value={paidToday}
                max={limits.dailyPaymentUsd}
                format={(n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                note="Counted from the recent feed. Verifiers hold the budget that applies."
              />
            )}
            {online !== undefined && verifiers && needed !== undefined && (
              <Meter label="Verifiers online" value={online} max={verifiers.length} tick={needed} floor={needed} format={String} note={`A clearance needs ${needed} signatures.`} />
            )}
            {!usage && !limits && !verifiers && <p className="muted">Waiting for the API.</p>}
          </div>
        </section>
        <section className="panel" aria-labelledby="owner-limits">
          <header className="panel-head"><h2 id="owner-limits">Owner limits</h2><a className="panel-link" href="#limits">Review</a></header>
          {limits ? (
            <dl className="facts flush">
              <Fact label="Trades without asking">Up to ${limits.maxSizeUsd.toLocaleString()}</Fact>
              <Fact label="Never trades above">${limits.humanCapUsd.toLocaleString()}</Fact>
              <Fact label="Largest price impact">{limits.maxImpactBps} bps</Fact>
              <Fact label="Largest payment">${limits.maxPaymentUsd} each, ${limits.dailyPaymentUsd} a day</Fact>
              <Fact label="Tokens it may trade">{limits.allowedTokens.map((a) => agent?.tokens[a]?.symbol ?? short(a)).join(", ") || "None"}</Fact>
            </dl>
          ) : <p className="panel-empty muted">{agent ? "A limit record is missing or invalid, so every action is being refused." : "Waiting for the API."}</p>}
        </section>
      </div>

      {usage && <UsageWindows usage={usage} />}

      <section aria-labelledby="latest-strips">
        <div className="section-head">
          <h2 id="latest-strips">Latest actions</h2>
          {strips.length > 3 && <a className="panel-link" href="#live">All {strips.length} strips</a>}
        </div>
        <StripList strips={strips.slice(0, 3)} agent={agent} />
      </section>
    </>
  );
}

function Tile({ label, value, suffix, note, tone }: { label: string; value?: number; suffix?: string; note?: ReactNode; tone?: "ok" | "bad" }) {
  return (
    <div className="tile">
      <span>{tone && <i className={`dot ${tone}`} aria-hidden="true" />}{label}</span>
      <b>{value === undefined ? "-" : value.toLocaleString()}{suffix && value !== undefined && <em> {suffix}</em>}</b>
      {note && <small>{note}</small>}
    </div>
  );
}

/** `floor` marks a meter that must stay at or above a value, like a quorum, instead of below its max. */
function Meter({ label, value, max, format, note, tick, floor }: { label: string; value: number; max: number; format: (n: number) => string; note?: string; tick?: number; floor?: number }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  const tone = floor !== undefined ? (value < floor ? "bad" : "ok") : share >= 1 ? "bad" : share >= 0.8 ? "warn" : "ok";
  return (
    <div className="meter">
      <div className="meter-head"><span>{label}</span><span className="meter-value"><b>{format(value)}</b> of {format(max)}</span></div>
      <div className="track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <i className={tone} style={{ width: `${share * 100}%` }} />
        {tick !== undefined && max > 0 && <u style={{ left: `${(tick / max) * 100}%` }} />}
      </div>
      {note && <small>{note}</small>}
    </div>
  );
}

/** Sums cleared payments from the feed. USDC has 6 decimals and counts as dollars here, as it does in the limits. */
function clearedPaymentsUsd(events: FeedEvent[]): number {
  const since = Date.now() - 24 * 3600_000;
  let total = 0n;
  for (const event of events) {
    if (event.type !== "decision" || event.at < since || event.data.action.kind !== "payment") continue;
    if (event.data.verdict !== "ALLOW" && event.data.verdict !== "REDUCE") continue;
    total += BigInt(event.data.clearance?.maxAmountIn ?? event.data.action.authorization.value);
  }
  return Number(total) / 1e6;
}

// ---- Live strips ----

type StripData = { event: Extract<FeedEvent, { type: "decision" }>; outcomes: Outcome[] };

function useStrips(events: FeedEvent[]): StripData[] {
  return useMemo(() => {
    const outcomesAfter = new Map<number, Outcome[]>();
    const decisions = events.filter((e) => e.type === "decision") as Extract<FeedEvent, { type: "decision" }>[];
    for (const event of events) {
      if (event.type !== "outcome") continue;
      // Without a decision id, a leg belongs to the last swap or refused payment before it. Cleared payments are skipped: those are x402 fees paid between steps.
      const owner = [...decisions].reverse().find((d) => (event.data.decisionId ? d.data.id === event.data.decisionId : d.id < event.id && (d.data.action.kind === "swap" || d.data.verdict === "BLOCK")));
      if (!owner) continue;
      outcomesAfter.set(owner.id, [...(outcomesAfter.get(owner.id) ?? []), event.data]);
    }
    return [...decisions].reverse().map((d) => ({ event: d, outcomes: outcomesAfter.get(d.id) ?? [] }));
  }, [events]);
}

function LiveStrips({ events, agent }: { events: FeedEvent[]; agent?: AgentInfo }) {
  const usage = usePolled<Usage>("/v1/admin/usage", 5000, events.length);
  const strips = useStrips(events);
  return (
    <>
      <PageHead title="Live strips">Each strip is one action an agent asked to take, and what happened to it.</PageHead>
      {usage && <UsageWindows usage={usage} />}
      <StripList strips={strips} agent={agent} />
    </>
  );
}

function StripList({ strips, agent }: { strips: StripData[]; agent?: AgentInfo }) {
  if (strips.length === 0) {
    return (
      <div className="empty">
        <h2>No actions yet</h2>
        <p>Point an agent at the API, or try to break it in the attack lab.</p>
        <a className="button" href="#lab">Open the attack lab</a>
      </div>
    );
  }
  return (
    <ol className="strips">
      {strips.map(({ event, outcomes }) => (
        <Strip key={event.id} decision={event.data} at={event.at} outcomes={outcomes} agent={agent} />
      ))}
    </ol>
  );
}

const HOUR_MS = 3600_000;
const hourLabel = (hour: number) => new Date(hour).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function UsageWindows({ usage }: { usage: Usage }) {
  const [hovered, setHovered] = useState<number>();
  // The API only returns hours that had requests. Filling the gaps keeps the time axis honest.
  const slots = useMemo(() => {
    const byHour = new Map(usage.hourly.map((h) => [h.hour, h]));
    const latest = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    return Array.from({ length: 25 }, (_, i) => {
      const hour = latest - (24 - i) * HOUR_MS;
      return byHour.get(hour) ?? { hour, cleared: 0, refused: 0, other: 0 };
    });
  }, [usage.hourly]);
  const totals = slots.reduce((sum, h) => ({ cleared: sum.cleared + h.cleared, refused: sum.refused + h.refused, other: sum.other + h.other }), { cleared: 0, refused: 0, other: 0 });
  const max = Math.max(1, ...slots.map((h) => h.cleared + h.refused + h.other));
  const shown = hovered === undefined ? undefined : slots[hovered];
  const hasData = totals.cleared + totals.refused + totals.other > 0;

  return (
    <section className="panel usage" aria-label="API usage">
      <div className="windows">
        {[
          ["Last 15 minutes", usage.last15m],
          ["Last 24 hours", usage.last24h],
          ["Last 30 days", usage.last30d],
        ].map(([label, value]) => (
          <div key={label as string} className="window">
            <span>{label}</span>
            <b>{(value as number).toLocaleString()}</b>
          </div>
        ))}
      </div>
      <div className="hours">
        <div className="hours-head">
          <span className="hours-title">Requests per hour</span>
          <ul className="legend">
            <li><i className="ok" />Cleared {totals.cleared}</li>
            <li><i className="bad" />Refused {totals.refused}</li>
            <li><i className="other" />Other {totals.other}</li>
          </ul>
        </div>
        {hasData ? (
          <>
            <div className="bars" onMouseLeave={() => setHovered(undefined)}>
              {slots.map((h, i) => {
                const label = `${hourLabel(h.hour)}. ${h.cleared} cleared, ${h.refused} refused, ${h.other} other`;
                return (
                  <button type="button" key={h.hour} className={`bar ${hovered === i ? "on" : ""}`} aria-label={label} onMouseEnter={() => setHovered(i)} onFocus={() => setHovered(i)} onClick={() => setHovered(i)}>
                    {h.other > 0 && <i className="other" style={{ height: `${(h.other / max) * 100}%` }} />}
                    {h.refused > 0 && <i className="bad" style={{ height: `${(h.refused / max) * 100}%` }} />}
                    {h.cleared > 0 && <i className="ok" style={{ height: `${(h.cleared / max) * 100}%` }} />}
                  </button>
                );
              })}
            </div>
            <div className="axis"><span>24 hours ago</span><span>Now</span></div>
            <p className="readout" aria-live="polite">
              {shown ? `From ${hourLabel(shown.hour)}: ${shown.cleared} cleared, ${shown.refused} refused, ${shown.other} other` : `Busiest hour: ${max} requests`}
            </p>
          </>
        ) : (
          <p className="hours-empty">Nothing in the last 24 hours. <a href="#lab">Run an attack</a> to see it here.</p>
        )}
      </div>
    </section>
  );
}

function Strip({ decision, at, outcomes, agent }: { decision: Decision; at: number; outcomes: Outcome[]; agent?: AgentInfo }) {
  const [open, setOpen] = useState(false);
  const action = describeAction(decision.action, agent?.tokens ?? {});
  const tone = VERDICT_CLASS[decision.verdict] ?? "other";
  const allowed = decision.evaluations.filter((e) => e.verdict === "ALLOW" || e.verdict === "REDUCE").length;
  const headline = [...new Set(decision.evaluations.flatMap((e) => e.reasons.filter((r) => r.severity !== "info").map((r) => r.detail)))][0];
  const tokenIn = decision.action.kind === "swap" ? (decision.action.zeroForOne ? decision.action.pool.currency0 : decision.action.pool.currency1) : undefined;

  return (
    <li className={`strip ${tone}`}>
      <button className="strip-main" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="stamp">{VERDICT_LABEL[decision.verdict]}</span>
        <span className="what">
          <b>{action.verb} {action.amount}</b> <span className="muted">{action.detail}</span>
          {headline && <small>{readable(headline, agent?.tokens)}</small>}
          {decision.verdict === "REDUCE" && decision.clearance && tokenIn && (
            <small>Cleared {formatAmount(decision.clearance.maxAmountIn, agent?.tokens[tokenIn]?.decimals ?? 18)} {agent?.tokens[tokenIn]?.symbol} instead</small>
          )}
        </span>
        <span className="sigs" aria-label={`${allowed} of ${decision.evaluations.length} verifiers signed, ${decision.required} needed`}>
          {decision.evaluations.map((e) => (
            <i key={e.verifier} className={VERDICT_CLASS[e.verdict]} />
          ))}
          {decision.unreachable.map((u) => <i key={u} className="off" />)}
          <small>{allowed} signed, {decision.required} needed</small>
        </span>
        <time>{timeOf(at)}</time>
      </button>
      {outcomes.length > 0 && (
        <ul className="legs">
          {outcomes.map((o, i) => (
            <li key={i} className={o.result}>
              <span className="leg-dot" />
              <span>{o.label}</span>
              <small>{friendly(o.detail)}</small>
            </li>
          ))}
        </ul>
      )}
      {open && <DecisionDetail decision={decision} tokens={agent?.tokens} />}
    </li>
  );
}

const friendly = (detail: string) => detail.replace(/Executed in (0x[0-9a-f]{6})[0-9a-f]+/, "Executed, tx $1…").replace(/^Reverted with /, "Reverted: ");

/** Shows a token's symbol, or a shortened address, instead of a full address in the middle of a sentence. */
function readable(text: string, tokens: AgentInfo["tokens"] = {}): string {
  return text.replace(/0x[0-9a-fA-F]{40}/g, (address) => tokens[address]?.symbol ?? short(address));
}

function DecisionDetail({ decision, tokens }: { decision: Decision; tokens?: AgentInfo["tokens"] }) {
  return (
    <div className="detail">
      {decision.action.reason && (
        <div className="quote"><span>The agent's stated reason. Treated as untrusted, and never read by the rules.</span><q>{decision.action.reason}</q></div>
      )}
      <div className="verifier-grid">
        {decision.evaluations.map((e) => (
          <div key={e.verifier} className="verifier-col">
            <header><code title={e.verifier}>{short(e.verifier)}</code><span className={`pill ${VERDICT_CLASS[e.verdict]}`}>{VERDICT_LABEL[e.verdict]}</span></header>
            <ul>{e.reasons.map((r, i) => <li key={i}>{readable(r.detail, tokens)}{r.source && <small> from {r.source}</small>}</li>)}</ul>
            <p className="model">
              {e.review.status === "ok" ? `${e.review.provider}: ${e.review.summary}` : e.review.status === "failed" ? `${e.review.provider} failed, so rules alone decided.` : "No model set up. Rules alone decided."}
            </p>
            {e.review.trace?.requestId && <code className="hash request-id">Request ID {e.review.trace.requestId}</code>}
            <code className="hash" title={e.evidenceHash}>Evidence {short(e.evidenceHash, 10, 6)}</code>
          </div>
        ))}
      </div>
      <p className="detail-foot">
        <a href={`/api/v1/proofs/${decision.id}`} target="_blank" rel="noreferrer">Open the public proof</a>
        {decision.attestation && <span> Independent check: {decision.attestation.status}, by {decision.attestation.mode}.</span>}
      </p>
    </div>
  );
}

// ---- Attack lab ----

function Lab() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<string>();
  const [unreachable, setUnreachable] = useState(false);

  const load = useCallback(async () => {
    const body = await runner<{ running?: string; scenarios: ScenarioInfo[] }>("/scenarios");
    setScenarios(body.scenarios);
    setRunning(body.running);
    setUnreachable(false);
    return body.running;
  }, []);

  // Keeps trying, so the lab recovers by itself when the runner comes back.
  useEffect(() => {
    const poll = () => load().catch(() => setUnreachable(true));
    poll();
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, [load]);

  async function run(id: string) {
    setError(undefined);
    try {
      await runner(`/run/${id}`, { method: "POST" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const finished = scenarios.filter((s) => s.result);

  return (
    <>
      <PageHead title="Attack lab" action={finished.length > 0 ? <span className="head-note">{finished.length} of {scenarios.length} run, {finished.filter((s) => s.result?.pass).length} passed</span> : undefined}>
        Each run sends real transactions to the test chain, then shows what the pool and the wallet did.
      </PageHead>
      {unreachable && <div className="notice bad" role="alert"><div><strong>The scenario runner isn't reachable.</strong> Start it with <code>pnpm start</code>. This page reconnects by itself.</div></div>}
      {error && <div className="notice bad">{error}</div>}
      {scenarios.length === 0 && !unreachable && <div className="empty"><h2>Loading the attacks</h2><p>They appear here as soon as the runner answers.</p></div>}
      <ul className="scenarios">
        {scenarios.map((s) => {
          const state = running === s.id ? "running" : s.result ? (s.result.pass ? "pass" : "fail") : "idle";
          return (
            <li key={s.id} className={`scenario ${state}`}>
              <div className="scenario-head">
                <div>
                  <h2>{s.title}</h2>
                  <p>{s.description}{s.waitsForOwner ? " You answer the approval yourself." : ""}</p>
                </div>
                <button className={`button ${running === s.id ? "" : "quiet"}`} disabled={Boolean(running)} onClick={() => run(s.id)}>
                  {running === s.id ? "Running" : s.result ? "Run again" : "Run"}
                </button>
              </div>
              {s.result && (
                <ol className="checks">
                  {s.result.checks.map((c, i) => (
                    <li key={i} className={c.pass ? "pass" : "fail"}>
                      <span aria-hidden="true">{c.pass ? "✓" : "✕"}</span>
                      <div><b>{c.label}</b><small>{friendly(c.detail)}</small></div>
                    </li>
                  ))}
                  {s.result.error && <li className="fail"><span aria-hidden="true">✕</span><div><b>The run stopped</b><small>{s.result.error}</small></div></li>}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---- Requests ----

function Requests({ agent }: { agent?: AgentInfo }) {
  const [requests, setRequests] = useState<RequestRecord[]>([]);
  const [selected, setSelected] = useState<RequestRecord>();
  const [decision, setDecision] = useState<Decision>();

  useEffect(() => {
    const load = () => api<RequestRecord[]>("/v1/admin/requests").then(setRequests, () => undefined);
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setDecision(undefined);
    if (selected?.decisionId) api<Decision>(`/v1/admin/decisions/${selected.decisionId}`).then(setDecision, () => undefined);
  }, [selected]);

  const current = selected ?? requests[0];
  useEffect(() => {
    if (!selected && requests[0]) setSelected(requests[0]);
  }, [requests, selected]);

  return (
    <>
      <PageHead title="Requests">Every call to the clearing API, newest first.</PageHead>
      {requests.length === 0 ? (
        <div className="empty"><h2>No requests yet</h2><p>Calls to the clearing API appear here. Run an attack to make the first one.</p><a className="button" href="#lab">Open the attack lab</a></div>
      ) : (
        <div className="split">
          <ul className="req-list">
            {requests.map((r) => (
              <li key={r.id}>
                <button className={current?.id === r.id ? "active" : ""} onClick={() => setSelected(r)}>
                  <span className={`code s${Math.floor(r.status / 100)}`}>{r.status}</span>
                  <code><b>{r.method}</b> {r.path}</code>
                  <time>{timeOf(r.at)}</time>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <section className="req-detail" aria-label="Request detail">
              <h2><code>{current.method} {current.path}</code></h2>
              <dl className="facts flush">
                <Fact label="Status"><span className={`code s${Math.floor(current.status / 100)}`}>{current.status}</span></Fact>
                <Fact label="Paid with">{current.auth === "api_key" ? "API key" : current.auth === "x402" ? "x402 payment" : "No charge"}</Fact>
                <Fact label="Time taken">{current.latencyMs} ms</Fact>
                {current.verdict && <Fact label="Verdict"><span className={`pill ${VERDICT_CLASS[current.verdict]}`}>{VERDICT_LABEL[current.verdict]}</span></Fact>}
                {current.decisionId && <Fact label="Decision"><a href={`/api/v1/proofs/${current.decisionId}`} target="_blank" rel="noreferrer"><code>{current.decisionId}</code></a></Fact>}
              </dl>
              {current.status === 402 && <p className="muted">The server asked for payment here. The x402 client paid and retried, which appears as the next request.</p>}
              {decision && (
                <>
                  <p className="req-action">{(() => { const a = describeAction(decision.action, agent?.tokens ?? {}); return `${a.verb} ${a.amount} ${a.detail}`; })()}</p>
                  <DecisionDetail decision={decision} tokens={agent?.tokens} />
                </>
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

// ---- Keys ----

function Keys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [quota, setQuota] = useState<number>();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKey>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    api<{ keys: ApiKey[]; monthlyQuota: number }>("/v1/admin/keys").then((body) => {
      setKeys(body.keys);
      setQuota(body.monthlyQuota);
    }, () => undefined);
  }, []);
  // Keeps trying, so the list fills in by itself when the API comes back.
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      setCreated(await api<ApiKey>("/v1/admin/keys", { method: "POST", body: JSON.stringify({ name }) }));
      setName("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`Revoke "${key.name}"? Anything using it stops working.`)) return;
    setError(undefined);
    try {
      await api(`/v1/admin/keys/${key.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHead title="API keys">
        {quota !== undefined ? `A key includes ${quota.toLocaleString()} checks a month. ` : ""}Without one, agents pay per check with x402.
      </PageHead>
      {error && <div className="notice bad">{error}</div>}
      {created?.secret && (
        <div className="secret" role="status">
          <h2>Copy this key now</h2>
          <p>It won't be shown again. Only its hash is stored. Replace <code>your-api</code> below with the address of your API.</p>
          <div className="secret-row">
            <code>{created.secret}</code>
            <CopyButton key={created.secret} value={created.secret} />
          </div>
          <pre>{`curl -X POST https://your-api/v1/clear/swap \\
  -H "authorization: Bearer ${created.secret}" \\
  -H "content-type: application/json" \\
  -d @swap.json`}</pre>
        </div>
      )}
      <section className="panel" aria-label="Your keys">
        <form className="inline-form" onSubmit={create}>
          <label>Key name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trading agent" required maxLength={60} /></label>
          <button className="button">Create key</button>
        </form>
        {keys.length === 0 ? (
          <p className="panel-empty muted">No keys yet. Name one above to call the API without paying per check.</p>
        ) : (
          <table className="stack">
            <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th><span className="sr">Actions</span></th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "revoked" : ""}>
                  <td data-label="Name">{k.name}</td>
                  <td data-label="Key"><code>clr_••••{k.hint}</code></td>
                  <td data-label="Created">{new Date(k.createdAt).toLocaleDateString("en-GB")}</td>
                  <td data-label="Last used">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("en-GB") : "Never"}</td>
                  <td className="right">{k.revokedAt ? <span className="muted">Revoked</span> : <button className="link danger" onClick={() => revoke(k)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

// ---- Limits ----

function Limits({ agent, onChange }: { agent?: AgentInfo; onChange: () => void }) {
  const [form, setForm] = useState({ maxSizeUsd: "", humanCapUsd: "", maxImpactBps: "" });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (agent?.limits) {
      setForm({
        maxSizeUsd: String(agent.limits.maxSizeUsd),
        humanCapUsd: String(agent.limits.humanCapUsd),
        maxImpactBps: String(agent.limits.maxImpactBps),
      });
    }
  }, [agent?.limits?.maxSizeUsd, agent?.limits?.humanCapUsd, agent?.limits?.maxImpactBps]);

  if (!agent) {
    return (
      <>
        <PageHead title="Owner limits">These live in the agent's ENS records, so every verifier reads them from the chain.</PageHead>
        <div className="empty"><h2>Waiting for the agent</h2><p>The limits appear once the API answers. Start it with <code>pnpm start</code>.</p></div>
      </>
    );
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      await api("/v1/admin/limits", {
        method: "POST",
        body: JSON.stringify({
          maxSizeUsd: Number(form.maxSizeUsd),
          humanCapUsd: Number(form.humanCapUsd),
          maxImpactBps: Number(form.maxImpactBps),
        }),
      });
      setSaved(true);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof form, label: string, help: string, record: string, unit: string) => (
    <label className="limit">
      <span className="limit-text">
        <b>{label}</b>
        <small>{help}</small>
        <code>{record}</code>
      </span>
      <span className="with-unit"><input type="number" min="0" value={form[key]} disabled={!agent.canEditLimits} onChange={(e) => setForm({ ...form, [key]: e.target.value })} required /><em>{unit}</em></span>
    </label>
  );

  const tokenName = (a: string) => agent.tokens[a]?.symbol ?? short(a);

  return (
    <>
      <PageHead title="Owner limits">These live in <code>{agent.name}</code>'s ENS records, so every verifier reads them from the chain, and only the owner's wallet can change them.</PageHead>
      {!agent.limits && <div className="notice bad">A limit record is missing or invalid, so every action is being refused.</div>}
      <form className="panel limits-form" onSubmit={save}>
        {field("maxSizeUsd", "Trade without asking me", "Above this, you approve each trade with World ID.", "clearance.maxSizeUsd", "USD")}
        {field("humanCapUsd", "Never trade above", "A hard cap. Even your approval can't exceed it.", "clearance.humanCapUsd", "USD")}
        {field("maxImpactBps", "Largest price impact", "Bigger trades get reduced. 100 is 1%.", "clearance.maxImpactBps", "bps")}
        {agent.canEditLimits ? (
          <div className="form-foot">
            <button className="button" disabled={saving}>{saving ? "Writing to the chain" : "Save limits"}</button>
            {saved && <span role="status">Saved. The next check uses these.</span>}
            {error && <span className="bad-text">{error}</span>}
          </div>
        ) : <p className="form-foot muted">Change these from the owner's wallet.</p>}
      </form>
      {agent.limits && (
        <section className="panel" aria-label="Other limits">
          <dl className="facts flush">
            <Fact label="Tokens it may trade">{agent.limits.allowedTokens.map(tokenName).join(", ") || "None"}</Fact>
            <Fact label="Pools you approved">{agent.limits.allowedPools.length}</Fact>
            <Fact label="Who it may pay">{agent.limits.allowedPayees.map((p) => short(p)).join(", ") || "Nobody"}, up to ${agent.limits.maxPaymentUsd} each and ${agent.limits.dailyPaymentUsd} a day</Fact>
            <Fact label="Signatures needed">{Math.max(agent.limits.requiredVerifiers, agent.threshold)} of {agent.verifierCount}</Fact>
            <Fact label="Bound wallet"><code>{agent.limits.account}</code></Fact>
            <Fact label="Hook"><code>{agent.hook}</code></Fact>
            <Fact label="Independent check ledger"><code>{agent.ledger}</code></Fact>
          </dl>
        </section>
      )}
    </>
  );
}

// ---- Verifiers ----

function Verifiers() {
  const [verifiers, setVerifiers] = useState<VerifierStatus[]>([]);
  const [record, setRecord] = useState<{ verdicts: Record<string, number>; attested: number; attestationRefused: number; verifiers: { address: string; evaluated: number; dissented: number }[] }>();

  useEffect(() => {
    const load = () => {
      api<typeof verifiers>("/v1/admin/verifiers").then(setVerifiers, () => undefined);
      api<NonNullable<typeof record>>("/v1/track-record").then(setRecord, () => undefined);
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <PageHead title="Verifiers">Each one reads the data itself. A verifier that disagrees with the others shows up here.</PageHead>
      {record && (
        <section className="tiles" aria-label="Track record">
          <Tile label="Cleared" value={(record.verdicts.ALLOW ?? 0) + (record.verdicts.REDUCE ?? 0)} tone="ok" />
          <Tile label="Refused" value={record.verdicts.BLOCK ?? 0} tone="bad" />
          <Tile label="Sent to the owner" value={record.verdicts.HUMAN_REQUIRED ?? 0} />
          <Tile label="Independent checks passed" value={record.attested} />
          <Tile label="Independent checks refused" value={record.attestationRefused} />
        </section>
      )}
      <section className="panel" aria-label="Verifier list">
        {verifiers.length === 0 ? (
          <p className="panel-empty muted">No verifiers have answered yet. Start them with <code>pnpm start</code>.</p>
        ) : (
          <table className="stack">
            <thead><tr><th>Verifier</th><th>Status</th><th>Model</th><th className="right">Checks</th><th className="right">Disagreed</th></tr></thead>
            <tbody>
              {verifiers.map((v, i) => {
                const stats = record?.verifiers.find((s) => s.address === v.address);
                return (
                  <tr key={i}>
                    <td data-label="Verifier">{v.address ? <code title={v.address}>{short(v.address, 10, 6)}</code> : `Verifier ${i + 1}`}</td>
                    <td data-label="Status"><span className={`pill ${v.online ? "ok" : "bad"}`}>{v.online ? "Online" : "Offline"}</span></td>
                    <td data-label="Model" className="wrap">{v.provider && v.provider !== "none" ? v.provider : <span className="muted">Rules only. Add a provider key to turn on review.</span>}</td>
                    <td data-label="Checks" className="right num">{stats?.evaluated ?? 0}</td>
                    <td data-label="Disagreed" className="right num">{stats?.dissented ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
