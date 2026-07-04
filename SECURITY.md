# Primehod — Security Review

_Last updated: 2026-07-04 · Factory `0x57EfC7cE5250C96B0b0E7C554c9d9743A18b794f` (Robinhood Chain mainnet, chainId 4663)_

This document is an **internal security review** of the Primehod contracts. It is
an engineering review with reproducible tests, not a paid third-party firm audit.
The full source is in [`/contracts`](./contracts) and every claim below is backed
by a script in [`/scripts`](./scripts) you can run yourself. If you are considering
significant funds, read this in full and verify the contract on-chain.

## Scope

| Contract | Lines | Role |
| --- | --- | --- |
| `PrimehodToken.sol` | 36 | Fixed-supply ERC-20, fully minted at launch, no admin |
| `PrimehodVesting.sol` | 69 | Immutable creator vesting, 1% of supply per 30 days |
| `PrimehodCurve.sol` | 242 | ETH constant-product bonding curve, dynamic fee, fee split |
| `PrimehodFactory.sol` | 236 | One-transaction launch of token + vesting + curve |

Dependencies: OpenZeppelin Contracts v5 (`ERC20`, `Ownable`, `ReentrancyGuard`).
Compiler `solc 0.8.26`, `evmVersion: paris` (avoids PUSH0/MCOPY on a young chain),
optimizer on, `viaIR: true`.

## Method

- Line-by-line manual review of all four contracts against a launchpad threat model:
  liquidity drain, insolvency, reentrancy, privileged backdoors, rug paths, honeypots.
- Two independent prior review passes before mainnet (the high finding below came
  from those and was fixed).
- Reproducible adversarial tests that assert each attack path **reverts or stays
  safe** — `scripts/testPrimehodCurve.ts` (behaviour) and
  `scripts/auditAdversarial.ts` (attacks). Both pass on the shipped source.

## Threat model & trust assumptions

- **Token holders / traders** trust only the curve math and the solvency guard.
  No party can seize, freeze, or withdraw the curve's ETH or tokens.
- **The platform owner** can change DEFAULTS for *future* launches (fee ceiling,
  vesting schedule, `ethUsdPrice`, platform fee recipient) and, for its own
  launches only, use an instant team distribution. The owner has **no power over
  any already-deployed token, curve, or vesting contract** — those are immutable.
- **Token creators** receive a vesting slice and a share of swap fees. They cannot
  mint, pause, or touch curve reserves. The worst a creator can do is sell their
  own vested tokens on the same public curve as everyone else.

## Findings

### Resolved before mainnet

**H-1 · Owner control over graduated liquidity — FIXED.** An earlier design let the
factory owner call `seedDex()` to move a graduated token's pooled liquidity. On a
chain with no live DEX this was an unnecessary custody path over user funds. It was
removed entirely: there is no `seedDex`, `withdraw`, `rescue`, or `migrate` function
anywhere in the curve. Graduation is now only a milestone flag; trading continues on
the curve so holders always keep a non-custodial exit.
_Verified: `auditAdversarial.ts` check 2 asserts the curve exposes no such function._

**L-1 · Division-by-zero at full curve depletion — FIXED.** Buys are bounded by
`require(tokensOut < curveTokenBalance)` (strict), so the token reserve can never be
fully drained to zero and the price math never divides by a zero reserve.
_Verified: `testPrimehodCurve.ts` runs the curve to graduation and beyond._

### Open — economic design, not fund-theft bugs

These do not let anyone steal from the contract, but they shape what holders should
expect. They are disclosed here rather than "fixed" because they are properties of the
bonding-curve model itself.

**M-1 · A token's own creator allocation is sell pressure on that token's curve.** Two
supply paths exist, and they are distinct:

- **Public launch (anyone):** ~80% of supply seeds the curve and the remaining 20% goes
  into an **immutable vesting contract for the launcher of that token**, released 1% of
  supply per month over 20 months. The platform receives nothing and mints nothing; there
  is no instant unlock. This is a standard creator allocation.
- **Owner launch (platform only):** if the platform owner launches its *own* token with a
  distribution configured, those slices mint instantly to the team/treasury with no
  vesting. This path is `onlyOwner`-gated and applies only to the platform's own tokens —
  it can never touch a token someone else launched.

The note for holders is simply that a token's creator allocation, once vested, can be sold
on that same curve like any other tokens, so factor it in as sell pressure — the same as
on any launchpad. It is **not** a platform-wide mint or a hook the platform has over public
launches; each public token's 20% belongs to, and vests to, that token's own creator.

**M-2 · Exit is not guaranteed for every holder at once.** Sell price is quoted against
the *virtual* ETH reserve (`vEthReserve0 + ethRaised`), but real payouts are capped at
`ethRaised`, which also shrinks as fees are pulled out of the pool. Redemption is
first-come: early sellers drain `ethRaised`, and a later holder can hit
`"insufficient liquidity"` (the sell reverts) even though the token still shows a nonzero
price. The contract comment "holders always keep a live, non-custodial exit" is only true
*while pool ETH lasts* — it is not a guarantee that everyone can exit at the quoted price.
Public-facing copy has been corrected to say so.

**M-3 · `ethUsdPrice` is an owner-set number, not an oracle.** Future-launch graduation
caps derive from it with only a `> 0` check. A stale or extreme value mis-scales new
launches (in the extreme, a single buy could capture most of a new token's supply). It
cannot touch existing launches. Recommend adding sane min/max bounds and/or an oracle.

**L-2 · The dynamic volatility fee is bypassable.** `volBps` is derived only from the
immediately-preceding trade, so a trader can prepend a dust trade to reset it and pay
only the base fee; conversely it can be spiked to grief a victim's pending trade (capped
at 5%, so never a honeypot). The anti-volatility mechanism does not reliably do its job.

_Informational:_ the `buy` bound `tokensOut < curveTokenBalance` can never trigger
(`vTokenReserve == curveTokenBalance` always), and the curve's `factory` variable is
stored but unused (a leftover from the removed DEX-seeding path — not a backdoor).

### Design properties confirmed (no action needed)

- **Solvency is enforced.** The curve prices against a *virtual* ETH reserve but
  caps every payout at real ETH taken in: `sell` requires `gross <= ethRaised`, and
  the invariant `contractBalance >= ethRaised + creatorFees + platformFees` holds
  across buy, sell, and fee claims. A max-size dump cannot drain more than exists.
  _Verified: `auditAdversarial.ts` check 1 — attacker buys then dumps the full stack;
  curve stays solvent._
- **Reentrancy-safe.** Every state-changing entrypoint is `nonReentrant`, follows
  checks-effects-interactions, and moves ETH last. Fees use a pull pattern.
- **Admin-less token.** `PrimehodToken` is a plain OZ ERC-20 with no mint, pause,
  blacklist, or owner. _Verified: `auditAdversarial.ts` check 3._
- **Immutable per-launch economics.** Owner changing factory defaults does not touch
  a live curve. _Verified: `auditAdversarial.ts` check 4._
- **Fee is capped at 5%** (`MAX_FEE_BPS = 500`), so a launch can never be turned into
  a honeypot via fees. _Verified: `auditAdversarial.ts` check 5._
- **Immutable vesting.** No early-release, no admin, funds only ever move on schedule
  to the fixed beneficiary.

## Residual / operational risks (not code bugs)

- **Owner key.** The factory owner can set future-launch defaults and the platform
  fee recipient. This key should be a hardware wallet or multisig. It cannot reach
  existing user funds, but it governs the platform. The current deployer/owner is
  `0xbfaD84372F4Cd42245aC3804a7Ab5705d5F8432D`.
- **`ethUsdPrice` is owner-set.** It only affects the ETH graduation cap of *future*
  launches; a stale value shifts where new tokens graduate, nothing more.
- **Permissionless launches.** `createToken` is open to anyone, by design. Expect
  low-effort and duplicate tokens; always verify the token address, not the name.
- **Exit liquidity, not custody, is the real user risk (M-2).** Nobody can seize the
  pool, but the pool can be emptied by other sellers before you exit. This is inherent
  to a single bonding curve with no external market; size positions accordingly.
- **No third-party firm audit yet.** This is an internal review. For large TVL a
  professional audit is recommended before relying on it heavily.

### Uniswap v3 venue (added 2026-07-05)

Launches can now target a Uniswap v3 pool instead of the curve. Security posture:

- The v3 stack used (factory `0x1f7d…2EfA`, position manager `0x7399…E0D3`,
  SwapRouter02 `0xCaf6…5cb2`, chain-native aeWETH proxy) was **audited against the
  canonical Ethereum mainnet bytecode**: identical modulo compiler metadata and
  per-chain immutable addresses, with standard fee tiers, and all three contracts
  cross-referencing each other correctly.
- The LP position NFT is held by `PrimehodV3Locker`, which has **no function that
  can move the NFT or decrease liquidity** — fees can only be collected and split
  55/45 between the immutable creator and platform addresses.
- Verified end-to-end on a fork of the live chain (`scripts/testV3Launch.ts`):
  single-sided launch, locked position, buys/sells through the public router, fee
  split, and the absence of any withdrawal path.
- Trust notes: the external v3 factory owner can only enable new fee tiers; WETH is
  the chain owner's upgradeable canonical wrapper (the same trust as the chain itself).
  M-2 (exit liquidity) applies to the curve venue; a v3 pool's exit liquidity follows
  standard Uniswap v3 mechanics.

## Reproduce

```bash
cd contracts
npm install
npx hardhat run scripts/testPrimehodCurve.ts     # behaviour + graduation
npx hardhat run scripts/auditAdversarial.ts       # attack paths must all hold
FORK_URL=<rpc> npx hardhat run scripts/testV3Launch.ts   # v3 venue, on a chain fork
```

Verify the live factory on the
[Robinhood Chain explorer](https://robinhoodchain.blockscout.com/address/0x57EfC7cE5250C96B0b0E7C554c9d9743A18b794f).
