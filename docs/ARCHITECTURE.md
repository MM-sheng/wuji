# WUJI · 架构与决定

> 无极生太极，太极生两仪。
> A market before reason. From nothing, yin and yang; together, always whole.

WUJI 是一个**和世界无关的资产**：价格由 BNB 链的出块哈希决定，不跟经济、情绪、消息或任何人的决定相关。它是相关性的零点。

本文记录已经拍板的决定。改变任何一条都要改这里。

> 2026-09-19 目标澄清：创始意图是无强制到期、允许持有者等待盈利目标的随机资产。以下期次与滚动金库描述记录现有原型，尚未实现该目标；不得将原型测试通过等同于最终资产机制成立。数学定义、独立性假设及兑付约束见 [WUJI_FOUNDATIONS.md](WUJI_FOUNDATIONS.md)。新的经济模型仍处于研究阶段，未批准替换现有合约。

---

## 0. 原则

1. **纯粹**：价格的唯一输入是链上区块哈希。没有预言机、没有治理、没有管理员、合约不可升级。
2. **自洽**：系统内每一块钱的盈利精确对应另一块钱的亏损；任何价格下金库都不能资不抵债。
3. **可验证**：任何人用公共 RPC 能从创世重算全部历史。索引层只是缓存，没有权威。

---

## 1. 指数（Index）

- 随机源：BSC 主网每个区块的 `blockhash`。
- 每块一个对数增量，**整数运算，链上链下逐位一致**：
  - `byteSum = 哈希 32 个字节之和`（∈ [0, 8160]，均值 4080，标准差 418.04）
  - `U_n = Σ (byteSum_i − 4080)`（精确整数）
  - `S_n = U_n · UNIT`，`UNIT = 3.3e-7`（合约里 `3.3e11` wad）
  - 32 个均匀字节之和按中心极限定理已非常接近正态（超额峰度 −0.04，尾部 ±9.8σ 截断），每块等效 `σ_block ≈ 1.38e-4`
  - 为什么不用 Box-Muller：链上 ln/cos 太贵且浮点不可复现；byteSum 用 5 步 SWAR 只要几十 gas，JS 和 Solidity 得到完全相同的整数
- BSC 目前 ≈0.45 s/块 ≈ 192k 块/天，对应日波动 ≈ 6%。
  - **已知取舍**：波动率跟随出块节奏。链变快市场就变"热"。接受——链是心跳。
- 指数价格 `P_n = 100 · exp(S_n)`（链下计算，合约只存 S）。
- 创世块：`GENESIS_BLOCK = 122616000`（2026-09-18，BSC 主网）。原型阶段可重设；主网合约部署后永久固定。

## 2. 两仪（配对铸造）

- `mint(100 USDT) → 1 YANG + 1 YIN`（当期），`redeem(1 YANG + 1 YIN) → 100 USDT`，任何时刻。
- 价值：`YANG = 50 + 50 · (S_now − S_start)`，`YIN = 100 − YANG`。
  - 每块从输方向赢方转移 `50 · r_block`（r 是该块的对数增量，≈ 涨跌幅，差异 ~1e-8 级），**基数固定为 50**，不是各自余额。这是唯一让 YANG+YIN 恒等于 100 的转移规则。
  - 用对数增量而不是算术涨跌幅：这样金库只需读 `WujiIndex.S`，不需要第二个累加器，也不需要链上 exp。
- 边界：`yangShare = clamp(½ + ½·ΔS, 0, 1)`，YIN = 1 − yangShare。两边都是有界的 claim，像期权一样：到边界后赢方不再多拿。没有钱被创造或销毁，只是停止转移。
- **不做每日封顶顺延**（2026-09-18 改）：封顶需要链上每日检查点，增加复杂度和 gas，却不能消除边界——它只是让触碰边界慢一点。有界 claim + 期次已经足够诚实。
- **期次（Series）**：主网每期固定 5,760,000 个区块（按当前约 0.45 秒/块约为 30 天），从 50/50 起步。结算区块在开期时已经确定；`WujiIndex` 折叠该块时把 S 固化为链上 checkpoint。任何人以后调用 `settle()` 都只能读取这个 checkpoint，不能选择更晚、更有利的路径点。下一期边界按相同区块间隔递增。代币按期命名 `YANG-k` / `YIN-k`。
  - 为什么要期次：余额是转移额的累加，波动按 √T 增长（每日 σ≈3 块）。永远滚下去一年内触底概率约四成；30 天内约 0.5%。

## 2b. 多抵押品（工厂）

- `WujiVaultFactory.create(asset, notional)`：任何人、任何 ERC-20、任何面值，无许可、无白名单。每个金库读同一个 `WujiIndex`，同一条路径、同一批检查点；抵押品只决定"两仪相加等于什么"（100 USDT / 1 BNB / …）。
- 同一 `(asset, notional)` 只能开一个金库（防重复市场）。
- 代币名带抵押品：`YANG-USDT-3`、`YIN-WBNB-0`。`SeriesToken` 由无状态的 `SeriesTokenDeployer` 部署（否则工厂嵌套金库嵌套代币的字节码超过 EIP-170 的 24KB 上限）。
- 前端只推精选列表（首发 USDT + WBNB）；转账扣费代币金库会在 mint 时原子拒绝，rebase 代币不支持、靠列表排除。
- 代价：流动性按抵押品分散；keeper 每期结算 × 金库数。

## 3. 永续现货（滚动金库）

- `WUJI` = 持有当期 YANG 的金库份额；`YIN`（永续）= 持有当期 YIN 的镜像金库。
- 期末结算 → 两个金库**联合铸对**进下一期，差额走二级市场。
- 净值走法 ≠ 指数 `100·exp(S)`：每块涨跌幅 = `50·r / YANG`。接受，不用杠杆去追。前端两条都画：指数是"天气"，WUJI 净值是"你能买到的天气"。
- 标准 BEP-20，可上 DEX / CEX / 跨链。定义在链上，流通在任何地方。

## 4. 合约层

- **价格合约** `contracts/src/WujiIndex.sol`：`tick(max)` 任何人可调，把上次记录以来最多 `max` 个块哈希（最旧优先）折进 `S`；`tick()` 默认 1024。
  - 哈希来源：最近 256 块用 `blockhash`（≈1.4k gas/块）；256～8191 块用 **EIP-2935 历史合约** `0x0000F90827F1C53a10cb7A02335B175320002935`（BSC 主网和测试网都已上线，实测可读 8000 块前的哈希；≈6k gas/块）。窗口约 **1 小时**，keeper 只要一小时内调一次就不会断档。
  - 断档（>8191 块无人 tick）：断档增量**定义为 0**，`frozenBlocks` 计数，`Gap` 事件留记录。丑但确定。历史合约对窗口内的块拿不到哈希时**回滚**而不是记 0——宁可不记，不记错。
  - 固定 checkpoint：从创世块开始每隔 `CHECKPOINT_INTERVAL` 块记录一次精确 S。checkpoint 对应的区块号在其哈希产生前已经确定；若边界落在断档内，则按断档零增量规则记录断档前的 S。
  - keeper `indexer/keeper.mjs`：有积压 ≥40 块就 tick，gas 按积压量预算（gas 估算会过期：估算时的块数 < 上链时的块数，第一次部署就因此 OOG 过一次）；链高越过结算块后自动 `settle()`。
  - 用户操作（mint/redeem）**不** tick：配对按面值铸赎与 S 无关，而且无界的折叠会让钱包 gas 估算失效。只有 `settle()` 需要新鲜的 S。
  - `settle()` 只要求距离当期 checkpoint 不超过一个默认 tick（1024 块）；更远时必须先独立调用 `WujiIndex.tick()`。当前链头即使已经远远越过边界，结算值仍是固定 checkpoint，边界后的块不会计入上一期。
  - 无 owner、无升级、无参数可调。
- **金库合约** `contracts/src/WujiVault.sol`：
  - `mint(pairs)` 在结算块之前拉 `pairs × NOTIONAL` 抵押 + 0.05% 费；`redeemPair(id, pairs)` 任何时候按面值赎（开期或已结算都行）；`settle()` 在边界块被挖出后任何人可调，读取固定 checkpoint、冻结 share、开下一期；`redeemSettled(id, yang, yin)` 单边按冻结值赎。
  - 每期两个独立 ERC-20（`SeriesToken`，只有金库能铸销）：`YANG-k` / `YIN-k`。
  - 费率 0.05% 写死，`treasury` 地址 immutable。去向仍待定，但机制已定：不可改。
  - 不变量（Foundry invariant 测试，45,000 次随机调用序列含断档、结算、单边持有）：金库余额 ≥ 全部负债；开期内 YANG 供应 == YIN 供应；YANG+YIN 值恒等于 NOTIONAL；任何时刻只有最后一期未结算；手续费只流向 treasury。
  - 结算时点不能由调用者选择：每期的 `settlementBlock` 预先确定，结算读取 `checkpointS[settlementBlock]`。keeper 只负责推进和及时开户，不影响赔付结果。
  - 抵押品必须是普通、非 rebasing、非 fee-on-transfer ERC-20；mint 会核对金库余额增量，不足则整笔回滚。
- 二级市场直接用 PancakeSwap：YANG/USDT、YIN/USDT，铸赎套利把两池价格之和钉在 100。`enterYANG(50 USDT)` 路由一笔交易铸对+卖 YIN。

## 5. 索引 / API（无权威缓存）

- 跟链读块，累加精确整数 `U`，落盘（每块 12 字节）。
- `GET /head`、`GET /seconds?from&to`（每秒末价格）、`GET /candles?tf&from&to`、`GET /blocks`、`GET /blockAt?ts`、`GET /proof/:block`（哈希 → byteSum → U → S，含合约 wad 值，可用任意 RPC 重算）。
- 客户端不可能自己从创世同步（一天 192k 块 ≈ 1GB RPC 流量），索引层从第一天就是必需的。

## 6. 前端（终端）

- 现有 `apps/terminal` 改为读索引 API；保留**纸面账户**（localStorage）作为漏斗入口；钱包接入后 BUY/SELL 变成 enterYANG/enterYIN。
- 每根 K 线可查区块范围 → BscScan，"自己验"是核心体验。
- 猴子（每分钟抛硬币的基准）、事后新闻、TA 叠加层、时光穿梭、杠杆爆仓（纸面）保留——它们是论点的一部分。

---

## 路线

1. ✅ 架构定稿（本文）
2. ✅ 索引器 + 终端接链：本地跑通"块 → 价格"（创世 #122616000，2026-09-18）
2b. ✅ 价格合约 `WujiIndex` + 单元/模糊/真实哈希对账测试
2c. ✅ 金库合约 `WujiVault` + 单元/模糊/不变量测试
3. ✅ BSC testnet 部署（`contracts/deployments/bsc-testnet.json`），keeper 在跑，链上 S 与索引器逐位一致
3b. ✅ 终端「两仪 · On-chain」标签：YANG/YIN 实时值、期次倒计时、合约 S vs 索引 S 对照、金库偿付、钱包 mint/redeem（原生 EIP-1193，无库；MetaMask 实机待验）
4. 🔄 固定区块结算已实现；待独立审计、完整测试网结算、主网、上池子
5. 滚动金库（WUJI / YIN 永续）

## 待定

- 手续费去向
- 随机源是否混入 drand 做双保险
- 断档规则是否改为"按缺失块数补零增量"以外的方案
- 品牌：域名 wuji.finance / wuji.market（截至 2026-09-18 可注册）
