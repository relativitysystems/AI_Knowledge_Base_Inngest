'use strict';

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// ---------------------------------------------------------------------------
// Ingestion jobs
// ---------------------------------------------------------------------------

async function createIngestionJob(clientId, sourceFileId) {
  const { data, error } = await supabase
    .from('knowledge_ingestion_jobs')
    .insert({ client_id: clientId, source_file_id: sourceFileId, status: 'queued' })
    .select()
    .single();
  if (error) throw new Error(`createIngestionJob: ${error.message}`);
  return data;
}

async function updateIngestionJob(jobId, { status, errorMessage, documentId } = {}) {
  const patch = { updated_at: new Date().toISOString() };
  if (status !== undefined) patch.status = status;
  if (errorMessage !== undefined) patch.error_message = errorMessage;
  if (documentId !== undefined) patch.document_id = documentId;

  const { error } = await supabase
    .from('knowledge_ingestion_jobs')
    .update(patch)
    .eq('id', jobId);
  if (error) throw new Error(`updateIngestionJob: ${error.message}`);
}

async function logIngestionError(jobId, documentId, err) {
  const patch = {
    status: 'failed',
    error_message: err && err.message ? err.message : String(err),
    updated_at: new Date().toISOString(),
  };
  if (documentId) patch.document_id = documentId;

  const { error } = await supabase
    .from('knowledge_ingestion_jobs')
    .update(patch)
    .eq('id', jobId);
  if (error) console.error('logIngestionError: failed to write error to DB:', error.message);
}

async function getIngestionJobsByClient(clientId) {
  const { data, error } = await supabase
    .from('knowledge_ingestion_jobs')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`getIngestionJobsByClient: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

async function upsertKnowledgeDocument(clientId, provider, fileId, fileName, mimeType, contentHash) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('knowledge_documents')
    .upsert(
      {
        client_id: clientId,
        source_provider: provider,
        source_file_id: fileId,
        file_name: fileName,
        mime_type: mimeType,
        content_hash: contentHash,
        status: 'indexing',
        updated_at: now,
      },
      { onConflict: 'client_id,source_provider,source_file_id' }
    )
    .select()
    .single();
  if (error) throw new Error(`upsertKnowledgeDocument: ${error.message}`);
  return data;
}

async function getKnowledgeDocumentBySourceId(clientId, provider, fileId) {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('*')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('source_file_id', fileId)
    .maybeSingle();
  if (error) throw new Error(`getKnowledgeDocumentBySourceId: ${error.message}`);
  return data; // null if not found
}

async function getKnowledgeDocumentById(documentId) {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('*')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw new Error(`getKnowledgeDocumentById: ${error.message}`);
  return data;
}

async function getDocumentsByClient(clientId) {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('*')
    .eq('client_id', clientId)
    .neq('status', 'deleted')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getDocumentsByClient: ${error.message}`);
  return data;
}

async function getAllIndexedDocumentSourceIds(clientId, provider) {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('source_file_id')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('status', 'indexed');
  if (error) throw new Error(`getAllIndexedDocumentSourceIds: ${error.message}`);
  return data.map((row) => row.source_file_id);
}

async function getAllIndexedDocuments(clientId, provider) {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('id, source_file_id, content_hash')
    .eq('client_id', clientId)
    .eq('source_provider', provider)
    .eq('status', 'indexed');
  if (error) throw new Error(`getAllIndexedDocuments: ${error.message}`);
  return data;
}

async function markDocumentIndexed(documentId) {
  const { error } = await supabase
    .from('knowledge_documents')
    .update({ status: 'indexed', last_indexed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw new Error(`markDocumentIndexed: ${error.message}`);
}

async function markDocumentDeleted(documentId) {
  const { error } = await supabase
    .from('knowledge_documents')
    .update({ status: 'deleted', updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw new Error(`markDocumentDeleted: ${error.message}`);
}

async function markDocumentError(documentId, errorMessage) {
  const { error } = await supabase
    .from('knowledge_documents')
    .update({ status: 'error', error_message: errorMessage, updated_at: new Date().toISOString() })
    .eq('id', documentId);
  if (error) throw new Error(`markDocumentError: ${error.message}`);
}

async function getDistinctClientIds() {
  const { data, error } = await supabase
    .from('knowledge_documents')
    .select('client_id')
    .neq('status', 'deleted');
  if (error) throw new Error(`getDistinctClientIds: ${error.message}`);
  // Deduplicate in JS since Supabase JS client doesn't expose .distinct()
  const ids = [...new Set(data.map((r) => r.client_id))];
  return ids;
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

async function deleteChunksForDocument(documentId) {
  const { error } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('document_id', documentId);
  if (error) throw new Error(`deleteChunksForDocument: ${error.message}`);
}

async function insertKnowledgeChunks(chunks) {
  // chunks: [{ document_id, client_id, chunk_index, content, embedding, metadata }]
  // Batch in groups of 500 to stay within Supabase request size limits
  const BATCH = 500;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const { error } = await supabase.from('knowledge_chunks').insert(batch);
    if (error) throw new Error(`insertKnowledgeChunks (batch ${i}): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

async function searchChunks(clientId, queryEmbedding, { threshold = 0.7, count = 5 } = {}) {
  const { data, error } = await supabase.rpc('match_knowledge_chunks', {
    query_embedding: queryEmbedding,
    match_client_id: clientId,
    match_threshold: threshold,
    match_count: count,
  });
  if (error) throw new Error(`searchChunks: ${error.message}`);
  return data;
}

module.exports = {
  createIngestionJob,
  updateIngestionJob,
  logIngestionError,
  getIngestionJobsByClient,
  upsertKnowledgeDocument,
  getKnowledgeDocumentBySourceId,
  getKnowledgeDocumentById,
  getDocumentsByClient,
  getAllIndexedDocumentSourceIds,
  getAllIndexedDocuments,
  markDocumentIndexed,
  markDocumentDeleted,
  markDocumentError,
  getDistinctClientIds,
  deleteChunksForDocument,
  insertKnowledgeChunks,
  searchChunks,
};
