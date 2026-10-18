# Sepolia v3 安全修复部署（2026-10-12）

**部署、运行时代码及追块验收已通过；真实资金往返进行中。** 合约源码为 `03f6256`，
采用同日 R1–R4 修复。未部署主网，未升级或迁移任何旧合约及其资金。

| 合约 | Sepolia 地址 |
|---|---|
| WujiHeaderIndex | `0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a` |
| RelayerRewards | `0xe6933fB941861b6Ef3888Eb11e2Dfb476B3aAB35` |
| FeeRouter | `0xcc32633A49eDf61400cBc48a0eE082a8866946b4` |
| WujiAccountsFactory | `0xF2C7BAa3Cdd8a69c2ED2576478140d13c29c48a9` |
| WETH 5% 模型波动率池 | `0xbfdcebf9dd77ddfd12e9be020564ab4e16d4ae68` |
| WETH 10% 模型波动率池 | `0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14` |
| WETH 25% 模型波动率池 | `0xcd159a006aeb31535ead9514a9ea335466c9c137` |

完整交易、代码分片地址及参数见 [部署清单](../../contracts/deployments/sepolia-header-v3.json)；
固定 EVM 观察块的验证结果见 [verification](../../contracts/deployments/sepolia-header-v3-verification.json)。

## 已完成

- 沿用原 Bitcoin anchor 969545、genesis 969546、K=100、重组 margin=144、checkpoint=4320。
  新指数额外支持 256 头一段的封存证明，工作量门槛没有降低。
- 七个业务合约 runtime 与源码编译输出相同，包含 compiler metadata，只屏蔽编译器声明的 immutable
  槽位；这些槽位的公开绑定和参数另行核对。工厂两个数据合约的完整字节分别等于 STOP 加固定
  creation code 分片，因此一共检查 9 个链上合约。
- 验证块 **11899653**：六笔 fold 从原起点计入 **1,461** 高度，到 **971006**，最新验证头为
  **971106**。完整 continuity（含按时间先后保存的 11 个时间戳、U、工作量和重定向状态）逐头重算
  一致；S=`110700000000000000` wad。971106 的哈希还与 mempool.space 和 blockstream.info 分别一致。
- 当时三个池均为空、接受新申请，所有资产/index/treasury/K/fee/epoch/批量上限及零准备金检查通过。
  后来的测试存款不改变这个历史快照的含义。
- 独立 keeper `0x27b2474c8CA832d25C301eA43cF90C57C5a2dcD2` 已启动，服务
  `com.wuji.sepolia-header-v3-keeper`。runtime 采用修复版并追加目标链 gas 估算，准确版本与哈希见清单；
  每 120 秒检查，minFold=36、maxFold=250。
  首轮 P2P 已更新到 971108；少量未响应 peer 之后成功取得头，正常等待足够可折叠高度。
- 新 keeper 在提交前保存按哈希寻址的原始头；初次追块已保存 **1,561** 个头及可封存 continuity。
  状态/缓存/日志独立位于 `/Users/m/Projects/wuji/operator/sepolia-header-v3`。
- 本地 terminal 的指数直读切换到 v3；对应 UI/钱包及冻结读取测试 **37 通过**。公开网页/IPFS 未重新发布。

部署前的源码验收见 [修复报告](2026-10-12-security-fixes.md)：325 Solidity、154 Node/terminal 通过，
另有 24 和 1 个需全历史数据的跳过项。本次没有把历史回放、内部复核或测试网交易当成第三方审计。

## 真实往返的当前状态

使用专用测试钱包 `0x1405D3d3f81F507be2315BF4708Fc9444BBbca3f`，在 10% 池创建阳/阴各一个账户，
每个存入 **0.00001 测试 WETH**，总计 **0.00002**。代币授权仅为这两笔存款所需的精确数额。

- 阳账户 #1：`0x6281d7decd35d92039e7d23ea82217b4815ed7a1621d3bde0e2e2c7d82181044`
- 阴账户 #2：`0x5cd25d42eaaa2ee3b167b859eaaaf7a162f329422eb4040a7f02647616c4aa36`
- 二者入场净本金各 `9970000000000` wei，入场定价 epoch 都是 **971160**；目前等待入场定价。
  至少要看到 Bitcoin 971260 才满足 100 确认，keeper 批量阈值还可能增加等待高度。
- 有限验收流程在条件满足后申请退出，等待退出定价，再领取并比对实际收款与 `claimableOf`，最后解包
  测试 WETH。脚本只操作上述专用钱包和两笔固定金额账户；确切签名交易在广播前记录，重启不能改 nonce
  重复存款。读取记录前获取进程独占锁；下一依赖操作等待 Sepolia finalized，并核验旧回执所在块仍属规范链。
  领取以匹配账户 ID/收款地址的 Claimed 和 WETH Transfer 事件为证据，额外转入的钱单独记录，不能阻塞
  正常领取的恢复。4 项恢复辅助测试通过，实际重新启动读取也未重复交易。
  后台服务 `com.wuji.sepolia-header-v3-lifecycle` 完成后退出；状态不能提前写成“完整往返通过”。

完整往返取决于未来 Bitcoin 出块，可能跨越数日。机器需保持运行且联网；数据缺失、余额不足、交易
失败或本机服务停止时不会凭空完成。尚未在公开链上制造真实深重组；这一场景的依据仍是本地回归和
真实历史头夹具测试。

## Gas 与操作记录

全部部署、六次初始 fold 和两笔专用钱包注资的 gas 支出合计 **0.0226676291 测试 ETH**。
另有 **0.02** 测试 ETH 转入 keeper、**0.005** 转入测试钱包，属于用户控制账户间的资金，不是 gas 消耗。
初始包裹、精确授权及两笔入场共耗 gas **0.0002024376 测试 ETH**；后续交易支出尚未发生。

所有部署使用目标链 `eth_estimateGas` 并留余量。工厂实际总 gas **43,512,115**，每个池约
**36,763,560**；不能将本地执行 gas 与此处总 gas 混用。没有失败的已上链交易。一次 RPC
`block not found` 发生在部署成功后的代码读取阶段，保留回执并仅重试读取，未重复部署。

v3 keeper 启用 `KEEPER_ESTIMATE_GAS=1`：每次发送前按实际 signer/target/calldata/value 估算，
增加 25% 余量，保留原执行预算下限，上限设为 50M 且不得超过当前块 gas limit。估算失败或超限
会停止该次发送，不退回偏小的固定值；其他运行实例不启用时行为不变。4 项新增 gas 测试、全部
indexer/terminal **158 通过、1 跳过**，并对当前 Sepolia 做了只读估算检查。尚未用 64 个真实账户
完成链上大批结算；不把本地 64 账户测试当作目标链 gas 实测。

签名均通过加密 keystore；本报告、清单和证据不含私钥或密码。旧 v2 及更早的合约仍保留原行为，
不能把 v3 的验证结果套用到旧地址。原 main 分支、旧资金和旧 keeper 均未修改。
