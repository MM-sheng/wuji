# WUJI · Sepolia 修正版部署 · 2026-10-12

已部署修复 MTP 时间窗口的版本。网络为 **Sepolia（11155111）**，合约源码提交 `9baee1e`。
原始 Bitcoin 起点 969545、GENESIS_HEIGHT=969546、初始 U=0、确认深度 100、checkpoint 间隔 4320、重组余量 144 均保持不变。

## 地址

| 合约 | Sepolia 地址 |
| --- | --- |
| WujiHeaderIndex | `0xf44F0FE640436d188fE1292a65D75CC1697C1a51` |
| RelayerRewards | `0xc1dCDEAA991cA1c6e96b5acd6eedE78cA2ac432e` |
| FeeRouter | `0x6f3f95A6f201901F9a233cf59e7B5310645685D1` |
| WujiAccountsFactory | `0xDD0093d0f9BaD478Ce90DfA0C5be13f39A5Ae6eF` |
| 5% 模型波动率池 | `0xa275fc68586febd29cab8a57e65dad445eb184b8` |
| 10% 模型波动率池 | `0xd1aeb70dc36a5f206b3494be3613cacae0795940` |
| 25% 模型波动率池 | `0x22dcc0745db4fa54d0461ab8dfe3e090fb452de9` |

5%/10%/25% 是模型年化波动率档位，不是收益承诺。抵押品继续使用 Sepolia WETH `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`。

## 核验

- 观察 EVM 区块 **11898557**，区块哈希 `0x764999aa8d6b99cef5bb2941798ddc8d32d9cc38a6ec50c00ab93f18b6340ab2`；读完复查哈希一致。
- 全部 **7 个合约**运行时代码与本地构建一致，包含 compiler metadata，仅屏蔽编译器声明的 immutable 槽位；参数和绑定另行逐项检查。
- 6 笔真实折叠交易，共计 **1,440 个高度**，最终 lastHeight=**970985**、seenHeight=**971085**。
- 从原始 anchor 独立逐头重算，S、U、hash、height、bits、time、epochStart、累计工作量及按区块先后排列的 11 个时间戳完全一致。
- U=8093，S_wad=**97116000000000000**。高度 971085 的 Bitcoin hash 已与 mempool.space 和 Blockstream 交叉核对。
- 三个池均绑定新 index / FeeRouter，RELAY_TIP=false，INDEX_CAN_FREEZE=true，acceptingRequests=true，nextId=1，WETH 余额为 0。
- 修复前完成的 260 项 Solidity 测试、24 段完整历史回放、180 项 Node 测试和 7 项 Rust 测试沿用；此次合约源码没有再修改。

这是代码和状态一致性核验，不是第三方安全审计；新池未执行真实入场/退出往返测试。

## 部署过程及 gas

第一笔 RelayerRewards 部署 `0xbf360c4b08bae7cf247182dbf31e6507f5bf98822587eede686eecb77cc054a4` 回滚，gas 用尽，未生成合约。
本地 Prague 模拟给出的 1,444,446 gas 不足，当前节点对此构造交易估算约 7,702,134 gas。
后续部署逐笔使用实时 eth_estimateGas 加 20% 余量，签名仍经 Foundry 加密 keystore。
新 index 实际消耗 16,698,701 gas，factory 35,917,061 gas，每个池约 30,462,128 gas。
这些是当前 Sepolia 的总 gas 实测，旧的本地模拟数值不能直接作为发布交易限额。
当前状态创建与执行 gas 的区分参见 [EIP-8037](https://eips.ethereum.org/EIPS/eip-8037)；具体采用规则须以目标链核验为准。

部署、追块、keeper 注资交易及失败交易的 gas 合计 **0.0210813865 Sepolia 测试 ETH**。
另外转入独立 keeper 的 **0.02 Sepolia 测试 ETH** 是运行资金，不是额外 gas 消耗；其中一部分已用于追块。
公共 RPC 曾短暂返回上一块状态或 block not found；最终核验固定到已有数个确认的同一 EVM 区块，避免混合快照。

## Keeper 与客户端

- 新 keeper 地址：`0xD0310442d42d791219aaDAa413Cb34f2Da660DFa`，独立加密账户，与旧 keeper 分离。
- 本机 launchd 服务：`com.wuji.sepolia-header-v2-keeper`；每 120 秒检查，积累 36 个可计入高度再提交，每笔最多 250 个计入高度；失败退出由 launchd 重启。
- 保存每批 continuity 状态供将来重组封存使用。生产 keeper 已完成一次读取和三个池的维护检查；该轮等待条件为 100 个未计入确认区块。
- runtime、P2P 缓存、状态和日志位于本机 `operator/sepolia-header-v2/`（gitignored）；不是临时工作目录。密钥只在 Foundry 加密 keystore 中，口令文件权限 0600。
- 这是本机用户会话后台服务，依赖电脑运行、联网及测试币余额；不是云端高可用部署。
- 当前修复分支的 terminal 指数直读入口已指向新 index。现有公开网页/IPFS 版本未重新发布；本次没有把新池接入旧版交易入口。

## 旧部署与边界

旧 index `0x2d61Dd88F9c0F8069fFd3DaaeD76B4aE404AB9f7` 仍不可升级，旧运行时代码仍有该缺陷。
旧 keeper 保留，旧池和旧账户的抵押品未转移、未退出、未重新入场。新建空池不会自动继承旧账户。
保留原始指数起点只保证同高指数可重算一致，不等于债权或资金已迁移。
独立审阅、池子的 badDebt / 退出顺序设计及主网发布门槛仍未完成。

证据：`contracts/deployments/sepolia-header-v2.json` 包含地址、交易、资金及运营记录；
`contracts/deployments/sepolia-header-v2-verification.json` 包含字节码、绑定和逐头重算结果。
