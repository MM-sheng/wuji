#!/usr/bin/env bash
# Prompts for the testnet private key without echoing it and writes contracts/.env. Nothing is printed back.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "请粘贴测试钱包私钥（输入不会显示），然后按回车："
for attempt in 1 2 3; do
  read -rs KEY
  KEY=$(printf '%s' "$KEY" | tr -d '[:space:]"'"'"' ')   # strip spaces, quotes, newlines
  KEY=${KEY#0x}; KEY=${KEY#0X}
  if [[ "$KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then break; fi
  words=$(printf '%s' "$KEY" | wc -w)
  if [[ "$KEY" == *" "* ]] || (( ${#KEY} > 80 )); then echo "这看起来像助记词，需要的是私钥（在钱包里选「导出私钥」）。再试一次："; else echo "收到 ${#KEY} 个字符，需要 64 位十六进制（可带 0x）。再试一次："; fi
  KEY=""
done
[[ -n "$KEY" ]] || { echo "三次失败，未保存。"; exit 1; }
printf 'PRIVATE_KEY=0x%s\nRPC=https://bsc-testnet-rpc.publicnode.com\n' "$KEY" > .env
chmod 600 .env
echo "已保存到 contracts/.env（权限 600，git 忽略）。回到对话告诉 Claude 即可。"
