# Sepolia v4 · 独立审阅与运营交接入口

准备日期：2026-09-22。这里交接的是已经部署的测试候选；独立审阅者、另一台机器的运营者尚未到位。
本机复算、回执、压力测试和这份材料均不能替代他们的验收。不要再次部署、重复捐赠或复制作者的签名凭据。

## 1. 固定审阅对象

| 对象 | 标识 |
| --- | --- |
| 部署时源码 | `1b099529715874da35a1958bbde8afb5aabb6973` |
| 当前运行代码 | `5bb128bdbd02a5f8c260177b2ca90a3c9a53a109` |
| 结算测试链 | Ethereum Sepolia，chain ID `11155111` |
| 地址及构造参数 | [sepolia-weth-v4.json](../../contracts/deployments/sepolia-weth-v4.json) |
| 初次部署与 WETH 往返回执 | [T9_SEPOLIA_V4_REPORT.md](T9_SEPOLIA_V4_REPORT.md) |
| Keeper 后续修改与测试 | [T8_KEEPER_RUNTIME.md](T8_KEEPER_RUNTIME.md) |
| 最新本地验收 | [T8_RECOVERY_REPORT.md](T8_RECOVERY_REPORT.md)：完整双源重算、资金回执、分批累计 1000 × 100 的资金性质测试 |

上述两个提交之间没有生产 Solidity 变更；审阅人应自己运行以下比较确认。后续如果修改合约或部署参数，
必须重新确定审阅对象，不能沿用旧审计结论。当前本地入口为 `http://localhost:8794`，它不是别人可访问的公网服务。

```sh
git diff 1b099529715874da35a1958bbde8afb5aabb6973 5bb128bdbd02a5f8c260177b2ca90a3c9a53a109 -- contracts/src
```

## 2. 给审阅者的任务

先读 [ARCHITECTURE.md](../ARCHITECTURE.md)、[THREAT_MODEL.md](../THREAT_MODEL.md)、
[2026-09-20 对抗评审](../reviews/2026-09-20-adversarial.md)，再核对以下范围。

1. `BitcoinRelay`：原始/显示哈希字节序、PoW 紧凑目标符号与溢出、分支自己的难度周期、重定向、
   MTP 与未来时间、累计工作量选链、可信锚点及最坏分叉 Gas。它不验证区块体、交易或脚本。
2. `WujiIndex`：每高度唯一累加、六个后继、固定检查点、过期中继门槛、重组后不继续使用失配历史。
   公共来源可用和同高整数相等不证明全球最高工作量链。
3. T9：观察绑定修订、恢复/再次分歧、不可推迟有效观察、144 高度候选延迟、不可逆封存、逐金库关闭、
   各期自己的边界与 1/2 退出；重点看谁能从终止获利、如何反复重置等待以及无人中继时的退出限制。
4. `WujiVault` / `SeriesToken` / factory：普通 ERC-20 假设下的偿付、固定配对、舍入、已结算期不改价、
   重入、任意代币隔离和无特权创建；所有原有资金不变量必须保留。
5. `FeeRouter` / `RelayerRewards`：100% 运营储备、只能按任务领取、捐赠与分配守恒、孤块和重复工作不得
   重复领取、旧工作不能领取新费用、终止后的留存资金。没有救援钥匙不等于不存在资金永久留存。
6. 部署及链下：immutable 绑定、可复现元数据、钱包交易前的部署核验、固定 EVM 快照、待确认交易与余额
   检查、数据接口失败、私钥隔离，以及作者服务全部消失后仍能独立退出的路径。

结论应给出：审阅人、日期、精确提交、范围和方法、每个发现的复现/严重度/影响、修复提交及复核结果、
未覆盖项。作者的历史内部笔记不是本版本的外部审计；[AUDIT_NOTES.md](../AUDIT_NOTES.md) 主要描述已被替代的 BSC 版本。

复验入口（从仓库根目录执行，RPC 与 Bitcoin 来源由审阅者明确选择）：

```sh
forge test --root contracts
node --test indexer/*.test.mjs scripts/*.test.mjs apps/terminal/*.test.mjs
FOUNDRY_INVARIANT_RUNS=1000 FOUNDRY_INVARIANT_DEPTH=100 FOUNDRY_INVARIANT_FAIL_ON_REVERT=true \
  forge test --root contracts --match-contract '^(WujiVaultInvariants|RelayerRewardsInvariants|FrozenExitInvariants)$'
READ_RPC="$SEPOLIA_READ_RPC" bash scripts/verify-bytecode.sh contracts/deployments/sepolia-weth-v4.json
READ_RPC="$SEPOLIA_READ_RPC" VERIFY_BITCOIN_SOURCES="$BITCOIN_SOURCE_A,$BITCOIN_SOURCE_B" \
  VERIFY_OUTPUT=/tmp/wuji-independent-verification.json \
  node scripts/wuji-verify.mjs contracts/deployments/sepolia-weth-v4.json
```

完整来源重算不读索引器缓存；任一来源失败就不能标为通过。字节码比较会遮罩编译器声明的 immutable
位置，所以还要复查 manifest 的构造参数和实际绑定。公开报告不要包含带认证信息的 RPC URL。

## 3. 给另一位运营者的任务

使用另一台由运营者控制的机器、另一家 Sepolia RPC、独立选择的 Bitcoin 来源和新建且已资助的测试账户。
只需公共 manifest、代码及自己的凭据；不需要作者私钥，也没有需要作者授予的合约权限。

从 `.env.docker.example` 复制到已被 Git 忽略的 `.env.docker`，明确设置：

```dotenv
MANIFEST=contracts/deployments/sepolia-weth-v4.json
WUJI_PORT=8794
RPC=<运营者自己的 Sepolia RPC>
BITCOIN_API=<运营者选定的 Esplora API 根地址>
KEYSTORE_ACCOUNT=wuji-independent-operator
KEYSTORE_FILE=<新账户的加密 keystore 绝对路径>
PASSWORD_FILE=<密码文件绝对路径>
```

文件值需替换后使用；密码文件不能对所有用户可读，容器内 uid 1000 需要只读权限。先只启索引器，完成
链号、部署、六后继和同高整数核验，再启 keeper。一个账户只运行一个签名进程。

```sh
docker compose --env-file .env.docker up -d --build indexer
docker compose --env-file .env.docker --profile keeper up -d keeper
docker compose --env-file .env.docker logs --tail=100 keeper
```

Docker 的健康检查只证明 HTTP 可达，不代表追链、对账或 Gas 余额足够。按架构中的情景预算
300000 gas/高度、144 高度/天、1 gwei，48 小时约需 0.0864 测试 ETH，另加追链、结算、领取和余量；
这不是实时费用或资助承诺。有限余额和赏金不能证明独立运营者有利可图。

## 4. 验收记录

先证明第二位运营者实际提交/折叠并领取，再安排作者关闭服务。关闭作者服务前，要保留对双方地址、
进程和待确认交易的记录；不要把仍使用作者的 RPC、前端或 Bitcoin 接口计为完全接手。

| 阶段 | 必须留下的证据 | 当前状态 |
| --- | --- | --- |
| 独立启动 | 运营者身份或公开代号、机器/提供商、代码提交、独立数据来源、公开工作地址 | 待实际参与者 |
| 首次工作 | relay/fold/claim 成功回执、固定观察块、六后继与整数复算 | 待另一位运营者执行 |
| 48 小时消失演练 | 作者服务停启时间、各自运行日志、最长中断/积压、交易与真实费用、用户退出证据 | 未开始 |
| 第一期真实结算 | Bitcoin 高度 `972145` 的 checkpoint、settle、单边 redeem、资金核算 | 尚未到期 |
| 独立审计 | 精确提交及有身份的审阅报告、发现清单和修复复核 | 未完成 |

观察期间保留原始整数、EVM 区块及哈希、Bitcoin 高度及哈希、回执与来源；失配或缺数据明确记失败。
链上正常期结算与本地合成深重组退出演练是两份证据，不能相互替代。
主网上线仍依 [MAINNET_CHECKLIST.md](../MAINNET_CHECKLIST.md) 逐项验收；原生 ETH 金库、CREATE2 和 ENS
也是架构中的未实现目标，当前 Sepolia WETH 不能代替它们。
