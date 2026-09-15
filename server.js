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
//  Headers — إزالة أي قيود تمنع blob: أو Firebase
// ============================================================
app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  // ملاحظة: مفيش CSP هنا عشان ما نكسرش شاشة الباسورد
  next();
});

// ============================================================
//  API: تحويل الصوت إلى MP3
//  ✅ يدعم data URLs مع ;codecs=... (زي audio/webm;codecs=opus)
// ============================================================
app.post('/api/convert-audio', async (req, res) => {
  try {
    const { audioDataUrl } = req.body;
    if (!audioDataUrl || typeof audioDataUrl !== 'string' || !audioDataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Invalid audio data' });
    }

    // ✅ الطريقة الصحيحة: افصل عند أول فاصلة
    // مثال: "data:audio/webm;codecs=opus;base64,GkXfo..."
    //           ↑ header                    ↑ comma    ↑ payload
    const commaIdx = audioDataUrl.indexOf(',');
    if (commaIdx === -1) {
      return res.status(400).json({ error: 'No comma in data URL' });
    }

    const header = audioDataUrl.slice(0, commaIdx);      // data:audio/webm;codecs=opus;base64
    const base64Data = audioDataUrl.slice(commaIdx + 1); // GkXfo...

    // استخرج الـ mime (أول حاجة بعد data: وقبل أي ;)
    const mimeMatch = header.match(/^data:([^;]+)/i);
    const inputMime = mimeMatch ? mimeMatch[1].toLowerCase() : 'audio/webm';

    // فك الـ base64
    let inputBuffer;
    try {
      inputBuffer = Buffer.from(base64Data, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64 data' });
    }

    if (!inputBuffer || inputBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio data' });
    }

    // حدد inputFormat من الـ mime
    let inputFormat = 'webm';
    if (inputMime.includes('mp4')) inputFormat = 'mp4';
    else if (inputMime.includes('ogg')) inputFormat = 'ogg';
    else if (inputMime.includes('webm')) inputFormat = 'webm';
    else if (inputMime.includes('mpeg') || inputMime.includes('mp3')) inputFormat = 'mp3';
    else if (inputMime.includes('wav')) inputFormat = 'wav';
    else if (inputMime.includes('aac')) inputFormat = 'aac';
    else if (inputMime.includes('m4a')) inputFormat = 'm4a';

    console.log(`[convert] mime=${inputMime} format=${inputFormat} size=${inputBuffer.length} bytes`);

    // حوّل الـ buffer لـ stream
    const inputStream = new PassThrough();
    inputStream.end(inputBuffer);

    const outputStream = new PassThrough();
    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk));

    // شغّل ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputStream)
        .inputFormat(inputFormat)
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .audioChannels(1)         // mono — أقل حجماً وأوسع توافقاً
        .audioFrequency(44100)    // sample rate قياسي
        .format('mp3')
        .on('start', (cmd) => {
          console.log('[convert] ffmpeg started');
        })
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
    if (!mp3Buffer || mp3Buffer.length === 0) {
      return res.status(500).json({ error: 'Conversion produced empty output' });
    }

    console.log(`[convert] output size: ${mp3Buffer.length} bytes`);

    const mp3DataUrl = `data:audio/mpeg;base64,${mp3Buffer.toString('base64')}`;

    res.json({ audioDataUrl: mp3DataUrl, mimeType: 'audio/mpeg' });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed', details: String(error) });
  }
});

// ============================================================
//  Static files — index.html, voice.js, call.js, ...
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
//  Fallback: أي route غير معروف → index.html
//  (بس 404 للملفات اللي ليها امتداد ومش موجودة)
// ============================================================
app.get('*', (req, res) => {
  // لو الطلب لملف (فيه امتداد) → 404
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
  console.log(`✅ Ready to convert audio to MP3`);
});
