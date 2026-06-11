-- Migration 002: Add storage_path column to knowledge_documents
-- Additive only — existing rows and all existing code are unaffected.
-- Run in the AIKB Supabase project SQL editor before deploying code changes.

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS storage_path TEXT;
