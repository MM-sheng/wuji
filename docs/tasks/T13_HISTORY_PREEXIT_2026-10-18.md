# 全历史回放与退出前核验 · 2026-10-18

两笔真人账户仍在 entering，尚未达到 Bitcoin 972012 的定价条件。本轮只读与本地测试，没有签名或发送交易。

## 补齐默认跳过的全历史测试

当前整合源码与此前 325 项回归相同。使用既有原始头夹具，启用 WUJI_REPLAY_DIR=cache/replay，
运行 FullHistoryReplayTest 全部 24 段，24 通过、0 失败、0 跳过。
覆盖 Bitcoin 高度 11–969692，确认尾部至 969792。每段有独立 anchor，区段首尾连续。
每批次比较 MTP 窗口原始顺序，结束时比较 U、S、工作量、区块哈希与 seenHeight；
生产合约执行真实 PoW、链接、难度重定向及时间验证规则。测试 gas 上限提高仅用于本地长回放，
不是实际交易 gas 承诺。

另以独立 JS 计算核对缓存夹具：24 个 bin 文件都等于当前 P2P 头档相应片段；
从真实 genesis 检查前缀所有链接与 PoW，再重算每段 U、work、ancestorTimes 和末端哈希。
没有重生成夹具、修改 expected 值或缩小测试范围。

结果：[Solidity 回放](../../contracts/deployments/t13-full-history-2026-10-18.txt)、
[夹具来源及重算](../../contracts/deployments/t13-full-history-data-2026-10-18.json)。
此前 325 项通过与本次 24 项通过来自两次调用；不可把默认跳过项重复算作通过。
全历史夹具截止 969692，不宣称它已覆盖当前链头；部署起点后的实时对账另行执行。

## 当前部署的指数复核

固定 EVM 块，从部署起点 969546 重算至链上已折叠高度 971823，并检查后继 100 个头的链接：
U=1105，S_wad=13260000000000000，与链上整数完全相等。
末端哈希经 mempool.space / Blockstream 两个 HTTP 来源交叉核对；这不等同于两个完全独立头档的全量回放。
[原始记录](../../contracts/deployments/t13-index-recheck-2026-10-18.json)。

## 两笔账户的退出前检查

以同一新鲜、规范 EVM 块读取 owner、方向、净本金、定价高度、claimable、准备金，并 eth_call 模拟：

| 账户 | 状态 | 退出模拟 | 领取模拟 |
|---|---|---|---|
| 3 · 阳 | entering / 972012 | entry pending | not claimable |
| 4 · 阴 | entering / 972012 | entry pending | not claimable |

每笔净本金 0.00000997 WETH，claimable=0；池余额 0.00002，
pendingPrincipal=0.00001994、buffer=0.00000006，refundReserve/reservedClaims/badDebt=0，
settling/insolvent=false。未定价时显示价值 0 不表示本金已损失。
[同块账户/模拟记录](../../contracts/deployments/t13-wallet-preexit-2026-10-18.json)。
准备金下界检查不替代所有存续债权的偿付证明。任何传输故障都不算作合约正确拒绝；脚本会失败。
下一阶段需达到高度、确认和链上处理，再重新核验后由用户确认退出；本轮不提前排队或自动退出。

重复入口：check-history-fixtures.mjs、verify-header-index.mjs、check-header-wallet.mjs，全部只读。
全历史测试继续使用隔离编译产物与原始不变量设置，未改生产合约。

## 后台 RPC 日志边界

keeper 仍有间歇 eth_call fetch failed 日志。本轮用相同 Node v26.8.1、同 RPC、同 readPool
进行 21 次实际只读调用，全部成功，未复现传输错误。未因此宣称问题修复，也未盲目重启或改变冻结快照。
当前批次还未达到 K=100 加 MIN_FOLD=36 的门槛；该等待与 RPC 问题分开记录。
后续需要观察到真正的 fold/定价处理，并在错误持续影响进度时保存具体传输原因后修复。
