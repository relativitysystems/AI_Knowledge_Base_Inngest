'use strict';

const OpenAI = require('openai');
const config = require('../config');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// Log key presence at startup without printing the value.
console.log(
  `[openaiService] init | OPENAI_API_KEY present=${!!config.openai.apiKey}` +
  ` | embeddingModel=${config.openai.embeddingModel}`
);

// System prompt used for all RAG query completions.
const RAG_SYSTEM_PROMPT = `You are the internal knowledge assistant for Relativity Systems clients.

Your job is to help team members find company information, explain procedures, answer operational questions, and draft 
client-facing communications using information contained in the company knowledge base.

Do not invent policies, pricing, procedures, timelines, guarantees, or commitments.

When information is missing, incomplete, outdated, or conflicting, clearly state that and recommend the appropriate next step.

## Core Rules

- Only use information found in the retrieved context below.
- Never create pricing, policies, timelines, guarantees, or commitments that are not documented.
- If the answer is not clearly documented, say: "This is not fully documented in our knowledge base." Then state what was found and recommend the smallest next step.
- If the answer is supported by information in the retrieved context, cite the source document(s) using: Source: filename for non-paginated documents, or Source: filename, p. X when a page number is present in the retrieved context. Never invent a page number.
- If the question is not documented, missing, or cannot be answered from the retrieved context, do NOT cite a retrieved document as if it supports the answer. Use: Source: N/A
- If documents disagree, present both versions and recommend confirmation with the appropriate owner.

## Response Format

TL;DR
Guidance
Next Step
Source`;

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_TIMEOUT_MS = 60_000;

/**
 * Generate embeddings for an array of text strings.
 * Batches requests to stay within OpenAI's 2048-input limit per call.
 * Returns a parallel array of float[] embeddings.
 */
async function generateEmbeddings(texts) {
  if (!texts.length) return [];

  const totalBatches = Math.ceil(texts.length / EMBEDDING_BATCH_SIZE);
  console.log(
    `[generateEmbeddings] START | model=${config.openai.embeddingModel}` +
    ` | totalTexts=${texts.length} | batchSize=${EMBEDDING_BATCH_SIZE} | totalBatches=${totalBatches}`
  );

  const results = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

    console.log(`[generateEmbeddings] START batch ${batchNum}/${totalBatches} | size=${batch.length}`);
    const start = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    let response;
    try {
      response = await openai.embeddings.create(
        { model: config.openai.embeddingModel, input: batch },
        { signal: controller.signal }
      );
    } catch (err) {
      if (controller.signal.aborted) {
        const msg = `embeddings.create timed out after ${EMBEDDING_TIMEOUT_MS / 1000}s` +
          ` (batch ${batchNum}/${totalBatches})`;
        console.error(`[generateEmbeddings] TIMEOUT batch ${batchNum}/${totalBatches}` +
          ` | elapsed=${Date.now() - start}ms`);
        throw new Error(msg);
      }
      console.error(
        `[generateEmbeddings] ERROR batch ${batchNum}/${totalBatches}` +
        ` | elapsed=${Date.now() - start}ms` +
        ` | status=${err.status ?? 'unknown'}` +
        ` | code=${err.code ?? 'unknown'}` +
        ` | message=${err.message}`
      );
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    console.log(`[generateEmbeddings] END batch ${batchNum}/${totalBatches} | elapsed=${Date.now() - start}ms`);

    const embeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    results.push(...embeddings);
  }

  console.log(`[generateEmbeddings] END | totalEmbeddings=${results.length}`);
  return results;
}

/**
 * Embed a single query string for similarity search.
 */
async function embedQuery(text) {
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
  });
  return response.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

/**
 * Generate a RAG answer given retrieved context chunks and a user question.
 * contextChunks: [{ content, metadata: { fileName, ... } }]
 */
async function generateRagAnswer(question, contextChunks, sessionMessages = []) {
  const contextText = contextChunks
    .map((c, i) => {
      const source = c.metadata && c.metadata.fileName ? c.metadata.fileName : 'unknown';
      const page = c.metadata && c.metadata.pageNumber != null ? `, p. ${c.metadata.pageNumber}` : '';
      return `[${i + 1}] Source: ${source}${page}\n${c.content}`;
    })
    .join('\n\n---\n\n');

  const messages = [
    ...sessionMessages,
    {
      role: 'user',
      content: `Context from knowledge base:\n\n${contextText}\n\n---\n\nQuestion: ${question}`,
    },
  ];

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [{ role: 'system', content: RAG_SYSTEM_PROMPT }, ...messages],
    temperature: 0.2,
  });

  return response.choices[0].message.content;
}

/**
 * Low-level chat completion with full message control.
 */
async function generateChatCompletion(messages, systemPrompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [{ role: 'system', content: systemPrompt || RAG_SYSTEM_PROMPT }, ...messages],
    temperature: 0.2,
  });
  return response.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

const INTENT_CLASSIFIER_PROMPT = `You are an intent classifier for an internal knowledge base assistant used by business teams.

Classify the user message into exactly one of these intents and return strict JSON only.

## Intents

"knowledge_query" — User is asking for information that should come from uploaded company documents: SOPs, policies, FAQs, training materials, pricing guides, scripts, handbooks, or internal processes.
Examples: "What is our refund policy?", "How do we reschedule last-minute appointments?", "Do we offer partial refunds on group bookings?", "What are the onboarding steps?"
shouldRunRetrieval: true, shouldAllowKnowledgeGap: true

"casual_conversation" — Greeting, small talk, thanks, acknowledgement, or non-task social phrase.
Examples: "yo", "hi", "hello", "thanks", "ok", "cool", "what's up", "great"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

"help_request" — User asks what the assistant can do or how to use it.
Examples: "what can you do?", "how does this work?", "what should I ask?", "help"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

"clarification_needed" — Message is too vague or incomplete to search reliably, but may become a knowledge query if clarified.
Examples: "refund", "policy", "pricing?", "what about onboarding?", "the process"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

"unsupported" — Request is outside knowledge base scope: personal trivia, jokes, general internet knowledge, weather, medical/legal advice unrelated to company docs, etc.
Examples: "what's my favorite ice cream?", "write me a poem", "who won the Super Bowl?", "what's the weather?"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

## Rules
- Never classify a short greeting as a knowledge gap.
- Never classify an unsupported question as a knowledge gap.
- Only allow knowledge gap when intent is "knowledge_query" and retrieval fails.
- If confidence is low (< 0.7), prefer "clarification_needed" unless the message clearly asks for company/internal documentation.

## Output format (strict JSON, no markdown, no extra keys)
{
  "intent": "knowledge_query|casual_conversation|help_request|clarification_needed|unsupported",
  "confidence": 0.0,
  "shouldRunRetrieval": true,
  "shouldAllowKnowledgeGap": true,
  "responseStyle": "rag|conversational|help|clarify|unsupported",
  "reason": "one sentence"
}`;

// Obvious greetings — checked before calling the LLM to avoid unnecessary cost.
const GREETING_WORDS = new Set([
  'yo', 'hi', 'hey', 'hello', 'sup', 'howdy',
  'thanks', 'thank you', 'ty',
  'ok', 'okay', 'cool', 'great', 'nice', 'alright',
  'bye', 'goodbye', 'cya',
]);

// Clearly vague single-word prompts — let LLM clarify rather than searching.
const VAGUE_SINGLE_WORDS = new Set([
  'refund', 'pricing', 'policy', 'onboarding',
  'process', 'procedure', 'info', 'information',
]);

/**
 * Classify the user's question to decide whether to run vector retrieval.
 * Returns:
 *   { intent, confidence, shouldRunRetrieval, shouldAllowKnowledgeGap, responseStyle, reason }
 *
 * Classifier failure always falls back to clarification_needed (never retrieval).
 */
async function classifyQueryIntent(question) {
  const trimmed = (question || '').trim();

  // Guardrail: empty input
  if (!trimmed) {
    return {
      intent: 'clarification_needed',
      confidence: 1.0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'clarify',
      reason: 'Empty input',
    };
  }

  const lower = trimmed.toLowerCase();

  // Guardrail: obvious greeting (single token, no spaces or known multi-word phrases)
  if (GREETING_WORDS.has(lower) || GREETING_WORDS.has(lower.replace(/[!?.]+$/, ''))) {
    return {
      intent: 'casual_conversation',
      confidence: 1.0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'conversational',
      reason: 'Obvious greeting detected by guardrail',
    };
  }

  // Guardrail: clearly vague single-word prompt (no spaces)
  if (!lower.includes(' ') && VAGUE_SINGLE_WORDS.has(lower)) {
    return {
      intent: 'clarification_needed',
      confidence: 1.0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'clarify',
      reason: 'Vague single-word term detected by guardrail',
    };
  }

  // LLM classifier for everything else
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: INTENT_CLASSIFIER_PROMPT },
        { role: 'user', content: trimmed },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const raw = response.choices[0].message.content;
    const result = JSON.parse(raw);

    if (
      typeof result.intent !== 'string' ||
      typeof result.shouldRunRetrieval !== 'boolean' ||
      typeof result.shouldAllowKnowledgeGap !== 'boolean'
    ) {
      throw new Error('Classifier returned unexpected shape');
    }

    console.log('[classifyQueryIntent]', { intent: result.intent, confidence: result.confidence, reason: result.reason });
    return result;
  } catch (err) {
    console.error('[classifyQueryIntent] classifier error, falling back to clarification_needed:', err.message);
    return {
      intent: 'clarification_needed',
      confidence: 0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'clarify',
      reason: 'Classifier fallback due to error',
    };
  }
}

// ---------------------------------------------------------------------------
// Non-retrieval response builders
// ---------------------------------------------------------------------------

function buildConversationalResponse(question) {
  return [
    'TL;DR',
    'Hello! How can I assist you today?',
    '',
    'Guidance',
    'Your message appears to be a greeting. I can help answer questions using your approved knowledge base documents.',
    '',
    'Next Step',
    'Ask me about a policy, SOP, FAQ, pricing document, training guide, or internal process.',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

function buildHelpResponse() {
  return [
    'TL;DR',
    "I'm your internal knowledge assistant. I can help you find answers from your company's uploaded documents.",
    '',
    'Guidance',
    'You can ask me about policies, SOPs, FAQs, pricing guides, training materials, onboarding steps, or any internal process documented in your knowledge base.',
    '',
    'Next Step',
    'Try asking something like: "What is our refund policy?" or "How do we handle last-minute appointment reschedules?"',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

function buildClarificationResponse(question) {
  return [
    'TL;DR',
    'I need a little more detail before searching the knowledge base.',
    '',
    'Guidance',
    `"${question}" is a bit vague. Could you clarify what aspect you'd like to know about? For example, are you asking about eligibility, the process, how to communicate it to a customer, or something else?`,
    '',
    'Next Step',
    'Please ask a complete question, such as "What is our refund policy?" or "How do we handle appointment cancellations?"',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

function buildUnsupportedResponse(question) {
  return [
    'TL;DR',
    "That question is outside the scope of the knowledge base.",
    '',
    'Guidance',
    "I'm designed to answer questions about your company's internal documents, policies, SOPs, FAQs, and operational procedures. I can't help with general knowledge, personal questions, or topics unrelated to your uploaded documents.",
    '',
    'Next Step',
    'Ask me about a company policy, internal process, or topic covered in your uploaded knowledge base.',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

/**
 * Dispatch to the appropriate response builder based on intent.responseStyle.
 */
function buildNonRetrievalAnswer(question, intent) {
  switch (intent.responseStyle) {
    case 'conversational': return buildConversationalResponse(question);
    case 'help':           return buildHelpResponse();
    case 'clarify':        return buildClarificationResponse(question);
    default:               return buildUnsupportedResponse(question);
  }
}

module.exports = {
  generateEmbeddings,
  embedQuery,
  generateRagAnswer,
  generateChatCompletion,
  RAG_SYSTEM_PROMPT,
  classifyQueryIntent,
  buildNonRetrievalAnswer,
};
