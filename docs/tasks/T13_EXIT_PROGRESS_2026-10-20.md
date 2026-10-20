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
