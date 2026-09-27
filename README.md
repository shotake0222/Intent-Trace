# Intent-Trace

空間・設備・安全の統合マネジメントプラットフォーム（合同会社Straid）

NFC（意図・ゼロ距離の証明）と BLE（空間・接近の検知）を組み合わせ、巡回・点検の確実な記録、設備カルテ、資格に基づく操作権限、手順インターロック、単独作業の生存確認、重機接近のヒヤリハット分析を一つのプロダクトで提供します。クラウド側は Cloudflare のエッジに完全集約しています。

## アーキテクチャ

```mermaid
flowchart LR
  subgraph 現場
    Tag["NFCタグ<br/>URL＋ID のみ"]:::p
    Phone["作業員スマホ PWA<br/>オフラインキュー"]
    Badge["BLEタグ/社員証"]
    Rx["重機側 ESP32 受信機<br/>警報・減速はローカル完結"]
    Reader["固定NFCリーダー<br/>プランB"]
  end
  Tag -- タッチ --> Phone
  Badge -. 接近 .-> Rx
  subgraph Cloudflare
    W["Workers (Hono)<br/>API + 静的配信"]
    DO1["DO: EquipmentLock<br/>バーチャルキー"]
    DO2["DO: DeadmanTimer<br/>Alarm で確実に発火"]
    DO3["DO: SiteHub<br/>WebSocket配信"]
    D1[("D1")]
    R2[("R2 マニュアル/写真")]
    KV[("KV タグキャッシュ")]
  end
  Phone -- HTTPS --> W
  Rx -- 接近ログ(後送) --> W
  Reader --> W
  W --> DO1 & DO2 & DO3 & D1 & R2 & KV
  DO3 -- リアルタイム --> Admin["管理ダッシュボード"]
  classDef p fill:#fef3c7
```

| 企画書の要素 | 実装 |
|---|---|
| フロントエンド (Pages) | **Workers Static Assets**（Pages の後継。API と同一 Worker・同一オリジンで配信） |
| API (Workers) | `worker/` — Hono。タップ判定、資格判定、打刻、ヒヤリハット受信 |
| リアルタイム排他制御 (DO) | `EquipmentLock`（誰が操作中か）、`DeadmanTimer`（残り時間・Alarm）、`SiteHub`（WebSocket 配信） |
| D1 | 従業員・資格・設備・タグ・点検・巡回・ヒヤリハット・監査ログ（`migrations/`） |
| R2 | マニュアルPDF・点検写真（Worker 経由で認可付き配信） |
| KV | タグ定義のエッジキャッシュ、ログイン試行のレート制限 |
| 物理安全層 | `firmware/forklift-receiver/`（ESP32 リファレンス。通信断でも警報は動作） |

## 「NFC の仮想ビーコン化」の実装ポイント

- タグには `https://<host>/t/<tagId>` の **URL だけ** を書き込みます。iPhone / Android ともアプリ不要でタッチ → PWA が開き打刻されます。
- 状態（巡回の進捗、手順の段階、デッドマンの期限、設備の占有者）はすべてクラウド側。1 回のタッチが文脈に応じて「巡回の地点通過」「手順ステップの完了」「生存応答」「設備カルテの呼び出し」に解釈されます（`worker/lib/tap.ts`）。
- **証明レベル** をタップごとに記録します。
  - `high` … NTAG 424 DNA の SUN（タッチごとに生成される暗号署名付きURL）を検証済み／固定リーダー
  - `medium` … Android のアプリ内スキャンで物理UIDを照合
  - `low` … 静的URLのみ（URLを知っていれば再現可能）
- SUN はカウンタの単調増加と一意制約でリプレイ（撮影したURLでの不正打刻）を拒否します（`worker/lib/sun.ts`、NXP AN12196 のテストベクタで検証済み）。
- 点検記録は「完了時刻の30分以内に本人がその設備タグへタッチしていること」を要求し、バーチャルキーは「5分以内のタッチ＋有効な資格」を要求します。

## 機能一覧

**作業員 PWA**（`/`）: タグ着地ページ、設備カルテ（PDFマニュアル・履歴）、点検チェックリスト＋写真、巡回（順序強制可）、バーチャルキー、手順インターロック、単独作業の生存確認、ヒヤリハット報告、Android のアプリ内NFCスキャン、オフライン保存と自動再送。

**管理ダッシュボード**（`/admin`）: リアルタイムフィード、未対応アラート、単独作業者の残り時間、設備の使用状況、日別推移、ゾーン別ヒートマップ・曜日×時間帯・作業員別・重機別（Pro）、点検所要時間分析（Pro）、月次報告書（印刷/PDF）、CSV出力、設備・タグ・ユーザー・資格・巡回・手順・IoTデバイス・現場/ゾーン管理、監査ログ。

**デバイス API**（`/api/device/*`, `Authorization: Device <id>.<token>`）: BLE接近ログのバッチ受信、起動許可（ignition）状態、固定リーダーでの社員証タッチ（プランB）。

## 画面構成（3層）

| 画面 | URL | 利用者 | 主な機能 |
|---|---|---|---|
| 運営コンソール | `/ops` | 合同会社Straid（オーナー / スタッフ） | テナント作成・契約管理・利用停止、代理ログイン、NFCタグ在庫（発行→UID取込→出荷割当）、請求書発行・入金管理、料金プラン、お知らせ配信、サポート対応、運営監査ログ |
| テナント管理画面 | `/admin` | 契約企業の管理者・マネージャー | ダッシュボード、分析、記録・レポート、設備カルテ、**受領タグの登録・交換**、巡回・手順、作業員・資格・社員証、IoTデバイス、現場・ゾーン、契約・請求書・お問い合わせ・パスワード |
| 現場アプリ（PWA） | `/` | 作業員 | タッチ記録、点検、巡回、手順、生存確認、ヒヤリハット |

初回は `/ops/login` でセットアップトークンを入力して運営オーナーを作成します。

### NFCタグのライフサイクル

1. **発行**（運営）: 登録コード（=タグURLのID）を採番。NTAG 424 DNA はタグ固有の暗号鍵も生成
2. **書き込み**（運営/業者）: CSV（NTAG424は鍵付きCSV・オーナーのみ）でURLを書き込み、ラベル印刷シートを貼付
3. **UID取込**（運営）: 書き込みツールの出力（登録コード, UID）を取り込み
4. **出荷割当**（運営）: テナントに割り当て（送り状番号などをメモ）
5. **現地登録**（テナント）: 貼った場所で管理者がスマホをタッチ → その場で用途・呼び名・設備を登録。管理画面で登録コード入力でも可
6. **交換**（テナント）: 破損・紛失時は新しいタグに交換。巡回ルート・手順・固定リーダーの紐付けは自動で引き継ぎ
7. **社員証**: 出荷された社員証は「作業員・資格」でユーザーに割り当て（固定リーダーでの認証に使用）

プランごとの上限（タグ・ユーザー・現場）と機能（分析・IoT・レポート・暗号鍵の手動登録）は運営コンソールの「料金プラン」で設定し、テナント個別に上限を上書きできます。

## 通知・セキュリティ

**メール / LINE 通知**（運営コンソール「設定・通知・セキュリティ」で設定）

| 通知 | 宛先 | 経路 |
|---|---|---|
| ご利用開始の案内（初期パスワード） | テナント初期管理者 | メール |
| ユーザー招待（PIN・初期パスワード） | メールを登録した作業員・管理者 | メール |
| パスワード再設定リンク（1時間・1回限り） | 管理者・マネージャー／運営 | メール |
| 運営によるパスワード再発行 | 対象ユーザー | メール |
| 請求書発行・再送 | 請求書送付先（なければ担当者・管理者） | メール |
| アラート（生存確認・接近・無資格操作・点検異常 など） | 管理者・マネージャー＋追加宛先／連携したLINEグループ・個人 | メール・LINE |
| トライアル終了3日前・支払期限経過 | 請求書送付先 | メール（Cron） |

- メール送信サービスは Brevo / Resend / SendGrid から選択（APIキーは暗号化保存）。未設定でも送信履歴に内容は記録されます。
- LINE は Messaging API。LINE Developers に Webhook URL（`/api/line/webhook`）を登録し、テナント管理者が発行した連携コード（IT-XXXXXXXX）をグループ／個人トークで送ると連携されます。
- すべての通知は `notification_outbox` に記録され、失敗分は Cron（10分ごと）で最大5回再送。同一内容のアラートは3分以内の重複送信を抑止。

**運営の二段階認証（TOTP）**: Google Authenticator 等に対応。ログインは「パスワード → 6桁コード（またはリカバリーコード10個・各1回）」。同じコードの再利用は拒否。オーナーは「全運営アカウントに必須化」「他アカウントの2FAリセット」が可能。

**タグのQRコード**: 運営のラベルシートとテナント管理画面の「ラベル印刷（QR付き）」でQR入りラベルを印刷できます。QRは `/t/<ID>?src=qr` を指し、読み取りは「QR読取・証明レベル低」として記録されます（撮影で再現できるため）。テナントは「通知」設定でQR打刻を禁止できます。

## サービス紹介ページ（LP）

- `web/public/lp/`（`index.html`・`privacy.html`・`img/`）。未ログインで `/` を開くとLP、ログイン中はアプリを表示。`/lp/` は常にLP
- スタイルは Tailwind をビルドした `web/public/lp/lp.css`（HTMLを編集したら `npm run build:lp`）
- お問い合わせフォームは Formspree（`https://formspree.io/f/xppwyngv`）へ送信
- 掲載価格は運営コンソール「料金プラン」と一致させること
- 利用規約 `web/public/lp/terms.html`。改定時は `shared/types.ts` の `TERMS_VERSION` を更新すると、各テナント管理者に再同意を求める

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars          # 値を設定
npm run db:migrate:local
npm run dev                              # http://localhost:5173
# 別ターミナルでデモデータ投入（30日分の擬似履歴つき）
node scripts/seed-demo.mjs http://localhost:5173 <SETUP_TOKEN> --history
npx wrangler d1 execute intent-trace --local --file=seed/history.sql
```

デモアカウント: 管理者 `admin@demo.example / demo-admin-pass`、作業員 会社コード `DEMO` / 社員番号 `W001`〜`W003` / PIN `1234`

テスト:

```bash
npm test                                  # 単体（AES-CMAC / SUN / TOTP）
node scripts/e2e.mjs http://localhost:5173         # 現場・管理の結合テスト（seed 後）
node scripts/e2e-ops.mjs http://localhost:5173     # 運営・タグ登録
node scripts/e2e-notify.mjs http://localhost:5173  # 通知・二段階認証・QR
node scripts/e2e-tenancy.mjs http://localhost:5173 # テナント分離・規約同意・権限失効（e2e-ops の後）
```

## デプロイ（Cloudflare）

**GitHub Actions（標準）**: リポジトリの Secrets に `CLOUDFLARE_API_TOKEN`（任意で `CLOUDFLARE_ACCOUNT_ID`）を登録すると、`main` への push ごとに `scripts/ci-deploy.sh` が以下を冪等に実行します。

- D1 / KV / R2 がなければ作成し、ID を `wrangler.jsonc` に差し込んでビルド
- D1 マイグレーション → デプロイ → Worker シークレット（`JWT_SECRET` / `TAG_KEY_SECRET`）の初回生成
- 初回のみ `SETUP_TOKEN` を生成してデモテナントを作成し、認証情報を `deploy/operator.pub.pem` の公開鍵で暗号化してログに出力（公開リポジトリでも平文は残りません。対応する秘密鍵は運営者のみが保持）

**手元から（代替）**: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を設定して `./scripts/provision.sh`。

テナント追加:
   ```bash
   curl -X POST https://<host>/api/auth/setup -H 'content-type: application/json' \
     -d '{"token":"<SETUP_TOKEN>","orgName":"株式会社○○","orgCode":"ABC","siteName":"本社ビル","adminName":"山田","email":"...","password":"..."}'
   ```

## NTAG 424 DNA の設定（暗号タグ）

NXP TagXplorer 等で NDEF ファイルに URL `https://<host>/t/<tagId>?picc=<32桁>&cmac=<16桁>` を書き込み、SDM を以下で有効化します。

- UID ミラー・読取カウンタミラー: 有効（PICCData を暗号化 = SDMMetaRead に鍵を割当）
- PICCDataOffset: `picc=` の値の先頭、SDMMACOffset / SDMMACInputOffset: `cmac=` の値の先頭（MAC 入力は空）
- 管理画面でタグ登録時に SDMMetaReadKey / SDMFileReadKey と UID を入力（鍵は `TAG_KEY_SECRET` で AES-GCM 暗号化して D1 に保存）
- タグごとに固有鍵を使用してください（デモの全ゼロ鍵は NXP の公開テストベクタ用）

## 既知の制約・今後

- iPhone の Safari は Web NFC 非対応のため、iPhone では URL 方式（証明レベルは static タグで `low`、SUN タグで `high`）。
- ブラウザ（PWA）からは BLE 発信ができないため、接近検知は携帯 BLE タグ＋重機側受信機の構成。
- 集計は JST 固定（サイト別タイムゾーンは未対応）。
- Webプッシュ通知、元請けへの自動レポート送付、オンライン決済（カード・口座振替）は未実装（請求書発行・入金消込は運営コンソールで手動）。
- ファームウェアはリファレンス（未コンパイル・未実機検証）。車両制動との連動は機能安全評価が前提（フェーズ3）。
