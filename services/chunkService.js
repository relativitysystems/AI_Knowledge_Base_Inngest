'use strict';

const DEFAULT_CHUNK_SIZE = 4000;  // characters
const DEFAULT_OVERLAP    = 400;   // characters

/**
 * Split text into overlapping chunks suitable for embedding.
 *
 * Strategy:
 *   1. Split on double newlines (paragraph boundaries) first.
 *   2. Accumulate paragraphs until the chunk size is reached.
 *   3. Begin the next chunk with the last `overlap` characters of the previous chunk.
 *   4. If a single paragraph exceeds chunkSize, hard-split it at the character boundary.
 *
 * @param {string} text     Extracted plain text
 * @param {object} metadata Preserved on every chunk: { clientId, fileName, sourceProvider, sourceFileId, ...extra }
 * @param {object} options  { chunkSize, overlap }
 * @returns {{ content: string, chunkIndex: number, metadata: object }[]}
 */
function chunkText(text, metadata = {}, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const overlap   = options.overlap   || DEFAULT_OVERLAP;

  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  let chunkIndex = 0;

  function flush() {
    if (current.trim()) {
      chunks.push({
        content: current.trim(),
        chunkIndex,
        metadata: { ...metadata },
      });
      chunkIndex++;
    }
  }

  for (const para of paragraphs) {
    // If adding this paragraph would exceed chunkSize, flush and start a new chunk with overlap
    if (current.length > 0 && current.length + para.length + 2 > chunkSize) {
      flush();
      // Carry the tail of the previous chunk as overlap context
      current = current.slice(-overlap);
    }

    // If a single paragraph is larger than chunkSize, hard-split it
    if (para.length > chunkSize) {
      // Flush any accumulated text first
      if (current.trim()) flush();
      current = '';

      let offset = 0;
      while (offset < para.length) {
        const slice = para.slice(offset, offset + chunkSize);
        chunks.push({
          content: slice.trim(),
          chunkIndex,
          metadata: { ...metadata },
        });
        chunkIndex++;
        offset += chunkSize - overlap;
      }
      continue;
    }

    current = current ? current + '\n\n' + para : para;
  }

  flush();
  return chunks;
}

module.exports = { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP };
