# Working in this repo (for any coding agent)

Read `docs/ARCHITECTURE.md` first. It is the source of truth for every product decision; if you change a
decision, change that file in the same PR. Open task briefs live in `docs/tasks/`; the current queue is `docs/tasks/NEXT.md`.

## Non-negotiables

- No owner, no admin, no pause, no upgrade path, no governance, no project token. Immutable parameters only.
- The pair rule is `yangShare = ½ + ½·ΔS` with a fixed base, clamped to [0, 1]. `YANG + YIN == NOTIONAL` always.
- Everything the indexer serves must be recomputable by anyone from public data (`/proof` shows how).
- Never put a private key on a command line, in a log, or in git. Signing goes through Foundry's encrypted
  keystore (`contracts/scripts/set-key.sh`, `.env` holds only the account name and password-file path).

## Layout

- `contracts/` — Foundry. `forge test` must pass (unit, fuzz, real-data fixtures, invariants). Only vendored
  dependency is OpenZeppelin under `lib/`. Keep contracts under the EIP-170 size limit (`forge build --sizes`).
- `indexer/` — zero-dependency Node ≥ 18: `index.mjs` (follower + HTTP API + static terminal), `keeper.mjs`
  (signs with `cast`). Keep it dependency-free.
- `apps/terminal/index.html` — single-file terminal, no build step, no libraries.
- `docs/` — architecture, threat model, audit notes, mainnet checklist, task briefs.
- `scripts/testnet.sh` runs the testnet indexer (:8788) + keeper; `contracts/scripts/deploy-testnet.sh` deploys.

## Conventions

- Commit messages: imperative subject, body explains *why*. Small, reviewable PRs.
- Tests before deploys; testnet before mainnet; record every deployment in `contracts/deployments/`.
- Chinese or English in docs is fine; match the file you are editing. Code and comments in English.
- `contracts/.env`, `contracts/.keystore-password`, `indexer/data/` are gitignored — keep it that way.
