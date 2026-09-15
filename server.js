const express = require('express');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { PassThrough } = require('stream');

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
//  CORS — عشان Firebase و أي API تشتغل بدون قيود
// ============================================================
app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  // ملاحظة: مفيش Content-Security-Policy هنا — سايبينها مفتوحة
  next();
});

// ============================================================
//  API: تحويل الصوت إلى MP3
// ============================================================
app.post('/api/convert-audio', async (req, res) => {
  try {
    const { audioDataUrl } = req.body;
    if (!audioDataUrl || !audioDataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Invalid audio data' });
    }

    const m = audioDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ error: 'Bad data URL format' });
    }

    const inputMime = m[1];
    const base64Data = m[2];
    const inputBuffer = Buffer.from(base64Data, 'base64');

    let inputFormat = 'webm';
    if (inputMime.includes('mp4')) inputFormat = 'mp4';
    else if (inputMime.includes('ogg')) inputFormat = 'ogg';
    else if (inputMime.includes('webm')) inputFormat = 'webm';
    else if (inputMime.includes('mpeg') || inputMime.includes('mp3')) inputFormat = 'mp3';
    else if (inputMime.includes('wav')) inputFormat = 'wav';

    console.log(`[convert] mime=${inputMime} format=${inputFormat} size=${inputBuffer.length}`);

    const inputStream = new PassThrough();
    inputStream.end(inputBuffer);

    const outputStream = new PassThrough();
    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk));

    await new Promise((resolve, reject) => {
      ffmpeg(inputStream)
        .inputFormat(inputFormat)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .format('mp3')
        .on('error', (err) => {
          console.error('[convert] ffmpeg error:', err.message);
          reject(err);
        })
        .on('end', () => {
          console.log('[convert] ffmpeg done. chunks:', chunks.length);
          resolve();
        })
        .pipe(outputStream, { end: true });
    });

    const mp3Buffer = Buffer.concat(chunks);
    const mp3DataUrl = `data:audio/mpeg;base64,${mp3Buffer.toString('base64')}`;

    res.json({ audioDataUrl: mp3DataUrl, mimeType: 'audio/mpeg' });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed', details: String(error) });
  }
});

// ============================================================
//  Static files
// ============================================================
app.use(express.static(__dirname));

// ============================================================
//  Fallback — للمسارات اللي من غير امتداد بس
//  (عشان مايتداخلش مع ملفات مفقودة)
// ============================================================
app.get('*', (req, res) => {
  // لو المسار فيه امتداد ملف (زي .json .js .png) → رجّع 404 عادي
  if (/\.\w+$/.test(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  Start server
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Lime Devil server running on port ${PORT}`);
  console.log(`✅ ffmpeg path: ${ffmpegPath}`);
});
