'use strict';

class UnsupportedMimeTypeError extends Error {
  constructor(mimeType) {
    super(`Unsupported MIME type: ${mimeType}`);
    this.name = 'UnsupportedMimeTypeError';
    this.mimeType = mimeType;
  }
}

/**
 * Extract plain text from a document buffer.
 *
 * Supported MIME types:
 *   text/plain, text/markdown, text/csv  — decoded as UTF-8
 *   application/pdf                      — extracted via pdf-parse
 *   application/vnd.google-apps.*        — should never reach here;
 *                                          googleDriveService exports Google Docs as text/plain
 *
 * Throws UnsupportedMimeTypeError for unrecognised types.
 *
 * @param {Buffer} buffer    Raw file content
 * @param {string} mimeType  MIME type string
 * @param {string} fileName  Used only for error messages
 * @returns {Promise<string>} Extracted plain text
 */
async function parseDocument(buffer, mimeType, fileName) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('parseDocument: buffer must be a Buffer');
  }

  const type = (mimeType || '').toLowerCase().split(';')[0].trim();

  if (type === 'text/plain' || type === 'text/markdown' || type === 'text/csv' || type === '') {
    return cleanText(buffer.toString('utf8'));
  }

  if (type === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    return cleanText(result.text);
  }

  // Google Docs exports should have already been converted to text/plain by googleDriveService
  if (type.startsWith('application/vnd.google-apps.')) {
    throw new UnsupportedMimeTypeError(
      `${mimeType} — Google Docs must be exported as text/plain before parsing`
    );
  }

  throw new UnsupportedMimeTypeError(mimeType || 'unknown');
}

/**
 * Strip null bytes, control characters (except newlines/tabs), and
 * collapse runs of blank lines down to two newlines.
 */
function cleanText(text) {
  return text
    .replace(/\0/g, '')                          // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '') // control chars (keep \t \n \r)
    .replace(/\r\n/g, '\n')                      // normalise line endings
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')                  // collapse excess blank lines
    .trim();
}

module.exports = { parseDocument, cleanText, UnsupportedMimeTypeError };
