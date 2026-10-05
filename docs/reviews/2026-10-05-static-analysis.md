# 静态分析：第一步上线的三个合约

2026-10-05 · 开发会话 · 范围：`WujiHeaderIndex.sol`、`RelayerRewards.sol`、`FeeRouter.sol`（第一步上主网的三个合约，
源码为 `85b0861` 时的版本）。池子合约属于第二步，审计时一并处理。

工具：Slither 0.11.6（`uv tool install slither-analyzer`），Aderyn（`npx @cyfrin/aderyn`，当前 npm 版；
crates.io 上的 0.1.9 太旧，读不了 `evm_version = "prague"`，所以在只含这三个文件的副本上以 `cancun` 编译后分析）。

## 结论

**两个工具都没有找到真正的漏洞。** 报出的条目逐条核对，全是误报或代码风格问题，下面写明理由。
但在核对代码时，发现了运营文档里的一个**配置错误**（不是合约漏洞），已修正，见最后一节。

## Slither：38 条

| 级别 | 检查项 | 条数 | 判断 |
|---|---|---:|---|
| High | weak-prng | 3 | **误报。** 指的是 `height % RETARGET_INTERVAL == 0` 和检查点边界的取模。这是判断"是否到了难度调整/检查点高度"，不是生成随机数。 |
| Medium | incorrect-equality | 7 | **误报。** 取模判断同上；`targetOf` 的符号位检查照搬比特币规则；`FeeRouter.route` 的 `balance == 0` 只是提前返回；`RelayerRewards.fund/claim` 的余额严格相等是**有意的**：拒绝转账收费币和变基币，防止记账与实际余额不符。 |
| Medium | uninitialized-local | 4 | **误报。** `w`（工作区结构体）、`previous`（排序检查从地址 0 开始）、`r`、`size` 都是有意从 0 开始。 |
| Low | reentrancy-events | 1 | **无影响。** `foldHeaders` 在调用 `rewards.credit` 之后才发 `Fold` 事件。`rewards` 是部署时固定的自家合约，`credit` 只记账、不转币、不回调；状态在调用前已全部写完。 |
| Low | timestamp | 11 | **误报。** 被标的比较几乎都是比特币区块头里的字段（难度、MTP、哈希），不是以太坊区块时间。唯一用到 `block.timestamp` 的是"区块头时间不超过当前时间 + 2 小时"，这正是比特币的规则。 |
| Info | naming / too-many-digits / pragma | 12 | 代码风格：常量式命名（`GENESIS_HEIGHT`、`S()`）、`byteSum` 的位掩码长字面量、依赖库的 pragma 版本不同。不改。 |

## Aderyn

| 编号 | 内容 | 判断 |
|---|---|---|
| H-1 | 外部调用后改状态：`RelayerRewards.fund`、`claim`，`WujiHeaderIndex` 构造函数 | **无影响。** `fund`/`claim` 都有 `nonReentrant`，`claim` 先清零再转账；`fund` 用的币是调用者自己选的，恶意币只能在自己的交易里回调，而储备所有改状态的函数都上了重入锁。构造函数里的外部调用是读取 `rewards.index()` 做绑定检查。 |
| H-2 | 存储变量传给 memory 参数 | **误报。** `_commitment(tip, …)` 只对状态做哈希，本来就不该写回存储。 |
| L-1 | 循环里有高成本操作 | 有上界：检查点写入次数受每笔 512 个区块头限制，赏金循环最多 8 个币种。 |
| L-2、L-3 | 大数字面量、字面量未写成常量 | 代码风格，不改。 |

## 核对时发现的问题：一次推进最多 256 个高度

`RelayerRewards.credit` 规定：列出赏金代币时，一次最多记 256 个高度（`MAX_HEIGHTS`），超过就回退。
它在 `foldHeaders` 里被调用，所以**列了赏金代币、又一次推进超过 256 个高度，整笔推进都会失败**。

- 合约本身没错：这个上限是为了限制赏金计算的 gas，keeper 默认每次最多 250 个高度，从来没碰到过它。
- 错的是 2026-10-04 写进经济账文档的建议："前期攒满 412 个高度推进一次"。照这个配置，主网 keeper 一领赏金就会一直失败。
  全历史回放没发现这个问题，因为回放没有接储备合约。
- 修正：
  - 文档改为"攒满 256 个高度推进一次"，约 1.8 天一次，每月约 21 美元（原来算的是 19 美元）。
  - `indexer/zk-keeper.mjs` 在启动时拒绝"设了赏金代币，`ZK_MAX_FOLD` 又大于 256"的配置，直接报错，不再等到每笔都失败。

## 复现

```bash
cd contracts && slither . --include-paths "src/(WujiHeaderIndex|RelayerRewards|FeeRouter)\.sol"
```

Aderyn：把三个文件复制到一个只有它们的 Foundry 项目（`evm_version = "cancun"`，OpenZeppelin 用同一份库），
运行 `npx @cyfrin/aderyn .`。

注意：Slither 运行时会执行 `forge clean`，清掉 `contracts/cache/`，包括全历史回放的分段数据。
回放前重新运行 `node scripts/replay-history.mjs` 即可。
