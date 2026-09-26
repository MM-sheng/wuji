# T11 wallet test — in progress

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

## Resume without duplicating deposits

1. Read this report and the current handoff; inspect concurrent repository changes. Keep testing the recorded v3 address unless a new explicit handoff changes it.
2. Read `/account/0x2f1bd256267b2738c49cf16f68ab413b62139791/3` and `/4` on port 8789. Wait until their status is `open` and record the pricing transaction/height/value. Do not enter again.
3. In the real wallet UI, request #3's exit after pricing, test the duplicate request safely, and record all resulting transaction hashes. Then wait for the exit epoch, claim and compare the receipt's token transfer to `value - floor(value × 30 / 10000)`.
4. Close the counterpart #4 through the same wallet flow after its role in the test is complete, so this test does not leave a forgotten position.
5. Complete the pending approval/race/screenshot cases and append results. Keep Task A marked incomplete until the actual round trip and acceptance checks finish.
