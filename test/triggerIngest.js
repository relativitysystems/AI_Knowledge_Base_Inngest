#!/usr/bin/env node
'use strict';

require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY  = process.env.API_KEY  || '';

// ---------------------------------------------------------------------------
// Edit these values to match a real file in your configured Google Drive folder
// ---------------------------------------------------------------------------
const CLIENT_ID      = process.env.TEST_CLIENT_ID || 'replace-with-a-valid-uuid';
const SOURCE_FILE_ID = process.env.TEST_FILE_ID   || 'replace-with-a-google-drive-file-id';
const FILE_NAME      = process.env.TEST_FILE_NAME || 'sample_plain.txt';
const MIME_TYPE      = process.env.TEST_MIME_TYPE || 'text/plain';

async function main() {
  console.log(`Triggering ingest for file: ${FILE_NAME} (${SOURCE_FILE_ID})`);
  console.log(`Client ID: ${CLIENT_ID}`);
  console.log(`Server: ${BASE_URL}`);
  console.log('');

  const res = await fetch(`${BASE_URL}/api/knowledge/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      sourceFileId: SOURCE_FILE_ID,
      fileName: FILE_NAME,
      mimeType: MIME_TYPE,
      sourceProvider: 'google_drive',
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error('Error:', body);
    process.exit(1);
  }

  console.log('Ingest event queued successfully:');
  console.log(JSON.stringify(body, null, 2));
  console.log('');
  console.log('Watch the Inngest dev dashboard for step progress:');
  console.log('  http://localhost:8288');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
