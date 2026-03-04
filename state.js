const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const APP_STATE_ROW_ID = 'main';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const THOUGHTS_SECRET = process.env.THOUGHTS_SECRET;

function getKeyBytes() {
  if (!THOUGHTS_SECRET) {
    throw new Error('Missing THOUGHTS_SECRET');
  }
  const trimmed = String(THOUGHTS_SECRET).trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const base64 = Buffer.from(trimmed, 'base64');
    if (base64.length === 32) return base64;
  } catch (_) {
    // fall through
  }
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest();
}

function encryptState(state) {
  const key = getKeyBytes();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    v: 1
  };
}

function decryptState(payload) {
  if (!payload || typeof payload !== 'object' || !payload.enc || !payload.iv || !payload.tag) {
    return null;
  }
  const key = getKeyBytes();
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.enc, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

function normalizeState(input) {
  return {
    thoughts: Array.isArray(input.thoughts) ? input.thoughts : [],
    deletedThoughts: Array.isArray(input.deletedThoughts) ? input.deletedThoughts : [],
    customCategories: Array.isArray(input.customCategories) ? input.customCategories : []
  };
}

function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase service credentials');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  let supabase;
  try {
    supabase = getSupabaseClient();
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
    return;
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('app_state')
        .select('thoughts, deleted_thoughts, custom_categories, updated_at')
        .eq('id', APP_STATE_ROW_ID)
        .maybeSingle();

      if (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Supabase read failed', details: error.message }));
        return;
      }

      if (!data) {
        res.statusCode = 200;
        res.end(JSON.stringify({
          thoughts: [],
          deletedThoughts: [],
          customCategories: [],
          updatedAt: null
        }));
        return;
      }

      const decrypted = decryptState(data.thoughts);
      if (decrypted) {
        const normalized = normalizeState(decrypted);
        res.statusCode = 200;
        res.end(JSON.stringify({
          ...normalized,
          updatedAt: data.updated_at || null
        }));
        return;
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        thoughts: Array.isArray(data.thoughts) ? data.thoughts : [],
        deletedThoughts: Array.isArray(data.deleted_thoughts) ? data.deleted_thoughts : [],
        customCategories: Array.isArray(data.custom_categories) ? data.custom_categories : [],
        updatedAt: data.updated_at || null
      }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Server error', details: error.message }));
    }
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }

  const normalized = normalizeState(body || {});
  const encrypted = encryptState(normalized);

  try {
    const nowIso = new Date().toISOString();
    const payload = {
      id: APP_STATE_ROW_ID,
      thoughts: encrypted,
      deleted_thoughts: [],
      custom_categories: [],
      updated_at: nowIso
    };

    const { error } = await supabase
      .from('app_state')
      .upsert(payload, { onConflict: 'id' });

    if (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Supabase write failed', details: error.message }));
      return;
    }

    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, updatedAt: nowIso }));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Server error', details: error.message }));
  }
};
