#!/usr/bin/env bash
# Imports the testnet deployer key into Foundry's encrypted keystore (~/.foundry/keystores/wuji-testnet)
# and writes contracts/.env with the account name + password file. After this, no script ever puts the
# raw key on a command line (where `ps` could show it) — forge/cast decrypt it from the keystore.
set -euo pipefail
cd "$(dirname "$0")/.."
CAST=${CAST:-$HOME/.foundry/bin/cast}
ACCOUNT=${ACCOUNT:-wuji-testnet}
PWFILE=".keystore-password"

KEY=""
if [[ -f .env ]] && grep -q '^PRIVATE_KEY=0x' .env; then
  KEY=$(grep '^PRIVATE_KEY=' .env | cut -d= -f2)   # migrate an existing plaintext .env
  echo "在 .env 里找到明文私钥，正在迁移到加密 keystore…"
else
  echo "请粘贴测试钱包私钥（输入不会显示），然后按回车："
  for attempt in 1 2 3; do
    read -rs KEY
    KEY=$(printf '%s' "$KEY" | tr -d '[:space:]"'"'"' '); KEY=${KEY#0x}; KEY=${KEY#0X}
    [[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]] && { KEY=0x$KEY; break; }
    echo "收到 ${#KEY} 个字符，需要 64 位十六进制（可带 0x）。再试一次："; KEY=""
  done
  [[ -n "$KEY" ]] || { echo "三次失败，未保存。"; exit 1; }
fi

[[ -f $PWFILE ]] || { openssl rand -hex 24 > $PWFILE; chmod 600 $PWFILE; }
rm -f "$HOME/.foundry/keystores/$ACCOUNT"
"$CAST" wallet import "$ACCOUNT" --private-key "$KEY" --unsafe-password "$(cat $PWFILE)" >/dev/null
ADDR=$("$CAST" wallet address --account "$ACCOUNT" --password-file $PWFILE)
printf 'KEYSTORE_ACCOUNT=%s\nPASSWORD_FILE=%s\nDEPLOYER=%s\nRPC=https://bsc-testnet-rpc.publicnode.com\n' "$ACCOUNT" "$PWFILE" "$ADDR" > .env
chmod 600 .env
unset KEY
echo "已导入 keystore「$ACCOUNT」，地址 $ADDR。.env 不再含私钥。回到对话告诉 Claude 即可。"
