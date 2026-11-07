# BeforeCoin build plan

Spec: `../research/09-clearance-hour-one.md` and the Clearance section of `../research/site/src/projects.html`.

## Goal

A verification protocol AI agents must pass before they move money.
Independent verifiers check an action, a quorum signs, and the pool and the wallet refuse anything uncleared.

## Modes

- **Local (default).** Plain anvil, with v4 deployed fresh and test tokens. No keys needed, and every scenario runs.
- **Sepolia.** The same code against real v4, ENSv2, USDC, World and model providers. A fork proves v4, ENSv2 and USDC today. World, models and CRE simulation need keys.

## Build order

| # | Part | Done when |
|---|---|---|
| 1 | `contracts/`: hook, router, verifier set, smart account, test USDC | Foundry tests cover every revert in the spec |
| 2 | `packages/shared`: EIP-712, canonical JSON, ENS keys, human approval check | Hashes match the contracts in a cross-language test |
| 3 | `apps/verifier`: facts, rules, model review, signing | Rules tests, including stale data and hostile model output |
| 4 | `apps/api`: `/v1/clear`, quorum, World gate, x402, feed | API tests against a real local chain |
| 5 | `apps/agent`: agent and attack scenarios | All scenarios pass end to end |
| 6 | `apps/web`: owner dashboard and live feed | Checked in a browser at desktop and phone width |
| 7 | Sepolia fork checks: Universal Router, ENSv2 | Fork tests pass |
| 8 | Independent review, README, `AI_USAGE.md`, `FEEDBACK.md` | Findings fixed or listed |

## Decisions

- BLOCK means no signature, and REDUCE means a smaller `maxAmountIn`.
- Rules decide. A model can explain or veto, and can never approve.
- `clearance.agent` is the smart account, because the hook sees the router's immediate caller.
- Exact-out swaps are refused, because `beforeSwap` can't bound their input.
- Verifiers evaluate independently, then sign one proposed clearance only if it is within what they each allowed.
- `inputsHash` covers the action and limits, not volatile facts. Each verifier reports its own evidence hash.
- Verifiers check the human approval's `id_token` themselves, so a compromised API can't invent an approval.
- The Quoter is allowlisted in the hook, because its swaps always revert by design.
- Only approved creators open pools on the hook, and the owner lists trusted pools in ENS, because pool prices value trades.
- The wallet enforces the signed minimum output, a daily spend cap per token and the owner's signature count.

## Not built, on purpose

- GoPlus and CoinGecko: neither has data for Sepolia test tokens, so the bytecode rule and Quoter do this job.
