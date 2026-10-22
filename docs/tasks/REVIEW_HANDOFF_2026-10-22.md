# 当前 header-v3 审阅入口 · 2026-10-22

这是当前测试网实现的审阅材料，不是独立审计结论或主网放行。
旧 `REVIEW_HANDOFF.md` 的地址、行数、测试数及 T12/v4 讨论属于历史范围。

## 固定对象和版本

| 对象 | 当前标识 |
|---|---|
| 本轮核验的源码基线 | `023e3c77881ee71e19611f25008daffaf0ca3610`（随后仅本轮文档/证据更新）；不是审计发布标签 |
| 合约部署来源 | `03f6256c2821e5a67a8b98739ee9b199a32da27a`；当前 `contracts/src/` 全目录无差异 |
| 链 | Ethereum Sepolia，11155111 |
| 指数 | `0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a` |
| 奖励储备 | `0xe6933fB941861b6Ef3888Eb11e2Dfb476B3aAB35` |
| 费用路由 | `0xcc32633A49eDf61400cBc48a0eE082a8866946b4` |
| 永续池工厂 | `0xF2C7BAa3Cdd8a69c2ED2576478140d13c29c48a9` |
| 10% WETH 池 | `0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14` |
| keeper 代码 | `662e35e5f07730f64caf3c553a29e00c1ef45a09`，25 模块；本地 `runtime-rpc-2026-10-22-r2` |
| indexer 原快照 | `193269d3ce4eadcecc8519303d104d377c73df3b`；终端 HTML 从当前源码同步 |

三个池、两段 creation-code 数据、构造与不可变绑定见
[v3 清单](../../contracts/deployments/sepolia-header-v3.json)。
首尾字节序、参数、代码与状态须自行核对，不能只信本表或图标。
旧 `0x2d61…`、v2、v4 与 ZK index 都不是本次部署对象；旧地址不会被源码更改升级。

## 推荐审阅顺序

1. `WujiHeaderIndex`：原始/显示哈希字节序、SHA256 输入、PoW/compact target、难度重定向、
   MTP 窗口复制、未来时间边界、工作量选择、K=100、按高度折叠、检查点。
2. 重组封存：fork base、同链排除、工作量门槛，跨 fold 的深重组，分段承诺、继续条件与 gas；
   不得把分段执行长度当成允许重组的最大深度。
3. `WujiAccounts`：未来入场/退出高度、公开信息窗口、费用取整；真实现金覆盖与
   pendingPrincipal/refundReserve/reservedClaims 隔离；分批结算期间的锁定状态。
4. 自动资不抵债分配、已保留退出款、未入场退款与冻结历史价格认证；核对领取顺序不影响固定分配。
5. `WujiAccountsFactory`、两段 STOP 数据、RelayerRewards/FeeRouter：不可变绑定、无 owner/升级路径、
   一次性赏金、资金留存和代币假设；区分无权限与经济上持续可执行。
6. 链下：头档恢复、同高度对账、RPC 失败分类与逐池恢复、模糊发送结果/重启语义，
   终端签名前的代码/参数/网络/账户检查，以及可选字段的错误传播。

先阅读 [架构](../ARCHITECTURE.md)、[MTP 修复](../reviews/2026-10-12-mtp-window.md)、
[偿付与重组修复](../reviews/2026-10-12-security-fixes.md)、[v3 部署](../reviews/2026-10-12-sepolia-header-v3.md)。
不得削弱既有不变量、fail_on_revert 或测试强度来使结果通过。

## 证据与复现入口

- [新鲜构建与源码整合](T13_RELEASE_INTEGRATION_2026-10-18.md)：包含 metadata 的构建比较，
  `contracts/remappings-header-v3.json` 为历史部署复现设置；仅 immutable 槽按编译器声明处理。
- [本轮代码/运行基线](../../contracts/deployments/t13-readiness-baseline-2026-10-22.json)：
  9 个链上对象完整指纹与上述构建记录一致；这次没有重新编译。
- [历史回放](T13_HISTORY_PREEXIT_2026-10-18.md)：24 段开启后实际通过；默认 forge 跳过这些项目，
  不能把默认跳过写成通过。来源运营者独立性需另证。
- [真人完整往返](T13_WALLET_ROUNDTRIP_2026-10-22.md)：两个真实 MetaMask 仓位的签名、
  规范链收据、WETH Transfer、手续费及账户关闭。不是所有 UI 分支的验收。
- [RPC 修复](T13_RPC_FIX_2026-10-22.md)：53 项相关 Node 回归、5 项 watchdog、
  325 项合约通过/24 项默认跳过；不可据此声称全部脚本测试或全部金融场景均通过。

可公开只读运行 `node scripts/verify-header-index.mjs`（需要原始头档）和
`node scripts/verify-perp-release.mjs`；没有签名步骤。构建复现按整合报告在隔离目录进行，
避免旧工具的固定输出路径覆盖历史证据。运行 operator 的私有目录不是独立审阅的必要授权，
不向审阅人提供原作者密钥或密码；另一运营者自行生成独立账户。

## 未完成与报告要求

[当前缺口清单](READINESS_2026-10-22.md) 是下一步入口：长期运行、当前 v3 全范围双来源复核、
成本/告警、真实拒签与首次 type-4 路径、独立参与者接手仍 OPEN。
主网原生 ETH / CREATE2 未实现；任何后续目标实现都要追加范围与复审，当前报告不能提前覆盖。

审阅结论需记录准确提交、对象/链/地址、发现级别、可复现触发条件、资金与活性影响、
建议修复及复审证据。内部核验和 AI 自查与外部人员实际签字的审阅结果分别记录。
尚未选定外部审阅人或预算；本轮没有对外发送消息、付费或发起部署。
