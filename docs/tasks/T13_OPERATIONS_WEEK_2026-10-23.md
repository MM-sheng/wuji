# 七个不重叠的 24 小时运营成本窗口 · 2026-10-23

用户要求记录并汇总七个互不重叠的 24 小时运营成本窗口。
本轮使用公开链上数据补算雅加达 **2026-10-16 00:00 至 2026-10-23 00:00**。
这是过去七天的成本账本；连续监控仅自 10 月 22 日起有记录，不能冒充七天稳定运行验收。

## 核算对象与口径

- Sepolia 11155111，worker `0x27b2474c8ca832d25c301ea43cf90c57c5a2dcd2`。
- 当前 header-v3 指数 `0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a`。
- 七个 `[start,end)` 区间各 86400 秒。每个边界使用该时间前最后一个规范块的状态。
  相邻窗口共享同一边界块、哈希、nonce、余额和指数高度；不拼接每小时的滚动成本。
- 全部 worker 出站 nonce 对应交易均有收据，包含失败 gas；失败 value 不算转出。
  WETH 奖励分配和领取分别记录，不与 ETH gas 净额相抵。
- 记录每个窗口的指数高度变化；不以账户 nonce 或发出交易笔数代替新增折叠高度。
- 原生币净流入由余额桥推得，不是逐笔水龙头或收入证明。
  不包含 deployer、用户钱包、服务器或 RPC 服务的成本，也不能作为主网预算。
- 历史外部链头积压、RPC/数据源故障时长、人工干预缺少完整连续遥测，保持 UNKNOWN。

## 实现与恢复过程

源码提交 `e43c764`。新增独立只读 `scripts/wuji-cost-week.mjs`，可留存逐日记录、断点续跑和离线汇总。
没有更改生产合约、钱包、keeper、indexer、监控快照、阈值或资金。

首次获取保留了失败：PublicNode 已裁剪无关古老区块和本次所需的七天前账户状态，
旧交易收据查询也出现 null。时间查找现从近期向前扩大范围，不要求创世数据；
历史核算改用能提供所需状态/收据的另一个公开 RPC，不修改线上 RPC 配置。

另一处兼容问题是普通交易收据返回 `blobGasUsed=0x0` 而不返回 blobGasPrice。
已修复零 blob 用量的整数计费；非零用量缺单价仍拒绝，不把缺失费用当作零。
四次 CLI 失败尝试原样保留在 attempts.ndjson，随后成功结果另存，不覆盖失败。

Node 26：25 项相关测试通过，包括精确端点、窗口连续、重复交易、缺日、错误收据、
余额桥不一致、已裁剪古老历史、零/非零 blob gas，以及恢复后的规范块检查。
Node 18.0.0：直接运行计费和七窗测试文件，合计 16 项通过。

## 结果与复现

**七个窗口真实获取和核算已完成。** [逐日汇总表](../reviews/evidence/operations-week-2026-10-23/SUMMARY.md)，
[机器可读合计](../reviews/evidence/operations-week-2026-10-23/summary.json)。

| 项目 | 七天结果 |
|---|---:|
| keeper 出站交易 | 34 笔，失败 0 笔 |
| 新折叠 Bitcoin 高度 | 1013 |
| gas 合计 | **0.0081564271 Sepolia ETH** |
| 指数操作 | 28 笔，0.0077974083 Sepolia ETH |
| 池维护 | 6 笔，0.0003590188 Sepolia ETH |
| 成功转出 value / 推得净原生币流入 | 各 0 |
| WETH 奖励分配 / 领取 | 各 0 |

相邻边界块/哈希、nonce、余额与指数状态均连续，34 个交易哈希无重复。
Node 18/26 无网络离线重算结果均与保存的 summary.json 完全一致；
离线汇总重新读取七个日文件并按原始收据计算费用，不复用保存的总数。
另一个公共 RPC 对照八个日边界规范块哈希，结果见
[边界对照](../reviews/evidence/operations-week-2026-10-23/boundary-crosscheck.json)。
对照仅涉及边界区块，不构成独立账户状态证明、独立审计或第二运营者。

以上样本属于现有测试网实际负载；WETH 赏金为零，不能把支出测试币称作协议收入或经济自养。
不根据这七天替用户承诺无限补贴、主网月预算或未来使用量。

原始记录目录：[operations-week-2026-10-23](../reviews/evidence/operations-week-2026-10-23/plan.json)。
实际公共 RPC、代码摘要、裁剪错误观测见 [来源记录](../reviews/evidence/operations-week-2026-10-23/provenance.json)。

只读重算（CONFIG 包含 manifest、worker 和可选 costRpc；不要使用凭据文件）：

```sh
node scripts/wuji-cost-week.mjs docs/reviews/evidence/operations-week-2026-10-23/config.example.json NEW_OUTPUT 2026-10-23T00:00:00+07:00
node scripts/wuji-cost-week.mjs --summarize NEW_OUTPUT
```

第二条命令不联网，只从 plan 与七份日记录重算合计，不读取既有 summary.json 来充当结果。
已有日文件不会覆盖；重新获取需另建目录，或在同一计划下复查已有日文件的规范块后续跑。

## 下一步

本表关闭的是七个历史链上成本窗口的核算工作，不关闭独立运营、长期稳定性、预算承担人或经济自养。
据此准备未来维护预算时，应将实际使用负载、gas 价格情景、链下费用、补贴来源及停止资助后的服务安排补齐。
