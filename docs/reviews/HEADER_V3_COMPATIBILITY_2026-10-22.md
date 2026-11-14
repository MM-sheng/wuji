# header-v3 外部验证包：Node 18 兼容与续传复核

## 结果

修订 `header-v3-r2-20261022` 已完成。协议、候选身份、公开复算实现与部署没有改动；修正测试入口和一条断言，增加下载续传的故障检验，更新说明与自检摘要。

本轮是作者同机兼容性检查，**不是外部开发者验收**。原先使用公共数据取得的 4931 个头继续作为已标明来源的自检夹具，没有重复全量下载或假称第二来源。

## 首次失败与修正

使用 [Node 官方发布的 v18.0.0 macOS arm64 二进制](https://nodejs.org/download/release/v18.0.0/)，摘要与官方清单一致。它仅放在隔离临时目录，不替换系统运行时。

| 检查 | 首次结果 | 修正与结果 |
|---|---|---|
| README 的 `node --test verify.test.mjs` | 退出 9，`bad option: --test` | 改为 `node verify.test.mjs`，可在最初的 Node 18 上运行 |
| 固定块证据的错误输入断言 | Node 18 完整测试 13 PASS、1 FAIL，`ERR_AMBIGUOUS_ARGUMENT` | 明确匹配 `ERR_ASSERTION`，错误证据仍须拒绝 |
| 历史消费者 | 首次即通过 | 解压 r2 后再次通过，整数 S 一致 |
| 原生 Fetch 只读 RPC | 首次即通过，17 个 view | 使用固定块 11969645，未改变协议读取实现 |

首次失败日志：[启动参数](evidence/header-v3-compat-2026-10-22/documented-base-test.log)、[完整测试](evidence/header-v3-compat-2026-10-22/full-test.log)。原始 r1 自检摘要[单独保留](evidence/header-v3-compat-2026-10-22/r1-SELF_CHECK.json)。

## 修后验证

| 运行时 | 无下载档案 | 带原公开档案 |
|---|---|---|
| Node v18.0.0 | 9 PASS、0 FAIL、6 SKIP | 15 PASS、0 FAIL、0 SKIP |
| Node v26.8.1 | 9 PASS、0 FAIL、6 SKIP | 15 PASS、0 FAIL、0 SKIP |

完整日志：[Node 18](evidence/header-v3-compat-2026-10-22/node18-full-test-after.log)、[Node 26](evidence/header-v3-compat-2026-10-22/node26-full-test-after.log)；机器可读[修后结果](evidence/header-v3-compat-2026-10-22/repaired-results.json)。未实测其他系统或每个 Node 次版本。

新增第 15 项把公开档案作为模拟 HTTP 响应：在新目录取得三页后令下一页的三次请求失败，确认没有成功报告；拒绝改来源后复用该目录；恢复后复算全部页面，确认前三页未再次下载且字节不变；完成目录拒绝再次下载覆盖。测试仅缩短重试与分页计时，不联网，不代表真实公共服务的中断恢复或磁盘写入故障已验证。

## 交付身份

- 新文件：`wuji-header-v3-verification-2026-10-22-r2.zip`，14 个文件、34944 字节。
- r2 SHA-256：`7255e67c3a999ec4822ba939a7e7357a8da3e974e2d1b87e859bc3d981471bef`。
- 原 r1 压缩包保留，SHA-256：`493158fb71180073553077acf1528a4cfbef473bc1e7a4410c9b8c33e57f3120`。
- r2 从压缩包解压到仓库外，用 Node 18 执行包摘要校验与消费者均通过；压缩包内容逐文件与当前源文件相同。见 [交付核对](evidence/header-v3-compat-2026-10-22/r2-delivery.json)。

当前说明、验收计数、机器摘要与包内 `SHA256SUMS` 已同步；首个自然检查点仍为 NOT_REACHED，外部验收仍为 NOT_RUN。没有修改合约、部署、测试钱包、操作资金、改动后台或发送邀请。
