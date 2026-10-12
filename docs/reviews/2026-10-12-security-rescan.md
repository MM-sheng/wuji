# WUJI 本地安全复查（2026-10-12）

> 后续状态：用户要求立即修复后，R1–R4 已完成本地源码修订和回归验证，见
> [修复验收](2026-10-12-security-fixes.md)。尚未部署。以下内容保留复查基线时的发现、行号和验证记录；
> “生产源码未修改”“尚未修复”均指原复查阶段，不能当作当前工作树状态。

复查基线：`codex/fix-mtp-window`，`2454eb24ee9f938f385cdf0214a56d3ccca7926e`。工作目录为 `/Users/m/Documents/Codex/2026-10-11/ya/work/wuji-mtp-fix`。本报告接续同日交接记录，复核四项已有复现；生产源码未修改。本轮只在本地测试，没有发送链上交易、部署、改动运行中的 keeper 或公开发布发现。

**结论：MTP 修复不等于永续池安全。** 最优先的问题仍是坏账与领取顺序造成的实际少付，且未完成入场的资金也会承担旧亏损。本轮另外确认两个此前查阅文档未覆盖的实现边界：keeper 使用缺少哈希的标记作为锚点，以及深重组封存证明长度不足。冻结定价对调用顺序的依赖则属于已写入 T13 的政策风险。这里的“新”仅相对于本次查阅的仓库文档及交接记录，不代表全球首次发现。

## 结果与优先级

P1 表示真实资金使用前应解决；P2 表示应修复或明确决定接受。优先级同时考虑影响与可恢复性，不是已证明的攻击概率。

| 编号 | 分类 | 结论 | 建议优先级与边界 |
|---|---|---|---|
| R1 | 已知设计风险，本轮补充具体影响 | 坏账可消耗尚未入场、应退款的本金；先领者改变后领者损失 | P1，直接资金影响；未证明可操控 Bitcoin 指数 |
| R2 | 新实现缺陷 | `marked=true`、`hashAt=0` 会让当前 keeper 反复失败 | P2，特定队列下的自动维护阻塞，可手动恢复 |
| R3 | 已知冻结政策风险 | 先标记历史价格或先冻结，得到不同结算金额 | P2，指数已经封存且存在待处理 epoch 时触发 |
| R4 | 新活性边界／设计假设缺口 | 有效深重组证明可能必须超过 800 个头，无法封存退出 | P1，极端条件下影响退出；未证明低成本触发 |

四项 Solidity 测试通过的含义是**不良行为被复现**，不是修复通过。当前四项均未修改生产实现。

## R1：旧坏账会侵入未入场资金，退款金额取决于领取顺序

位置：`contracts/src/WujiAccounts.sol:167–185`（准入）、`:392–452`（累计盈亏与坏账）、`:497–524`（领取）、`:554–561`（冻结退款）。

某一方跌穿本金下限时，另一方仍取得完整累计收益；亏损方的负数被截到零，缓冲金不足的部分记为 `badDebt`。`acceptingRequests` 和实际申请路径均未检查坏账。所有资金放在同一代币余额中；`claim` 将支付额截到该余额，并删除账户，不保留未支付差额的债权。`pendingPrincipal` 是会计计数，不是独立托管或退款准备金。

本轮使用 25% 档的 `K=4.6e18`、30 bps 费率、6 高度 epoch 等参数，构造 100:10 的不平衡头寸、长期指数变动及延迟处理/退休。坏账出现后 Carol 仍能存入 100 token；净本金 99.7 尚未入场，冻结时应退还。对同一状态做快照并改变领取顺序：

| 情景 | Carol 实收（18 位小数代币单位） |
|---|---:|
| Carol 先领退款 | 99.7 |
| 旧赢家先领，Carol 后领 | 90.7188540033 |
| 差额 | 8.9811459967 |

后领情况下 Carol 的账户已被删除，差额没有存续领取入口。这里只说净本金退款；原入场费并不退回。

**已知与新增证据的区分：** `docs/THREAT_MODEL.md:239–246` 已明确 floor overshoot、坏账及后退出者承担损失；T11 也讨论此风险。因此不把这一会计机制报成新漏洞。本轮新增的具体证据是：连未参加盈亏、应退回的待入场资金也会补贴旧亏损。

**限制：** 测试使用 mock 指数与代币，在会计层输入 `ΔS=9.2e18`，并推进约 200000 高度；未重放相应真实 Bitcoin 轨迹，也未证明这条精确离散指数路径可达、发生概率或攻击者可选价格。不能据此宣称存在即时无成本提款攻击。损失机制由实际池代码执行，mock 没有替换池的会计或领取逻辑。

**修复建议：**

1. 明确待入场资金与已退款但未领取资金的准备金，所有普通支付、赏金与 sweep 都不得侵入。冻结时不能仅减少 `pendingPrincipal` 就失去对未领退款的保护。
2. 先决定并证明全局偿付规则：如何限制输方损失与赢方收益，或在资不抵债时按确定规则分担。简单增加 buffer、加快 keeper 或仅在 `badDebt>0` 时拒绝新入场，均不足以覆盖尚未退休、尚未记账的负值。
3. 未足额支付时应明确保留剩余债权或按事先确定的损失规则核销，不能把“账户删除”当作“已足额付款”。仅保留债权也不会补足资金缺口。
4. 验收应包含：退款准备金不可被侵入；相同结算状态下领取顺序不改变最终应得分配；无 keeper、跨多 epoch、极度不平衡头寸、冻结与部分退款组合。当前 `balance + badDebt + unretired ≥ Σ values` 允许欠款，不等于现金足额偿付。

这些是候选设计建议，尚未替代 ARCHITECTURE 的产品决定。不得把配对金库 `YANG+YIN=NOTIONAL` 的偿付性质直接推广给永续账户池。

## R2：只有价格、没有哈希的标记阻塞 keeper

位置：`contracts/src/WujiAccounts.sol:296–308`、`:316–331`、`:356–385`；`indexer/accounts.mjs:122–149`。

无中继指数上，任何人调用 `mark(tip, tip)` 都可成功：循环长度为零，不需要访问不存在的 relay。它记录 `marked` 和 `sAt`，却不填 `hashAt`。指数继续推进后，这个高度已不是当前 tip；keeper 在第 142 行只检查 `marked`，仍把它用作更低 epoch 的 raw-header 锚点。`markWithHeaders` 要求非零哈希，因而回滚 `unknown base`。其第 317 行的提前返回也使已标记高度不能通过该入口补齐哈希。

真实 Bitcoin 头夹具验证了：两个待处理 epoch、中间产生上述标记、tip 继续推进、低 epoch 标记失败、尝试补齐高 epoch 无效、队列首项阻止两项处理。Node 复现调用真正的 `markFromHeaders`，连续两轮都选择缺失哈希的锚点并失败，未发送任何交易；Node 的 RPC 与模拟回滚是 mock，链上状态可达性由 Solidity 复现覆盖。

**影响边界：** 需要恰当的待处理队列与 tip 标记时机。它不伪造 S，也未证明永久锁死或直接盗取资金。手动从有效当前 tip 对低 epoch 进行标记后，测试恢复并处理两项请求。其他情况下是否跨池阻塞还取决于调用方的异常隔离，本报告不扩大这一结论。

**修复建议：** keeper 应区分“有价格”与“可作哈希锚点”。已知价格但缺少哈希的 epoch 可以跳过重新定价，却不能替换已有有效 anchor；跨越 `MAX_WALK` 的中间点也必须这样处理。需要补齐中间锚点时可使用可认证的相邻高度；对于旧合约，不能指望调用已提前返回的 `markWithHeaders` 自行修复。新版合约应在 tip 标记时记录 `lastHash`，并设计对已有价格的哈希补齐验证，确保不能改写价格。回归至少覆盖直接标记、桥接中间点及多轮重试恢复。

## R3：冻结结算依赖是否提前标记历史价格

位置：`contracts/src/WujiAccounts.sol:544–568`；`indexer/accounts.mjs:87–89`；已知政策 `docs/tasks/T13_ZK_REORG_EXIT.md:48`。

`freezePool` 只在尚未发生 fallback 且 epoch 已标记时使用历史 S；第一个未标记 epoch 及其后所有 epoch 改用冻结 tip 的 S。当前 keeper 看到指数冻结便直接调用 `freezePool`，不先恢复历史价格。对于只存头的指数，历史头仍可经 hash 链认证到最终封存的 tip；“未标记”并不等于“历史价格无法重算”。源码关于 relay 不再匹配的说明不能完整解释这个部署模式。

测试对同一真实头历史，仅 mock `frozen()` 返回 true，保留真实 S、哈希与头数据。100 token 头寸立即冻结得到 `100`；先认证并标记预定 epoch 再冻结得到 `99.624243478260869565`。两者不同说明调用顺序能改变经济结果，前者数值较高不代表该策略对所有账户有利。

**分类及限制：** T13 明文规定已标记用各自价格、其余用冻结 S，因此这是已知政策的条件性经济风险，不是声称实现违反该条规范。测试不包含真实深重组封存的完整端到端触发。任何人均可冻结，单纯调整 keeper 顺序不能保证别人不会抢先 fallback。

**修复建议：** 为无中继指数规定确定、可验证、且与调用顺序无关的冻结价格政策。可考虑对 `e≤frozenHeight` 的历史认证设为结算前提并支持分批补齐，对更晚入场退还本金；必须同时解决公开头数据可用性、长队列和交易 gas 上限，避免把顺序依赖换成永久等待。若保留 fallback，应在产品描述中明确其定价差异与抢先调用风险，并同步更新 ARCHITECTURE、T13、源码注释及 keeper。

## R4：单笔 800 头上限无法覆盖任意深重组退出

位置：`contracts/src/WujiHeaderIndex.sol:30–32`、`:195`、`:266–285`。原假设：`docs/tasks/T13_ZK_REORG_EXIT.md:80–82`。

封存证明必须从 `committedAt` 中已记录、且属于候选分支共同前缀的状态起步，一次提交全部头；没有保存中间替代分支状态的入口。固定难度下，若这个可用 base 距当前 finalized tip 为 `d` 个高度，满足工作量门槛所需头数至少为：

`n ≥ d + CONFIRMATIONS + REORG_MARGIN`。

在 `K=100`、margin=144 时，`d=557` 要求 `n≥801`，已经超过 800。距离应从**最后一个可用已记录共同前缀状态**计数，不只是 fork 点到 tip 的距离；检查点稀疏还会增加证明前缀。

复现先分三批生成旧链，finalized tip 到 base 的距离为 557；另一条 801 头分支经过相同验证规则分两批在独立实例上通过。向原实例提交其中 800 头因工作量不足而失败，801 头因超限失败；直接正常 fold 替代分支也因父哈希不同失败。base 之后记录的两个中间状态都位于被替代的旧链，不可作为新分支的起点。

**影响与限制：** 若实际发生跨越该范围的重组，诚实新链无法继续推进该指数，也无法走预定的封存路径；需要未来推进或冻结的池债权可能无法退出。此前已处理且可领取的债权不因此全部失效。测试使用仓库已有的低 PoW 难度 subclass，只降低目标难度以生成分叉，其他头规则及长度、承诺、工作量逻辑沿用生产代码；不证明能制造主网级分叉或其经济可行性。复现 gas 包含测试挖头、数组复制及多次部署，不能当作生产封存交易 gas。

T13 把所需旧链跨度假设为“最多一次 fold”，这一假设不能覆盖跨多次 fold 的重组。keeper 每次只推进 250 高度也不能限制自然重组深度。

**修复建议：** 设计无特权、分段验证的替代分支证明：初始状态绑定已记录承诺；每段保存或承诺完整连续状态、累计工作量及是否经过原 tip；最终按明确绑定的 finalized 状态和原规则比较门槛后封存。需处理正常链推进时的并发、多个候选分支、存储滥用、难度重定向、MTP 及每笔 gas 上限。单纯提高一个有限上限只能移动失效边界，不能提供一般恢复性。验收应覆盖 800/801 边界、跨多 fold、稀疏 base、变难度与分段/一次验证等价性。

## 验证记录

工具版本：Forge 1.8.4（`50af4efe189dc64bad2b75ed6990b835de66c4ae`）、Solc 0.8.28、Node v26.8.1、Slither 0.11.6。配置仍为仓库的 optimizer 200、Prague、非 via-IR；不变量仍为 64 runs、depth 60、`fail_on_revert=true`。

| 验证 | 本轮结果 |
|---|---|
| 默认完整 Foundry 套件（隔离构建，离线） | 32 套件，284 通过、0 失败、24 跳过，退出 0；包含 unit、fuzz、真实头夹具和状态不变量 |
| 四项定向 Solidity 复现 | 4 通过、0 失败、0 跳过，退出 0；确认问题仍存在 |
| Node 账户与 keeper 配套 | 9 通过、0 失败、0 跳过，退出 0；其中新增 1 项 |
| 生产构建与尺寸 | `forge build --sizes`（跳过 test/script）退出 0；本次关注的 5 个生产合约均低于 24576 字节 |
| Slither | 分析完成，86 条提示；详见下方人工分诊，不是零告警 |

完整 Foundry 计数包含 Review 派生合约重复运行的 8 项 header-index 父测试及 12 项 reorg 父测试。新增独立 Solidity 复现为 4 项，不是 24 项；24 个跳过项全部来自 `FullHistoryReplayTest` 的默认环境开关。没有放宽不变量或修改断言以取得通过。

运行时代码字节：`WujiHeaderIndex` 10188、`WujiAccounts` 19536、`WujiAccountsFactory` 23105、`RelayerRewards` 4660、`FeeRouter` 1115。factory 仅余 1471 字节空间，未来修复后需重新检查；尺寸通过不等于安全通过。

为避免沿用不完整 build-info，构建目录和编译缓存单独放在 `../wuji-rescan-static/`；未执行 `forge clean`，未删除 `contracts/cache/replay`。默认构建目录下首次完整测试启动后持续无输出，主动终止（143）并改用隔离目录、离线编译完成验证；不把这次中断算作测试通过或代码失败。

重现命令（从本 worktree 执行，命令不签名）：

```sh
cd /Users/m/Documents/Codex/2026-10-11/ya/work/wuji-mtp-fix/contracts
/Users/m/.foundry/bin/forge test --offline \
  --out ../../wuji-rescan-static/out --cache-path ../../wuji-rescan-static/cache
/Users/m/.foundry/bin/forge test --offline \
  --out ../../wuji-rescan-static/out --cache-path ../../wuji-rescan-static/cache \
  --match-path test/Review20261012.t.sol --match-test test_review -vv
cd ..
node --test indexer/accounts.test.mjs indexer/accounts.security-review.test.mjs
```

实际隔离目录的绝对路径是 `/Users/m/Documents/Codex/2026-10-11/ya/work/wuji-rescan-static`。完整测试中的历史回放默认跳过，本轮未重新跑 Bitcoin 全历史；之前 MTP 修复的 24 段回放、180 项 Node 和 7 项 Rust 结果仅是历史证据，不计入本轮。

### 静态扫描的处理

原扫描因缺失 build-info output 文件失败。本轮先以 `forge build --build-info --skip test --skip script --sizes` 在上述隔离目录生成新构建，再运行：

```sh
PATH=/Users/m/.foundry/bin:$PATH /Users/m/.local/bin/slither . --ignore-compile \
  --foundry-out-directory /Users/m/Documents/Codex/2026-10-11/ya/work/wuji-rescan-static/out \
  --include-paths 'src/(WujiHeaderIndex|WujiAccounts|WujiAccountsFactory|RelayerRewards|FeeRouter)\.sol' \
  --json /Users/m/Documents/Codex/2026-10-11/ya/work/wuji-rescan-slither-final.json
```

JSON 为 `success:true, error:null`，日志显示分析 40 个合约、102 个 detector，筛选后 86 条结果：High 3、Medium 16、Low 25、Informational 42。进程返回 255 且检测器有发现，**不称为“无告警通过”**。

- High 3 均把 checkpoint/retarget 的高度取模识别成 weak PRNG；它们是周期判断，不是从区块时间生成随机数，属于误报。
- Medium 16：3 条除法后乘法分别是 epoch 向上取整、年龄查表及定点盈亏分配；8 条相等判断是头规则/周期或普通 ERC-20 到账校验；5 条未初始化局部变量涉及默认零值、先填充的 MTP 数组及工作状态。人工检查未据此确认额外漏洞；盈亏舍入不消除 R1。
- Low 包含时间依赖、循环外部读调用及事件重入提示。`RelayerRewards.credit` 的生产实现只做内部账务，不调用外部代币；不能把该事件提示写成已证实的提款重入。循环与时间门槛仍有 gas/可用性约束。
- factory 的 treasury 零地址提示属于部署参数健壮性：下游 pool 构造函数另做参数检查；应保留部署绑定核验。其余命名、数字格式、未用常量及循环存储写提示没有作为新增安全结论。

这只是静态提示的语义分诊，不是证明所有路径安全，也不替代独立审计。

## 证据、交付与后续

新增复现文件：`contracts/test/Review20261012.t.sol`（4 个独立复现，另继承现有用例）；`indexer/accounts.security-review.test.mjs`（1 个 keeper 复现）。本轮没有实现生产补丁，也未提交、推送或发布报告。

本地证据均位于 `/Users/m/Documents/Codex/2026-10-11/ya/work/`：

- `wuji-rescan-reproductions-final.log`：四项定向复现及精确金额。
- `wuji-rescan-forge-final.log`：本轮完整默认 Foundry 套件。
- `wuji-rescan-node-final.log`：本轮 Node 配套测试。
- `wuji-rescan-static-build.log`：独立构建、尺寸和编译器 lint。
- `wuji-rescan-slither-final.json`、`wuji-rescan-slither-final.log`：扫描原始输出。
- `wuji-rescan-evidence-manifest.json`：源码、测试与交付物哈希，便于后续定位基线。

建议顺序：先决定 R1 的偿付与退款保护规则；实现 R2 的 keeper 恢复与合约标记修复；完成 R3 的确定性冻结政策和 R4 的分段证明设计，再做针对性回归和独立复核。所有改动保持无 owner、无管理员暂停、无升级权限；合约规则变化需另行更新 ARCHITECTURE。已部署不可变合约不会随本地改动得到修复。

本报告未刷新线上余额或 keeper 状态，不把之前新池为空的快照当作当前事实。它是授权的本地源码复查，不是独立第三方审计，也不作“没有其他漏洞”的保证。
