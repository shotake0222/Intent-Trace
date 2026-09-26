-- 運営（プラットフォーム）機能: プラン、契約状態、運営アカウント、タグ在庫、請求、お知らせ、サポート

-- ===== 料金プラン =====
CREATE TABLE plans (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  monthly_fee   INTEGER NOT NULL DEFAULT 0,    -- 円（税抜）
  fee_per_tag   INTEGER NOT NULL DEFAULT 0,    -- 稼働タグ1枚あたり月額
  fee_per_user  INTEGER NOT NULL DEFAULT 0,    -- 有効ユーザー1人あたり月額
  included_tags INTEGER NOT NULL DEFAULT 0,    -- 月額に含まれるタグ数
  included_users INTEGER NOT NULL DEFAULT 0,
  max_tags      INTEGER,                       -- NULL = 無制限
  max_users     INTEGER,
  max_sites     INTEGER,
  features_json TEXT NOT NULL DEFAULT '[]',    -- ["analytics","reports","devices","sun"]
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0
);
INSERT INTO plans (code, name, monthly_fee, fee_per_tag, fee_per_user, included_tags, included_users, max_tags, max_users, max_sites, features_json, sort) VALUES
  ('trial',    'トライアル',   0,     0,  0,   30,  10,  30,   10,   1,    '["reports"]', 0),
  ('standard', 'スタンダード', 9800,  50, 300, 50,  10,  500,  100,  5,    '["reports","devices"]', 1),
  ('pro',      'プロ',         29800, 40, 250, 200, 30,  NULL, NULL, NULL, '["reports","devices","analytics","sun"]', 2);

-- ===== 契約情報（テナント） =====
ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- trial | active | suspended | cancelled
ALTER TABLE organizations ADD COLUMN trial_ends_at INTEGER;
ALTER TABLE organizations ADD COLUMN contract_started_at INTEGER;
ALTER TABLE organizations ADD COLUMN contact_name TEXT;
ALTER TABLE organizations ADD COLUMN contact_email TEXT;
ALTER TABLE organizations ADD COLUMN contact_phone TEXT;
ALTER TABLE organizations ADD COLUMN billing_email TEXT;
ALTER TABLE organizations ADD COLUMN address TEXT;
ALTER TABLE organizations ADD COLUMN notes TEXT;                  -- 運営メモ（テナントには非表示）
ALTER TABLE organizations ADD COLUMN max_tags_override INTEGER;   -- 個別契約で上限を変える場合
ALTER TABLE organizations ADD COLUMN max_users_override INTEGER;

-- ===== 運営アカウント =====
CREATE TABLE platform_admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','staff')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE platform_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO platform_settings (key, value) VALUES
  ('company_name', '合同会社Straid'),
  ('company_address', ''),
  ('invoice_registration_no', ''),
  ('bank_info', ''),
  ('support_email', ''),
  ('tax_rate', '10');

CREATE TABLE platform_audit_logs (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_platform_audit_time ON platform_audit_logs(created_at);

-- ===== NFC ハードウェア在庫（運営が発行・出荷し、テナントが現地で登録する） =====
-- id はタグに書き込む公開ID（URL /t/<id>）。登録時に tags.id として引き継ぐ。
CREATE TABLE tag_stock (
  id            TEXT PRIMARY KEY,
  item_type     TEXT NOT NULL CHECK (item_type IN ('location_tag','badge')), -- 設置タグ / スマート社員証
  chip          TEXT NOT NULL CHECK (chip IN ('ntag213','ntag215','ntag216','ntag424','mifare','other')),
  uid           TEXT,                      -- 物理UID（エンコード後に取り込み）
  sun_meta_key  TEXT,                      -- NTAG424: AES-GCM で封印した鍵
  sun_file_key  TEXT,
  batch         TEXT NOT NULL,             -- ロット名
  status        TEXT NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','allocated','registered','retired')),
  org_id        TEXT REFERENCES organizations(id),
  allocated_at  INTEGER,
  shipment_note TEXT,
  registered_at INTEGER,
  registered_user_id TEXT,                 -- 社員証の割当先
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_tag_stock_org ON tag_stock(org_id, status);
CREATE INDEX idx_tag_stock_batch ON tag_stock(batch);
CREATE UNIQUE INDEX idx_tag_stock_uid ON tag_stock(uid) WHERE uid IS NOT NULL;

-- ===== 請求 =====
CREATE TABLE invoices (
  id          TEXT PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,        -- INV-202609-0001
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  period      TEXT NOT NULL,               -- YYYY-MM
  plan_code   TEXT NOT NULL,
  items_json  TEXT NOT NULL,               -- [{label, qty, unit, amount}]
  subtotal    INTEGER NOT NULL,
  tax         INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft','issued','paid','void')),
  issued_at   INTEGER,
  due_at      INTEGER,
  paid_at     INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (org_id, period)
);

-- ===== お知らせ =====
CREATE TABLE announcements (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','maintenance','important')),
  org_id       TEXT REFERENCES organizations(id), -- NULL = 全テナント
  published_at INTEGER NOT NULL,
  expires_at   INTEGER,
  created_by   TEXT,
  created_at   INTEGER NOT NULL
);

-- ===== サポート問い合わせ =====
CREATE TABLE support_tickets (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  user_id     TEXT REFERENCES users(id),
  subject     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general', -- general | tags | billing | bug | request
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_tickets_org ON support_tickets(org_id, updated_at);

CREATE TABLE support_messages (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES support_tickets(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('tenant','platform')),
  author_id   TEXT,
  author_name TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_ticket ON support_messages(ticket_id, created_at);

-- パスワード変更・強制ログアウト時にセッションを失効させるための世代番号
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_admins ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
