-- Relativity Knowledge Base — initial schema
-- Run this in the Supabase SQL editor before starting the server.

-- pgvector extension (required for embedding storage and similarity search)
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- knowledge_documents
-- One row per source document per client.
-- source_provider + source_file_id uniquely identifies a document within a client.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL,
  source_provider TEXT,                                 -- e.g. 'google_drive'
  source_file_id  TEXT,                                 -- e.g. Google Drive file ID
  file_name       TEXT,
  mime_type       TEXT,
  content_hash    TEXT,                                 -- SHA-256 of extracted text (dedup key)
  status          TEXT        NOT NULL DEFAULT 'pending', -- pending|indexing|indexed|deleted|error
  error_message   TEXT,
  last_indexed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, source_provider, source_file_id)
);

-- ---------------------------------------------------------------------------
-- knowledge_chunks
-- Text chunks with embeddings, linked to a parent document.
-- Deleting the parent document cascades to its chunks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  UUID        NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  client_id    UUID        NOT NULL,
  chunk_index  INT         NOT NULL,
  content      TEXT        NOT NULL,
  embedding    VECTOR(1536),                            -- text-embedding-3-small output dimension
  metadata     JSONB,                                   -- fileName, sourceProvider, sourceFileId, etc.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- knowledge_ingestion_jobs
-- Audit trail for every ingest/reindex/delete operation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_ingestion_jobs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID        NOT NULL,
  document_id    UUID,                                  -- null until document row is created
  source_file_id TEXT,
  status         TEXT        NOT NULL DEFAULT 'queued', -- queued|running|completed|failed
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Vector similarity search (cosine) — used by match_knowledge_chunks
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Client-scoped chunk lookups
CREATE INDEX IF NOT EXISTS knowledge_chunks_client_idx
  ON knowledge_chunks (client_id);

-- Document status filtering per client
CREATE INDEX IF NOT EXISTS knowledge_docs_client_status_idx
  ON knowledge_documents (client_id, status);

-- Dedup lookups by source
CREATE INDEX IF NOT EXISTS knowledge_docs_source_idx
  ON knowledge_documents (source_provider, source_file_id);

-- ---------------------------------------------------------------------------
-- match_knowledge_chunks
-- Performs cosine similarity search scoped to a single client_id.
-- Call via Supabase RPC: supabase.rpc('match_knowledge_chunks', { ... })
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_knowledge_chunks (
  query_embedding  VECTOR(1536),
  match_client_id  UUID,
  match_threshold  FLOAT   DEFAULT 0.7,
  match_count      INT     DEFAULT 5
)
RETURNS TABLE (
  id          UUID,
  document_id UUID,
  content     TEXT,
  metadata    JSONB,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.document_id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  WHERE kc.client_id = match_client_id
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
