# BeforeCoin

A check AI agents can't skip.

Agents hold real money, and a hijacked one will happily spend it.
Other tools tell an agent what looks risky, then let it decide.
BeforeCoin takes that decision away.
Independent verifiers check the exact action against live data, and without enough signatures the pool refuses the swap and the wallet refuses the payment.

The code calls the signed approval a clearance, so names like `ClearanceHook` are expected.

## Run it

You need Foundry, Node 22 or newer, pnpm and Bun.
Nothing here needs real funds or keys.

```bash
git clone --recursive https://github.com/sagarjethi/ethmumbai.git
cd ethmumbai
pnpm install
pnpm start
```

- Website: http://localhost:5184
- Dashboard: http://localhost:5183
- Try every attack from the dashboard's attack lab, or with `pnpm demo`.

## How it works

1. **The owner sets limits** in the agent's ENS records: size, price impact, tokens, payees.
2. **The agent asks** `POST /v1/clear/swap` with the exact swap, and pays with x402 or an API key.
3. **Verifiers check separately.** Each reads the chain itself. Fixed rules decide, and missing or stale data always blocks. A model can explain or veto, and can never approve.
4. **A quorum signs** one EIP-712 clearance bound to the agent, pool, direction, amount, expiry and nonce. A refusal is simply no signature, and a reduction is a smaller `maxAmountIn`.
5. **Big trades get a human and a second look.** Over the limit, the owner approves with World ID, bound to that one action. A Chainlink CRE workflow then re-derives limits, quorum and market, and writes its finding on chain.
6. **The chain enforces.** The v4 hook reverts anything without a valid clearance. The agent's smart account refuses other pools, direct transfers and uncleared payments.

A hook only guards its own pool, so the smart account is the real enforcer. The hook is an opt-in safe pool.

The wallet also enforces what no server can talk it out of: a signed minimum output, a rolling daily spend cap per token, and the owner's own signature count.
Only an approved creator can open a pool on the hook, and the owner lists the pools it trusts in ENS, because a pool's own price means nothing otherwise.

## Where to look

### Uniswap v4

| What | Where |
|---|---|
| The check on every swap | [`beforeSwap`](contracts/src/ClearanceHook.sol#L149), [`_enforce`](contracts/src/ClearanceHook.sol#L161) |
| Who really called, through `IMsgSender` | [`ClearanceHook.sol:169`](contracts/src/ClearanceHook.sol#L169), [`ClearanceRouter.msgSender`](contracts/src/ClearanceRouter.sol#L32) |
| Only allowed hooks, no direct transfers, spend cap and signed output | [`ClearanceAccount.swapCleared`](contracts/src/ClearanceAccount.sol#L111) |
| Only approved creators can open a pool | [`beforeInitialize`](contracts/src/ClearanceHook.sol#L196) |
| The Quoter as live market data | [`apps/verifier/src/facts.ts`](apps/verifier/src/facts.ts) |
| Friction we hit | [`FEEDBACK.md`](FEEDBACK.md) |

### ENSv2

| What | Where |
|---|---|
| Name, per-agent resolver and limits | [`setupAgentName`](packages/shared/src/ensv2.ts#L135) |
| Reading limits through ENSIP-10 | [`readAgentRecords`](packages/shared/src/ensv2.ts#L100) |
| A writer limited to one record | [`grantRecordWriter`](packages/shared/src/ensv2.ts#L233) |
| Each name bound to one wallet | [`clearance.account`](packages/shared/src/limits.ts) |
| Tests on the real contracts | [`tests/ens-fork.test.ts`](tests/ens-fork.test.ts) |

### World ID

| What | Where |
|---|---|
| Step-up with `max_age=0` and `prompt=login`, and backend validation | [`apps/api/src/human.ts`](apps/api/src/human.ts) |
| Checks on `state`, `nonce`, `acr`, `auth_time` and the owner | [`checkHumanApproval`](packages/shared/src/human.ts#L38) |
| The denied path | [`human-denied` scenario](apps/agent/src/scenarios.ts) |
| Integration debrief | [`docs/WORLD_DEBRIEF.md`](docs/WORLD_DEBRIEF.md) |

### Chainlink CRE

| What | Where |
|---|---|
| The workflow | [`attestDecision`](cre/attest/attest.ts#L181) |
| Its checks | [`evaluateAttestation`](packages/shared/src/attestation.ts#L68) |
| Where its reports land | [`ClearanceLedger.onReport`](contracts/src/ClearanceLedger.sol) |
| Where its reports get enforced | [`NotAttested`](contracts/src/ClearanceHook.sol#L190) |
| External price sources, with keys from CRE secrets | [`PRICE_SOURCES`](cre/attest/attest.ts#L109), [`secrets.yaml`](cre/secrets.yaml) |
| How sources get compared, failing closed | [`compareSources`](packages/shared/src/attestation.ts#L106) |
| The simulation, on a throwaway Sepolia fork | [`scripts/cre-simulate.ts`](scripts/cre-simulate.ts) |

### x402

| What | Where |
|---|---|
| Charging for a check | [`apps/api/src/x402.ts`](apps/api/src/x402.ts) |
| A smart account paying, with verifiers inside the signature | [`Agent.paymentSigner`](apps/agent/src/agent.ts), [`isValidSignature`](contracts/src/ClearanceAccount.sol#L154) |

### 0G

| What | Where |
|---|---|
| Verifier model review on 0G Private Computer, pinned to sealed inference with the TEE check on | [`apps/verifier/src/review.ts`](apps/verifier/src/review.ts#L90) |
| The request id and TEE result recorded on every review | [`zeroGTrace`](apps/verifier/src/review.ts#L54) |
| A bad TEE signature, an empty balance or an outage can't approve anything | [`tests/adversarial.test.ts`](tests/adversarial.test.ts#L372) |
| One live review, printing its request id | [`scripts/0g-review.ts`](scripts/0g-review.ts) |

## Connect an agent over MCP

`apps/mcp` is an MCP server with five tools, so an agent can call BeforeCoin as a tool: `clearance_check_swap`, `clearance_attest`, `clearance_get_proof`, `clearance_check_token` and `clearance_checkpoint_status`.
It speaks stdio, and the client starts it for you.

With `pnpm start` running, create a key in the dashboard's API keys tab, then use this config with absolute paths to your clone:

```json
{
  "mcpServers": {
    "beforecoin": {
      "command": "/absolute/path/to/ethmumbai/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/ethmumbai/apps/mcp/src/index.ts"],
      "env": {
        "CLEARANCE_API_URL": "http://127.0.0.1:18787",
        "CLEARANCE_API_KEY": "clr_your_key"
      }
    }
  }
}
```

- **Claude Code:** put it in `.mcp.json` at your project root.
- **Cursor:** put it in `.cursor/mcp.json` or `~/.cursor/mcp.json`, then approve the server.

Both were checked with their own CLIs, `claude mcp list` and `cursor-agent mcp list-tools`.
A client started from a desktop app may not find `node` on its `PATH`, so add a `PATH` entry to `env` if the server won't start.
A `BLOCK` is a normal answer and not a tool error, so the agent reads `verdict`.
The server has no payment tool yet, so payments go through your x402 signer over REST.

## Tests

```bash
pnpm test:contracts
pnpm test:ts
pnpm test:cre
pnpm test:fork
```

`pnpm test:fork` runs every attack against the real Sepolia PoolManager, Quoter and StateView, with limits on a real ENSv2 name, on a throwaway fork.
All tests use throwaway chains and temporary databases.

## Use it from an agent skill

[`skills/beforecoin`](skills/beforecoin/SKILL.md) tells an agent to get a check before every swap or payment, what each verdict means, how to submit the result to its wallet, and never to route around a refusal.

For Claude Code, copy it to one of the [skill folders in Claude Code's docs](https://code.claude.com/docs/en/skills):

```bash
mkdir -p ~/.claude/skills && cp -R skills/beforecoin ~/.claude/skills/   # all your projects
mkdir -p .claude/skills && cp -R skills/beforecoin .claude/skills/       # one project
```

For another agent, give it `SKILL.md` as instructions, and let it read `references/` and run `scripts/check.ts`.
The script takes a swap as JSON, needs only Node, and reads `CLEARANCE_API_URL` and `CLEARANCE_API_KEY`:

```bash
node skills/beforecoin/scripts/check.ts swap.json
```

It exits `0` only for `ALLOW`, so a refusal or an error can't fall through to a swap.

`tests/skill.test.ts` runs the script against a throwaway stack: `ALLOW` executes through the smart account and `BLOCK` is refused on chain, along with `REDUCE`, `HUMAN_REQUIRED` and payments.
No model has been run with the skill loaded yet, in Claude Code or anywhere else, so how well agents follow it is untested.

## Status

What's proven, and what isn't:

| Part | Status |
|---|---|
| Hook, account, verifiers, API, scenarios | Tested end to end on a local chain |
| Real v4, ENSv2 and Circle USDC | Every scenario passes on a Sepolia fork, including the smart account's ERC-1271 payment through x402. Not yet deployed to Sepolia |
| CRE workflow | Compiles to WASM with `cre workflow build` and passes on the SDK's mock runtime. `cre workflow simulate` needs a logged-in account and hasn't run yet. `pnpm cre:simulate` is ready to run it. Up to that command, the script's `--prepare` run produced a real clearance on a Sepolia fork, and the local attestor attested it through the mock forwarder's address |
| CRE price sources | Tested against mocks of each source's documented reply. CoinGecko's and Coinbase's reply shapes were checked against live keyless replies. CoinMarketCap's comes from its docs, since no key was available. No keyed request has been made |
| World ID | Runs against a local test issuer that proves nobody's humanity. Not yet run against World's sandbox |
| Model review | Adapters tested against stub servers. Not yet run with real provider keys |
| 0G review | Tested against a mock of the Router's documented format, through the full stack. No live 0G inference has run, so there is no real request id yet, and glm-5.3's output and latency are unchecked |
| x402 on Launa | Unproven with a smart account on real Sepolia. The fork runs use the npm reference facilitator |

An independent review found a critical bug, now fixed and tested: anyone could open a pool on the hook at an absurd price, and verifiers would have trusted it.

Known limits:

- **Attestations through a mock forwarder are not trustworthy.** `cre workflow simulate --broadcast` delivers through CRE's mock forwarder, which anyone may be able to call. For real use, deploy the workflow, point the ledger at the real forwarder and set `ATTEST_WORKFLOW_ID`.
- **Payment budgets and used approvals live in verifier memory.** A restart forgets them. The swap spend cap is on chain and doesn't have this limit. A durable store comes next.
- **USD values come from the owner-approved pool's own price**, so owner approval of a pool is a trust decision. An independent price oracle is the next step for mainnet.
- **Hook attestation thresholds are in raw input units**, so selling tWETH nearly always needs an attestation. This fails closed.
- **One agent per deployment.** The verifiers read one resolver, so more agents need their own deployment for now.
- **The dashboard's admin token** is held by its dev server, which binds to localhost. A hosted version needs real owner sign-in first.
- **GoPlus isn't used**, because it has no data for Sepolia test tokens. The bytecode rule and Quoter do this job on testnet.
- **The CRE price check is on ETH/USD, not the pool's price.** Testnet tokens have no market, so it refuses when outside sources disagree, and doesn't yet compare them with the pool. Only the workflow runs it, because `LocalAttestor` has no CRE secrets.
- **0G review is optional, and it can only refuse.** Rules still decide without it, and in a 2-of-3 quorum one verifier's veto doesn't stop a trade on its own. `tee_verified` is the Router's own claim. Independent checking with 0G's SDK isn't built, though the id it needs is recorded.
- **The contracts haven't had an external audit.** Don't put real funds behind them.

## Deploy to Sepolia

Fill in `.env` from `.env.example`, then:

```bash
set -a; source .env; set +a
pnpm deploy:sepolia
```

To simulate the CRE workflow, which needs no deployment or funds:

```bash
~/.cre/bin/cre login
export COINGECKO_API_KEY=<your key> COINMARKETCAP_API_KEY=<your key>
pnpm cre:simulate
```

This starts a throwaway Sepolia fork, deploys to it, gets a real clearance and runs `cre workflow simulate --broadcast` against that fork.
On an attestation it saves the scrubbed output to `docs/cre-simulation.txt`.
Without both keys, the workflow writes no attestation.
Against live Sepolia, deploy with `pnpm deploy:sepolia`, copy `cre/attest/config.example.json` to `config.json`, fill in the addresses, and use `--target local-simulation`.

## Layout

```text
contracts/        Hook, router, smart account, verifier set, ledger, Foundry tests
packages/shared/  EIP-712, canonical hashing, limits, ENSv2, human approval check
apps/verifier/    Facts, rules, model review, signing
apps/api/         Clearing, quorum, World gate, x402, keys, proofs
apps/agent/       Agent, attack scenarios, runner
apps/mcp/         MCP server, so any agent can call BeforeCoin as a tool
skills/           Agent skill: instructions, real examples, check script
apps/web/         Owner dashboard
apps/site/        Website and docs
apps/mock-world/  Local test issuer for the World flow
cre/attest/       Chainlink CRE workflow
```
