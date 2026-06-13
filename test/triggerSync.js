#!/usr/bin/env node
'use strict';

require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY  = process.env.API_KEY  || '';

async function main() {
  console.error('Google Drive scheduled sync has been removed from this backend.');
  console.error('Documents are now ingested via portal upload only.');
  console.error('See test/triggerPortalIngest.js for the correct test script.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
