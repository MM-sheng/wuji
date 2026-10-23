# 24 小时运营成本刷新恢复 — 2026-10-23

用户要求排查并修复成本统计不完整；仅涉及只读运营监控，不变更 keeper、索引器、合约、资金或钱包。

## 原因与证据

- 告警于 `2026-10-23T12:26:09.147Z` 出现。失败尝试起于 `12:25:59.530Z`，
  原状态记录 `kind=execution, rpcMethod=eth_getTransactionCount`。
- 旧程序没有保留 JSON-RPC 原始错误或具体历史块号，因此不能追认服务端具体原因。
  不能把它归结为确定的链上交易缺失、余额不足或某种特定节点故障。
- 之后用相同未修改的 `costWindow` 与相同公共 RPC 重新运行，103 次只读调用完整通过：
  窗口 `0xb6a4aa..0xb6c086`，gas `1107467500000000 wei`。历史 nonce 读取也成功。
  说明这次读取失败可恢复，并非当前数据必然无法重算。
- 放大问题是刷新调度：成功和失败共用 `costAttemptAt` 的一小时间隔。
  一次失败后，后续五分钟采样仍持续保留告警，却整小时不重新扫描。
- 最近的历史完整记录没有丢失或变为零；告警正确阻止把历史记录冒充最新完整窗口。
  [修复前原始状态](../reviews/evidence/operations-cost-recovery-2026-10-23/before.json)。

## 修复

源码提交 `92c4fa7`：只修改监控脚本、回归测试和运营说明。

- 失败后最早五分钟重试（由现有五分钟采样执行），成功后仍每小时刷新。
- 不立即循环重扫；保留原进程锁与每次 210 秒扫描预算。
- 失败保留历史成本和不完整告警；仅新窗口完整成功后恢复。
- 脱敏诊断记录失败方法与白名单原因，未知原因保留 null；不保存 URL、凭据或任意 RPC 报错原文。
- 不放宽 nonce 覆盖、规范块哈希、收据、日志和普通 EOA 校验，也不重试 JSON-RPC 执行错误本身。

Node 26：相关 17 项测试全部通过；覆盖失败保存、五分钟边界、未到时间不重复扫描、
成功后恢复一小时间隔、恢复通知一次，以及原有缺交易/收据/日志、重组、余额桥等拒绝条件。
Node 18.0.0 直接运行监控测试文件 5 项通过（该早期版本尚无 `--test` 参数）。
[测试输出](../reviews/evidence/operations-cost-recovery-2026-10-23/tests.log)。

## 运行切换与验收

仅把只读 launchd 作业 `com.wuji.sepolia-header-v3-operations` 切换到新冻结快照
`operator/sepolia-header-v3/operations-runtime-2026-10-23-r4`。
基于原 r3 的 27 个模块，只替换 `scripts/wuji-operations.mjs`，其余哈希逐项一致；
源提交及文件哈希记录在 `operations-runtime-source-r4.json`。
旧快照、配置、plist 和状态备份保留在 operator 目录，通知游标不重置，告警阈值不变。

真实运行于 `2026-10-23T13:22:30.493Z` 重算成功：

- finalized 窗口 `0xb6a4ca..0xb6c0a6`，完整覆盖 nonce
  `56..59` 共 4 笔交易。
- gas 合计 **1107467500000000 wei = 0.0011074675 Sepolia ETH**；
  WETH 分配和领取各为 0（两种资产不混算）。
- `costError=false`、`status=COMPLETE`，旧 `costFailure` 清除。
  告警事件 seq 6 为 `cost-coverage recovered`；原有余额偏低/零储备告警保留。
- [修复后完整原始窗口与收据](../reviews/evidence/operations-cost-recovery-2026-10-23/after.json)
  及 [冻结快照清单](../reviews/evidence/operations-cost-recovery-2026-10-23/runtime-source.json)。
- launchd 恢复五分钟采样；首个计划采样于 `2026-10-23T13:23:01.300Z` 成功，
  未重复扫描刚完成的成本窗口（costAttemptAt 保持不变）。keeper PID 30557、indexer PID 1393 保持原进程。
  没有发交易、修改统计阈值或确认通知游标。

这修复失败后的恢复调度，不保证公共 RPC 永远可用；未来真实读取/校验失败仍会正确告警。
