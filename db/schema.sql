-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Table to store style guide rules with 768-dimensional embeddings from Gemini gemini-embedding-001
CREATE TABLE IF NOT EXISTS style_rules (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768),
  repo_full_name TEXT DEFAULT 'global'
);

-- Index for scoped vector similarity lookups
CREATE INDEX IF NOT EXISTS style_rules_repo_idx ON style_rules (repo_full_name);
