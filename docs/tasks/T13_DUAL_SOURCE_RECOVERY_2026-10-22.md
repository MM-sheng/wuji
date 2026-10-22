# 当前 header-v3 双来源完整核验与隔离恢复 · 2026-10-22

本轮范围是当前不可变 Sepolia v3 指数 `0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a`。
同机作者核验，不是第三方审计、第二运营者接手或作者消失 48 小时验收。没有签名、部署、转账、
修改协议参数或切换线上服务。

## 完整核验

固定 Sepolia finalized 块 **11969645**，哈希
`0x72be42afcf3cd795f35d9f19051858f4fde77fd631353d47a262e572231c47d7`。
保存 `continuity()`、确认数、封存状态、seenHeight/seenTime、起点和检查点间隔的原始 RPC 返回；
完成后重新读取该规范块哈希；最终再读 `S()`，与整数重算值一致。复用保存快照时也必须重新核对该块及全部只读调用，缓存不是链上证明。

| 范围 / 项目 | 本轮结果 |
|---|---|
| 头档范围 | 969535–972610，3,076 个、246,080 字节；包含锚点所需的 11 个时间戳 |
| 已折叠范围 | 969546–972510，共 2,965 高度；另验证后继 100 个头 |
| 来源 A | 线上 Bitcoin P2P 原始头档的固定范围副本；只读，未修改原文件 |
| 来源 B | 独立向 mempool.space `/api/v1/blocks/:height` 分页取得全部元数据，重新编码 80 字节头并校验各自区块哈希 |
| 逐字节比对 | 全部相同，两个范围文件 SHA-256 均为 `52348deac3f4461fafcb5e75aed1a68c5449f3c6090e5fc4584ebebebfdeb921` |
| 跨越难度调整 | 969696、971712，两次均验证时间跨度夹限与 compact target |
| 指数 | `U = 293`，`S_wad = 3516000000000000`，即 `S = 0.003516` |
| 完整状态 | raw hash、height、bits、time、epochStart、U、11 时间戳和累计 work 均与链上相同 |
| 累计工作量 | `1717113702291114818887492394`，从部署锚点开始，不是 Bitcoin 创世累计工作量 |
| 检查点 | 首个末端 973865 尚未达到；没有把不存在的自然检查点写成通过 |

参考重算模块不调用生产 `bitcoin.mjs` 的编码或 step，实现 SHA256d、显示/原始字节序、
`R=SHA256(raw SHA256d(header))`、byteSum−4080、整数 UNIT、链接、PoW、MTP、未来时间、难度调整及 work。
部署锚点的初始 epoch 时间另外由第二来源取得，并与 P2P 对应头一致。
来源 B 的每页原始 JSON、URL 和 SHA-256 均保存，缺页、错误、限流耗尽、字节不一致直接失败，
不会降级成仅比较末端哈希。HTTP 原始字段说明见
[mempool 官方 API](https://mempool.space/docs/api/rest)。

这证明两种获取路径在固定范围得到相同区块头，以及它们与已部署指数的完整状态一致。
它不验证交易、UTXO 或所有完整节点规则，不证明数据源运营者与矿工独立，也不消除锚点和 EVM RPC 信任。

## 隔离恢复

仅在 `operator/sepolia-header-v3/verification-2026-10-22/` 下创建新目录：

1. 从空的内容寻址头档开始，使用来源 B 的头，按已逐字节核对的范围末端 raw hash 逆向追溯，分段恢复全部范围；其中已折叠末端 972510 的 raw hash 已与链上直接核对，后继 100 个头另经链接与 PoW 验证。
2. 新 Node 进程在无数据源回退的条件下读取全部恢复文件。
3. 单独删除一个头、篡改其字节、提供同高度的错误分支，确认都拒绝；再由第二来源恢复正确数据。
4. 空索引缓存启动实际生产索引器模块。HTTP 头服务及 EVM 快照服务均仅监听 loopback；
   子进程只得到必要的只读配置，没有 keystore、密码、签名配置，也不转发至线上 RPC。
5. 逐行核对恢复后的头、U；在同一高度核对链上 S 和 raw hash，停止并重启隔离索引器，比较缓存 SHA-256、
   行数、S、末端哈希和固定 EVM 块。
6. 故意向本地快照服务调用 `eth_sendRawTransaction`，必须拒绝；它没有转发发送的方法。
   检查线上 keeper/indexer PID、运行文件和原头档固定前缀没有变化。

展示索引器目前采用 6 个确认，协议使用 100；本轮没有改动这个既有差异。
固定 tip 972610 时展示缓存应到 972604；对账读取 **972510 那一行**，不能拿展示末端代替合约末端。
本次恢复完成于 `2026-10-22T13:10:48.210Z`：3,076 个存档头跨新进程读取通过，
3,059 行缓存逐行核验和重启摘要相同；共 24,487 次本地头请求、78 次本地快照 RPC，
1 次故意发送测试被拒绝，外部 RPC 与广播均为 0。线上 keeper/indexer PID 未变，84 个运行文件和头档固定前缀未变。
恢复结果以随附原始 JSON 为准，不把无签名索引器重启称为 keeper 模糊发送或 nonce 恢复验收。

## 复现和证据

新增工具均为 Node 标准库，未引入依赖；原合约、生产服务模块及不变量没有修改。
在仓库根目录执行，使用从未完成演练的新隔离目录：

```sh
node scripts/verify-v3-recovery.mjs /tmp/wuji-v3-check-UNIQUE
node scripts/drill-v3-recovery.mjs /tmp/wuji-v3-check-UNIQUE
node --test scripts/lib/header-verification.test.mjs indexer/header-history.test.mjs indexer/bitcoin.test.mjs
```

核验器默认读取本机 P2P 头档；其他原始创世起始头档可用 `HEADER_FILE` 指定。
指定 `VERIFY_SNAPSHOT=contracts/deployments/t13-v3-verification-snapshot-2026-10-22.json` 可复现本轮固定块，
需要 RPC 仍能读取该历史块。未指定则固定运行时的 finalized 块。下载可从同一未完成目录续传，
完整恢复必须从没有 recovered-archive / recovered-indexer 的目录开始；完成目录不会被覆盖。
隔离恢复脚本的运行文件保护检查针对本机已安装的三份运行快照，需要该目录结构；
外部运营者应按自己的部署环境执行同类检查。演练没有读取作者的密钥或密码。

- [双来源结果、恢复结果](../../contracts/deployments/t13-v3-dual-source-recovery-2026-10-22.json)
- [固定 EVM 原始快照](../../contracts/deployments/t13-v3-verification-snapshot-2026-10-22.json)
- [各页来源和摘要](../../contracts/deployments/t13-v3-source-pages-2026-10-22.json)
- 大体积原始 JSON 页、两个范围二进制、恢复头档、缓存和进程日志保留在上述 gitignored 隔离目录；
  没有提交线上 operator 私有文件。

验证：相关 Node **26/26**；默认 Forge **325 通过、0 失败、24 跳过**。
24 项全历史回放本轮没有重新开启，不能计入本轮通过。新增参考模块也用已提交的真实 Bitcoin 夹具
跨一次难度调整，并对照既有 R 向量；坏链接、MTP、未来时间、难度、retarget、PoW 等故障测试均通过。

## 后续

本轮补齐当前 v3 双来源整段核验与同机隔离恢复。真实拒签/取消重试与首次 type-4 路径、
自然检查点、跨天运营观测、外部独立审阅和另一台机器接手仍未完成。
主网原生 ETH / CREATE2 目标尚未实现；本轮结果不构成主网上线许可。
