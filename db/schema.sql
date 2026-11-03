-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Table to store style guide rules with 768-dimensional embeddings from Gemini text-embedding-004
CREATE TABLE IF NOT EXISTS style_rules (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768)
);

