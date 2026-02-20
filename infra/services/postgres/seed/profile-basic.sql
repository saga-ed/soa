-- profile-basic.sql — PostgreSQL seed data (basic profile)
-- 2 orgs, 6 users, attendance records

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

CREATE TABLE IF NOT EXISTS attendance (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  org_id VARCHAR(36) NOT NULL REFERENCES organizations(id),
  date DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'present',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO organizations (id, name, slug) VALUES
  ('org-001', 'Northside Academy', 'northside'),
  ('org-002', 'Riverside School', 'riverside')
ON CONFLICT DO NOTHING;

INSERT INTO users (id, org_id, email, role, display_name) VALUES
  ('user-001', 'org-001', 'admin@northside.test', 'ADMIN', 'North Admin'),
  ('user-002', 'org-001', 'tutor1@northside.test', 'TUTOR', 'North Tutor 1'),
  ('user-003', 'org-001', 'student1@northside.test', 'STUDENT', 'North Student 1'),
  ('user-004', 'org-002', 'admin@riverside.test', 'ADMIN', 'River Admin'),
  ('user-005', 'org-002', 'tutor1@riverside.test', 'TUTOR', 'River Tutor 1'),
  ('user-006', 'org-002', 'student1@riverside.test', 'STUDENT', 'River Student 1')
ON CONFLICT DO NOTHING;

INSERT INTO attendance (id, user_id, org_id, date, status) VALUES
  ('att-001', 'user-003', 'org-001', '2025-01-15', 'present'),
  ('att-002', 'user-003', 'org-001', '2025-01-16', 'absent'),
  ('att-003', 'user-006', 'org-002', '2025-01-15', 'present')
ON CONFLICT DO NOTHING;
