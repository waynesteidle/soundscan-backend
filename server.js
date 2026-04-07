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
    console.log('Lookup ' + code + ' -> ' + row.url);
    res.json({ code: row.code, url: row.url });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Generate watermarked WAV using custom SoundScan watermarker
// Primary band 8-12kHz: survives ALL TV speakers
// Secondary band 15-17kHz: sub-human on good TVs
// Detects in 1 second from any point in the 30-second loop
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

// Detect watermark from uploaded audio recording
app.post('/detect', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  const input  = req.file.path;
  const converted = input + '_converted.wav';

  // Convert uploaded audio to standard WAV format first
  exec('ffmpeg -y -i ' + input + ' -ar 44100 -ac 1 -f wav ' + converted, (ferr, fout, ferr2) => {
    try { fs.unlinkSync(input); } catch {}
    if (ferr) {
      // If ffmpeg fails, try directly
      runDetect(input);
    } else {
      runDetect(converted);
    }
  });

  function runDetect(audioFile) {
  const cmd = 'python3 ' + WM + ' detect_any_sr ' + audioFile;

  exec(cmd, async (err, stdout, stderr) => {
    try { fs.unlinkSync(audioFile); } catch {}

    console.log('Detect output: ' + stdout.trim());

    // Parse output: "Detected: 123456789 (confidence=0.987)"
    const m = stdout.match(/Detected:\s*(\d{9})\s*\(confidence=([\d.]+)\)/);

    if (m) {
      const code = m[1];
      const conf = parseFloat(m[2]);
      try {
        const row = await pool.query('SELECT code, url FROM codes WHERE code = $1', [code]);
        if (row.rows.length > 0) {
          res.json({ code, url: row.rows[0].url, confidence: conf });
        } else {
          res.status(404).json({ error: 'Code not found in database', code, confidence: conf });
        }
      } catch (dbErr) {
        res.status(500).json({ error: 'Database error' });
      }
    } else {
      const nothingMatch = stdout.match(/Nothing detected \(confidence=([\d.]+)\)/);
      const conf = nothingMatch ? parseFloat(nothingMatch[1]) : 0;
      res.status(404).json({ error: 'No watermark detected', confidence: conf });
    }
  });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});



app.get('/wm-test', (req, res) => {
  const testCode = '123456789';
  const carrier = path.join(TMP, 'wm_diag_carrier.wav');
  const marked  = path.join(TMP, 'wm_diag_marked.wav');
  
  // Generate a short carrier and watermark it, then detect
  exec('python3 -c "import sys; sys.path.insert(0,chr(47)+chr(97)+chr(112)+chr(112)); from watermark import generate_carrier, watermark_file, detect_file; generate_carrier(5.0, chr(47)+chr(116)+chr(109)+chr(112)+chr(47)+chr(99)+chr(97)+chr(114)+chr(46)+chr(119)+chr(97)+chr(118)); watermark_file(chr(47)+chr(116)+chr(109)+chr(112)+chr(47)+chr(99)+chr(97)+chr(114)+chr(46)+chr(119)+chr(97)+chr(118), chr(47)+chr(116)+chr(109)+chr(112)+chr(47)+chr(109)+chr(107)+chr(46)+chr(119)+chr(97)+chr(118), chr(49)+chr(50)+chr(51)+chr(52)+chr(53)+chr(54)+chr(55)+chr(56)+chr(57)); code,conf = detect_file(chr(47)+chr(116)+chr(109)+chr(112)+chr(47)+chr(109)+chr(107)+chr(46)+chr(119)+chr(97)+chr(118)); print(code, conf)"', (err, stdout, stderr) => {
    res.json({ result: stdout.trim(), error: stderr.trim() });
  });
});


app.get('/wm-test', (req, res) => {
  const script = `
import sys
sys.path.insert(0, '/app')
from watermark import generate_carrier, watermark_file, detect_file
generate_carrier(5.0, '/tmp/tc.wav')
watermark_file('/tmp/tc.wav', '/tmp/tm.wav', '123456789')
code, conf = detect_file('/tmp/tm.wav')
print(f'{code} {conf:.3f}')
`;
  exec('python3 -c "' + script.replace(/"/g, '\"').replace(/
/g, ';') + '"', (err, stdout, stderr) => {
    res.json({ result: stdout.trim(), error: stderr.trim().slice(0,200) });
  });
});

app.get('/python-test', (req, res) => {
  exec('python3 ' + WM + ' detect_any_sr 2>&1 || true', (err, stdout, stderr) => {
    exec('python3 -c "import numpy; import scipy; print(numpy.__version__, scipy.__version__)"', (err2, stdout2, stderr2) => {
      res.json({ 
        wm_test: stdout || stderr || String(err),
        python_libs: stdout2 || stderr2 || String(err2)
      });
    });
  });
});

app.get('/carrier-test', (req, res) => {
  const exists = fs.existsSync(CARRIER);
  const wmExists = fs.existsSync(WM);
  const size = exists ? fs.statSync(CARRIER).size : 0;
  res.json({
    carrier_exists: exists,
    carrier_size_mb: (size/1024/1024).toFixed(2),
    watermark_py_exists: wmExists
  });
});

app.listen(PORT, () => {
  console.log('SoundScan API running at http://localhost:' + PORT);
  console.log('POST /generate');
  console.log('GET  /lookup/:code');
  console.log('GET  /watermark/:code');
  console.log('POST /detect');
  console.log('GET  /health');
  console.log('GET  /carrier-test');
});
