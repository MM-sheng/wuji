# WUJI 外部开发者最小验证包

本包用于独立理解和复算 **Ethereum Sepolia header-v3** 的一个固定历史样本，并把已验证的整数指数接入一个无资金的小程序。只需要 Node.js 18+ 和公共网络；不需要项目运行目录、完整 Bitcoin 头档、Foundry、钱包、账户或测试币。

这是协议原型验证材料。下载和重放通过，只证明本包写明的历史数据与固定链上状态一致；不代表实时价格、独立安全审计或可上线资金产品。

当前交付修订：`header-v3-r4-20261023`。本修订修复限流后的过早重试：HTTP 429 或带 `Retry-After` 的失败请求立即停止，由使用者按提示等待后续传；本地 JSON 损坏则给出保留现场、换新目录的明确指引。沿用 r3 的来源记录核对和 r2 的 Node 18.0 兼容性。协议、候选身份和指数公式未改。

## 先看哪三份材料

1. [PROTOCOL.md](PROTOCOL.md)：当前协议、输入输出、部署身份和限制。
2. 本页：可直接运行的公共数据复算与最小接入。
3. [ACCEPTANCE.md](ACCEPTANCE.md)：完成标准、失败处理和可回传的验收记录。

本包没有导入项目生产模块，也不会读取 `.env`、keystore 或作者本机目录。网络入口仅允许 Bitcoin 的 HTTP GET，以及固定指数的 `eth_chainId`、`eth_getBlockByNumber`、`eth_getCode`、`eth_call`。它没有交易发送或钱包连接功能。

## 1. 检查收到的文件

把整个 `header-v3` 文件夹复制或解压到自己的机器，在该文件夹中打开终端：

```sh
node --version
node verify.mjs integrity
node verify.test.mjs
```

第一项检查文件是否与随包的 `SHA256SUMS` 相符；校验清单本身不是发布者签名，应另外核对交付者提供的压缩包摘要。第二项检查已知区块向量、编码、Keccak、整数和只读边界。没有历史下载目录时，完整重放、十项损坏/不一致档案和一项中断续传测试会明确显示 **12 SKIP**，不是通过；基础测试应为 **16 PASS、0 FAIL**。基础项包含五种服务端冷却响应、两种本地截断 JSON 的拒绝测试，全部使用模拟传输，不访问公网。

测试直接运行文件即可，兼容 Node 18.0 起的接口；该初始版本不支持 `node --test` 参数。旧版 Node 可能显示 Fetch API 或测试模块的 experimental 提示，它们不等于测试失败；以退出码和结果汇总为准。

## 2. 从公共数据重新取得历史证据

选择一个尚不存在的输出目录，放在验证包目录之外。以下相对路径创建一个同级目录：

```sh
node verify.mjs fetch ../wuji-v3-run-01
```

默认读取：

- Sepolia RPC：`https://ethereum-sepolia.publicnode.com`。
- Bitcoin 区块元数据：`https://mempool.space/api/v1/blocks/:height`。

程序先固定 EVM 区块 `11969645`，检查链 ID、区块哈希、部署代码指纹、17 个只读接口和锚点状态承诺，再逐页取得 Bitcoin 高度 `967680–972610` 的 **4931 个头**。元数据重新编码成 80 字节，逐个检查哈希、链接及适用规则，最后重新核对 EVM 块。平均约 329 页；限速为每个新页面后等待一秒，通常需要数分钟，实际取决于公共服务。

网络超时或限流时，命令返回非零且不产生成功报告。只有缓存文件完整、配置未变的网络中断才可以用原命令续传，每个缓存页面仍会重新校验。限流与本地损坏处理见下节。完成后的目录只用于重放，重新下载请使用新目录。**不要删除检查条件、修改预期值或改成 latest 来绕过错误。**

也可以显式选择自己的公共或本地只读 RPC：

```sh
node verify.mjs fetch ../wuji-v3-run-02 --rpc http://127.0.0.1:8545
```

该节点必须服务 **Sepolia**，并支持固定历史块的 `eth_call` / `eth_getCode` 和 `finalized`。Bitcoin 来源可通过 `--bitcoin-api` 改为兼容 mempool `/v1/blocks/:height` 的 API。任意 Esplora 服务未必提供此分页接口。只支持 HTTPS 或 loopback HTTP；不接收 URL 用户名、密码、query token，不需要为本包提供密钥。

固定历史样本避免作者和验收者在不同时间追着不同末端比较。**本命令不会自动切换成新高度，也不是实时 indexer。** 若历史状态已经不可查询，应记录 `BLOCKED_DATA` 并换一个能提供该历史数据的来源，而非报告 PASS。

### 限流、网络中断与本地文件损坏

- **HTTP 429，或失败响应带 `Retry-After`：** 该请求立即失败，不再自动重试，不生成成功报告。若等待值是秒数，按提示至少等待相应秒数；若是 HTTP 日期，不早于提示的 GMT 时间再运行。缺少或无效等待值时，先按提供商的冷却规则处理。工具不自动睡眠数小时，也没有跨进程冷却锁；不要循环运行命令、切换同一服务域名或换目录来提前重试。
- **其他网络超时/暂时失败：** 每个请求最多尝试三次，间隔 1 秒、2 秒；耗尽后停止。来源恢复且缓存完整时，再手动运行原命令续传。已有完整页不重新下载，结束后仍验证整个范围。
- **`invalid JSON evidence: source.json / rpc.json / 页面文件`、缺文件或摘要不符：** 这是本地证据不完整/损坏，不是能够自动修复的网络中断。保留原目录、失败输出、工具修订及来源配置；先检查磁盘空间或写入中断等存储问题，然后在服务端冷却已结束的前提下，用一个从未存在的新目录重新获取。不要手工补写 JSON、改预期哈希、删掉配置或伪造成功报告。

例如，旧目录损坏时保留 `../wuji-v3-run-01`，另执行：

```sh
node verify.mjs fetch ../wuji-v3-run-recovered-01
```

`source.json` 或已缓存 `rpc.json` 的 JSON 损坏会在联网前拒绝；后续页面损坏可能在 RPC 重新核对之后才发现。程序不会覆盖这些损坏文件。中途写入错误和磁盘损坏仍可能留下残留文件；本包没有声明崩溃后的自动修复或原子档案写入能力。回传时区分 `BLOCKED_DATA`（服务端限流/不可用）与本地损坏失败，保留第一次失败及新目录的独立结果。

成功输出的核心字段应为：

```json
{
  "status": "PASS_PUBLIC_REPLAY",
  "chainId": 11155111,
  "index": "0x4a70Ebc03DA98f04d88964E17dF212ba1bb2705a",
  "evmBlock": {
    "number": "0xb6a46d",
    "hash": "0x72be42afcf3cd795f35d9f19051858f4fde77fd631353d47a262e572231c47d7",
    "timestamp": "0x6ada0648"
  },
  "rows": 2965,
  "checkpoint": {"height": 973865, "status": "NOT_REACHED"},
  "operatorIndependence": "NOT_ATTESTED"
}
```

真实输出还包含完整 continuity、整数 S、数据摘要和来源时间；其中 `bitcoin.finalized.height=972510`、`u="293"`、`S_wad="3516000000000000"`。不要只截取这一段示例 JSON 作为自己的结果。

从 r3 起的 `sources` 同时列出 RPC、Bitcoin API 和 `labelConsistency:"CHECKED"`；`evidenceSha256` 列出 `source.json`、`rpc.json`、`pages.json`、`final-block.json` 的文件摘要，方便回传结果与留存档案对照。RPC 来源必须与配置一致，每页 URL 必须对应所选 Bitcoin API 和高度，观测时间必须是有效 UTC ISO 字符串。这里只检查记录内部一致，`sources.authenticity` 仍为 `NOT_ATTESTED`：有人若一致改写所有标签，离线工具无法证明其实际使用过哪个服务。

输出目录保存以下证据，不触及验证包源文件或后台服务：

| 文件 | 用途 |
|---|---|
| `source.json` | 候选身份、候选文件摘要、明确选择的公开来源 |
| `rpc.json` / `final-block.json` | 固定块只读原始返回、代码、前后块哈希及结束时复查 |
| `pages/` / `pages.json` | 原始元数据页面、URL、覆盖范围与逐文件摘要 |
| `headers.bin` | 从 967680 起、按高度连续排列的原始 80 字节头 |
| `series.ndjson` | 969546–972510 的 2965 条已计入指数的数据行 |
| `result.json` | 本次完整校验成功后才生成的报告 |

完整下载采用一个 Bitcoin HTTP 来源；既有范围摘要是额外固定向量。它**不是两家来源的全量独立比对**。

## 3. 不联网重放，再验证损坏数据会被拒绝

在新进程运行，或将整个输出目录复制到另一处后运行：

```sh
node verify.mjs replay ../wuji-v3-run-01
node verify.test.mjs ../wuji-v3-run-01
```

`replay` 完全不联网，不信任现成的 `result.json`；它从保存的原始页面重新编码头、重算状态，并核对 `headers.bin`、`series.ndjson` 与 RPC 证据。预期状态为 `PASS_OFFLINE_REPLAY`。

后一条命令执行全部 28 项本包测试，包括在独立临时副本中删除页面、改变头、改变 RPC 的 S、改变输出序列，以及制造来源标签、页面 URL、观测时间的不一致；这些情况都必须失败。另用已有档案作为模拟 HTTP 响应，检验网络中断后续传、429 时保留已下载前缀并立即停止、之后手动续传、缓存页复核、配置不一致拒绝及完成档案不被覆盖；这项测试不联网，也不算新的公共下载。只删除由测试自己创建的临时副本，原输出目录不变。验收时应是 **28 PASS、0 FAIL、0 SKIP**。

r1/r2/r3 下载的完整原始档案可直接用 r4 重放，不修改旧 `result.json`。回传时另保存本次重放输出，用其中的来源与证据摘要对照原档案；不要把旧报告手工改写成新结果。

可选地，用另一家实际独立的 RPC 再核对同一历史块：

```sh
node verify.mjs check-rpc ../wuji-v3-run-01 --rpc http://127.0.0.1:8545
```

该命令先离线重放，再重新读取固定块，成功返回 `PASS_RPC_RECHECK`。记录实际提供商；换域名或换进程本身不证明组织独立。命令输出到终端，不覆盖原证据。

## 4. 作为开发者独立使用

```sh
node consume.mjs ../wuji-v3-run-01
```

这是最小消费者，先重放验证，再输出带链、地址、EVM 块哈希和 Bitcoin 高度的历史样本。`S_wad` 保持十进制整数字符串；`displayIndex` 只是浮点展示，显式标注 `live:false`、`tradableQuote:false`。

自己的程序可以直接调用：

```js
import { verifyArchive } from './verify.mjs';
const result = verifyArchive('../wuji-v3-run-01');
const sWad = BigInt(result.bitcoin.finalized.S_wad);
// Use sWad in a historical experiment. Preserve the chain, address, height and block hash.
```

若要做路径图或模拟，验证后读取 `series.ndjson`。每行包含 `height`、Bitcoin 显示哈希、`delta`、整数 `U` 和 `S_wad`；确认后缀的 100 个头不写进这份序列。不要将模拟结果作为真实账户可兑现金额。

运行附带示例只完成技术接入演示。外部需求验收还需要你写出自己的用途、替代方案、可接受成本/延迟以及继续使用的条件，见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 来源与范围

协议候选从仓库基线 `a4cd706bd6d10aaf3bf6fb008c12e02e1b6b712a` 整理，部署合约来源为 `03f6256c2821e5a67a8b98739ee9b199a32da27a`，这些是不同身份；本包独立验证工具的版本由修订号和文件摘要标识，不代表该历史提交已包含本包全部文件。参考计算没有导入生产的 Bitcoin step、keeper 或钱包模块。代码指纹比较不等于源代码到运行字节码的独立编译证明。

API 定义参考 [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/) 与 [mempool REST API](https://mempool.space/docs/api/rest)。本包的具体字段、数据来源与适用限制以 [PROTOCOL.md](PROTOCOL.md) 为准。作者自检结果单列于 [SELF_CHECK.md](SELF_CHECK.md)，外部验收尚需你独立完成。
