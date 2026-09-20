# WUJI · 架构与决定

> 无极生太极，太极生两仪。

WUJI 提供一条可由公开比特币区块头重算的路径。两仪金库是使用这条路径的示例应用。
不把随机性等同于无条件独立性或保证收益；数学边界见 WUJI_FOUNDATIONS.md。
任务规范见 [BTC_SOURCE.md](tasks/BTC_SOURCE.md)。

## 0. 原则

- 无 owner、管理员、暂停、升级、治理或项目代币。部署参数 immutable。
- 配对价值相加恒等于 NOTIONAL，固定基数分配，不凭空创造抵押品。
- 任何人可提交区块头、折叠指数或调用结算；索引器只是缓存。
- MIT；链下 Node/终端零第三方运行依赖；签名使用加密 keystore。

## 1. 指数

对比特币主链每个高度 h ≥ GENESIS_HEIGHT，在中继主链至少领先该高度 6 块后：

```
H = SHA256(SHA256(serialized 80-byte Bitcoin header))
R = SHA256(H)
delta = byteSum(R) - 4080
U += delta
S_wad = U * 12000000000000
price = 100 * exp(S_wad / 1e18)
```

H 是哈希函数的原始 32 字节输出；浏览器显示的比特币哈希将 H 反转。
R 对原始 H 哈希，不对显示字符串或其 ASCII 字节哈希。二次混合避免直接累加 PoW 哈希的零位偏差。
每块等效波动约 0.50%，以平均 144 块/天估算日波动约 6%；这不是固定日波动承诺。
检查点高度为 GENESIS_HEIGHT + k×4320 − 1。中继延迟只影响可用时间，不改变增量。

## 2. 两仪与检查点

- 1 对 = 1 YANG + 1 YIN；铸造抵押为 NOTIONAL，费率仍为 5 bps。
- `yangShare = clamp(1/2 + (S-S0)/2, 0, 1)`，YIN 取补数。固定基数，不复利放大。
- 期次使用 Bitcoin `startHeight` / `settlementHeight`。
- 当 `index.lastHeight >= settlementHeight`，本期停止 mint。
- settle 读取预定高度的 checkpoint，不能任选更晚的 S。下一期边界固定递增。
- 配对随时可赎，已结算代币可单边赎；费率、向 treasury 路由、舍入方向均保留。
- 只有普通、非 rebasing、非转账扣费 ERC-20 受支持；mint 校验实际到账。

## 2b. 多抵押品

WujiVaultFactory 无许可创建 `(asset, notional)` 唯一金库。所有金库读同一 WujiIndex。
SeriesTokenDeployer 保留；代币名称带抵押品。不同抵押品分散流动性，工厂不构成资产审核。

## 3. 应用边界

滚动金库、交易路由、持仓策略属于应用，尚未实现。现有有界期次金库不保证等待到盈利，
也不等同于永久现货。不得用配对偿付测试代替资产收益证明。

## 4. 合约

### BitcoinRelay

- 锚定可信主网 checkpoint header / height / epochStartTime / chainWork。
- 校验 80 字节、父链接、双 SHA256 PoW、nBits 解码有效性、非重定向高度难度相同。
- 每 2016 高度按父节点所在分支的 epoch 起止时间重算，时间跨度限制到 1/4–4 倍，编码回紧凑 nBits 后严格比较。
- 分叉由累计工作量选择，同工作量保留先到分支，较短但工作更多的分支也可成为主链。
- 存储哈希、父哈希、累计工作量和验证所需字段，不存完整 80 字节头。事件可用于追踪。
- `submit` 与 `fold` 分离，中继可被其他应用使用；fold 失败不阻止正确中继继续推进。
- 省略 MTP/未来时间限制，不验证交易和区块体；这是有明确信任边界的 SPV，不是完整节点。
- 测试网部署的累计工作量从 checkpoint 自身工作量起算；共同的历史前缀偏移不影响任意两条分支比较。

### WujiIndex

- 从 relay 读取六深主链哈希，按高度折叠。默认每次 256，高度不会跳过。
- 保存 lastHeight 和该高度的 lastHash。fold 开始时核对主链哈希，包括 max=0 或无积压时。
- 已折叠高度发生变化时明确回滚 `deep Bitcoin reorg`；不自动撤销此前交易和结算。
- 构造金库最多折叠 256，高于此积压要求先独立 fold；mint/redeem 不做隐式积压处理。

## 5. 索引/API 与 keeper

- `SOURCE=bitcoin`，默认公共 Esplora 接口 mempool.space 和 blockstream.info。
- `BITCOIN_API` 可配置本地 Esplora；`BITCOIN_API_KIND=bitcoind-rest` 配合本地 Core REST 根 URL。
- `GENESIS_HEIGHT` 必填，数据文件为 `bitcoin-<genesis>.json`，与旧缓存分离。
- 核对 header 的显示哈希、父链接和六个后继头后发布。已发布历史变化时停止，不继续重写路径。
- 秒级价格按确认头时间发布；时间取该头及六后继时间的最大值，再与上一条发布时间取最大，避免比特币时间戳倒退导致时间索引错序。这是确定的展示约定，不是精确现实确认时间。
- `/head`、`/seconds`、`/blocks`、`/blockAt`、`/proof/:height` 保留。proof 返回原始头、H、R、delta、U、S_wad、来源链接。
- 新高度到达后终端刷新秒级缓存；块间保持平价，平均约十分钟不是倒计时承诺。
- keeper 比较来源与 relay 主链，寻找共同祖先，最多提交 24 个连续头，然后 fold，再 settle。
- 旧 SOURCE 默认 BSC 对照模式保留在 bsc-index.mjs / bsc-keeper.mjs，独立运行目录不会被新版本改动覆盖。

## 6. 验证与限制

- 夹具：798336–800363，共 2028 头；checkpoint 798335。跨越 800352 重定向，包含 800000 字节序已知向量。
- Solidity 与 Node 检查每一个 R 和累积 S；真实 relay 拒绝错误 PoW、难度和链接。
- 资金不变量保留原五项、64×60 调用深度与 fail_on_revert=true。资金状态测试使用显式标记的测试头 feeder，生产 PoW 另由真实夹具验证；不得把 feeder 当真实 PoW。
- 分叉测试使用测试专属低难度 subclass 来构造分支；生产部署没有低难度开关。
- 本次实测批量中继约 103034 gas/头，高于 60000 目标；未以削弱校验换取 gas 达标。详细测量见 BTC_SOURCE_REPORT.md。

## 决定记录

- 2026-09-20：source = Bitcoin PoW。旧 BSC 测试环境保留作对照，新合约独立部署。
- 2026-09-20：submit/fold 分离；存储最小验证字段；选择 798336–800363 作为真实夹具。

## 后续

独立审计、降低中继存储成本、深度重组恢复策略的应用设计、完整长期测试网观察。

## 7. 协议中继奖励（T1）

FeeRouter 是新金库的 immutable treasury。`route(token)` 将余额的一半发送到 RelayerRewards，
另一半发送到 `0x000000000000000000000000000000000000dEaD`；奇数最小单位留在 router，
下一次费用到达后继续分配。这里的“销毁”是发送到不可用地址，不保证 ERC-20 totalSupply 减少。
费率仍为 5 bps，配对与偿付规则不变。

RelayerRewards 只允许 immutable relay/index 增加积分。每个成功折叠的高度：原始区块头提交者 1 分，
fold 的直接调用者 1 分。为避免短暂领先的孤块领取奖励，中继在 submit 记录归属，在六确认后由 index
调用 relay.rewardFinalized 确认积分。这个时点相对 NEXT.md 中的 submit 即时积分有意延后；不会奖励
折叠前已被淘汰的分叉。深重组仍使 fold 回滚，已经支付的历史奖励不能追回。

积分是累积的、不可转移、无衰减；不是项目代币。费用在 sync 时按当时积分分配，早期工作会持续分享
未来费用。这是 T1 的 lifetime-points 模型，不能宣称它保证覆盖每个新中继者的 gas 成本。
无积分时收到的奖励留待有积分后 sync；直接转账与 sync 间隔期间增加的积分可以分享该笔未分配奖励。

每种 ERC-20 保留 accPerPoint 与按全局积分序号记录的累计值；每位工作者保留自己的积分批次。
credit 不调用代币，也不遍历币种或用户；claim 通过二分查找扣除该批积分出现前的累计奖励，默认处理
128 个新积分批次、最多 256 个，可以重复调用补齐。领取后的积分合并为 activePoints，之后只结算增量。
整数分配残差留在奖励池，个人小数残差跨次领取保留，不把残差重复分配。
任意异常代币只能影响自身 sync/claim，无法令 credit 遍历该代币而阻塞协议。支持范围仍仅限普通 ERC-20。

部署顺序 rewards → relay → index → router；根据部署者 CREATE nonce 预先计算 relay/index 地址，
部署脚本断言实际地址一致，没有 setter 或临时管理员。基础金融测试仍使用显式零奖励模式，新增完整
连接测试覆盖生产奖励路径；原五个金库不变量断言不变。运行 keeper 时折叠批量为 16。

## 8. 中继存储压缩（T2）

父哈希按 PoW 数值序存储 224 位，并与 32 位节点 ID 合用一槽。主网 PoW 上限保证其高 32 位为零；
编码显式检查这个条件，解码恢复完整哈希。main[height] 仍保存完整原始哈希。
每个节点的 height/time/epochId/workerId 合计 128 位，相邻两个节点共享一槽，插入不覆盖另一半。

同一难度周期内每块工作量相同，累计工作量从分支自己的周期起点精确推导：
baseWork + (height − baseHeight) × blockWork。检查点可能在周期中间，此时它作为工作量起点，
但 retarget 使用真实周期起始时间；分叉到新的重定向点就建立独立周期记录。没有浮点或近似工作量。
原提交者地址按 ID 共享，submitter(hash) 仍是常数时间查询；六确认后归属、费率和积分分配不变。

高度/工作量和新增的节点、周期、工作者 ID 都有显式上限，越界回滚，不截断或复用记录。
测试网奖励版常规 24 块批量约 68069 gas/头，新工作者批量约 69919；首次跨重定向初始化批量
约 71748，因此 7 万是常规批量的验收值，不是所有交易的绝对上限。
完整对照、折叠成本及部署证据见 [T2_REPORT.md](tasks/T2_REPORT.md)。
