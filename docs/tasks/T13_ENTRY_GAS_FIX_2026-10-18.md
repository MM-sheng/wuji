# MetaMask 进场 gas 修复 · 2026-10-18

## 根因与证据

失败交易 0x3195b840a9c1f7cba06e6037de3947ad2e4ad4b2d09495ab502c6bae875b8209
为 EIP-7702 type 4，经 DelegationManager 包装调用 requestEnter。
完整本地重放（先执行同块前序交易）在 WETH transferFrom 成功后、池内写状态期间 OutOfGas，
层层回滚。重放 gasUsed=1233602，与真实回执完全一致；不能用“gasUsed 小于总 gasLimit”排除内层耗尽，
因为调用转发和回滚后的记账/退款会影响外层用量。

原上限 1659180；在相同前一区块分叉、相同时间戳、原授权及其余交易字段下：

| gasLimit | 状态 | gasUsed | EnterRequested |
|---:|---|---:|---|
| 1659180 | 回滚 | 1233602 | 无 |
| 2737148 | 成功 | 1451596 | 本地账户 3，正确 owner、阳方向 |

对照只改变 gasLimit，没有修改池子或代币、余额与授权。分叉成功不计作公共 Sepolia 建仓成功。
原始证据：[完整重放](../../contracts/deployments/t13-metamask-entry-replay-2026-10-18.txt)、
[快速重放](../../contracts/deployments/t13-metamask-entry-quick-replay-2026-10-18.txt)、
[本地分叉对照收据](../../contracts/deployments/t13-metamask-gas-replay-2026-10-18.json)。
包装地址的公开验证源码来自 Sourcify v2，exact_match；没有引入其源码作为项目依赖。

## 修复

网页在模拟成功后取得直接调用的 eth_estimateGas，并识别当前账户的 EIP-7702 delegation indicator。
普通账户预留 25%；delegated 账户使用 estimate*2+500000，为包装的授权和 hooks 留余量。
本例直接估值 1118574，得到 2737148。预算超过 5000000 gas 或估值异常则停止。
提交显式 gas 前再次核对链、provider 选中账户、应用账户与池子。
不改 gas 单价、钱包设置或 delegation；实际费用仍由用户在钱包确认，未用 gas 不收费。
此余量是本例验证过的预算，不保证任意钱包包装都足够；真实交易必须再核对上限与回执。

56 项前端回归通过，包含 delegated 预算和过高估值阻止发送；三池实时发布核验通过。
HTML 已同步至 localhost:8796。没有改合约或重新部署。

## 真实复验交接

由于上次失败消耗 gas，原余额 0.0029576749782152 ETH。
再补 0.003 Sepolia ETH，确认余额 0.0059576749782152 ETH；本轮累计 gas 补给 0.008 ETH。
[本次补给交易与收据](../../contracts/deployments/t13-metamask-retry-fuel-2026-10-18.json)；无主网资金。
网页已重新连接同一 0x6657…0B95 / Sepolia，10% 池，阳，0.00001 WETH，复用已有精确授权。
仅发起一次进场，等待用户在钱包签名。公共链成功与否及实际 gasLimit 待补，暂不标记真人验收 PASS。

## 本地复现

启动仅监听 127.0.0.1:18547 的 Anvil，chainId 11155111，forkBlock 11938380，accounts 0，
使用 --no-bal --no-fork-node-info --fork-state-by-number；随后运行
scripts/replay-metamask-entry-gas.mjs。脚本固定 loopback RPC、检查初始高度，仅本地 impersonation；
没有私钥，也不向公共 RPC 广播。

![真实复验签名等待](../../contracts/deployments/t13-gas-fix-wait-2026-10-18.jpg)

## 真实复验结果（后续确认）

用户签名后，真实交易
`0x51de27248e423130f3ca9d4bdd6502c6b8d5188f8639c8a57b5e70eaa84e5a33`
在 Sepolia 块 `0xb62adc` 成功（status 1，块哈希已核对）。

- owner：0x6657289562f870677325124f3acbdebb0ea80b95；10% 池；阳；账户 3。
- WETH Transfer 入池：10000000000000 wei（0.00001）。
- EnterRequested 本金：9970000000000 wei（0.00000997），0.3% 费用 30000000000 wei。
- 进场定价高度：972012；账户状态 entering，尚未定价。WETH 剩余 0.00001。
- latest/pending nonce 均 4，无额外待发交易；没有重复进场。
- 交易为 type 2，仍由 DelegationManager 包装；账户已在上次 type 4 后具备 delegation。
- 实际 gasLimit **1659992**，gasUsed **1408578**。钱包重建包装并重新计算 gas，
  没有原样采用网页请求的 2737148 预算。不能把真实成功完全归因于预算被钱包采纳，
  也不能据此宣布首次 type 4 授权路径已经普遍修复。

结论：原始失败的内层 OutOfGas 已复现；增加预算在同笔原交易的本地对照中成功；
当前已 delegated 账户的真实网页进场成功。首次升级账户的包装 gas 兼容性仍有边界，需在独立测试账户
进一步验收；不撤销当前用户 delegation 来强行复现，不重复消耗当前账户资金。
真实收据、事件、同块账户状态与余额见
[成功原始证据](../../contracts/deployments/t13-metamask-entry-success-2026-10-18.json)。
后续等待 972012、K=100 和链上处理，按协议完成退出/领取；完整往返仍 OPEN。

![真实成功账户状态](../../contracts/deployments/t13-metamask-entry-success-2026-10-18.jpg)
