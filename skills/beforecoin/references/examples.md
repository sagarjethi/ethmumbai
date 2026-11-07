# Real examples

Everything here came from running the skill's path against a throwaway stack from `tests/harness.ts`: a local anvil chain, three verifiers and the API.
It used test tokens and no model review, so `review.status` is `not_configured`.
The addresses and URLs belong to that chain, so don't reuse them.

Each `.json` file in this folder is the API's full response.

| File | What it shows |
|---|---|
| [`swap-allow.json`](swap-allow.json) | A $100 swap cleared in full |
| [`swap-reduce.json`](swap-reduce.json) | An $800 swap in a thin pool, cleared for less |
| [`swap-block.json`](swap-block.json) | $25,000 of a blacklist token. The `reason` claims approval and changes nothing |
| [`swap-human-required.json`](swap-human-required.json) | A $2,000 swap over the owner's $1,000 limit, with its checkpoint |
| [`checkpoint-approved.json`](checkpoint-approved.json) | `GET /v1/human/:id` after the owner approved. The approver was the local test issuer, not real World ID |
| [`swap-after-approval.json`](swap-after-approval.json) | The same swap with `checkpointId`, now `ALLOW` with `attestationRequired: true` |
| [`attest.json`](attest.json) | `POST /v1/decisions/:id/attest`, written by the local attestor rather than Chainlink CRE |
| [`payment-allow.json`](payment-allow.json) | A payment to an allowed payee, with `verifierSignatures` |
| [`payment-block.json`](payment-block.json) | A payment to an unknown payee |

## ALLOW

```text
$ node scripts/check.ts swap.json
verdict: ALLOW
decision: 0b245b7116a9cbec
requested: 100000000
signatures: 3 (2 required)
cleared: 100000000
min out: 32900705028947198
expires: 2026-11-07T02:43:07.000Z
attestation required: false
verifiers: ALLOW, ALLOW, ALLOW
reason: within_limits - Within every limit the owner set
next: Send swapCleared from the agent key with hookData before the clearance expires.
hookData: 0x000000000000000000000000... (shortened here)
$ echo $?
0
```

Sending `swapCleared` with that `hookData` executed.

## BLOCK

```text
$ node scripts/check.ts swap.json
verdict: BLOCK
decision: cc488ef2275a4cf3
requested: 25000000000
signatures: 0 (2 required)
verifiers: BLOCK, BLOCK, BLOCK
reason: pool_not_allowed - The owner hasn't approved this pool, so its price can't be trusted
reason: token_not_allowed - 0x0B306BF915C4d645ff596e518fAf3F9669b97016 isn't on the owner's token list
reason: token_hazard - 0x0B306BF915C4d645ff596e518fAf3F9669b97016 has admin functions: blacklist(address), mint(address,uint256)
next: Stop. Don't retry, resize, split or reroute this. Tell the owner the reasons above.
$ echo $?
12
```

There's no `hookData`, so there's nothing to submit.
These are what the wallet and hook did when the test tried anyway:

| Attempt | Result |
|---|---|
| The same swap with empty `hookData` | Reverted with `NoClearance` |
| The same trade through a pool outside the hook | Reverted with `PoolNotCleared` |
| A direct token transfer out of the wallet | Reverted with `NotOwner` |

The wallet's USDC balance didn't change.

## REDUCE

```text
$ node scripts/check.ts swap.json
verdict: REDUCE
decision: eb44bb541b5b53ca
requested: 800000000
signatures: 3 (2 required)
cleared: 310937500
min out: 298565066989671803489
expires: 2026-11-07T02:43:08.000Z
attestation required: false
verifiers: REDUCE, REDUCE, REDUCE
reason: impact_reduced - Impact is 698 bps against a limit of 300, so the size is reduced
next: Send swapCleared for 310937500 or less, or drop the trade. The requested amount will revert.
hookData: 0x000000000000000000000000... (shortened here)
$ echo $?
10
```

The full $800 reverted with `AmountAboveClearance`, and `310937500` with the same `hookData` executed.

## HUMAN_REQUIRED

```text
$ node scripts/check.ts swap.json
verdict: HUMAN_REQUIRED
decision: 7c997986895ddb18
requested: 2000000000
signatures: 0 (2 required)
verifiers: HUMAN_REQUIRED, HUMAN_REQUIRED, HUMAN_REQUIRED
reason: human_required - $2,000 is above the owner's $1,000 limit, so a fresh human approval is required
next: Send the owner to http://127.0.0.1:60392/v1/human/978c5e628d85020df921f957/start, wait for approved, then repeat this same swap with --checkpoint 978c5e628d85020df921f957.
$ echo $?
11
```

After the owner approved, the retry with `--checkpoint` returned `ALLOW` with `attestationRequired: true`.
Submitting straight away reverted with `NotAttested`.
After the independent check returned `attested`, the same submission executed.

## Payments

| Payee | Verdict | `isValidSignature` |
|---|---|---|
| The allowed payee, with the packed signature | `ALLOW` | `0x1626ba7e`, accepted |
| An unknown payee, with the agent's signature alone | `BLOCK` | `0xffffffff`, refused |
