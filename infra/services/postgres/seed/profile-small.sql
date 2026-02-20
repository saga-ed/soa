-- profile-small.sql — PostgreSQL seed data (small profile)
-- 1 org, 3 users

CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  org_id VARCHAR(36) NOT NULL REFERENCES organizations(id),
  email VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL,
  display_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO organizations (id, name, slug) VALUES
  ('org-001', 'Demo School', 'demo-school')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, org_id, email, role, display_name) VALUES
  ('user-001', 'org-001', 'admin@demo.test', 'ADMIN', 'Admin User'),
  ('user-002', 'org-001', 'tutor@demo.test', 'TUTOR', 'Test Tutor'),
  ('user-003', 'org-001', 'student@demo.test', 'STUDENT', 'Test Student')
ON CONFLICT DO NOTHING;
