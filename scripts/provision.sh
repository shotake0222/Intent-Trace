#!/usr/bin/env bash
# Cloudflare リソース（D1 / R2 / KV）を作成し、wrangler.jsonc の ID を書き換え、シークレットを登録する
# 事前に: export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ D1"
D1_JSON=$(npx wrangler d1 create intent-trace --location apac 2>&1 || true)
D1_ID=$(echo "$D1_JSON" | grep -oE '"database_id": ?"[0-9a-f-]{36}"' | grep -oE '[0-9a-f-]{36}' | head -1 || true)
if [ -z "$D1_ID" ]; then
  D1_ID=$(npx wrangler d1 list --json | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const d=l.find(x=>x.name==="intent-trace");console.log(d?d.uuid:"")')
fi
echo "  database_id=$D1_ID"

echo "▶ R2"
npx wrangler r2 bucket create intent-trace-files --location apac >/dev/null 2>&1 || echo "  (既存)"

echo "▶ KV"
KV_ID=$(npx wrangler kv namespace list | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const k=l.find(x=>x.title==="intent-trace-cache");console.log(k?k.id:"")')
if [ -z "$KV_ID" ]; then
  KV_ID=$(npx wrangler kv namespace create intent-trace-cache 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
fi
echo "  kv id=$KV_ID"

node -e '
const fs=require("fs");let s=fs.readFileSync("wrangler.jsonc","utf8");
s=s.replace(/"database_id": "[^"]*"/,`"database_id": "${process.argv[1]}"`);
s=s.replace(/("binding": "CACHE", "id": ")[^"]*"/,`$1${process.argv[2]}"`);
fs.writeFileSync("wrangler.jsonc",s);' "$D1_ID" "$KV_ID"
echo "▶ wrangler.jsonc を更新しました"

echo "▶ マイグレーション"
npx wrangler d1 migrations apply intent-trace --remote

echo "▶ 初回デプロイ"
npm run deploy

echo "▶ シークレット"
for k in JWT_SECRET TAG_KEY_SECRET SETUP_TOKEN; do
  if [ "$k" = "TAG_KEY_SECRET" ]; then v=$(openssl rand -hex 32); else v=$(openssl rand -base64 36 | tr -d '\n'); fi
  printf '%s' "$v" | npx wrangler secret put "$k" -c dist/intent_trace/wrangler.json >/dev/null
  if [ "$k" = "SETUP_TOKEN" ]; then echo "  SETUP_TOKEN=$v  ← テナント作成に使います。安全な場所に保管してください"; fi
done
echo "  ※ TAG_KEY_SECRET を変更すると登録済みの暗号タグ鍵が復号できなくなります"
echo "完了"
