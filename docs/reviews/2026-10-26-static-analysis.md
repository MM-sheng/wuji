# 静态分析（第二次）：当前指数合约与带上限的池子

2026-10-26 · Claude Code（独立审查） · 取代 [2026-10-05 的报告](2026-10-05-static-analysis.md)作为当前证据。

## 为什么重跑

10 月 5 日的报告针对的是当时的代码。之后：

- `WujiHeaderIndex` 修了中位时间窗口被原地排序的 bug（`9baee1e`），并加了分段重组证明 `beginReorg` / `extendReorg` / `freezeReorg`（`03f6256`）；
- 池子合约加了储备保护、分批结算、资不抵债自动关闭（`03f6256` 等）；
- 本分支（`pool-caps-v3`）给池子加了规模上限。

## 范围与工具

| 组 | 合约 | 代码版本 |
|---|---|---|
| 第一步（上主网） | `WujiHeaderIndex`、`RelayerRewards`、`FeeRouter` | 与本机 `main` `02e42a6` 完全相同 |
| 第二步（池子） | `WujiAccounts`、`WujiAccountsFactory` | `pool-caps-v3`（含规模上限） |

Slither 0.11.6；Aderyn（npm 当前版，在只含 `src/` 的副本上以 `evm_version = "cancun"` 编译）。

## 结论

**两组都没有发现真正的漏洞。** 下面逐类说明判断依据。

## 第一组：指数、储备、路由（Slither 42 条）

和 10 月 5 日相比多出 4 条，全部来自新代码：

| 检查项 | 位置 | 判断 |
|---|---|---|
| incorrect-equality | `_extendReorg` | **有意为之。** 分支经过原链尾（高度和哈希都相等）就说明是同一条链，必须拒绝；这里只能用严格相等。 |
| uninitialized-local | `beginReorg` 的 `p`、`_median` 的 `t` | **误报。** `p` 在下一行由 `abi.decode` 填满；`t` 是修 bug 时引入的副本，逐个从输入复制，这正是那次修复的内容。 |
| timestamp | `freezeOnReorg`、`freezeReorg`、`_extendReorg` | **误报。** 比较的是比特币区块头里的时间和工作量；唯一用到以太坊区块时间的，是比特币"未来两小时"规则。 |

其余 38 条与 10 月 5 日报告相同（取模被误判为随机数、余额严格相等用于拒绝收费代币、命名风格等），判断不变。

Aderyn：
- "外部调用后改状态"（`RelayerRewards.fund/claim`）：有重入锁；`claim` 先清零再转账。
- "存储数组传给 memory 参数"（`WujiHeaderIndex` 第 138 行）：只对状态做哈希。
- "未检查返回值"（`RelayerRewards.sync`）：`_sync` 返回的余额在这里不需要。

## 第二组：池子与工厂（Slither 112 条，第一次扫）

| 检查项 | 条数 | 判断 |
|---|---:|---|
| divide-before-multiply | 3 | **有意为之。** `_advance` 先算单位本金的位移 `dS·1e27/K` 再乘配对本金，1e27 的精度下截断误差可以忽略，两边都向下取整，只会在池里留下尘埃，不会欠钱；`marginForAge` 是按小时向上取整查表；`_roundUp` 是向上取整到定价周期的倍数。 |
| incorrect-equality | 2 | **有意为之。** 进入时余额必须正好增加 `amount`，用来拒绝转账收费币；`_payBounty` 中金额为 0 时提前返回。 |
| uninitialized-local | 1 | **误报。** `_advance` 的计数器 `work` 从 0 开始。 |
| calls-loop | 22 | **无影响。** 循环里调用的全是部署时固定的指数合约和抵押币（只读或标准 ERC-20），循环次数受 `MAX_WALK` 和每批账户数限制；被调用方不是用户可以替换的合约。 |
| missing-zero-check | 1 | 工厂没有检查 `treasury` 是否为 0。池子的构造函数会拒绝 0 地址，所以这样的工厂开不出任何池子，没有资金风险。可以在工厂里补一行检查（可选）。 |
| unused-state | 1 | 常量 `ONE` 没被使用。常量不占存储，也不进运行时代码，可以删（可选）。 |
| timestamp、assembly、costly-loop、命名、复杂度等 | 82 | 风格或说明性条目，不涉及正确性。 |

Aderyn：
- "外部调用后改状态"：`mark`、`markWithHeaders` 先读指数合约再写记录（固定的只读调用）；`sweep`、`freezePool` 有重入锁。
- "未检查返回值"：`_process` 调用 `mark(...)` 时没用返回值，`mark` 已经把 S 写进 `sAt`。
- "Yul 中的 return"（工厂的代码数据合约）：有意为之，用来把池子代码原样存成数据合约。

## 规模上限部分（本分支新增）

这部分没有任何工具报出问题。人工核对了这几点：

- 待处理本金在**所有**会变动的地方都同步了：进入申请、每期结算、资不抵债后退回未定价的申请；
- 上限检查在收款之前，超出就整笔回退；
- 退出不受上限影响。

## 复现

```bash
cd contracts
slither . --include-paths "src/(WujiHeaderIndex|RelayerRewards|FeeRouter)\.sol"
slither . --include-paths "src/(WujiAccounts|WujiAccountsFactory)\.sol"
```

Aderyn：把 `contracts/src` 复制到只含它和 OpenZeppelin 库的 Foundry 项目（`evm_version = "cancun"`），运行 `npx @cyfrin/aderyn .`。
Slither 会执行 `forge clean`，清掉 `contracts/cache/`（包括全历史回放的分段数据），回放前要重新生成。
