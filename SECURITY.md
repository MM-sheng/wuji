# Security policy and bug bounty

WUJI's contracts have no owner, no admin, no pause and no upgrade path. A deployed bug cannot be patched, only
redeployed, so we want to hear about it first. （中文摘要见文末。）

## Report privately

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/MM-sheng/wuji/security/advisories/new)** (Security tab → Report a vulnerability).

Please include:

- the affected contract and function, and the commit you looked at;
- what goes wrong and why;
- a proof of concept, ideally a Foundry test against this repository (`contracts/test/`);
- an Ethereum address for the reward.

Do not open a public issue, post the finding, or exploit it on any network before it is acknowledged and a fix
(usually a redeployment) is in place, or 90 days have passed since your report, whichever comes first.
We reply within 7 days.

## Scope

Rewarded, at the latest commit on `main` and, once published, the mainnet deployment listed in
`contracts/deployments/`:

| Contract | File |
|---|---|
| `WujiHeaderIndex` | `contracts/src/WujiHeaderIndex.sol` |
| `RelayerRewards` | `contracts/src/RelayerRewards.sol` |
| `FeeRouter` | `contracts/src/FeeRouter.sol` |

Welcome but not rewarded yet: the pools (`WujiAccounts`, `WujiAccountsFactory`; testnet-only until audited), the
keeper and indexer (`indexer/`), the terminal (`apps/terminal/`) and the testnet research contracts (`ZkWujiIndex`).
Reports on them are acknowledged in the changelog.

Out of scope:

- anything that needs a majority of Bitcoin's hash power, or a Bitcoin reorganization deeper than the index's
  `CONFIRMATIONS` (that case is designed to seal the index; see `docs/tasks/T13_ZK_REORG_EXIT.md`);
- behaviour described as known or accepted in `docs/AUDIT_NOTES.md` and `docs/THREAT_MODEL.md`;
- the index pausing because nobody submits headers (anyone can submit; it never computes a wrong value);
- third parties: RPC providers, Bitcoin peers, wallets, Ethereum itself;
- gas-price economics, style, and best-practice suggestions without a concrete failure;
- social engineering, phishing, and attacks on the maintainers' machines.

## Rewards

Paid only for valid, previously unreported findings in scope. If nobody finds anything, nothing is paid.

| Severity | Examples | Reward |
|---|---|---:|
| Critical | the index accepts a header Bitcoin consensus rejects; S, checkpoints or the recorded state can be made wrong; a seal (`freezeOnReorg`) can be triggered without the required work; funds in `RelayerRewards` can be taken by someone not entitled to them | USD 200 |
| Medium | the index can be stopped for good, or a transaction it needs (fold, seal, claim) can be made to exceed the 2^24 per-transaction gas cap | USD 80 |
| Low | any other real defect that affects correctness | USD 20 |

- **Total budget: USD 300.** Once it is used up, further valid reports are acknowledged publicly but not paid.
  Any change to these amounts is made in this file, so its history shows what applied when you reported.
- The first report of an issue is rewarded; duplicates are not. Several reports with one root cause count as one.
- Severity is set by the maintainers, judged by the impact on the deployed contracts.
- Payment is in ETH at the USD value on the day of payment, from the project's official wallet, to the address in
  your report. No identity check is required.

## Safe harbour

Good-faith research within these rules is welcome: we will not pursue legal action for it. Test on a local fork
or a testnet; do not interact with mainnet contracts in ways that affect other users.

---

## 中文摘要

- **报告方式**：通过 GitHub 私密安全报告（仓库 Security 页 → Report a vulnerability）提交，附概念验证（最好是 Foundry 测试）
  和收款的以太坊地址。在问题被确认并修复（通常是重新部署），或报告满 90 天之前，请不要公开。7 天内回复。
- **奖励范围**：`WujiHeaderIndex`、`RelayerRewards`、`FeeRouter`。池子、keeper、终端欢迎报告，但暂不奖励。
- **奖励**：严重 200 美元，中等 80 美元，轻微 20 美元；**总预算 300 美元**，用完后只公开致谢。
  只奖励第一个报告者；用官方钱包按付款当日价格支付 ETH；不要求实名。
- **不在范围内**：需要比特币多数算力或超过确认深度的重组（这种情况按设计会封存指数）、已公开的已知问题、
  没人提交导致的暂停、第三方服务、社会工程等。
