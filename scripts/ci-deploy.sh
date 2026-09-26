#!/usr/bin/env bash
# GitHub Actions 用: Cloudflare リソースを冪等に用意してデプロイする
#   必要な環境変数: CLOUDFLARE_API_TOKEN（CLOUDFLARE_ACCOUNT_ID は未設定なら自動取得）
# 初回（Worker に SETUP_TOKEN が未登録）のみ、シークレット生成とデモテナント作成を行い、
# 認証情報を deploy/operator.pub.pem で暗号化してログに出力する（公開リポジトリでも平文は出さない）
set -euo pipefail
cd "$(dirname "$0")/.."

# 失敗時はログ末尾をアノテーションに出す（ログ本体を開けない環境でも原因が分かるように）
LOG=/tmp/ci-deploy.log
exec > >(tee "$LOG") 2>&1
trap 'rc=$?; msg=$(tail -n 25 "$LOG" | grep -v "::add-mask::" | sed "s/%/%25/g" | awk "{printf \"%s%%0A\", \$0}"); echo "::error title=ci-deploy failed (line $LINENO, rc=$rc)::$msg"' ERR

api() { curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "https://api.cloudflare.com/client/v4$1"; }

# アカウントID: Secret → wrangler.jsonc の account_id → API（/accounts, /memberships）の順で解決
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID=$(node -e 'const s=require("fs").readFileSync("wrangler.jsonc","utf8");const m=s.match(/"account_id":\s*"([0-9a-f]{32})"/);console.log(m?m[1]:"")')
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  for ep in /accounts /memberships; do
    CLOUDFLARE_ACCOUNT_ID=$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" "https://api.cloudflare.com/client/v4$ep" | node -e 'let d={};try{d=JSON.parse(require("fs").readFileSync(0))}catch{};const r=d.result?.[0];console.log(r?(r.account?.id??r.id):"");if(!r)console.error("'"$ep"'", JSON.stringify(d.errors??d).slice(0,300))')
    [ -n "$CLOUDFLARE_ACCOUNT_ID" ] && break
  done
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "アカウントIDを特定できません。wrangler.jsonc に \"account_id\" を設定してください"
  curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" https://api.cloudflare.com/client/v4/user/tokens/verify | head -c 300; echo
  false
fi
export CLOUDFLARE_ACCOUNT_ID
echo "::add-mask::${CLOUDFLARE_ACCOUNT_ID}"

echo "▶ D1"
find_d1() { npx wrangler d1 list --json 2>/dev/null | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const d=l.find(x=>x.name==="intent-trace");console.log(d?d.uuid:"")'; }
D1_ID=$(find_d1)
if [ -z "$D1_ID" ]; then npx wrangler d1 create intent-trace --location apac >/dev/null; D1_ID=$(find_d1); fi
[ -n "$D1_ID" ] || { echo "D1 の作成に失敗しました"; exit 1; }

echo "▶ KV"
find_kv() { npx wrangler kv namespace list 2>/dev/null | node -e 'const l=JSON.parse(require("fs").readFileSync(0));const k=l.find(x=>x.title==="intent-trace-cache"||x.title.endsWith("-intent-trace-cache"));console.log(k?k.id:"")'; }
KV_ID=$(find_kv)
if [ -z "$KV_ID" ]; then npx wrangler kv namespace create intent-trace-cache >/dev/null; KV_ID=$(find_kv); fi
[ -n "$KV_ID" ] || { echo "KV の作成に失敗しました"; exit 1; }

echo "▶ R2"
if ! npx wrangler r2 bucket list 2>/dev/null | grep -q "intent-trace-files"; then
  npx wrangler r2 bucket create intent-trace-files --location apac || {
    echo "::error::R2 バケットを作成できません。Cloudflare ダッシュボードで R2 を有効化（初回のみ・無料枠あり）してから再実行してください"; exit 1; }
fi

node -e '
const fs=require("fs");let s=fs.readFileSync("wrangler.jsonc","utf8");
s=s.replace(/"database_id": "[^"]*"/,`"database_id": "${process.argv[1]}"`);
s=s.replace(/("binding": "CACHE", "id": ")[^"]*"/,`$1${process.argv[2]}"`);
fs.writeFileSync("wrangler.jsonc",s);' "$D1_ID" "$KV_ID"

echo "▶ マイグレーション"
npx wrangler d1 migrations apply intent-trace --remote

echo "▶ ビルド & デプロイ"
npx vite build
npx wrangler deploy -c dist/intent_trace/wrangler.json | tee /tmp/deploy.log
URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' /tmp/deploy.log | head -1 || true)
if [ -z "$URL" ]; then
  SUB=$(api "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).result?.subdomain??"")')
  URL="https://intent-trace.${SUB}.workers.dev"
fi
echo "APP_URL=${URL}"
echo "### デプロイ先: ${URL}" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "▶ シークレット"
EXISTING=$(npx wrangler secret list -c dist/intent_trace/wrangler.json 2>/dev/null || echo "[]")
has() { echo "$EXISTING" | grep -q "\"$1\""; }
put() { printf '%s' "$2" | npx wrangler secret put "$1" -c dist/intent_trace/wrangler.json >/dev/null; }
has JWT_SECRET || put JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
has TAG_KEY_SECRET || put TAG_KEY_SECRET "$(openssl rand -hex 32)"

if has SETUP_TOKEN; then
  echo "既存環境: 初期化はスキップ"
  exit 0
fi

echo "▶ 初回ブートストラップ"
SETUP_TOKEN=$(openssl rand -hex 24)
ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=\n' | cut -c1-16)
MANAGER_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=\n' | cut -c1-16)
WORKER_PIN=$(printf '%06d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 )))
for v in "$SETUP_TOKEN" "$ADMIN_PASSWORD" "$MANAGER_PASSWORD" "$WORKER_PIN"; do echo "::add-mask::$v"; done
put SETUP_TOKEN "$SETUP_TOKEN"

# 反映待ち
for i in $(seq 1 30); do
  curl -fsS "${URL}/api/health" >/dev/null 2>&1 && break
  sleep 5
done
sleep 10

ADMIN_EMAIL="admin@demo.example" ADMIN_PASSWORD="$ADMIN_PASSWORD" MANAGER_PASSWORD="$MANAGER_PASSWORD" WORKER_PIN="$WORKER_PIN" \
  node scripts/seed-demo.mjs "$URL" "$SETUP_TOKEN" --history
npx wrangler d1 execute intent-trace --remote --file=seed/history.sql >/dev/null
echo "デモデータ投入完了"

PAYLOAD=$(printf '{"url":"%s","setup":"%s","admin":"%s","manager":"%s","pin":"%s"}' "$URL" "$SETUP_TOKEN" "$ADMIN_PASSWORD" "$MANAGER_PASSWORD" "$WORKER_PIN")
ENC=$(printf '%s' "$PAYLOAD" | openssl pkeyutl -encrypt -pubin -inkey deploy/operator.pub.pem -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 | base64 -w0)
echo "BOOTSTRAP_CREDENTIALS_ENCRYPTED=${ENC}"
