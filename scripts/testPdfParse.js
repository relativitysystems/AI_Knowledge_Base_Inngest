'use strict';

/**
 * Quick smoke-test for parseDocument.
 *
 * Usage:
 *   node scripts/testPdfParse.js path/to/file.pdf
 *
 * Prints page count and the first 200 characters from each page.
 */

const path = require('path');
const fs = require('fs');
const { parseDocument } = require('../services/documentParser');

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: node scripts/testPdfParse.js <path-to-pdf>');
    process.exit(1);
  }

  const resolved = path.resolve(pdfPath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(resolved);
  console.log(`\nLoaded: ${path.basename(resolved)} (${buffer.length.toLocaleString()} bytes)`);

  const result = await parseDocument(buffer, 'application/pdf', path.basename(resolved));

  console.log(`Page count : ${result.pages.length}`);
  console.log(`Total chars: ${result.text.length.toLocaleString()}`);

  for (const page of result.pages) {
    const preview = page.text.slice(0, 200).replace(/\n/g, '\\n');
    console.log(`\n--- Page ${page.pageNumber} (${page.text.length} chars) ---`);
    console.log(preview + (page.text.length > 200 ? '...' : ''));
  }
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
