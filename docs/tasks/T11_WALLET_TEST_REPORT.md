# T11 wallet test — in progress

## Task C checkpoint — 2026-09-29, before cooldown

Google rejected the approximately 17:21 request under its daily limit and explicitly returned **2026-09-29 17:30:01 Asia/Shanghai** as the next eligible time. No new receipt exists. The existing `wuji-sepolia` follow-up was moved to **17:35** and its stale prompt updated to use the latest claim/cooldown and the second-round funding requirement. This scheduling change is not an incoming transfer.

Sepolia RPC at block `0xb42807` shows **0.003111176757578118 ETH**. The original 0.15 ETH target was reached on September 28; the updated handoff asks for **another 0.15 ETH**, followed by ongoing upkeep. No additional confirmed faucet receipt after the September 28 receipt has been recorded here yet.

Previously tested alternatives remain unavailable under the current conditions: Alchemy and QuickNode require mainnet funds, Chainlink requires 1 mainnet LINK (the user confirmed they have none), PoW rejects the current hosting IP, and the logged-in ETHGlobal account was ineligible for both Hacker and Supporter Packs. These were not retried. No outgoing transaction, deployment or Task A signature was performed.

Attempt and balance evidence: [t11-sepolia-fuel-2026-09-29.json](../../contracts/deployments/t11-sepolia-fuel-2026-09-29.json). At the 17:35 follow-up, first check this log for a new receipt and then retry Google if still needed.

## Task C checkpoint — 2026-09-28

**September 28 collection passed on the user-requested retry. The deployer balance first reached the 0.15 ETH target: 0.150184441800254118 Sepolia ETH.** Funds remain at the designated address for Claude's deployment work; this does not mark Task A or any deployment complete.

The scheduled attempt at approximately 17:21 was blocked before submission: the browser request-header policy failed to load twice. At that point block `0xb40c1e` showed 0.100184441800254118 ETH. Those failed connection attempts did not submit a faucet claim.

The user-requested retry at approximately **17:30 Asia/Shanghai** recovered through the normal browser connection and existing Google login. The faucet displayed `Transaction complete! Check your wallet address`; no CAPTCHA, new login or terms acceptance was presented. [Transaction](https://sepolia.etherscan.io/tx/0xb7eb7bfb0e7befd0f80d3c2260c4cedaa8a0b069627936e38c4b5f6edbd8804d) has receipt status `0x1`, Sepolia chain ID `11155111`, recipient `0x85967858e2464535A12031103ABA38f2795Fe8Fd`, and value **50000000000000000 wei (0.05 ETH)**. The public Sepolia RPC verified the transaction and balance **150184441800254118 wei** at block `0xb40c4a`.

Today's claim is complete; do not submit another September 28 claim. No funds were transferred out, no contracts were deployed, and Task A wallet signatures were untouched. Raw transaction, receipt, current balance and preserved failed-attempt history: [t11-sepolia-fuel-2026-09-28.json](../../contracts/deployments/t11-sepolia-fuel-2026-09-28.json).

## Current checkpoint — 2026-09-27, handoff `65ef8ad`

**Task C's September 27 collection passed: 0.05 Sepolia ETH received; verified balance 0.100184441800254118 ETH, still below the 0.15 ETH target. Task A on v4 is incomplete and awaiting a human wallet action. This is a progress report, not a completed round-trip acceptance.** The September 26 v3 results below are historical. Claude closed the old v3 accounts in `b29df9a`; do not resume or transact on those accounts.

### C — today's faucet attempt

- Google Cloud Web3 faucet rejected today's request under its daily limit. The page gives the next eligible time as **2026-09-27 17:16:50 Asia/Shanghai**.
- Tried one alternative, Alchemy's Ethereum Sepolia faucet. It presented human verification and also requires at least **0.001 mainnet ETH**. The recipient's mainnet balance was **0**, so the alternative is not eligible. No real funds were paid or bridged; the CAPTCHA handoff was withdrawn once this requirement was confirmed.
- After the morning attempts, Sepolia balance remained **0.050184441800254118 ETH**; neither morning attempt produced a receipt.
- The one-shot thread follow-up (`wuji-sepolia`) ran after **17:20 Asia/Shanghai** and successfully claimed **0.05 Sepolia ETH** through the existing Google session. No CAPTCHA, new login or terms acceptance was presented. Google displayed `Transaction complete! Check your wallet address`.
- [September 27 receipt](https://sepolia.etherscan.io/tx/0x8fd7eef20f6b7da267518b6a437861008df00b63d02f1a32916514cc11db0b55): status `0x1`, Sepolia chain ID `11155111`, recipient `0x85967858e2464535A12031103ABA38f2795Fe8Fd`, value **50000000000000000 wei**. Public Sepolia RPC verified the transaction and receipt. Balance at observation block `0xb3f016` was **0.100184441800254118 ETH**. The **0.15 ETH target has not been reached**.
- Full transaction, raw receipt and balance observation: [t11-sepolia-fuel-2026-09-27.json](../../contracts/deployments/t11-sepolia-fuel-2026-09-27.json). No outgoing transfer, deployment or Task A wallet signature was performed during this follow-up. Today's claim is complete; do not submit another September 27 claim.

### A — v4 browser verification so far

Tested `http://localhost:8789` after reload, using the existing MetaMask account `0x6657289562f870677325124f3ACbdebB0ea80B95`, BSC testnet chain 97, v4 10% pool **`0x3Da26cae56AEB344E997075229Cf21aE8426b071`**, and MockWBNB `0xe374A11A6C390F18fbcbE15F1dBcbd46a57eeA15`.

Served terminal SHA-256: `d6efa03152954100e9caef3dc310ded878b41700f38256ef18beb8140ff51a9d`. Concurrent source commits through `9d0a525` include further contract review changes; browser testing the immutable v4 address does not establish that these latest source changes are deployed there. No contracts, terminal code, deployments or running services were changed for this attempt.

| Case / requested UI fix | Actual browser result | Status |
|---|---|---|
| Amount `0` | `✗ 数量无效`; control remained usable | PASS |
| Amount `abc` | `✗ 输入非负数量，最多 18 位小数`; control remained usable | PASS |
| Balance check before approval: amount `10000` | `✗ 余额不足：你有 9,906.28805662 WBNB`; no wallet prompt | PASS |
| Simulate before transaction and show Chinese revert reason | Not yet exercised on a failing v4 account action | OPEN |
| Explicit wrong-network message / switch mid-flow | Not yet exercised in this v4 run | OPEN |
| Rejected signature shows `已在钱包中取消` | Requested that the human cancel the current 1-token approval; no cancellation observed yet | WAITING |
| Pending account value shows `尚未定价` | No fresh test entry broadcast yet | OPEN |
| Fresh approve → enter 阳 1 and 阴 1 | First approval prompt pending; neither entry completed | WAITING |
| Pricing → exit → pricing → claim; duplicate exit; premature claim | Requires the fresh entries and actual Bitcoin pricing heights | OPEN |

The starting pool allowance was 8 MockWBNB. To make the fresh browser approval test meaningful, it was reset to zero using the existing encrypted Foundry signer (not imported into MetaMask), after checking chain, signer, nonce and simulation. This is **setup only**, not a browser approval or an entry:

- [Allowance-reset transaction](https://testnet.bscscan.com/tx/0x38ec5527ba50d3c926d5d526e3a5795b6bce0fad9ed9df24a2c18da1dce87435), receipt status `0x1`, nonce 1614.
- At **2026-09-27 10:55:01 Asia/Shanghai**, block `0x7f38c64`, allowance remained 0 and latest/pending wallet nonces were both 1615. No subsequent transaction from this wallet was observed at that checkpoint.
- Terminal currently displays `授权 WBNB · 请在钱包确认…`. Browser safety policy denied access to the MetaMask extension URL and explicitly prohibited alternate-surface workarounds. Wallet buttons must therefore be operated by the human. The current requested action is **cancel**, to test the cancellation message; then the formal approval and entry flow can resume.

Raw setup receipt, balances, UI observations and faucet attempts: [t11-v4-wallet-test-evidence.json](../../contracts/deployments/t11-v4-wallet-test-evidence.json). Screenshots are present in the Codex computer-use record; portable screenshot files remain outstanding. No payout arithmetic is reported as an actual result because no v4 claim occurred.

### Resume the current v4 test

1. Observe the human's cancellation of the pending 1 MockWBNB approval and record the exact message and button recovery. Do not reset the allowance again or replace wallet interaction with command-line signing.
2. Recheck account, chain and pool; submit fresh 阳 1 and 阴 1 through the terminal with human MetaMask confirmation. Record approval and entry receipts and derive the account IDs from those receipts. Do not reuse or assume v3 #3/#4, or attribute Claude's existing v4 smoke-test accounts to this run.
3. Verify `尚未定价`, premature-claim rejection, and actual entry pricing. Then request exits, check duplicate-exit rejection, await exit pricing, claim, and compare the actual MockWBNB transfers against `value - floor(value × 30 / 10000)` for both positions.
4. Complete wrong-network and mid-flow network-switch checks, export screenshots, and only then mark the five UI fixes and full round trip passed. Preserve any observed failures.
5. Today's faucet follow-up is complete. Check this log before any future daily collection to avoid duplicates; leave Sepolia funds for Claude.

## Sepolia fuel log

| Date (Asia/Shanghai) | Faucet | Received amount | Transaction | Balance after / observed |
|---|---|---|---|---|
| 2026-09-26 | Google Cloud Web3 | 0.05 ETH | `0x53bd87d02c1cba2ecedfd1d8858a03fa97e09190fe81578709c50b0c91330d67` | 0.050184441800254118 ETH |
| 2026-09-27, morning attempt | Google daily limit; Alchemy ineligible | 0 ETH (attempt only) | None | 0.050184441800254118 ETH |
| 2026-09-27, after 17:20 | Google Cloud Web3 | 0.05 ETH | `0x8fd7eef20f6b7da267518b6a437861008df00b63d02f1a32916514cc11db0b55` | 0.100184441800254118 ETH |
| 2026-09-28, 17:21 observation | Google page inaccessible to browser tool; claim not submitted | 0 ETH received by this attempt | None | 0.100184441800254118 ETH |
| 2026-09-28, approximately 17:30 retry | Google Cloud Web3 | 0.05 ETH | `0xb7eb7bfb0e7befd0f80d3c2260c4cedaa8a0b069627936e38c4b5f6edbd8804d` | **0.150184441800254118 ETH — first verified target attainment** |
| 2026-09-29, approximately 17:21 attempt | Google daily limit; eligible after 17:30:01 | 0 ETH (attempt only) | None | 0.003111176757578118 ETH |

## Historical report — 2026-09-26, v3

Date: 2026-09-26. Task: [CODEX_T11_HANDOFF.md](CODEX_T11_HANDOFF.md).

**Task B passed: 0.05 Sepolia ETH received. Task A has two real browser-wallet entries on chain and is waiting for Bitcoin height 968682 to be priced. Exit, payout and the complete round trip have not passed yet.**

## Tested deployment and scope

- Terminal: `http://localhost:8789`, Chrome with the existing MetaMask test account `0x6657289562f870677325124f3ACbdebB0ea80B95`. No project keystore was imported.
- Chain: BSC testnet, 97. Mock WBNB: `0xe374A11A6C390F18fbcbE15F1dBcbd46a57eeA15`.
- Released 10% volatility tier: `0x2f1BD256267b2738C49CF16F68Ab413B62139791`, `t11-accounts-v3`, K = 11.5, fee = 30 bps.
- The served terminal matched `apps/terminal/index.html` byte for byte; SHA-256 `44593632952bbca22dcc79dff46fd390a94453fe32875a755d3c9a3fda85a9ee`.
- The handoff was committed at `bd2ef5f`. Claude concurrently committed contract self-review fixes at `15245e5` and `55ca450`; **these tests target the existing immutable v3 pool, not a deployment of those later fixes**.
- No contracts, terminal source, watchdog or running stack were changed or redeployed for this test. No additional mock token mint was needed: the wallet started with about 0.03700224 tBNB and 9907.04447746 MockWBNB.
- Raw transactions, receipts, account observations and the early-claim simulation are in [t11-wallet-test-evidence.json](../../contracts/deployments/t11-wallet-test-evidence.json). The account/API observations are live observations, not a pinned, atomic EVM snapshot.

## A — actual browser-wallet entries

| Step | Result |
|---|---|
| Open 永续账户 and select 10% pool | Passed; all three released pools displayed |
| Connect the test wallet | Connected; the subsequent MetaMask transaction screen explicitly showed BNB Smart Chain Testnet |
| Enter 阳 with 1 MockWBNB | Receipt status 1; account **#3** |
| Enter 阴 with 1 MockWBNB | Receipt status 1; account **#4** |
| Look up each account | Both `entering`, principal `997000000000000000`, entry height **968682**, expected owner and side |
| Pool queue and buffer | One pending pricing epoch, buffer `6000000000000000`, bad debt 0 |
| Price entries | Waiting for the real Bitcoin height and six confirmations, then keeper processing |
| Request exit, price exit, claim | Not performed yet; no exit request should be inferred from this report |
| Check final payout | Pending actual exit pricing and claim receipt |

Entry transactions:

- 阳 #3: [0x7eeef130ad53089be31732004ed9917d7a721667d04100ce5e53503b008281a6](https://testnet.bscscan.com/tx/0x7eeef130ad53089be31732004ed9917d7a721667d04100ce5e53503b008281a6), wallet nonce 1558.
- 阴 #4: [0x843136b37821be392f606d5f3c37fae9bce420f97e39a8882086cb6d383e2321](https://testnet.bscscan.com/tx/0x843136b37821be392f606d5f3c37fae9bce420f97e39a8882086cb6d383e2321), wallet nonce 1559.

The terminal messages were respectively:

```text
✓ 进场 阳 · 0x7eee…81a6 · 账户 #3 · 约 1–4 小时后定价
✓ 进场 阴 · 0x8431…2321 · 账户 #4 · 约 1–4 小时后定价
```

The wallet already had a token allowance. It retained 6 MockWBNB of allowance after the two entries, so **the requested fresh approve-then-enter sequence was not exercised by these two deposits**. Do not count a new approval transaction or two observed confirmation prompts for either deposit. An approval prompt was observed in the excessive-amount test below and cancelled.

Entry arithmetic, confirmed in token units:

```text
deposit per side = 1,000,000,000,000,000,000
entry fee       = deposit × 30 / 10000 = 3,000,000,000,000,000
principal       = 997,000,000,000,000,000
two entry fees  = 6,000,000,000,000,000
```

At the initial observation, index height was 968658 and relay best was 968664. Pricing height 968682 was still in the future. The elapsed time is not a guaranteed 1–4-hour deadline.

## Error handling and confusing behaviour

| Case | Observed result | Assessment |
|---|---|---|
| Enter `0` | `✗ 数量无效`; buttons remained usable | Passed |
| Enter `abc` | `✗ 输入非负数量，最多 18 位小数`; buttons remained usable | Passed |
| Enter `10000`, above the roughly 9905 remaining MockWBNB | MetaMask requested a **10,000-token spending cap** instead of the page first explaining insufficient balance | Failed the readable preflight expectation; cancelled before approval, no excess deposit |
| Claim #4 before pricing or an exit request | MetaMask opened a transaction request with network fee `不可用`; no page explanation that the account was not claimable | Failed the readable preflight expectation; cancelled without broadcasting |
| Cancel either wallet prompt | `✗ MetaMask Tx Signature: User denied transaction signature.`; buttons became usable again | Recovery passed; message is technical English |
| Change connected site network to Sepolia, then enter `1` | After more than 60 seconds, the account panel still showed the previous rejection message, with buttons usable; no clear new wrong-network message | Failed; no transaction was confirmed on Sepolia |
| Change network while a signature is still pending | Not exercised | Open |
| Request exit twice | Awaiting the first valid exit request after entry pricing | Open |

Supporting read-only simulation for `claim(4)` returned `execution reverted: not claimable`. The browser did not surface that reason. This is **not** a reverted paid transaction.

Code inspection explains the wrong-network failure path: `perpEnter()` suppresses `requireWalletChain()` errors, then converts the allowance response with `BigInt(...)` outside a surrounding error handler. A read of this mock token address on Sepolia returned `0x`; `BigInt('0x')` throws. The observed stale message is consistent with this unhandled path. Fixing it should preserve the chain check and return an explicit message before reading an allowance or requesting a signature.

Additional display issue: a pending account shows `当前价值 0 · 0.0000×` beside principal `0.997`. This is the API's not-yet-priced placeholder, not an observed loss of the deposit. The terminal should label that value as not yet priced.

Screenshots of the entry success, wallet prompts, wrong-network test and faucet completion were captured in the Codex task's computer-use record. They have **not** been exported into this repository; the portable screenshot deliverable remains open. The raw receipts and exact visible messages above are persisted here.

## B — Sepolia fuel: PASS

Google Cloud Web3 faucet completed the request in its existing signed-in session. No CAPTCHA, new login or terms acceptance was presented during this request.

- Recipient: `0x85967858e2464535A12031103ABA38f2795Fe8Fd`.
- Received: **0.05 Sepolia ETH**, transaction value `50000000000000000` wei.
- Transaction: [0x53bd87d02c1cba2ecedfd1d8858a03fa97e09190fe81578709c50b0c91330d67](https://sepolia.etherscan.io/tx/0x53bd87d02c1cba2ecedfd1d8858a03fa97e09190fe81578709c50b0c91330d67).
- Receipt status: `0x1`, verified through `https://ethereum-sepolia-rpc.publicnode.com`.
- Balance after receipt: **0.050184441800254118 ETH**, `50184441800254118` wei.

No Sepolia deployment or outgoing transfer was made. The funds are left for Claude's deployment work.

## Historical resume instructions — superseded; do not execute

The following instructions belonged to the September 26 v3 report. The current handoff and v4 resume steps above replace them; Claude already closed these old positions.

1. Read this report and the current handoff; inspect concurrent repository changes. Keep testing the recorded v3 address unless a new explicit handoff changes it.
2. Read `/account/0x2f1bd256267b2738c49cf16f68ab413b62139791/3` and `/4` on port 8789. Wait until their status is `open` and record the pricing transaction/height/value. Do not enter again.
3. In the real wallet UI, request #3's exit after pricing, test the duplicate request safely, and record all resulting transaction hashes. Then wait for the exit epoch, claim and compare the receipt's token transfer to `value - floor(value × 30 / 10000)`.
4. Close the counterpart #4 through the same wallet flow after its role in the test is complete, so this test does not leave a forgotten position.
5. Complete the pending approval/race/screenshot cases and append results. Keep Task A marked incomplete until the actual round trip and acceptance checks finish.
