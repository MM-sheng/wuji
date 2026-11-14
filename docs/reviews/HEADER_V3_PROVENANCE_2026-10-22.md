# header-v3 回传证据与来源记录一致性

## 已复现的问题

在原公共档案的临时副本中，分别修改 `source.json` 的 RPC、`rpc.json` 的 RPC 标签、Bitcoin API、一个页面 URL，或将观测时间改成非时间字符串，r2 仍返回 `PASS_OFFLINE_REPLAY`。

五种情况下 S 均仍为 `3516000000000000`，不是指数计算被绕过；缺口在于报告没有检查来源记录之间是否一致，也没有返回这些来源供验收者对照。[首次复现记录](evidence/header-v3-provenance-2026-10-22/r2-reproduction.json)保留，原档案没有修改。

## r3 的修正

- RPC 标签与所选配置交叉核对，每页 URL 必须等于所选 Bitcoin API 下对应高度的路径，观测时间须为规范 UTC ISO 字符串。
- 续传遇到已有 RPC 标签与配置不同，在联网之前失败，避免下载到最后才发现记录混用。
- 重放结果增加 `sources` 和四份证据文件的 `evidenceSha256`。旧的 `result.json` 不作为可信输入，也不被覆盖；r1/r2 档案可直接重放产生新输出。
- 来源标签一致只表示档案内部一致。`sources.authenticity=NOT_ATTESTED` 和 `operatorIndependence=NOT_ATTESTED` 保留，不能证明实际向哪个运营者发过请求，也不能认证观测时间。全部标签被一致改写仍超出本工具的证明范围。

## 验证范围与结果

Node 18.0.0 与 26.8.1 均为 **20 PASS、0 FAIL、0 SKIP**；无档案基础执行为 **9 PASS、0 FAIL、11 SKIP**。新增五类不一致档案全部拒绝；原档案、续传与消费者仍通过。缓存来源错误在任何模拟网络请求前就被拒绝。

完整日志：[Node 18](evidence/header-v3-provenance-2026-10-22/node18-full-r3.log)、[Node 26](evidence/header-v3-provenance-2026-10-22/node26-full-r3.log)。另有[当前离线结果](evidence/header-v3-provenance-2026-10-22/r3-offline-replay.json)、[消费者输出](evidence/header-v3-provenance-2026-10-22/r3-consumer.json)及[机器可读结果](evidence/header-v3-provenance-2026-10-22/r3-test-results.json)。先前兼容检查摘要[保留为历史证据](evidence/header-v3-provenance-2026-10-22/r2-SELF_CHECK.json)。

本轮全部为本机离线检查，测试网络响应来自原始公共档案，不是第二来源或新公共下载，也不是外部开发者验收。协议公式、固定候选、合约、后台、钱包与资金没有变动，邀请未发送。

## 当前交付

修订 `header-v3-r3-20261022`，14 个文件，37983 字节：

`wuji-header-v3-verification-2026-10-22-r3.zip`

SHA-256：`999ef5db46be168d692d91b34a5a80278a445dc135d6a0926e4575d468d521ed`。

压缩包解压到仓库外，Node 18 的摘要检查与当前离线重放均通过，逐文件比对与源目录一致；[交付核对](evidence/header-v3-provenance-2026-10-22/r3-delivery.json)。原 r1/r2 压缩包保留；README、验收模板、SELF_CHECK 与 SHA256SUMS 已同步。
