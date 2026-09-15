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
//  Body parser (للتسجيلات الكبيرة)
// ============================================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================================
//  Security headers — CSP مرن يدعم blob: و Firebase
// ============================================================
app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https: https://*.googleapis.com https://*.gstatic.com https://*.firebaseio.com https://*.firebase.com",
      "style-src 'self' 'unsafe-inline' https:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: data: https:",
      "connect-src 'self' blob: data: https: wss: https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.cloudfunctions.net https://*.firebase.com",
      "font-src 'self' data: https:",
      "frame-src 'self' https:",
      "worker-src 'self' blob:"
    ].join('; ')
  );

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

    // استخرج الـ mime ونوع الملف
    const m = audioDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ error: 'Bad data URL format' });
    }

    const inputMime = m[1];
    const base64Data = m[2];
    const inputBuffer = Buffer.from(base64Data, 'base64');

    // حدد inputFormat من الـ mime
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
//  Static files — يقدم index.html, voice.js, call.js
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
//  Fallback: أي route → index.html
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
//  Start server  ← ده اللي كان ناقص!
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ Lime Devil server running on port ${PORT}`);
  console.log(`✅ ffmpeg path: ${ffmpegPath}`);
});
