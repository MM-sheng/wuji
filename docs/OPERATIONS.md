# WUJI 只读运营监控

当前 Sepolia header-v3：每 5 分钟采样，滚动 24 小时成本成功后每小时刷新；失败后最早五分钟重试。
监控不读取 keystore、不签名、不补给、不发送交易、不重启 keeper，也不更改合约参数。
它与 keeper 自身的连续失败恢复机制分开运行。

## 数据与成本口径

入口为 `scripts/wuji-operations.mjs CONFIG.json`；本机配置位于
`operator/sepolia-header-v3/operations-config.json`，输出 `operations/status.json`。
该 JSON 包含最新指标、当前异常、最多 500 条状态变化、成本窗口及其完整性标志。
统计窗口截止于 RPC 的 finalized 块，不是尚未确认的最新块，也不是当地日历自然日。
每小时产生的滚动窗口互相重叠，**不能相加作为累计成本**。

成本工具在固定 finalized 边界读取 worker nonce，用二分定位每个新增 nonce 对应的块与交易，
逐笔取得收据并核对规范块。找不到任一交易/收据、发生重组、超过 200 笔扫描预算、
finalized 视图陈旧或日志不全时，当前统计标记不完整；不会以日志缺失推断零支出。
窗口开始为请求截止时间前的最后一个块，计入其后、截止块之前的全部交易。

失败不会把最近一次完整记录改为零，也不会把旧记录当作本次成功：`costError` 和
`cost-coverage` 告警保持到新窗口真正完成。失败后下一次五分钟采样可重新扫描，
不再因一次暂时读取失败等待整小时；成功后恢复原每小时频率。每次扫描仍受 210 秒预算和进程锁约束。
`costFailure` 只记录失败类别、RPC 方法及白名单原因（历史状态不可用、限流、超时、预算耗尽），
不保存服务端任意原文、URL 或凭据。无法分类时保留 null，不推断具体故障。


- ETH gas = 收据 gasUsed × effectiveGasPrice，加上存在时的 blob fee，包含失败交易。
- 指数操作、池维护、奖励领取和其他目标分别归类，不过滤未知目标交易。
- 交易请求的 value 与实际成功转出的 value 分开，失败交易不计转出本金。
- 普通 EOA 的净原生币流入从前后余额、全部 gas 与成功 value 转出推得，不冒充逐笔水龙头收据。
  无法满足 nonce/普通 EOA 假设时失败，不默默套用到智能账户。
- WETH Bounty（分配）与 Claimed（领取）事件分别统计；本期领取可能对应历史分配，不能重复加为收入。
  不是该钱包所有 WETH 收支的总账，不与 ETH gas 或法币价格混算。

手动刷新成本（只读）可在仓库根目录运行：

```sh
node scripts/wuji-operations.mjs operator/sepolia-header-v3/operations-config.json --refresh-cost
```

有进程持锁时拒绝并行，不强抢活锁；进程已不存在的锁可归档后恢复。
状态以单文件临时写入并原子替换，重启保留告警序号及待处理 epoch 的起始时间。
读取或状态文件故障会由报告新鲜度告警揭示，不当作健康。

## 默认告警阈值

| 项目 | 提醒 | 严重 |
|---|---|---|
| keeper Sepolia ETH 余额 | < 0.005 ETH | < 0.001 ETH |
| 已记账 WETH 可用赏金储备 | 为 0 | 实际代币余额 < reserve + allocated |
| 可折叠积压 | ≥ 72 高度 | ≥ 144 高度 |
| 最新链上验证头年龄 | ≥ 12 小时 | ≥ 24 小时 |
| 同一 ready epoch 等待处理 | ≥ 30 分钟 | ≥ 2 小时 |
| keeper 日志未更新 | ≥ 15 分钟 | ≥ 30 分钟；日志缺失也报严重 |
| 同高度 S / 哈希不一致、指数封存、池资不抵债 | — | 立即 |
| RPC/池状态读取失败、索引器失联或观测陈旧 | — | 立即标记状态未知/不可用 |
| 独立 Bitcoin 来源缺失/分歧、不同高度暂不可对账、成本统计不完整 | 立即 | — |

可折叠积压 = max(0, 外部 Bitcoin 链头 − 链上折叠高度 − 100)。正常的 100 确认等待
和最少 36 高度一批的等待不直接报为停摆；这些阈值是本机运维配置，不是协议规则或安全上限。
链头来自两个 HTTP 服务；来源低于部署/已验证历史的高度不能当成健康数据。
同高度才比较整数 S 和哈希；不同观测高度提示暂不可对账，不把它说成数学不一致。

keeper RPC 错误单独看最近周期，需连续两个正常等待周期后恢复，不能只看日志 mtime。
ready epoch 的首次观察时间保存在状态文件；首次安装不能反推其此前已等待多久。
未知字段不会清除旧的余额/积压等告警；只有新的明确观测才会恢复对应状态。

## 通知与后台运行

macOS launchd 作业 `com.wuji.sepolia-header-v3-operations` 每 300 秒启动一次只读采样。
实际服务使用独立冻结快照，源文件哈希、路径和提交记录在
`operator/sepolia-header-v3/operations-runtime-source-r4.json`；原 keeper/indexer 不切换。
运行输出为 `operator/sepolia-header-v3/operations.log`。

Codex 线程心跳 **WUJI运营告警**（id `wuji`）每 30 分钟检查本地报告，
执行冻结的 `check-operations-alerts.mjs`，在异常出现、严重性变化、恢复或监控数据超过
15 分钟未更新时通知一次。同级别余额数值变化不重复提醒；事件历史缺口和异常序号会显式提示。
通知游标单独保存为 `operations/notification-cursor.json`，不与采样状态互相覆盖。
首次已报告的低余额/零储备已初始化游标，保持原状时不再推送。
这是定期检查，不承诺实时送达；依赖本机保持开机联网、launchd 与 Codex 心跳可执行。
没有向其他人发送邮件、Slack 或 webhook。领币自动化 `wuji-sepolia` 未修改。

只读检查待通知事件（不确认游标）：

```sh
node scripts/check-operations-alerts.mjs operator/sepolia-header-v3/operations/status.json operator/sepolia-header-v3/operations/notification-cursor.json
```

`--ack` 会确认当前通知游标，供心跳消费；手动确认会影响下一次通知，勿无目的清空或回退。
如需停用，停止本监控 launchd 作业并暂停/删除 WUJI运营告警，保留状态用于排查；
不要把它与实际签名的 keeper 作业或领币自动化混淆。

测试入口：`node --test indexer/operations.test.mjs scripts/wuji-operations.test.mjs scripts/check-operations-alerts.test.mjs`。
详见 [部署、实测成本和验证报告](tasks/T13_OPERATIONS_2026-10-22.md)。

2026-10-23 成本刷新失败后的五分钟恢复与实际切换验收见 [修复报告](tasks/T13_COST_RECOVERY_2026-10-23.md)。

## 七个固定的 24 小时成本窗口

`scripts/wuji-cost-week.mjs` 是单独的只读历史核算工具，不写线上 `operations/status.json`。
例如以雅加达 2026-10-23 零点为结束，生成 10 月 16 日至 22 日的七个完整日：

```sh
node scripts/wuji-cost-week.mjs CONFIG.json OUTPUT 2026-10-23T00:00:00+07:00
node scripts/wuji-cost-week.mjs --summarize OUTPUT
```

CONFIG 沿用 `manifest` / `worker`，可选 `costRpc` 指定支持历史状态的公共 RPC，
可选 `historyRpc` 分开读取区块/收据/日志；默认均用 manifest 的 RPC。
更换此离线工具的配置不改变线上监控、keeper 或 indexer。两类 RPC 分开时会核对链 ID；
历史状态仍依赖 RPC 正确响应，不是状态证明或独立审计。

每个区间固定为 `[start,end)`，恰好 86400 秒。二分状态边界是开始/结束前最后一个块，
相邻窗口必须共享同一个边界块和哈希、nonce、余额与指数高度，交易哈希不可重复。
工具保留 plan、逐日原始收据和失败尝试；完成的逐日文件不覆盖，续跑先复查规范块哈希。
`--summarize` 无网络地重新核对收据费用、nonce 连续性、余额桥、相邻边界和奖励求和；
缺一天、失败/损坏、重复交易或边界不连续就拒绝七天合计。

这可以补算历史链上成本和指数推进，但不能补造历史 RPC 故障、外部链头积压、
人工操作或服务器费用。缺少连续遥测的部分一律 UNKNOWN；七天历史成本不是七天稳定运行验收。
默认滚动统计的口径保持不变；固定历史模式不会让实时监控接受陈旧 finalized 视图。
