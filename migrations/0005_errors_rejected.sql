-- システムエラーの記録（サーバー・画面）と運営への通知
CREATE TABLE error_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL CHECK (source IN ('server','client')),
  method      TEXT,
  path        TEXT,
  message     TEXT NOT NULL,
  detail      TEXT,
  org_id      TEXT,
  user_id     TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL,
  reported_at INTEGER
);
CREATE INDEX idx_error_events_created ON error_events(created_at);
CREATE INDEX idx_error_events_unreported ON error_events(reported_at, created_at);

-- 再送を諦めた通知の運営エスカレーション
ALTER TABLE notification_outbox ADD COLUMN escalated_at INTEGER;

-- 現場で送信を拒否された記録（作業員の端末から自動で届く。管理者が確認する）
CREATE TABLE rejected_submissions (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  site_id      TEXT,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  photo_count  INTEGER NOT NULL DEFAULT 0,
  error        TEXT NOT NULL,
  error_code   TEXT,
  occurred_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_by  TEXT,
  resolution   TEXT,
  UNIQUE (org_id, client_id)
);
CREATE INDEX idx_rejected_org ON rejected_submissions(org_id, resolved_at, created_at);

-- BLE受信機・固定リーダー（IoT連携）は標準プランから外し、個別契約のオプションにする
UPDATE plans SET features_json = '["reports"]' WHERE code = 'standard';
UPDATE plans SET features_json = '["reports","analytics","sun"]' WHERE code = 'pro';

-- 個別見積もり（エンタープライズ）: IoT連携を含む全機能。金額は契約ごとに運営コンソールで調整する
INSERT OR IGNORE INTO plans (code, name, monthly_fee, fee_per_tag, fee_per_user, included_tags, included_users, max_tags, max_users, max_sites, features_json, sort)
VALUES ('enterprise', 'エンタープライズ', 29800, 40, 250, 200, 30, NULL, NULL, NULL, '["reports","devices","analytics","sun"]', 3);
