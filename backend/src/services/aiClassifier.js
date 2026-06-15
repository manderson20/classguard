/**
 * AI-powered domain classification service.
 *
 * Privacy design:
 *   - Only the bare domain name is sent to the AI provider.
 *   - No student identity, IP address, or query timestamp leaves this server.
 *   - Results are cached permanently in domain_classifications so each domain
 *     is classified once, not per-query.
 *
 * Provider support: claude (Anthropic), openai (OpenAI-compatible), ollama (local)
 */

const { pool } = require('../db');

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getConfig() {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE key IN (
      'ai_provider','ai_api_key','ai_model','ai_base_url'
    )`
  );
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    provider: process.env.AI_PROVIDER  || cfg.ai_provider  || 'claude',
    apiKey:   process.env.AI_API_KEY   || cfg.ai_api_key   || '',
    model:    process.env.AI_MODEL     || cfg.ai_model     || null, // null = provider default
    baseUrl:  process.env.AI_BASE_URL  || cfg.ai_base_url  || '',  // for Ollama
  };
}

// ---------------------------------------------------------------------------
// Classification prompt — intentionally minimal, no PII
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a school network content classifier.
You will receive a bare domain name (e.g. khanacademy.org) with NO user data.
Classify it and respond with ONLY valid JSON — no markdown, no explanation.`;

const USER_PROMPT = (domain) =>
  `Classify this domain for a K-12 school network: ${domain}

Respond with exactly this JSON structure:
{
  "category": "<one of: education, reference, productivity, news, social_media, gaming, streaming, shopping, adult, advertising, security, unknown>",
  "is_educational": <true|false>,
  "is_productive": <true|false>,
  "is_time_wasting": <true|false>,
  "confidence": <0.0 to 1.0>,
  "reasoning": "<one sentence, max 100 chars>"
}`;

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function classifyWithClaude(domain, apiKey, model) {
  const https   = require('https');
  const payload = JSON.stringify({
    model:      model || 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system:     SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: USER_PROMPT(domain) }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text   = parsed?.content?.[0]?.text || '';
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error('Claude parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function classifyWithOpenAI(domain, apiKey, model, baseUrl) {
  const https   = require('https');
  const url     = new URL((baseUrl || 'https://api.openai.com') + '/v1/chat/completions');
  const payload = JSON.stringify({
    model:       model || 'gpt-4o-mini',
    max_tokens:  256,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: USER_PROMPT(domain) },
    ],
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text   = parsed?.choices?.[0]?.message?.content || '';
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error('OpenAI parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function classifyWithOllama(domain, model, baseUrl) {
  const http    = require('http');
  const url     = new URL((baseUrl || 'http://localhost:11434') + '/api/chat');
  const payload = JSON.stringify({
    model:    model || 'llama3.2',
    stream:   false,
    format:   'json',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: USER_PROMPT(domain) },
    ],
  });

  const mod = url.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const text   = parsed?.message?.content || '';
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error('Ollama parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function classifyDomain(domain) {
  // Check cache first
  const { rows } = await pool.query(
    `SELECT * FROM domain_classifications
     WHERE domain = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [domain]
  );
  if (rows.length) return rows[0];

  const cfg = await getConfig();
  if (!cfg.provider) throw new Error('AI provider not configured');

  let result;
  if (cfg.provider === 'claude') {
    if (!cfg.apiKey) throw new Error('AI API key not set (ai_api_key setting)');
    result = await classifyWithClaude(domain, cfg.apiKey, cfg.model);
  } else if (cfg.provider === 'openai') {
    if (!cfg.apiKey) throw new Error('AI API key not set (ai_api_key setting)');
    result = await classifyWithOpenAI(domain, cfg.apiKey, cfg.model, cfg.baseUrl);
  } else if (cfg.provider === 'ollama') {
    result = await classifyWithOllama(domain, cfg.model, cfg.baseUrl);
  } else {
    throw new Error(`Unknown AI provider: ${cfg.provider}`);
  }

  // Validate and persist
  const { category, is_educational, is_productive, is_time_wasting, confidence, reasoning } = result;

  const { rows: saved } = await pool.query(
    `INSERT INTO domain_classifications
       (domain, category, is_educational, is_productive, is_time_wasting, confidence, classified_by, reasoning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (domain) DO UPDATE SET
       category = EXCLUDED.category,
       is_educational = EXCLUDED.is_educational,
       is_productive  = EXCLUDED.is_productive,
       is_time_wasting = EXCLUDED.is_time_wasting,
       confidence = EXCLUDED.confidence,
       classified_by = EXCLUDED.classified_by,
       reasoning = EXCLUDED.reasoning,
       classified_at = NOW(),
       expires_at = NOW() + INTERVAL '30 days'
     RETURNING *`,
    [domain, category, !!is_educational, !!is_productive, !!is_time_wasting,
     Math.min(1, Math.max(0, Number(confidence) || 0)),
     cfg.provider, reasoning || null]
  );

  return saved[0];
}

async function batchClassify(domains) {
  const results = [];
  for (const domain of domains) {
    try {
      results.push(await classifyDomain(domain));
    } catch (err) {
      results.push({ domain, error: err.message });
    }
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

module.exports = { classifyDomain, batchClassify, getConfig };
