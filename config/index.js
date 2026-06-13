'use strict';

require('dotenv').config();

function require_env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  supabase: {
    aikb: {
      url: require_env('AIKB_SUPABASE_URL'),
      serviceKey: require_env('AIKB_SUPABASE_SERVICE_KEY'),
    },
    global: {
      url: require_env('GLOBAL_SUPABASE_URL'),
      serviceKey: require_env('GLOBAL_SUPABASE_SERVICE_KEY'),
    },
  },
  openai: {
    apiKey: require_env('OPENAI_API_KEY'),
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  },
  inngest: {
    eventKey: process.env.INNGEST_EVENT_KEY,
    signingKey: process.env.INNGEST_SIGNING_KEY,
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
  storage: {
    bucket: process.env.AIKB_STORAGE_BUCKET || 'aikb-documents',
  },
  apiKey: process.env.API_KEY,
};

module.exports = config;
