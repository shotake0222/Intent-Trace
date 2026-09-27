-- 通知（メール・LINE）、運営の二段階認証、QR打刻

-- ===== 通知の送信キュー兼履歴 =====
CREATE TABLE notification_outbox (
  id          TEXT PRIMARY KEY,
  org_id      TEXT,                          -- NULL = 運営宛
  channel     TEXT NOT NULL CHECK (channel IN ('email','line')),
  to_address  TEXT NOT NULL,                 -- メールアドレス / LINE userId・groupId
  to_label    TEXT,                          -- 表示用（氏名・グループ名）
  event_type  TEXT NOT NULL,                 -- alert | invite | password_reset | invoice | reminder | test ...
  ref_id      TEXT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,                 -- テキスト本文（LINE はこのまま送信）
  html        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX idx_outbox_status ON notification_outbox(status, created_at);
CREATE INDEX idx_outbox_org ON notification_outbox(org_id, created_at);
CREATE INDEX idx_outbox_ref ON notification_outbox(event_type, ref_id);

-- ===== LINE 連携先（個人 / グループ） =====
CREATE TABLE line_targets (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  user_id      TEXT REFERENCES users(id),     -- 個人連携の場合
  line_id      TEXT NOT NULL,                 -- LINE userId / groupId
  kind         TEXT NOT NULL CHECK (kind IN ('user','group')),
  display_name TEXT,
  min_severity TEXT NOT NULL DEFAULT 'warning' CHECK (min_severity IN ('info','warning','danger')),
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE (org_id, line_id)
);

CREATE TABLE line_link_codes (
  code       TEXT PRIMARY KEY,               -- 6桁（LINE で送信してもらう）
  org_id     TEXT NOT NULL,
  user_id    TEXT,
  created_by TEXT,
  expires_at INTEGER NOT NULL
);

-- ===== パスワード再設定 =====
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  subject    TEXT NOT NULL CHECK (subject IN ('user','ops')),
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

-- ===== 通知設定 =====
-- 組織: {"alertEmail":"danger","alertLine":"warning","extraEmails":["..."],"invoiceEmail":true}
ALTER TABLE organizations ADD COLUMN notify_json TEXT;
-- 管理者・マネージャー個人がアラートメールを受け取るか
ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1;

-- ===== QR 打刻 =====
ALTER TABLE organizations ADD COLUMN allow_qr_checkin INTEGER NOT NULL DEFAULT 1;

-- ===== 運営の二段階認証（TOTP） =====
ALTER TABLE platform_admins ADD COLUMN totp_secret TEXT;          -- 封印済み Base32
ALTER TABLE platform_admins ADD COLUMN totp_pending TEXT;         -- 登録途中の秘密
ALTER TABLE platform_admins ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_admins ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0; -- 同一コードの再利用防止
ALTER TABLE platform_admins ADD COLUMN recovery_codes_json TEXT;  -- SHA-256 ハッシュの配列

INSERT OR IGNORE INTO platform_settings (key, value) VALUES
  ('email_provider', 'none'),
  ('email_from', ''),
  ('email_from_name', 'Intent-Trace'),
  ('line_bot_basic_id', ''),
  ('app_base_url', ''),
  ('require_ops_2fa', '0');
