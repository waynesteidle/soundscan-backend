const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;
const AW   = '/app/audiowmark-linux';
const TMP  = '/tmp';

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const upload = multer({ dest: TMP });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS codes (
      code       TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  console.log('PostgreSQL database ready');
}

initDb().catch(err => console.error('Database init failed:', err.message));

function generateCode() {
  return String(Math.floor(100000000 + crypto.randomInt(900000000)));
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function codeToHex(code) {
  return crypto.createHash('sha256').update('soundscan:' + code).digest('hex').substring(0, 32);
}

app.post('/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    let code;
    let attempts = 0;
    do {
      code = generateCode();
      attempts++;
      if (attempts > 100) throw new Error('Could not generate unique code');
      const existing = await pool.query('SELECT 1 FROM codes WHERE code = $1', [code]);
      if (existing.rows.length === 0) break;
    } while (true);
    const createdAt = new Date().toISOString();
    await pool.query('INSERT INTO codes (code, url, created_at) VALUES ($1, $2, $3)', [code, url, createdAt]);
    console.log('Generated code ' + code + ' -> ' + url);
    res.json({ code, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

app.get('/lookup/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^\d{9}$/.test(code)) return res.status(400).json({ error: 'Code must be 9 digits' });
  try {
    const result = await pool.query('SELECT code, url FROM codes WHERE code = $1', [code]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Code not found' });
    const row = result.rows[0];
    console.log('Lookup ' + code + ' -> ' + row.url);
    res.json({ code: row.code, url: row.url });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Generate watermarked WAV
// Uses white noise at 0.5 amplitude to ensure audiowmark can embed reliably
// Then we attenuate the output to make it inaudible
app.get('/watermark/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^\d{9}$/.test(code)) return res.status(400).json({ error: 'Code must be 9 digits' });
  try {
    const result = await pool.query('SELECT code FROM codes WHERE code = $1', [code]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Code not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }

  const hex      = codeToHex(code);
  const carrier  = path.join(TMP, 'carrier_' + code + '.wav');
  const marked   = path.join(TMP, 'marked_' + code + '.wav');
  const output   = path.join(TMP, 'wm_' + code + '.wav');

  // Step 1: Generate pink noise at full amplitude so audiowmark works reliably
  exec('ffmpeg -y -f lavfi -i anoisesrc=r=44100:color=pink:amplitude=0.5 -ac 2 -t 30 ' + carrier, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to generate carrier', detail: String(err) });

    // Step 2: Embed watermark at full amplitude
    exec(AW + ' add --strength 10 ' + carrier + ' ' + marked + ' ' + hex, (err2, stdout2, stderr2) => {
      try { fs.unlinkSync(carrier); } catch {}
      if (err2) return res.status(500).json({ error: 'Watermarking failed', detail: stderr2 });

      console.log('Watermark embed output: ' + stdout2);

      // Step 3: Attenuate to -30dB (inaudible) while preserving the watermark
      exec('ffmpeg -y -i ' + marked + ' -af volume=-30dB ' + output, (err3) => {
        try { fs.unlinkSync(marked); } catch {}
        if (err3) return res.status(500).json({ error: 'Attenuation failed' });

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Disposition', 'attachment; filename="soundscan_' + code + '.wav"');
        const stream = fs.createReadStream(output);
        stream.pipe(res);
        stream.on('end', () => { try { fs.unlinkSync(output); } catch {} });
      });
    });
  });
});

// Detect watermark from uploaded audio
app.post('/detect', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  const input = req.file.path;

  // Amplify before detection to compensate for attenuation
  const amplified = input + '_amp.wav';
  exec('ffmpeg -y -i ' + input + ' -af volume=30dB ' + amplified, async (ferr) => {
    try { fs.unlinkSync(input); } catch {}
    if (ferr) return res.status(500).json({ error: 'Amplification failed' });

    exec(AW + ' get ' + amplified, async (err, stdout, stderr) => {
      try { fs.unlinkSync(amplified); } catch {}

      console.log('Detect output: ' + stdout);

      const lines = stdout.split('\n');
      let detected = null;

      try {
        const allCodes = await pool.query('SELECT code FROM codes');
        const codes = allCodes.rows.map(r => r.code);

        for (const line of lines) {
          const m = line.match(/^pattern\s+\S+\s+([0-9a-f]{32})/);
          if (m) {
            const hex = m[1];
            if (hex === '00000000000000000000000000000000') continue;
            for (const code of codes) {
              if (codeToHex(code) === hex) { detected = code; break; }
            }
            if (detected) break;
          }
        }
      } catch (dbErr) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (detected) {
        const row = await pool.query('SELECT code, url FROM codes WHERE code = $1', [detected]);
        res.json({ code: detected, url: row.rows[0].url });
      } else {
        res.status(404).json({ error: 'No watermark detected', raw: stdout });
      }
    });
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/audiowmark-test', (req, res) => {
  exec(AW + ' --version', (err, stdout, stderr) => {
    res.json({ available: !err, output: stdout || stderr || String(err) });
  });
});

app.listen(PORT, () => {
  console.log('SonicTag API running at http://localhost:' + PORT);
  console.log('POST /generate');
  console.log('GET  /lookup/:code');
  console.log('GET  /watermark/:code');
  console.log('POST /detect');
  console.log('GET  /health');
  console.log('GET  /audiowmark-test');
});
