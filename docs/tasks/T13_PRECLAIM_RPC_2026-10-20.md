# 领取前对账与 RPC 恢复 · 2026-10-20

用户要求继续完成两侧领取、回款和手续费核对，并处理后台 RPC 错误。
本轮两侧仍未达到退出定价条件，没有申请钱包签名或发送领取交易。

## 领取前状态

北京时间 20:11 的固定规范块 `0xb66c09`，#3 阳、#4 阴均 exiting，退出高度 972372，
claimable=0；重复退出拒绝 exit pending，领取模拟拒绝 not claimable。
池子未处于 settling/insolvent，badDebt=0；准备金下界检查不代表全部存续债权的偿付证明。
[原始账户快照](../../contracts/deployments/t13-wallet-preclaim-2026-10-20.json)。

同一个 EVM 块下，从原始 P2P 区块头重算至 972185，U=9973、
S_wad=119676000000000000，与链上逐位相等；后继 100 个头链接通过，
末端哈希经 mempool.space / Blockstream 交叉核对。
[完整核验](../../contracts/deployments/t13-index-preclaim-2026-10-20.json)。
这不是两个独立头档的全量回放，也不是外部审计。

## 后台恢复观察

keeper 持续记录账户 eth_call fetch failed，而新进程同版本 Node 的三池并发读检查
61 次无传输错误；随后用实际 maintainPool / contractClient 的只读调用路径复验，
86 次读取、三池均通过、无需维护交易，send 禁用。

确认 worker 的 Sepolia latest/pending nonce 都是 43，无待确认交易后，
11:57:40 UTC 重启现有 launchd keeper，保留全部源码与状态目录。
启动重新加载头档至 972317，随后继续同步；12:08、12:11、12:15 已观察到正常等待轮次，
其中至少两轮维护已结束，观察期间没有新的账户 RPC 错误。链头继续至 972319。
24 个冻结运行文件的 SHA-256 全部不变，没有改合约、K、定价规则或费率。
[恢复日志与哈希核验](../../contracts/deployments/t13-rpc-recovery-2026-10-20.json)。

这是本轮连接恢复，不宣称长期根因已修复。当前错误包装只保留 fetch failed，缺少底层原因；
若复发应补充受限的传输错误诊断，避免仅凭新进程成功归因于 RPC 服务商或某个 Node 版本。
现有 keeper 的失败轮计数仅统计 round 抛错，maintainAccounts 捕获的逐池错误不计入，
因此头链 round 成功而账户维护持续失败时不会触发该自动恢复机制。后续修复需单独测试和记录运行版本切换。
Bitcoin P2P 的个别 peer 握手/响应错误仍存在，没有把它算作已解决。

## 往返账本

从两笔已保存的规范链进场收据，逐一核对 WETH Transfer、EnterRequested 的 owner、
方向、编号、净本金与高度。每笔投入 10000000000000 wei、入场费 30000000000 wei、
净本金 9970000000000 wei；合计投入 0.00002 WETH，入场费 0.00000006 WETH。
两笔退出申请均有成功收据，最终退出费和回款暂为 null，不能把当前显示价值充当结算回款。
[可核对账本](../../contracts/deployments/t13-roundtrip-ledger-2026-10-20.json)。

退出定价后，按合约整数核对 `exitFee=floor(grossExitValue*30/10000)`、
`net=grossExitValue-exitFee`。领取时确认真实钱包签名，核对规范链成功收据、
Claimed(id,owner,net)、WETH 实际转账金额、账户关闭和 reservedClaims 减少。
测试 ETH gas 与 WETH 头寸收益分开记录。上述最终步骤尚未完成，完整真人往返仍 OPEN。
