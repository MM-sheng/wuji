# WUJI 外部审阅与只读接手任务书

状态：准备材料，尚未发送、委托或产生外部结论。面向已经同意参与的开发者/审阅者。
WUJI 将公开 Bitcoin 区块头按固定规则转换为整数结算指数；当前审阅对象是 Sepolia header-v3 原型。
本任务的实际操作限于读取公开数据、离线计算、阅读源码和本地测试，不需要钱包或资金。

## 固定对象

| 对象 | 标识 |
|---|---|
| 复算包 | `header-v3-r4-20261023`，原 ZIP SHA-256 `5c2bc154938772e88a3eee116133ad16742d8ad9abd1c6d37ded84e80866272d` |
| 固定候选 | `wuji-sepolia-header-v3-fixed-11969645`，完整参数见 [candidate.json](../../verification/header-v3/candidate.json) |
| 链 / 指数 | Sepolia 11155111 / `0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a` |
| 历史观察块 | 11969645 / `0x72be42afcf3cd795f35d9f19051858f4fde77fd631353d47a262e572231c47d7` |
| 合约部署来源 | `03f6256c2821e5a67a8b98739ee9b199a32da27a` |
| 源码阅读快照 | `e884e05a42fb72d91ca8cc996efe1da7fe2c7ffc`，生产源码与上述部署来源相同；不是已审计的主网发布标签 |
| 编译器 / 依赖 | Solidity `0.8.28+commit.7893614a`；OpenZeppelin `cab19933c33c2ad1d4c7a84864a3601dddfd16f3` |

补充包中的源码和每个文件摘要列在根目录 `SOURCE_MANIFEST.json`，源码入口位于 `contracts/src/`。
`solc-input.json` 含全部导入内容，使用相对路径 remapping。它用于离线编译和阅读；由于编译元数据设置中的
路径上下文与历史部署不同，**本包编译不能单独证明链上字节码相等**。也未附带完整 Foundry 测试和全历史原始头档。
以上两项需要独立构建/测试工作，未被自动算作通过；发生文件或依赖不一致时先报告，不自行替换为最新版本。

## A. 开发者：独立复算与只读接手

只需 Node 18+。在自己控制的环境按 [r4 README](../../verification/header-v3/README.md) 执行：

```sh
cd verification/header-v3
node verify.mjs integrity
node verify.test.mjs
node verify.mjs fetch ../wuji-v3-external-01
node verify.mjs replay ../wuji-v3-external-01
node verify.test.mjs ../wuji-v3-external-01
node consume.mjs ../wuji-v3-external-01
```

输出目录必须此前不存在；`../wuji-v3-external-01` 位于复算包目录之外。限流遵守 README 的冷却指引。
基础测试预期 16 PASS、12 SKIP；完整档案预期 28 PASS、0 FAIL、0 SKIP；缺数据时的 SKIP 不能计入通过。
在新进程或另一处目录重放，保存本次输出，不改写旧 `result.json`。用自己的小程序接入是可选用途验证；
没有合适用途时直接说明，不需要模仿附带示例来凑采用。

回传 [ACCEPTANCE 模板](../../verification/header-v3/ACCEPTANCE.md)：环境、实际提供商、包/数据摘要、
result、重放输出、测试计数、第一次失败及恢复、协议疑问、用途或不采用原因。
这一步完成时只记“独立历史复算/只读接手”；没有证明持续追链、签名 keeper 接手或作者离线运营。

## B. 审阅者：请逐题给出自己的结论

源文件列表用于定位，不是预先指定“无漏洞”的检查答案。可以报告反例、残留假设或未评估；不要求为了交付而写 PASS。

| 题目 | 源码入口 | 希望回传的证据 |
|---|---|---|
| B1：输入与选链 | WujiHeaderIndex.sol 的 `_apply`、`_replay`、`foldHeaders` | 对比选定 Bitcoin Core 版本的相关规则；字节序、compact target、难度调整、MTP、未来时间与工作量的反例/等价范围。明确 header-only 与完整 Bitcoin 验证的差距、锚点与诚实提交假设 |
| B2：深重组与封存可执行性 | WujiHeaderIndex.sol 的单笔/分段封存、承诺与 fork base | 同链排除、跨 fold、链前进、难度变化、分段恢复与最终门槛；本地反例或可复现检查。800 头是单笔接口限制，256 是每段限制，不能视为允许重组的最大深度；gas 须说明环境，不能套用旧数值 |
| B3：资金与未来价格窗口 | WujiAccounts.sol | 预定价格高度、公开信息窗口、时间偏移；三类准备金隔离、分批锁定、资不抵债比例、冻结历史价格认证、取整和领取顺序。说明哪些属于资金损失、锁定或活性问题 |
| B4：绑定、费用与激励 | WujiAccountsFactory.sol、RelayerRewards.sol、FeeRouter.sol | 两段不可变 creation code、构造绑定、一次性赏金、重复/孤儿高度、代币假设与资金留存；区分无权限与有人愿意支付维护成本 |

源码里的 WujiIndex/BitcoinRelay 是导入依赖；它们不是本次主网发布路线的替换选择。
原生 ETH、CREATE2、钱包、keeper 和 indexer 的实现不在本补充源码快照中；其审阅不得被本次结论覆盖。
若只承接指数审阅，可将 B3 和 B4 中池相关内容标为 NOT_REVIEWED；这样不能形成资金池放行结论。

请按下列格式回传（每个发现单独一项，无发现也需写实际评估范围）：

```text
审阅者角色 / 与实现者的关系：
日期、环境、源码提交、补充包 SHA-256：
B1 / B2 / B3 / B4：REVIEWED / FINDING / UNRESOLVED / NOT_REVIEWED
参考 Bitcoin Core 版本/提交与文件（若使用）：
实际执行的本地命令、测试、种子与结果文件：

发现编号、严重程度及理由：
文件 / 函数 / 行号、触发前提：
复现步骤或最小反例、预期与实际行为：
资金/正确性/可用性影响，已知缓解与未决问题：
建议修复；修复后复查的版本与证据（未复查写 NOT_REVIEWED）：

未覆盖范围 / 未能获得的数据：
总体结论及成立条件：
```

请保留原始失败，不修改 expected 值来取得通过；只回传必要日志和摘要，不提供任何密钥、令牌或私有 RPC 凭据。
本包附带的 BUILD_CHECK 是作者的离线编译结果，不是审阅者的结论，也没有运行上表的攻击验证。

## C. 未来签名运营验收：仅列待办，当前不执行

A 完成后，仍需要有独立运营者和明确的资金/操作安排，才能另行执行：独立账户与 RPC 的实际提交、
重启和未知广播恢复、持续对账、接到故障后的处置、作者离线 48 小时下的服务与退出路径验证。
不得现在关闭作者服务、拿现有仓位演练或以只读脚本替代这些证据。

回传时将 A、B、C 分别记录；C 当前为 NOT_RUN。发现关键问题时保留原包和反例，停止依赖该候选，
等待实现方处理；不可升级合约不能通过替换文档或重新部署自动修复旧地址。
