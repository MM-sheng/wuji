# 主网 keeper 运行手册

2026-10-06 · 适用：以太坊主网 `WujiHeaderIndex`（第一步上线）。钱包整体安排见
[decisions/2026-10-05-wallets.md](decisions/2026-10-05-wallets.md)。

## 账户

| 机器 | 账户名（Foundry 加密密钥文件） | 地址 | 角色 |
|---|---|---|---|
| Mac mini | `wuji-mainnet-keeper-mini` | `0x7D3722215F1692a44c9398105D879c4b056469A9` | 主 keeper |
| MacBook | `wuji-mainnet-keeper-book`（待建） | — | 备用 keeper |

规则（AGENTS.md）：私钥只存在加密密钥文件里，不上命令行、不进日志、不进 git。密码文件和 `.env.*` 都在 `.gitignore` 里，权限 600。

## 在一台新机器上建 keeper 账户

在仓库的 `contracts/` 目录下执行（把 `book` 换成这台机器的名字）：

```bash
umask 077 && openssl rand -hex 24 > .keystore-password-mainnet-keeper
```

```bash
CAST_PASSWORD="$(cat .keystore-password-mainnet-keeper)" cast wallet new ~/.foundry/keystores wuji-mainnet-keeper-book
```

最后一条命令只显示地址，私钥直接加密写进 `~/.foundry/keystores/`。把地址告诉开发助手，记进上表。

**备份**：把 `~/.foundry/keystores/<账户名>` 和密码文件分开备份（例如分别存进两个不同的加密存储）。
丢了也不是灾难：里面只有几个月的 gas 费，以及还没领取的赏金。

## 启动

两台都要放在 `scripts/supervise.sh` 下运行：进程退出了会自动重启；keeper 连续 12 轮失败会主动退出，由守护脚本重启。

主 keeper（Mac mini）：攒满 256 个高度推进一次，约 1.8 天一次。设了赏金代币时，一次最多 256 个高度。

```bash
nohup scripts/supervise.sh env RPC=https://ethereum-rpc.publicnode.com CHAIN_ID=1 ZK_INDEX=<主网指数地址> KEYSTORE_ACCOUNT=wuji-mainnet-keeper-mini PASSWORD_FILE=/Users/m/Projects/wuji/contracts/.keystore-password-mainnet-keeper BITCOIN_SOURCE=p2p BITCOIN_P2P_DIR=/Users/m/Projects/wuji/indexer/data/headers-mainnet ZK_WORK_DIR=/Users/m/Projects/wuji/indexer/data/zk-mainnet ZK_MIN_FOLD=256 ZK_MAX_FOLD=256 ZK_MAX_WAIT_MIN=100000 node indexer/zk-keeper.mjs >> /tmp/wuji-mainnet-keeper.log 2>&1 &
```

备用 keeper（MacBook）：只在指数落后 500 个区块头以上时才推进。主 keeper 正常时，最多落后约 356 个，所以备用机永远轮不到；
主 keeper 停摆约一天后，备用机接手。

```bash
nohup scripts/supervise.sh env RPC=https://ethereum-rpc.publicnode.com CHAIN_ID=1 ZK_INDEX=<主网指数地址> KEYSTORE_ACCOUNT=wuji-mainnet-keeper-book PASSWORD_FILE=<仓库路径>/contracts/.keystore-password-mainnet-keeper BITCOIN_SOURCE=p2p ZK_MIN_FOLD=400 ZK_MAX_FOLD=256 ZK_MAX_WAIT_MIN=100000 node indexer/zk-keeper.mjs >> /tmp/wuji-mainnet-keeper.log 2>&1 &
```

- 第一次启动会从比特币网络同步全部区块头（约 77 MB，约 25 分钟），之后日志显示 `waiting: … headers past …` 就是正常状态。
- **两台都要长期开着**：深度重组时，keeper 只能从自己存过的状态发起封存（`indexer/seal.mjs`）。MacBook 插电，关闭自动睡眠（或用 `caffeinate -is` 包住命令）。
- 储备有赏金后，加上 `ZK_REWARD_TOKENS=<代币地址>` 领赏金。
- 要彻底停止：先停 `supervise.sh`，再停 keeper（否则守护脚本会把它重启）。

## 资金与监控

- 每台放 0.02–0.05 ETH，余额低于 0.01 ETH 时从官方钱包补。按 2026-10-03 的主网 gas，主 keeper 每月约 21 美元。
- 检查：指数 `lastHeight()` 不应比比特币链尾落后超过约 400 个区块；超过一天以上要查日志。
- 日志里出现 `reorg:` 或 `freezeOnReorg` 是重组事件，需要关注。
