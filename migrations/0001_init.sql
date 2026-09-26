-- Intent-Trace 初期スキーマ
-- 時刻はすべて UTC の epoch ミリ秒 (INTEGER)、ID は UUID 文字列

-- ===== テナント / 組織 =====
CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- 作業員ログイン時の会社コード
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'standard', -- standard | pro (ヒートマップ等の上位機能)
  created_at  INTEGER NOT NULL
);

CREATE TABLE sites (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  address     TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_sites_org ON sites(org_id);

-- 施設内のエリア（ヒートマップの集計単位）
CREATE TABLE zones (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id),
  name        TEXT NOT NULL,
  floor       TEXT,
  pos_x       REAL,                          -- フロアマップ上の座標(0-1)
  pos_y       REAL
);
CREATE INDEX idx_zones_site ON zones(site_id);

-- ===== 人 =====
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  role          TEXT NOT NULL CHECK (role IN ('admin','manager','worker')),
  name          TEXT NOT NULL,
  email         TEXT,                        -- 管理者ログイン用
  employee_code TEXT NOT NULL,               -- 社員番号（作業員ログイン用）
  password_hash TEXT,                        -- 管理者: パスワード / 作業員: PIN
  badge_uid     TEXT,                        -- プランB: スマート社員証のNFC UID
  ble_id        TEXT,                        -- 携帯BLEタグの識別子 (iBeacon major:minor 等)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  UNIQUE (org_id, employee_code)
);
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_badge ON users(org_id, badge_uid);
CREATE INDEX idx_users_ble ON users(org_id, ble_id);

CREATE TABLE qualifications (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  code        TEXT NOT NULL,                 -- 例: FORKLIFT, ELEC_2
  name        TEXT NOT NULL,
  UNIQUE (org_id, code)
);

CREATE TABLE user_qualifications (
  user_id          TEXT NOT NULL REFERENCES users(id),
  qualification_id TEXT NOT NULL REFERENCES qualifications(id),
  certified_at     INTEGER,
  expires_at       INTEGER,                  -- NULL = 無期限
  PRIMARY KEY (user_id, qualification_id)
);

-- ===== モノ =====
CREATE TABLE equipment (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organizations(id),
  site_id              TEXT NOT NULL REFERENCES sites(id),
  zone_id              TEXT REFERENCES zones(id),
  name                 TEXT NOT NULL,
  category             TEXT,                 -- 配電盤, 消火器, フォークリフト ...
  model                TEXT,
  serial_no            TEXT,
  location_note        TEXT,
  required_qualification_id TEXT REFERENCES qualifications(id), -- 操作に必要な資格
  lockable             INTEGER NOT NULL DEFAULT 0, -- バーチャルキー(占有ロック)対象か
  inspection_interval_days INTEGER,          -- 点検周期
  checklist_json       TEXT,                 -- 点検項目 ["外観異常なし", ...]
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_equipment_site ON equipment(site_id);

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  equipment_id  TEXT REFERENCES equipment(id),
  kind          TEXT NOT NULL DEFAULT 'manual', -- manual | photo | report
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  uploaded_by   TEXT REFERENCES users(id),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_documents_equipment ON documents(equipment_id);

-- ===== NFCタグ（仮想ビーコン） =====
-- タグ自体は識別子しか持たない。状態はすべてクラウド側。
CREATE TABLE tags (
  id            TEXT PRIMARY KEY,            -- URL に埋め込む公開ID (/t/:id)
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  site_id       TEXT NOT NULL REFERENCES sites(id),
  zone_id       TEXT REFERENCES zones(id),
  kind          TEXT NOT NULL CHECK (kind IN ('checkpoint','equipment','procedure_step','deadman')),
  label         TEXT NOT NULL,
  equipment_id  TEXT REFERENCES equipment(id),
  security      TEXT NOT NULL DEFAULT 'static' CHECK (security IN ('static','sun')),
  uid           TEXT,                        -- 物理UID (hex, 大文字)
  sun_meta_key  TEXT,                        -- NTAG424 SDMMetaReadKey (hex, 暗号化保存推奨)
  sun_file_key  TEXT,                        -- NTAG424 SDMFileReadKey (hex)
  sun_last_ctr  INTEGER NOT NULL DEFAULT -1, -- リプレイ防止用 最終カウンタ
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_tags_site ON tags(site_id);
CREATE INDEX idx_tags_uid ON tags(org_id, uid);

-- ===== 巡回ルート =====
CREATE TABLE patrol_routes (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  site_id       TEXT NOT NULL REFERENCES sites(id),
  name          TEXT NOT NULL,
  enforce_order INTEGER NOT NULL DEFAULT 0,
  time_limit_min INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE patrol_route_points (
  route_id  TEXT NOT NULL REFERENCES patrol_routes(id),
  seq       INTEGER NOT NULL,
  tag_id    TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (route_id, seq)
);

CREATE TABLE patrol_runs (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  route_id     TEXT NOT NULL REFERENCES patrol_routes(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL CHECK (status IN ('in_progress','completed','abandoned')),
  next_seq     INTEGER NOT NULL DEFAULT 1,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX idx_patrol_runs_user ON patrol_runs(user_id, status);

-- ===== 作業手順（インターロック） =====
CREATE TABLE procedures (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  equipment_id  TEXT REFERENCES equipment(id),
  name          TEXT NOT NULL,
  unlocks_equipment INTEGER NOT NULL DEFAULT 0, -- 全手順完了で設備のロック解除(起動許可)
  created_at    INTEGER NOT NULL
);

CREATE TABLE procedure_steps (
  procedure_id  TEXT NOT NULL REFERENCES procedures(id),
  seq           INTEGER NOT NULL,
  tag_id        TEXT NOT NULL REFERENCES tags(id),
  instruction   TEXT NOT NULL,
  PRIMARY KEY (procedure_id, seq)
);

CREATE TABLE procedure_runs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  procedure_id  TEXT NOT NULL REFERENCES procedures(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL CHECK (status IN ('in_progress','completed','aborted')),
  next_seq      INTEGER NOT NULL DEFAULT 1,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX idx_procedure_runs_user ON procedure_runs(user_id, status);

-- ===== タップ（証跡の原本） =====
CREATE TABLE tap_events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  site_id         TEXT NOT NULL,
  zone_id         TEXT,
  tag_id          TEXT NOT NULL REFERENCES tags(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  source          TEXT NOT NULL,              -- pwa_url | pwa_webnfc | reader
  assurance       TEXT NOT NULL CHECK (assurance IN ('high','medium','low')),
  purpose         TEXT NOT NULL,              -- checkin | inspection | patrol | procedure | unlock | deadman
  client_event_id TEXT,                       -- オフライン再送の冪等キー
  occurred_at     INTEGER NOT NULL,           -- 端末でタップした時刻
  received_at     INTEGER NOT NULL,           -- サーバ受信時刻
  offline         INTEGER NOT NULL DEFAULT 0,
  sun_ctr         INTEGER,                    -- NTAG424 SUN の読取カウンタ（リプレイ検出）
  meta_json       TEXT,
  UNIQUE (user_id, client_event_id)
);
CREATE UNIQUE INDEX idx_tap_sun_ctr ON tap_events(tag_id, sun_ctr) WHERE sun_ctr IS NOT NULL;
CREATE INDEX idx_tap_site_time ON tap_events(site_id, occurred_at);
CREATE INDEX idx_tap_tag_time ON tap_events(tag_id, occurred_at);
CREATE INDEX idx_tap_user_time ON tap_events(user_id, occurred_at);

-- ===== 点検記録（設備カルテ） =====
CREATE TABLE inspections (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  site_id         TEXT NOT NULL,
  equipment_id    TEXT NOT NULL REFERENCES equipment(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  tap_event_id    TEXT REFERENCES tap_events(id),
  result          TEXT NOT NULL CHECK (result IN ('ok','ng','needs_followup')),
  checklist_json  TEXT,
  note            TEXT,
  photo_keys_json TEXT,
  started_at      INTEGER,                    -- タップ時刻（所要時間分析用）
  completed_at    INTEGER NOT NULL
);
CREATE INDEX idx_inspections_equipment ON inspections(equipment_id, completed_at);
CREATE INDEX idx_inspections_site ON inspections(site_id, completed_at);

-- ===== ヒヤリハット / 接近イベント =====
CREATE TABLE incidents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  zone_id       TEXT,
  source        TEXT NOT NULL CHECK (source IN ('ble','manual','deadman','interlock')),
  severity      TEXT NOT NULL CHECK (severity IN ('info','warning','danger')),
  user_id       TEXT REFERENCES users(id),
  equipment_id  TEXT REFERENCES equipment(id),
  device_id     TEXT,
  distance_m    REAL,
  rssi          INTEGER,
  title         TEXT NOT NULL,
  note          TEXT,
  photo_keys_json TEXT,
  occurred_at   INTEGER NOT NULL,
  received_at   INTEGER NOT NULL,
  device_event_id TEXT,
  UNIQUE (device_id, device_event_id)
);
CREATE INDEX idx_incidents_site_time ON incidents(site_id, occurred_at);

-- ===== IoT デバイス（重機レシーバー / 固定リーダー） =====
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id),
  site_id       TEXT NOT NULL REFERENCES sites(id),
  kind          TEXT NOT NULL CHECK (kind IN ('ble_receiver','nfc_reader')),
  name          TEXT NOT NULL,
  equipment_id  TEXT REFERENCES equipment(id),
  tag_id        TEXT REFERENCES tags(id),     -- 固定リーダーが代理する地点
  token_hash    TEXT NOT NULL,
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL
);

-- ===== デッドマン（単独作業の生存確認） =====
CREATE TABLE deadman_sessions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  interval_sec  INTEGER NOT NULL,
  grace_sec     INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','ended','alarm')),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  last_checkin_at INTEGER
);
CREATE INDEX idx_deadman_user ON deadman_sessions(user_id, status);

-- ===== アラート =====
CREATE TABLE alerts (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  site_id       TEXT NOT NULL,
  type          TEXT NOT NULL,                -- deadman_missed | proximity | unauthorized | interlock_violation | inspection_ng
  severity      TEXT NOT NULL CHECK (severity IN ('info','warning','danger')),
  user_id       TEXT,
  ref_id        TEXT,
  message       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  acked_by      TEXT,
  acked_at      INTEGER
);
CREATE INDEX idx_alerts_site ON alerts(site_id, created_at);
CREATE INDEX idx_alerts_open ON alerts(org_id, acked_at);

-- ===== 監査ログ（設備の占有・資格判定など） =====
CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  detail_json   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_org_time ON audit_logs(org_id, created_at);

-- 巡回の各地点の到達記録
CREATE TABLE patrol_run_visits (
  run_id       TEXT NOT NULL REFERENCES patrol_runs(id),
  seq          INTEGER NOT NULL,
  tap_event_id TEXT NOT NULL REFERENCES tap_events(id),
  visited_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
