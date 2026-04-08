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
const TMP  = '/tmp';
const WM   = path.join(__dirname, 'watermark.py');
const SP   = path.join(__dirname, 'spectrum.py');
const CARRIER = path.join(__dirname, 'soundscan_carrier.wav');

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
    res.json({ code: row.code, url: row.url });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/watermark/:code', async (req, res) => {
  const { code } = req.params;
  if (!/^\d{9}$/.test(code)) return res.status(400).json({ error: 'Code must be 9 digits' });
  try {
    const result = await pool.query('SELECT code FROM codes WHERE code = $1', [code]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Code not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }

  if (!fs.existsSync(CARRIER)) {
    return res.status(500).json({ error: 'Carrier file not found' });
  }

  const output = path.join(TMP, 'wm_' + code + '.wav');
  const cmd = 'python3 ' + WM + ' embed ' + CARRIER + ' ' + output + ' ' + code;

  exec(cmd, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'Watermarking failed', detail: stderr });
    console.log('Watermarked code ' + code);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', 'attachment; filename="soundscan_' + code + '.wav"');
    const stream = fs.createReadStream(output);
    stream.pipe(res);
    stream.on('end', () => { try { fs.unlinkSync(output); } catch {} });
  });
});

app.post('/detect', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  const input     = req.file.path;
  const converted = input + '_converted.wav';

  exec('ffmpeg -y -i ' + input + ' -ar 44100 -ac 1 -f wav ' + converted, async (ferr) => {
    try { fs.unlinkSync(input); } catch {}
    const audioFile = ferr ? input : converted;

    // Log spectrum for diagnostics
    exec('python3 ' + SP + ' ' + audioFile, (se, so) => {
      if (so) console.log('Spectrum: ' + so.trim().replace(/\n/g, ' | '));
    });

    const cmd = 'python3 ' + WM + ' detect_raw ' + audioFile;
    exec(cmd, async (err, stdout, stderr) => {
      try { fs.unlinkSync(audioFile); } catch {}

      console.log('Detect: ' + stdout.trim());

      const rawMatch  = stdout.match(/Raw:\s*(\d+)/);
      const confMatch = stdout.match(/Confidence:\s*([\d.]+)/);

      if (!rawMatch || !confMatch) {
        return res.status(404).json({ error: 'No watermark detected', raw: stdout });
      }

      const rawN = parseInt(rawMatch[1]);
      const conf = parseFloat(confMatch[1]);

      // Try exact + all single-bit-flip variants
      const candidates = [];
      if (rawN >= 100000000 && rawN <= 999999999) candidates.push(String(rawN));
      for (let i = 0; i < 30; i++) {
        const flipped = rawN ^ (1 << i);
        if (flipped >= 100000000 && flipped <= 999999999) candidates.push(String(flipped));
      }

      try {
        for (const candidate of candidates) {
          const row = await pool.query('SELECT code, url FROM codes WHERE code = $1', [candidate]);
          if (row.rows.length > 0) {
            const isExact = candidate === String(rawN);
            console.log('Matched: ' + candidate + (isExact ? ' (exact)' : ' (1-bit corrected)'));
            return res.json({ code: candidate, url: row.rows[0].url, confidence: conf });
          }
        }
        res.status(404).json({ error: 'No watermark detected', raw: stdout, raw_n: rawN, confidence: conf });
      } catch (dbErr) {
        res.status(500).json({ error: 'Database error' });
      }
    });
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/carrier-test', (req, res) => {
  const exists   = fs.existsSync(CARRIER);
  const wmExists = fs.existsSync(WM);
  const size     = exists ? fs.statSync(CARRIER).size : 0;
  res.json({ carrier_exists: exists, carrier_size_mb: (size/1024/1024).toFixed(2), watermark_py_exists: wmExists });
});

app.get('/wm-test', (req, res) => {
  const tc = path.join(TMP, 'wm_test_carrier.wav');
  const tm = path.join(TMP, 'wm_test_marked.wav');
  exec('python3 ' + WM + ' generate ' + tc + ' 5', (e1) => {
    if (e1) return res.json({ error: 'generate failed' });
    exec('python3 ' + WM + ' embed ' + tc + ' ' + tm + ' 123456789', (e2) => {
      try { fs.unlinkSync(tc); } catch {}
      if (e2) return res.json({ error: 'embed failed' });
      exec('python3 ' + WM + ' detect_raw ' + tm, (e3, stdout) => {
        try { fs.unlinkSync(tm); } catch {}
        res.json({ result: stdout.trim(), error: e3 ? String(e3) : null });
      });
    });
  });
});

app.listen(PORT, () => {
  console.log('SoundScan API running at http://localhost:' + PORT);
});
