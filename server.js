const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  ffmpeg setup
// ============================================================
ffmpeg.setFfmpegPath(ffmpegPath);

// ============================================================
//  Body parser
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================================
//  Headers
// ============================================================
app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  next();
});

// ============================================================
//  API: تحويل الصوت إلى MP3
//  ✅ الإصلاح: نستخدم ملفات مؤقتة بدل streams
//     عشان ffmpeg يقدر يعمل seek ويحسب المدة الصح
// ============================================================
app.post('/api/convert-audio', async (req, res) => {
  let inputPath = null;
  let outputPath = null;

  try {
    const { audioDataUrl } = req.body;
    if (!audioDataUrl || typeof audioDataUrl !== 'string' || !audioDataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Invalid audio data' });
    }

    // افصل الـ data URL
    const commaIdx = audioDataUrl.indexOf(',');
    if (commaIdx === -1) {
      return res.status(400).json({ error: 'No comma in data URL' });
    }

    const header = audioDataUrl.slice(0, commaIdx);
    const base64Data = audioDataUrl.slice(commaIdx + 1);

    const mimeMatch = header.match(/^data:([^;]+)/i);
    const inputMime = mimeMatch ? mimeMatch[1].toLowerCase() : 'audio/webm';

    let inputBuffer;
    try {
      inputBuffer = Buffer.from(base64Data, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64 data' });
    }

    if (!inputBuffer || inputBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio data' });
    }

    // حدد الامتداد
    let inputExt = 'webm';
    if (inputMime.includes('mp4') || inputMime.includes('m4a')) inputExt = 'mp4';
    else if (inputMime.includes('ogg')) inputExt = 'ogg';
    else if (inputMime.includes('webm')) inputExt = 'webm';
    else if (inputMime.includes('mpeg') || inputMime.includes('mp3')) inputExt = 'mp3';
    else if (inputMime.includes('wav')) inputExt = 'wav';
    else if (inputMime.includes('aac')) inputExt = 'aac';

    // ✅ اكتب على ملف مؤقت — الحل الجذري
    const id = crypto.randomBytes(8).toString('hex');
    inputPath = path.join(os.tmpdir(), `voice-in-${id}.${inputExt}`);
    outputPath = path.join(os.tmpdir(), `voice-out-${id}.mp3`);

    fs.writeFileSync(inputPath, inputBuffer);
    console.log(`[convert] mime=${inputMime} ext=${inputExt} size=${inputBuffer.length} bytes`);

    // ✅ شغّل ffmpeg على الملفات (يدعم seek → مدة صح)
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .audioChannels(1)
        .audioFrequency(44100)
        .format('mp3')
        // ✅ مهم جداً: خلي ffmpeg يكتب header الـ Xing/LAME
        .outputOptions([
          '-write_xing', '1',
          '-id3v2_version', '3',
          '-write_id3v1', '1'
        ])
        .on('start', (cmd) => console.log('[convert] ffmpeg started'))
        .on('error', (err) => {
          console.error('[convert] ffmpeg error:', err.message);
          reject(err);
        })
        .on('end', () => {
          console.log('[convert] ffmpeg done');
          resolve();
        })
        .save(outputPath);
    });

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Output file missing' });
    }

    const mp3Buffer = fs.readFileSync(outputPath);
    if (!mp3Buffer || mp3Buffer.length === 0) {
      return res.status(500).json({ error: 'Empty MP3 output' });
    }

    console.log(`[convert] ✅ Output size: ${mp3Buffer.length} bytes`);

    const mp3DataUrl = `data:audio/mpeg;base64,${mp3Buffer.toString('base64')}`;
    res.json({ audioDataUrl: mp3DataUrl, mimeType: 'audio/mpeg' });

  } catch (error) {
    console.error('Conversion error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Conversion failed', details: String(error) });
    }
  } finally {
    // نظّف الملفات المؤقتة
    if (inputPath) {
      try { fs.unlinkSync(inputPath); } catch (_) {}
    }
    if (outputPath) {
      try { fs.unlinkSync(outputPath); } catch (_) {}
    }
  }
});

// ============================================================
//  Static files
// ============================================================
app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    }
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
  }
}));

// ============================================================
//  Fallback
// ============================================================
app.get('*', (req, res) => {
  if (/\.\w+$/.test(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  Start
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Lime Devil server running on port ${PORT}`);
  console.log(`✅ ffmpeg path: ${ffmpegPath}`);
});
