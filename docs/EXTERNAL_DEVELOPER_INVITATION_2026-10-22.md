# WUJI 外部开发者邀请说明

状态：待发送草稿。当前附件为 `wuji-header-v3-verification-2026-10-23-r4.zip`；本文件没有发送给任何人。
附件 SHA-256：`5c2bc154938772e88a3eee116133ad16742d8ad9abd1c6d37ded84e80866272d`。
[本轮交付与证明范围](tasks/EXTERNAL_VALIDATION_R4_2026-10-23.md)。

---

你好，想邀请你帮忙做一次 WUJI 的外部开发者验证。

WUJI 是一个公开可复算的随机结算指数协议原型：把比特币区块头按固定规则转换成一条整数指数路径，让不同应用能够引用并核对同一份结果。目前在测试网验证，重点是确认外部开发者能否独立理解、复算和接入，以及是否有实际用途。

附件是最小验证包，只需 Node.js 18+，不需要钱包、测试币或作者的运行环境。这次使用固定的历史样本，希望你在自己控制的机器上完成三件事：

1. 阅读协议说明，指出规则、输入输出或适用边界中不清楚的地方。
2. 按步骤自行取得公开数据、复算链上快照，再离线重放，并检查缺失或被篡改的数据会被拒绝。
3. 如果与你的工作相关，用自己的小程序做一次无资金接入，说明它解决什么问题，以及相比本地随机数或其他公开随机源，为什么需要 WUJI。不适合使用也是有价值的结论。

请按包内 `ACCEPTANCE.md` 的模板回传：运行环境与实际数据提供商、`result.json`、测试通过／失败／跳过数量、遇到的问题及复现步骤；如做了接入，再附输入输出、复现方式、可接受的延迟和成本，以及愿意继续使用的条件或不采用的原因。请保留第一次失败及后续修正记录，不必只报最后一次成功。无需提供密钥、访问令牌或整份原始数据。

这次希望分别得到两个判断：“能否独立复算”和“是否值得继续接入”。本轮不涉及资金操作、钱包测试或安全审计，复算通过也不代表资金产品已可上线。


## 接触渠道筛选 · 2026-10-23（内部准备，未发送）

以下是根据公开栏目说明作出的匹配判断，不代表任何社区或开发者已同意参与，也不保证响应。

- 优先候选：[Ethereum Magicians / Tooling](https://ethereum-magicians.org/c/magicians/tooling/29)。
  官方分类面向开发工具，已有轻客户端理解工具的反馈帖；适合先介绍只读复算工具，寻求一位愿意接手的人。
  栏目近期帖子和回复不多，应保留没有响应的可能，不把发帖本身算作需求成立。
- 技术方案讨论候选：[Primordial Soup](https://ethereum-magicians.org/c/magicians/61)。
  官方说明涵盖潜在技术方案；适合讨论 header-only 验证和结算基准的边界。避免在两个栏目重复贴同一邀请。
- 暂不作为招募入口：[Ethereum Stack Exchange](https://ethereum.stackexchange.com/help/on-topic)
  明确排除招募和项目宣传；仅在出现具体、可复现的技术问题时按其规则提问。
- [Ethereum Research 参与指引](https://ethresear.ch/guidelines)要求先看已有讨论、选对栏目，避免重复发帖和推广。
  若后续提出具体安全/机制问题，可先整理独立问题；当前不把广泛项目介绍当成已获允许的研究帖。

第一条接触信息的英文短稿（尚未发布；附件仅在对方愿意参与后提供）：

> Looking for one developer to independently replay a Bitcoin-header-derived settlement index on Sepolia.
> WUJI is a research prototype with a small, zero-dependency Node verification tool. I would like feedback on
> whether its rules are understandable and whether an external developer can fetch public evidence, reproduce
> a fixed historical snapshot, and replay it offline. No wallet, deposit, or test funds are needed.
> If it fits an existing project of yours, a small read-only consumer and an explanation of why a shared path is
> useful would be valuable; “not useful for my case” is also a valid result. This is not a request to endorse
> investment returns or certify contract safety. Would anyone be interested in reviewing the instructions?

首次目标是取得一位实际愿意参与的开发者及其范围，之后用既有 r4 验收模板回传。
不承诺酬劳、审计认证或持续服务；没有登录、联系个人、上传包或发送上述消息。
