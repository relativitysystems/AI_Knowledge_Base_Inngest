#!/usr/bin/env node
'use strict';

require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY  = process.env.API_KEY  || '';

async function main() {
  console.log('Triggering scheduled sync...');
  console.log(`Server: ${BASE_URL}`);
  console.log('');

  const res = await fetch(`${BASE_URL}/api/knowledge/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
  });

  const body = await res.json();
  if (!res.ok) {
    console.error('Error:', body);
    process.exit(1);
  }

  console.log('Sync event queued successfully:');
  console.log(JSON.stringify(body, null, 2));
  console.log('');
  console.log('Watch the Inngest dev dashboard:');
  console.log('  http://localhost:8288');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
