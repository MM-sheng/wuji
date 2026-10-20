# 真人钱包退出进度 · 2026-10-20

北京时间 18:52 的同块读链和调用模拟通过。10% 池
`0x8cdf42009548483f25fe4bcd6ac00bbb88e2bf14`，Sepolia 11155111，
持有人 `0x6657289562f870677325124f3acbdebb0ea80b95`。

阳 #3、阴 #4 已在 Bitcoin 972012 完成进场定价，当前均为 `open`，
每笔净本金 0.00000997 WETH。两笔 requestExit 模拟均成功；claim 模拟均因
`not claimable` 拒绝。exitEpoch 尚未设置，claimable=0。当前指数高度 972185，确认深度 100。

本次没有发出退出交易。Chrome 控制连接中断，重新发现扩展后访问页面仍超时；
没有操作钱包扩展，也没有将点击尝试当成已提交交易。已请用户在自己的 Chrome 中选择
永续账户 / 10% 池 / #3，手动申请退出并确认 MetaMask。先核对 #3 的成功收据、
事件与 exiting 状态，再处理 #4，避免重复申请或并发 nonce 冲突。

两笔申请成功后仍需未来 Bitcoin 高度定价、100 确认及链上处理，随后分别领取，
核对退出费、WETH 实际到账、领取事件与关闭状态。完整真人钱包往返仍未通过。

[固定块账户与模拟原始记录](../../contracts/deployments/t13-wallet-preexit-2026-10-20.json)。
准备金下界检查不构成所有存续债权的偿付证明。没有改合约、keeper 冻结运行文件或后台服务。

## 19:04 重试更新

用户要求再次尝试。Chrome 恢复后可以操作网页，但 `/head.chain` 报
`eth_chainId ... fetch failed`，因此永续池和钱包控件未加载。分别用当前 Node 与
launchd 同一 Node 二进制启动新进程，Sepolia 链号均读取成功；仅重启
`com.wuji.sepolia-header-v3-indexer` 只读服务，未改代码、配置或 keeper。
随后 `/head` 返回三个池、`reconciliation=matched`、链上高度 972185。

已在 Chrome 选中 10% 池、连接 MetaMask，并从网页核对完整 owner 与 Ethereum Sepolia。
输入 #3 后点击申请退出，网页弹出不可撤销确认。处理对话框时浏览器报告超时，
随后该对话框已不活跃，但网页读取及截图仍失败；无法据此确认是否已到 MetaMask 签名阶段。
已交用户查看现有提示或签名请求，明确先不要重复点击退出。未操作钱包扩展。

19:04:34 固定规范块复验：#3/#4 仍 open、exitEpoch=null；没有已确认退出。
[重试后的链上原始记录](../../contracts/deployments/t13-wallet-exit-retry-2026-10-20.json)。
下一次先检查现有请求及链上状态，再决定是否重新发起；本次截图未取得，不用旧截图替代。

## 页面内确认修复与 #3 成功退出

用户确认没有钱包弹窗。重试仍在原生 `confirm()` 后发生浏览器超时；网页恢复为未提交状态。
现替换为页面内“确认申请退出 #编号 / 取消本次确认”两步操作，保留不可撤销、未来高度定价提示，
并将确认绑定到原账户编号、池地址、钱包地址与网络。取消、上下文变化、重复确认均不得发送交易。
没有绕过 MetaMask 签名，也没有改合约。

`node --test apps/terminal/*.test.mjs`：62 通过、0 失败、0 跳过。
新增确认前零 provider 调用、取消后旧确认无效、四类上下文切换阻断及重复确认只发一次测试；
原有退出模拟与完整 calldata 检查保留。`scripts/header-testnet.sh` 同步新版静态页面并核对冻结文件哈希。

Chrome 中再次核对 Sepolia、10% 池、0B95，完成 #3 的两次页面点击；用户随后完成签名。
真实退出交易：`0xeb53f347263d60e3bbb7fc436c79b86e809a2a2622d49264c1f255dda2af0a68`。
RPC 核对 status=1、from=0B95、to=10% 池、value=0、规范块哈希一致，gasUsed=187014；
ExitRequested 的 id=3、epoch=972372。账户已为 exiting，重复 requestExit 模拟拒绝 `exit pending`，
claim 仍因 `not claimable` 拒绝。
[完整交易与收据](../../contracts/deployments/t13-metamask-exit-3-2026-10-20.json)。

已尝试切换编号至 #4 并打开其退出确认，但浏览器再次超时；尚未取得 #4 的交易哈希或成功收据，
不能标记它已退出。下一步检查现有 #4 页面确认，然后由用户签名；#3 不再重复申请。
等待退出定价与最终领取仍未通过。此修复减少了原生模态框阻塞，不宣称解决全部浏览器连接问题。
