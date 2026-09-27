-- 利用規約への同意（テナント管理者）
ALTER TABLE organizations ADD COLUMN terms_version TEXT;
ALTER TABLE organizations ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE organizations ADD COLUMN terms_accepted_by TEXT;
