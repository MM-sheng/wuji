# Handoff to Codex: T11 wallet test on BSC testnet, and Sepolia fuel

Written 2026-09-26. Context: `docs/tasks/T11_PERPETUAL_ACCOUNTS.md` (design + build log), `README.md`
§Perpetual accounts. Everything below is testnet only. Read `AGENTS.md` first; its rules apply.

## Hard rules

- Never put a private key or seed phrase on a command line, in a file, in a log or in git.
- Do not import the project's keystore accounts into MetaMask. Use a separate MetaMask test account.
- If a faucet or site shows a CAPTCHA / bot check / login wall, stop and ask the human to do that step.
- Record every transaction hash in the report. Do not change contracts or redeploy anything.

## Task A — a person-style wallet test of the terminal (BSC testnet, chain 97)

Pools (mock WBNB collateral, `0xe374A11A6C390F18fbcbE15F1dBcbd46a57eeA15`):

| tier | pool |
|---|---|
| 5%  | `0xD918c63AD7E1E71ef5c0822538A6715580B4c03e` |
| 10% | `0x2f1BD256267b2738C49CF16F68Ab413B62139791` |
| 25% | `0x346321B1D1F780f5D31A632D92AD3D5AbD4B8218` |

1. Terminal: the running indexer serves it at `http://localhost:8789` (do not restart that stack; a watchdog
   manages it). Open the 永续账户 tab.
2. Test account needs tBNB for gas (BSC testnet faucet) and mock WBNB. Mock WBNB has a public
   `mint(address,uint256)`; mint e.g. 5 WBNB to the MetaMask test address (any account may call it).
3. In the tab, pick the **10%** pool, connect MetaMask (it must switch to chain 97), side 阳, amount `1`,
   press 进场. Expect two wallet prompts (approve, then requestEnter). The message line should end with
   `账户 #N · 约 1–4 小时后定价`.
4. Check: the pool card shows one pending pricing height; looking up account #N shows 等待进场定价.
5. Also enter 阴 with `1` from the same or a second test account, so the account has a counterparty.
6. Wait until the keeper prices it (about 3–4 h; the pool card's 排队中的定价 clears). Look up #N: 持有中,
   value ≈ 0.997.
7. Press 申请退出 with #N in the id box; confirm the irreversibility dialog. Wait for pricing again.
8. Press 领取. The received WBNB must equal the account's value minus 0.3%.
9. Try to break it: 进场 with `0`, with `abc`, with more than the balance; 申请退出 twice; 领取 before the
   exit is priced; switch MetaMask to another chain mid-flow. Each must fail cleanly with a readable message
   and no stuck "busy" state.

Report: screenshots of each step, all tx hashes, the value/payout arithmetic for step 8, and every
message or behaviour that was confusing or wrong (with exact text).

## Task B — Sepolia ETH for the deployer

Send at least **0.05 Sepolia ETH** to `0x85967858e2464535A12031103ABA38f2795Fe8Fd` (the Sepolia deployer).
Any public Sepolia faucet works; most require a login or CAPTCHA — hand that step to the human. Confirm with
`cast balance 0x85967858e2464535A12031103ABA38f2795Fe8Fd -r https://ethereum-sepolia-rpc.publicnode.com -e`.
Do not deploy anything: Claude will deploy the pools to the Sepolia v4 index afterwards.

## Output

Write `docs/tasks/T11_WALLET_TEST_REPORT.md` with the results of A and B and commit it (message ends with the
repository's usual co-author line for your agent).
