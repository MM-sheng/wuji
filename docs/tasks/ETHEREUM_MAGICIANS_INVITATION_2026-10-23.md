# Ethereum Magicians 外部验收邀请

状态：用户于 2026-10-23 已授权将既有英文短稿发布至 Tooling；尚未发布。
用户完成登录后，已确认 Chrome mm 会话的论坛账号为 `mm-sheng`。
当前阻塞为新用户发帖限制：Tooling 和首页均没有创建主题入口，正常新主题路由也返回栏目页而不打开编辑器。
版主说明新用户须先阅读讨论再创建主题；论坛 Basic 徽章说明达到信任等级 1 后解除新用户限制。
已阅读社区指南、上述版主说明及相关轻客户端、多 RPC、合约元数据和 API 工具讨论；复查后仍未出现创建主题入口。
没有提交帖子或上传附件，尚无外部参与者回传。需要该账号获得创建主题权限后继续，原发布授权仍有效。

权限说明来源：

- https://ethereum-magicians.org/t/ethereum-improvement-proposal-all-info/12326/45
- https://ethereum-magicians.org/badges/1/basic

上述页面没有给出本站的确切阅读时长或数量门槛，不能保证若干分钟后一定解锁。

目标栏目：https://ethereum-magicians.org/c/magicians/tooling/29

文案来源：[既有邀请短稿](../EXTERNAL_DEVELOPER_INVITATION_2026-10-22.md)。
附件仅在对方愿意参与后提供；本次不上传验证包或源码包。

## Title

WUJI: seeking an independent developer to replay a Bitcoin-header-derived index

## Body

Looking for one developer to independently replay a Bitcoin-header-derived settlement index on Sepolia.

WUJI is a research prototype with a small, zero-dependency Node verification tool. I would like feedback on whether its rules are understandable and whether an external developer can fetch public evidence, reproduce a fixed historical snapshot, and replay it offline. No wallet, deposit, or test funds are needed.

If it fits an existing project of yours, a small read-only consumer and an explanation of why a shared path is useful would be valuable; “not useful for my case” is also a valid result. This is not a request to endorse investment returns or certify contract safety. Would anyone be interested in reviewing the instructions?

## 发布后记录

等待发布后填写实际帖子链接、账号、时间和公开或待审核状态；发帖本身不构成外部独立验收通过。

## 权限复查

- 2026-10-23 21:59（Asia/Jakarta）：按用户要求刷新已登录的 Tooling 页面，仍无创建主题入口；未提交邀请，继续保留文案和页面。

## 社区讨论阅读 · 2026-10-23

用户随后授权继续阅读相关帖子，并在权限开放后直接发布同一英文邀请。

- [预编译移除与 Bitcoin 轻客户端讨论](https://ethereum-magicians.org/t/discussion-removal-of-ripemd-160-and-blake2f-precompiles/14857)：阅读其技术兼容性、实际使用量与长期行为边界的争论。历史讨论不能视作当前协议状态；对本次邀请的启示是，具体用途需要外部证据，不能由可验证性推定需求。
- [ethPM V3 规格工作组](https://ethereum-magicians.org/t/ethpm-v3-specification-working-group/4086)：读到规格版本、路径、重现编译、校验和以及独立实现者的反馈。独立实现暴露了作者未必注意的可理解性问题，适合作为本轮外部复算验收的反馈形式参考。
- [公开可验证随机源讨论](https://ethereum-magicians.org/t/post-quantum-vrf-for-ethereum-ethresear-ch-cross-post/28743)：阅读原帖给出的构造、实现和审阅范围；没有独立验证其密码学主张，不据此改变 WUJI 机制或宣称优于其他随机源。
- [协议交互清单](https://ethereum-magicians.org/t/erc-8313-protocol-interaction-manifest/28663)：阅读其对 ABI、工作流信息和信任边界的区分；本轮仍保持只读复算，不扩展钱包操作范围。
- [独立复算的确定性随机数讨论](https://ethereum-magicians.org/t/deterministic-random-number-in-evm-for-independent-recomputability/29208)：读到各方对唯一性、重组标识与可重算输入的区分。帖子中的具体技术断言未经本次独立核验，不作为 WUJI 安全结论。
- [未来区块随机源讨论](https://ethereum-magicians.org/t/erc-7977-future-block-oracleless-randomness/24843)：阅读关于 grinding、两阶段请求和未来区块的质疑。保留 WUJI 既有的随机性模型边界，不把数据可复算等同于无偏。

中途核对账号统计仍为 0 个主题 / 0 条已读帖子；发现浏览器前台原在另一标签，已通过 Chrome 正常界面切换至论坛标签后继续阅读。该观察不能证明论坛的具体计时机制或晋级门槛。
没有修改网站代码、调用内部接口或伪造阅读统计；是否解锁仍以网站实际提供的创建主题入口为准。

### 本轮复查结果

复查时间：2026-10-23 22:21（Asia/Jakarta）。

用户完成手动切回英文并保留前台后，继续阅读相关回复并通过网站菜单导航。
期间观察到论坛脚本的 `removeChild` 界面错误；切回原文并重载后可正常导航，但这不证明自动翻译是统计未更新的唯一原因。
本轮最后的账号 Summary 仍显示 `< 1m`、`0 topics viewed`、`0 posts read`，没有 Basic 徽章。
返回 Tooling 后仍没有创建主题按钮；尝试网站 Keyboard Shortcuts 明示的 `C` 新主题入口，也未打开编辑器。
因此本轮未提交帖子，尚无帖子 URL 或待审核回执。后续需要论坛实际开放该账号的创建主题入口再继续。
不重复要求用户授权发布；既有对 Tooling 英文邀请的授权仍有效。
