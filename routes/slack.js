'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');

const router = express.Router();

// ---------------------------------------------------------------------------
// Slack request signature verification middleware
// ---------------------------------------------------------------------------

function verifySlackSignature(req, res, next) {
  if (!config.slack.signingSecret) {
    // No signing secret configured — skip verification in dev
    if (config.server.nodeEnv === 'production') {
      return res.status(500).json({ error: 'SLACK_SIGNING_SECRET is not configured' });
    }
    return next();
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const slackSig = req.headers['x-slack-signature'];

  if (!timestamp || !slackSig) {
    return res.status(400).json({ error: 'Missing Slack signature headers' });
  }

  // Reject requests older than 5 minutes (replay attack protection)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return res.status(400).json({ error: 'Request timestamp too old' });
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac('sha256', config.slack.signingSecret)
    .update(sigBase)
    .digest('hex');
  const expected = `v0=${hmac}`;

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(slackSig))) {
    return res.status(401).json({ error: 'Invalid Slack signature' });
  }

  next();
}

// ---------------------------------------------------------------------------
// POST /api/slack/events
// Receives Slack Events API payloads.
// Handles: url_verification challenge + app_mention events.
// ---------------------------------------------------------------------------

router.post('/events', verifySlackSignature, async (req, res) => {
  const { type, challenge, event } = req.body;

  // Slack URL verification handshake
  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  // Acknowledge immediately — Slack requires a 200 within 3 seconds
  res.status(200).send();

  if (type !== 'event_callback' || !event) return;
  if (event.type !== 'app_mention') return;

  // Skip messages from bots (prevents infinite loops)
  if (event.bot_id || event.subtype === 'bot_message') return;

  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;

  // Strip <@BOT_ID> mention from the text
  const question = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!question) return;

  // Derive clientId from channel (simple mapping: one Slack channel = one client).
  // In production this would be a DB lookup; for MVP use the channel ID as a stable client key.
  // Wrap in a UUID v5-style hash so it fits the UUID column format.
  const clientId = slackChannelToClientId(channel);

  try {
    // 1. Embed the question
    const queryEmbedding = await openaiService.embedQuery(question);

    // 2. Retrieve relevant chunks
    const chunks = await supabaseService.searchChunks(clientId, queryEmbedding, {
      threshold: 0.65,
      count: 5,
    });

    let answer;
    if (!chunks.length) {
      answer = "I couldn't find any relevant information in the knowledge base for your question. Try rephrasing or check that the relevant documents have been indexed.";
    } else {
      answer = await openaiService.generateRagAnswer(question, chunks);
    }

    await postSlackMessage(channel, thread_ts, answer);
  } catch (err) {
    console.error('[slack/events] error processing app_mention:', err.message);
    await postSlackMessage(
      channel,
      thread_ts,
      'Sorry, I ran into an error processing your question. Please try again.'
    ).catch(() => {}); // best-effort
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Slack channel ID to a deterministic UUID for client_id lookups.
 * This is the MVP approach. Replace with a real DB lookup when clients are
 * onboarded through the portal.
 */
function slackChannelToClientId(channelId) {
  // Use a UUID v5-like hash: namespace + channel ID → fixed UUID
  const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // UUID v5 DNS namespace
  const hash = crypto
    .createHash('sha1')
    .update(namespace + channelId)
    .digest('hex');
  // Format as UUID
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '5' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

async function postSlackMessage(channel, thread_ts, text) {
  if (!config.slack.botToken) {
    console.warn('[slack] SLACK_BOT_TOKEN not set — skipping reply');
    return;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({ channel, thread_ts, text }),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack postMessage failed: ${data.error}`);
  }
  return data;
}

module.exports = router;
