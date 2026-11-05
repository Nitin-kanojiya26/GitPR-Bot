-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Installations table (each tenant is an installed GitHub account or org)
CREATE TABLE IF NOT EXISTS installations (
  installation_id BIGINT PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Installation Settings table (encrypted Gemini keys, custom guide markdown, index state)
CREATE TABLE IF NOT EXISTS installation_settings (
  installation_id BIGINT PRIMARY KEY REFERENCES installations(installation_id) ON DELETE CASCADE,
  encrypted_key TEXT,
  key_iv_and_tag TEXT,
  last4 VARCHAR(4),
  guide_md TEXT,
  guide_version INT DEFAULT 1,
  index_status TEXT DEFAULT 'pending',
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Rules table (partitioned by installation_id with pgvector embedding)
CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rules_installation_id ON rules (installation_id);

-- 4. Reviews table (audit log of reviews run for each installation)
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  pr_number INT NOT NULL,
  head_sha TEXT NOT NULL,
  comments_posted INT DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  duration_ms INT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reviews_installation_id ON reviews (installation_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews (created_at);

-- 5. Comments table (individual review comments posted, with outcome tracking)
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  review_id INT REFERENCES reviews(id) ON DELETE CASCADE,
  github_comment_id BIGINT,
  repo TEXT NOT NULL,
  pr_number INT NOT NULL,
  file TEXT NOT NULL,
  line INT NOT NULL,
  rule_title TEXT,
  severity TEXT NOT NULL,
  outcome TEXT DEFAULT 'open',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  outcome_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_comments_installation_id ON comments (installation_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments (created_at);

-- 6. Webhook Deliveries table (delivery id deduplication for idempotency)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received_at ON webhook_deliveries (received_at);

-- 7. Sessions table (server-side session storage)
CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire);
