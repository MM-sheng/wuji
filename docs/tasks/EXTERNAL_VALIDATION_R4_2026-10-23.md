# 外部验证包 r4：限流与本地损坏恢复收尾

用户于 2026-10-23 重新要求继续推进。沿用已收敛的外部开发者验证主线，只处理上轮交接的两项已知问题，
没有恢复旧钱包/部署队列或重建自动推进任务。本轮未改生产合约、钱包、后台、阈值或资金。

## 交付结论

当前验证包修订 **`header-v3-r4-20261023`**，固定候选、协议参数、4931 头样本范围及 EVM 块 11969645 不变。

- HTTP 429 或失败响应带 `Retry-After` 时，触发请求立即停止；不再按通用 1000ms 退避过早重试。
  秒数与 HTTP 日期转为人工续传提示，缺失/无效值提示先按提供商冷却规则处理。
  响应体清理失败也不允许恢复为自动重试。没有数小时阻塞等待、跨进程冷却锁或自动换来源。
- JSON 证据损坏时给出文件名及恢复路径：保留旧目录、排除存储问题、用新目录获取；不会覆盖或修补损坏文件。
  README 与验收表分别说明正常网络续传、提供商冷却和本地损坏，不能把坏档案拒绝写成自动修复能力。
- 旧 r3 ZIP 与原公共档案保留。协议候选身份与历史 `result.json` 未修改；本轮没有重复公共下载或重新计数自然检查点。

## 实际验证

| 验证 | 结果 / 范围 |
|---|---|
| Node 18.0.0 完整测试 | 28 PASS、0 FAIL、0 SKIP |
| Node 26.8.1 完整测试 | 28 PASS、0 FAIL、0 SKIP |
| 两个运行时不带档案 | 各 16 PASS、0 FAIL、12 SKIP；不把 SKIP 计作通过 |
| 服务端冷却 | 五类模拟响应：429 秒数/HTTP 日期/缺失/无效值，503 附等待值；每个请求只发送一次 |
| 下载途中限流 | 已下载三页后模拟 429，三页原字节保留、不产生 result；模拟服务恢复后手动再调用，续传并完成重算 |
| 本地不完整 JSON | source.json / rpc.json 各两次重试，零网络请求、原字节不变、没有成功报告；截断页也被离线重放拒绝 |
| 离线重放 | 禁用 fetch 后，原 4931 头档案重算 2965 行、U=293、S_wad=3516000000000000 |
| 独立解压目录 | 14 文件与源目录逐字节一致；Node 18 摘要检查及消费者、Node 26 重放成功；没有依赖仓库父目录 |

冷却测试是模拟传输，没有向公网制造限流、实际等待 3600 秒或证明公共服务已恢复。
参考计算与资金/生产代码均未更改；默认合约回归 **325 PASS、0 FAIL、24 SKIP**，未开启全历史回放。
该结果在[单独检查记录](../reviews/evidence/header-v3-recovery-2026-10-23/contract-regression.json)中保存，不扩大本包的证明范围。

## 交付文件与复现

文件：`wuji-header-v3-verification-2026-10-23-r4.zip`，42017 字节，14 文件。

SHA-256：`5c2bc154938772e88a3eee116133ad16742d8ad9abd1c6d37ded84e80866272d`。

本机成果位置：
`/Users/m/Documents/Codex/2026-09-18/ni/wuji-deliverables/wuji-header-v3-verification-2026-10-23-r4.zip`。

[验证包入口](../../verification/header-v3/README.md)、[验收标准和回传模板](../../verification/header-v3/ACCEPTANCE.md)。
[机器可读交付核对](../reviews/evidence/header-v3-recovery-2026-10-23/r4-delivery.json)、
[运行时测试记录](../reviews/evidence/header-v3-recovery-2026-10-23/r4-test-results.json)、
[离线重放](../reviews/evidence/header-v3-recovery-2026-10-23/r4-offline-replay.json)。
旧 r3 的首次失败[原样保留](../reviews/evidence/header-v3-recovery-2026-10-23/r3-reproduction.json)，不覆盖成新版本通过结果。

在 verification/header-v3 或解压目录执行：

```sh
node verify.mjs integrity
node verify.test.mjs
node verify.mjs fetch ../wuji-v3-run-NEW
node verify.mjs replay ../wuji-v3-run-NEW
node verify.test.mjs ../wuji-v3-run-NEW
node consume.mjs ../wuji-v3-run-NEW
```

公开获取应由外部验收者在自己控制的环境中执行；已有输出目录不能作为新的公共获取结果。
按 README 遵守提供商冷却，不循环重开命令。本次附带的历史自检记录不算外部回传。

## 下一步及边界

**下一步是让一位外部开发者实际接手，不再扩展内部验收清单。** 邀请草稿已准备，当前没有联系人、
发送授权或外部结果；未发送邀请、上传包或替他填写验收。真正需要取得的反馈是：

1. 无作者私有缓存与现场修改，是否能独立理解、取得数据、复算并重放；保留第一次失败。
2. 他自己的无资金小程序是否有用途，为什么需要这条共同指数路径，以及接受怎样的延迟和成本。

需求、独立审计、第二运营者、主网和经济自养仍未通过。原 #5 测试仓位的后续退出/领取也保持单独待办，
没有因验证包完成而被写成结清。后台监控按原配置继续，本轮不自动部署或更改任何资金状态。
