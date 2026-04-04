const express    = require('express');
const Database   = require('better-sqlite3');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
const { exec }   = require('child_process');
const fs         = require('fs');
const multer     = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;
const AW   = '/app/audiowmark-linux';
const TMP  = '/tmp';

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Multer for audio file uploads
const upload = multer({ dest: TMP });

const db = new Database(path.join(__dirname, 'sonictag.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    code       TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);
console.log('Database ready: sonictag.db');

function generateUniqueCode() {
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(100000000 + crypto.randomInt(900000000)));
    attempts++;
    if (attempts > 100) throw new Error('Could not generate unique code');
  } while (db.prepare('SELECT 1 FROM codes WHERE code = ?').get(code));
  return code;
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// Convert 9-digit code to 32-char hex for audiowmark (128-bit message)
function codeToHex(code) {
  // Pad code to fill 128 bits: repeat and hash
  const hash = crypto.createHash('sha256').update('soundscan:' + code).digest('hex');
  return hash.substring(0, 32); // first 128 bits
}

// Store code->hex mapping so we can reverse lookup
function hexToCode(hex, codes) {
  for (const code of codes) {
    if (codeToHex(code) === hex) return code;
  }
  return null;
}

app.post('/generate', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!isValidUrl(url)) return res.status(400).json({ error: 'url must start with http:// or https://' });
  try {
    const code      = generateUniqueCode();
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO codes (code, url, created_at) VALUES (?, ?, ?)').run(code, url, createdAt);
    console.log('Generated code ' + code + ' -> ' + url);
    res.json({ code, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate code' });
  }
});

app.get('/lookup/:code', (req, res) => {
  const { code } = req.params;
  if (!/^\d{9}$/.test(code)) return res.status(400).json({ error: 'Code must be exactly 9 digits' });
  const row = db.prepare('SELECT code, url FROM codes WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ error: 'Code not found' });
  console.log('Lookup ' + code + ' -> ' + row.url);
  res.json({ code: row.code, url: row.url });
});

// Generate watermarked WAV file for a code
app.get('/watermark/:code', (req, res) => {
  const { code } = req.params;
  if (!/^\d{9}$/.test(code)) return res.status(400).json({ error: 'Code must be exactly 9 digits' });

  const row = db.prepare('SELECT code FROM codes WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ error: 'Code not found' });

  const hex     = codeToHex(code);
  const input   = path.join(__dirname, 'silence.wav');
  const output  = path.join(TMP, 'wm_' + code + '.wav');

  // Generate 30s silence WAV if not exists
  const genSilence = !fs.existsSync(input)
    ? new Promise((resolve, reject) => {
        exec('ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 30 ' + input, (err) => {
          if (err) reject(err); else resolve();
        });
      })
    : Promise.resolve();

  genSilence.then(() => {
    exec(AW + ' add ' + input + ' ' + output + ' ' + hex, (err, stdout, stderr) => {
      if (err) {
        console.error('audiowmark error:', stderr);
        return res.status(500).json({ error: 'Watermarking failed', detail: stderr });
      }
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', 'attachment; filename="soundscan_' + code + '.wav"');
      const stream = fs.createReadStream(output);
      stream.pipe(res);
      stream.on('end', () => { try { fs.unlinkSync(output); } catch {} });
    });
  }).catch(err => res.status(500).json({ error: 'Failed to generate silence', detail: String(err) }));
});

// Detect watermark from uploaded audio
app.post('/detect', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  const input = req.file.path;
  exec(AW + ' get ' + input, (err, stdout, stderr) => {
    try { fs.unlinkSync(input); } catch {}
    
    // Parse audiowmark output - look for "pattern all HEXCODE" line
    const lines = stdout.split('\n');
    let detected = null;
    for (const line of lines) {
      const m = line.match(/^pattern\s+\S+\s+([0-9a-f]{32})/);
      if (m) {
        const hex = m[1];
        // Look up which code matches this hex
        const allCodes = db.prepare('SELECT code FROM codes').all().map(r => r.code);
        const code = hexToCode(hex, allCodes);
        if (code) { detected = code; break; }
      }
    }

    if (detected) {
      const row = db.prepare('SELECT code, url FROM codes WHERE code = ?').get(detected);
      res.json({ code: detected, url: row.url });
    } else {
      res.status(404).json({ error: 'No watermark detected', raw: stdout });
    }
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
