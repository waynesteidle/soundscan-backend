/**
 * SonicTag — Backend API v1
 *
 * Endpoints:
 *   POST /generate        { url } → { code, url }
 *   GET  /lookup/:code    → { code, url }
 *   GET  /health          → { status: "ok" }
 */

const express    = require('express');
const Database   = require('better-sqlite3');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ── Database setup ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'sonictag.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    code       TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

console.log('Database ready: sonictag.db');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a random 9-digit code that doesn't already exist in the DB. */
function generateUniqueCode() {
  let code;
  let attempts = 0;
  do {
    // Random number between 100000000 and 999999999
    code = String(Math.floor(100000000 + crypto.randomInt(900000000)));
    attempts++;
    if (attempts > 100) throw new Error('Could not generate unique code');
  } while (db.prepare('SELECT 1 FROM codes WHERE code = ?').get(code));
  return code;
}

/** Basic URL validation */
function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /generate
 * Body: { "url": "https://example.com" }
 * Returns: { "code": "123456789", "url": "https://example.com" }
 */
app.post('/generate', (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }
  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'url must start with http:// or https://' });
  }

  try {
    const code      = generateUniqueCode();
    const createdAt = new Date().toISOString();

    db.prepare('INSERT INTO codes (code, url, created_at) VALUES (?, ?, ?)')
      .run(code, url, createdAt);

    console.log(`Generated code ${code} → ${url}`);
    res.json({ code, url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

/**
 * GET /lookup/:code
 * Returns: { "code": "123456789", "url": "https://example.com" }
 */
app.get('/lookup/:code', (req, res) => {
  const { code } = req.params;

  if (!/^\d{9}$/.test(code)) {
    return res.status(400).json({ error: 'Code must be exactly 9 digits' });
  }

  const row = db.prepare('SELECT code, url FROM codes WHERE code = ?').get(code);

  if (!row) {
    return res.status(404).json({ error: 'Code not found' });
  }

  console.log(`Lookup ${code} → ${row.url}`);
  res.json({ code: row.code, url: row.url });
});

/**
 * GET /health
 * Simple health check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/audiowmark-test', (req, res) => {
  const { exec } = require('child_process');
  exec('audiowmark --version', (err, stdout, stderr) => {
    res.json({
      available: !err,
      output: stdout || stderr || String(err)
    });
  });
});
```

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nSonicTag API running at http://localhost:${PORT}`);
  console.log(`  POST http://localhost:${PORT}/generate`);
  console.log(`  GET  http://localhost:${PORT}/lookup/:code`);
  console.log(`  GET  http://localhost:${PORT}/health`);
});
