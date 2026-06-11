'use strict';

const crypto = require('crypto');
const { inngest } = require('./client');
const config = require('../config');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const documentParser = require('../services/documentParser');
const chunkService = require('../services/chunkService');
const googleDriveService = require('../services/googleDriveService');

// ---------------------------------------------------------------------------
// Function 1: knowledge/document.ingest
//
// Full ingest pipeline for a single document. Idempotent: re-running with
// the same content hash is a no-op unless forceReindex is set.
// ---------------------------------------------------------------------------

const ingestDocument = inngest.createFunction(
  {
    id: 'knowledge-document-ingest',
    name: 'Ingest Knowledge Document',
    concurrency: { limit: 2, key: 'event.data.clientId' },
    retries: 3,
    onFailure: async ({ event, error }) => {
      const { jobId, documentId } = event.data.jobContext || {};
      if (jobId) {
        await supabaseService.logIngestionError(jobId, documentId || null, error);
      }
      console.error('[ingest] onFailure', { jobId, documentId, error: error.message });
    },
  },
  { event: 'knowledge/document.ingest' },
  async ({ event, step }) => {
    const {
      clientId,
      sourceProvider = 'google_drive',
      sourceFileId,
      fileName,
      mimeType,
      forceReindex = false,
      storagePath,
    } = event.data;

    // Track job + document IDs across steps so onFailure can log them
    let jobId = null;
    let documentId = null;

    // -- Step 1: Create ingestion job record ----------------------------------
    const job = await step.run('create-job', async () => {
      return supabaseService.createIngestionJob(clientId, sourceFileId);
    });
    jobId = job.id;

    // Attach to event so onFailure can reference them
    event.data.jobContext = { jobId, documentId };

    // -- Step 2: Check for existing document (dedup) --------------------------
    const existing = await step.run('check-existing', async () => {
      return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
    });

    // Google Drive supports md5Checksum for a quick pre-download dedup.
    // portal_upload has no equivalent — content-hash dedup below covers it.
    if (existing && existing.status === 'indexed' && !forceReindex
        && sourceProvider === 'google_drive') {
      // Fetch current Drive metadata to compare content hash
      const metadata = await step.run('fetch-metadata-for-dedup', async () => {
        return googleDriveService.getFileMetadata(sourceFileId);
      });

      // md5Checksum is undefined for Google Docs; fall through to re-index in that case
      if (metadata.md5Checksum && metadata.md5Checksum === existing.content_hash) {
        await step.run('skip-unchanged', async () => {
          await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId: existing.id });
        });
        return { skipped: true, reason: 'content unchanged', documentId: existing.id };
      }
    }

    // -- Step 3: Mark job running ---------------------------------------------
    await step.run('update-job-running', async () => {
      await supabaseService.updateIngestionJob(job.id, { status: 'running' });
    });

    // -- Step 4: Fetch document (provider-specific) ---------------------------
    const { buffer, resolvedMimeType } = await step.run('fetch-document', async () => {
      if (sourceProvider === 'portal_upload') {
        if (!storagePath) throw new Error('portal_upload document missing storagePath in event data');
        const result = await supabaseService.downloadFromStorage(storagePath);
        // Fall back to event mimeType if Storage didn't return a useful content-type
        const finalMime = result.resolvedMimeType || mimeType;
        // Buffer doesn't survive Inngest step serialization; convert to base64
        return { buffer: result.buffer.toString('base64'), resolvedMimeType: finalMime };
      } else if (sourceProvider === 'google_drive') {
        const result = await googleDriveService.downloadFileAsText(sourceFileId, mimeType);
        return { buffer: result.buffer.toString('base64'), resolvedMimeType: result.resolvedMimeType };
      } else {
        throw new Error(`Unsupported sourceProvider: ${sourceProvider}`);
      }
    });

    // -- Step 5: Parse document to plain text ---------------------------------
    const rawText = await step.run('parse-document', async () => {
      const buf = Buffer.from(buffer, 'base64');
      return documentParser.parseDocument(buf, resolvedMimeType, fileName);
    });

    // -- Step 6: Compute content hash -----------------------------------------
    const contentHash = await step.run('compute-hash', async () => {
      return crypto.createHash('sha256').update(rawText).digest('hex');
    });

    // Second dedup check using content hash (catches cases where md5 wasn't available)
    if (existing && existing.content_hash === contentHash && !forceReindex) {
      await step.run('skip-unchanged-by-hash', async () => {
        await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId: existing.id });
      });
      return { skipped: true, reason: 'content hash unchanged', documentId: existing.id };
    }

    // -- Step 7: Upsert document record ---------------------------------------
    const doc = await step.run('upsert-document', async () => {
      return supabaseService.upsertKnowledgeDocument(
        clientId,
        sourceProvider,
        sourceFileId,
        fileName,
        resolvedMimeType,
        contentHash,
        storagePath || undefined
      );
    });
    documentId = doc.id;
    event.data.jobContext = { jobId, documentId };

    // -- Step 8: Delete old chunks (clean slate for re-index) -----------------
    await step.run('delete-old-chunks', async () => {
      await supabaseService.deleteChunksForDocument(documentId);
    });

    // -- Step 9: Split text into chunks ---------------------------------------
    const chunks = await step.run('chunk-text', async () => {
      return chunkService.chunkText(rawText, {
        clientId,
        fileName,
        sourceProvider,
        sourceFileId,
      });
    });

    // -- Step 10: Generate embeddings -----------------------------------------
    const embeddings = await step.run('generate-embeddings', async () => {
      return openaiService.generateEmbeddings(chunks.map((c) => c.content));
    });

    // -- Step 11: Insert chunks with embeddings into Supabase -----------------
    await step.run('upsert-chunks', async () => {
      const rows = chunks.map((chunk, i) => ({
        document_id: documentId,
        client_id: clientId,
        chunk_index: chunk.chunkIndex,
        content: chunk.content,
        embedding: embeddings[i],
        metadata: chunk.metadata,
      }));
      await supabaseService.insertKnowledgeChunks(rows);
    });

    // -- Step 12: Mark document indexed ---------------------------------------
    await step.run('mark-indexed', async () => {
      await supabaseService.markDocumentIndexed(documentId);
    });

    // -- Step 13: Complete job ------------------------------------------------
    await step.run('complete-job', async () => {
      await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId });
    });

    return { success: true, documentId, chunkCount: chunks.length };
  }
);

// ---------------------------------------------------------------------------
// Function 2: knowledge/document.delete
//
// Mark a document as deleted and remove its chunks from the vector store.
// Lookup can be by documentId OR (sourceProvider + sourceFileId).
// ---------------------------------------------------------------------------

const deleteDocument = inngest.createFunction(
  {
    id: 'knowledge-document-delete',
    name: 'Delete Knowledge Document',
    retries: 3,
  },
  { event: 'knowledge/document.delete' },
  async ({ event, step }) => {
    const { clientId, documentId: inputDocumentId, sourceFileId, sourceProvider = 'google_drive' } = event.data;

    // -- Step 1: Find document ------------------------------------------------
    const doc = await step.run('find-document', async () => {
      if (inputDocumentId) {
        return supabaseService.getKnowledgeDocumentById(inputDocumentId);
      }
      return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
    });

    if (!doc) {
      return { skipped: true, reason: 'document not found' };
    }

    // -- Step 2: Delete chunks ------------------------------------------------
    await step.run('delete-chunks', async () => {
      await supabaseService.deleteChunksForDocument(doc.id);
    });

    // -- Step 3: Mark document deleted ----------------------------------------
    await step.run('mark-deleted', async () => {
      await supabaseService.markDocumentDeleted(doc.id);
    });

    // -- Step 4 (optional): Remove file from Supabase Storage for portal uploads
    if (doc.source_provider === 'portal_upload' && doc.storage_path) {
      await step.run('delete-storage-file', async () => {
        await supabaseService.deleteFromStorage(doc.storage_path);
      });
    }

    return { success: true, documentId: doc.id };
  }
);

// ---------------------------------------------------------------------------
// Function 3: knowledge/document.reindex
//
// Force re-ingest of a specific document regardless of content hash.
// Emits knowledge/document.ingest with forceReindex: true.
// ---------------------------------------------------------------------------

const reindexDocument = inngest.createFunction(
  {
    id: 'knowledge-document-reindex',
    name: 'Reindex Knowledge Document',
    retries: 3,
  },
  { event: 'knowledge/document.reindex' },
  async ({ event, step }) => {
    const {
      clientId, sourceFileId, sourceProvider = 'google_drive',
      fileName, mimeType, storagePath,
    } = event.data;

    const fileMeta = await step.run('fetch-file-metadata', async () => {
      if (sourceProvider === 'portal_upload') {
        if (!fileName || !mimeType || !storagePath) {
          throw new Error('portal_upload reindex requires fileName, mimeType, and storagePath');
        }
        return { name: fileName, mimeType };
      }
      if (fileName && mimeType) return { name: fileName, mimeType };
      return googleDriveService.getFileMetadata(sourceFileId);
    });

    await step.sendEvent('trigger-ingest', {
      name: 'knowledge/document.ingest',
      data: {
        clientId,
        sourceProvider,
        sourceFileId,
        fileName: fileMeta.name || fileName,
        mimeType: fileMeta.mimeType || mimeType,
        forceReindex: true,
        storagePath: storagePath || undefined,
      },
    });

    return { triggered: true, sourceFileId };
  }
);

// ---------------------------------------------------------------------------
// Function 4: knowledge/scheduled-sync
//
// Runs every hour. For each client, compares the Drive folder against the DB:
//   - Files in Drive but not in DB (or with changed md5Checksum) → emit ingest
//   - Files in DB but no longer in Drive → emit delete
//
// Safety guard: if Drive returns 0 files, skip all deletions for that client.
// ---------------------------------------------------------------------------

const scheduledSync = inngest.createFunction(
  {
    id: 'knowledge-scheduled-sync',
    name: 'Scheduled Knowledge Base Sync',
    retries: 2,
  },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const folderId = config.googleDrive.folderId;
    if (!folderId) {
      console.warn('[scheduled-sync] GOOGLE_DRIVE_FOLDER_ID is not set — skipping');
      return { skipped: true, reason: 'no folder configured' };
    }

    // -- Step 1: Get distinct client IDs from the DB --------------------------
    const clientIds = await step.run('list-clients', async () => {
      return supabaseService.getDistinctClientIds();
    });

    if (!clientIds.length) {
      return { skipped: true, reason: 'no clients found' };
    }

    const results = [];

    // Fan out per client — each client is a separate step so one failing
    // client doesn't block others
    for (const clientId of clientIds) {
      const result = await step.run(`sync-client-${clientId}`, async () => {
        return _syncClient(clientId, folderId);
      });
      results.push({ clientId, ...result });
    }

    return { synced: results.length, results };
  }
);

async function _syncClient(clientId, folderId) {
  // List current Drive files
  const driveFiles = await googleDriveService.listFolderFiles(folderId);

  // Safety guard: if Drive returns 0 files, abort to avoid mass-deleting
  if (driveFiles.length === 0) {
    return { skipped: true, reason: 'Drive returned 0 files — safety guard triggered' };
  }

  const driveMap = new Map(driveFiles.map((f) => [f.id, f]));

  // Get all indexed documents for this client from the DB
  const indexedDocs = await supabaseService.getAllIndexedDocuments(clientId, 'google_drive');
  const indexedMap = new Map(indexedDocs.map((d) => [d.source_file_id, d]));

  const toIngest = [];
  const toDelete = [];

  // Files in Drive — ingest if new or content changed
  for (const file of driveFiles) {
    const existing = indexedMap.get(file.id);
    if (!existing) {
      toIngest.push(file);
    } else if (file.md5Checksum && file.md5Checksum !== existing.content_hash) {
      toIngest.push(file);
    }
  }

  // Files in DB but no longer in Drive — delete
  for (const doc of indexedDocs) {
    if (!driveMap.has(doc.source_file_id)) {
      toDelete.push(doc);
    }
  }

  // Emit ingest events
  const ingestEvents = toIngest.map((file) => ({
    name: 'knowledge/document.ingest',
    data: {
      clientId,
      sourceProvider: 'google_drive',
      sourceFileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
    },
  }));

  // Emit delete events
  const deleteEvents = toDelete.map((doc) => ({
    name: 'knowledge/document.delete',
    data: {
      clientId,
      documentId: doc.id,
      sourceFileId: doc.source_file_id,
      sourceProvider: 'google_drive',
    },
  }));

  const allEvents = [...ingestEvents, ...deleteEvents];

  if (allEvents.length > 0) {
    // Use Inngest SDK directly — step.sendEvent is not available outside step context
    const { inngest: inngestClient } = require('./client');
    await inngestClient.send(allEvents);
  }

  return {
    driveFileCount: driveFiles.length,
    toIngest: toIngest.length,
    toDelete: toDelete.length,
  };
}

const functions = [ingestDocument, deleteDocument, reindexDocument, scheduledSync];

module.exports = { functions, ingestDocument, deleteDocument, reindexDocument, scheduledSync };
