-- profile-basic.sql — MySQL seed data (basic profile)
-- 2 orgs, 6 users, 2 programs

CREATE DATABASE IF NOT EXISTS saga_db;
USE saga_db;

CREATE TABLE IF NOT EXISTS organizations (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  org_id VARCHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  role VARCHAR(32) NOT NULL,
  display_name VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org_id (org_id)
);

CREATE TABLE IF NOT EXISTS programs (
  id VARCHAR(36) PRIMARY KEY,
  org_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org_id (org_id)
);

INSERT INTO organizations (id, name, slug) VALUES
  ('org-001', 'Northside Academy', 'northside'),
  ('org-002', 'Riverside School', 'riverside');

INSERT INTO users (id, org_id, email, role, display_name) VALUES
  ('user-001', 'org-001', 'admin@northside.test', 'ADMIN', 'North Admin'),
  ('user-002', 'org-001', 'tutor1@northside.test', 'TUTOR', 'North Tutor 1'),
  ('user-003', 'org-001', 'student1@northside.test', 'STUDENT', 'North Student 1'),
  ('user-004', 'org-002', 'admin@riverside.test', 'ADMIN', 'River Admin'),
  ('user-005', 'org-002', 'tutor1@riverside.test', 'TUTOR', 'River Tutor 1'),
  ('user-006', 'org-002', 'student1@riverside.test', 'STUDENT', 'River Student 1');

INSERT INTO programs (id, org_id, name, status) VALUES
  ('pgm-001', 'org-001', 'Math 101', 'active'),
  ('pgm-002', 'org-002', 'Science 201', 'active');
