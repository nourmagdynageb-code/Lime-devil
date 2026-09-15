const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// زيادة الحد عشان نستقبل الملفات الكبيرة (التسجيلات)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ... (كود الـ CSP زي ما هو) ...

// ============================================================
//  API جديد: تحويل الصوت إلى MP3
// ============================================================
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { PassThrough } = require('stream');

// ضبط مسار ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

app.post('/api/convert-audio', async (req, res) => {
  try {
    const { audioDataUrl } = req.body;
    if (!audioDataUrl || !audioDataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Invalid audio data' });
    }

    // فصل الـ base64 عن الـ header
    const base64Data = audioDataUrl.split(',')[1];
    const inputBuffer = Buffer.from(base64Data, 'base64');

    const inputStream = new PassThrough();
    inputStream.end(inputBuffer);

    const outputStream = new PassThrough();
    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk));

    // تشغيل ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputStream)
        .inputFormat('webm') // أو 'mp4' حسب اللي الآيفون بيسجله
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .format('mp3')
        .on('error', reject)
        .on('end', resolve)
        .pipe(outputStream, { end: true });
    });

    const mp3Buffer = Buffer.concat(chunks);
    const mp3DataUrl = `data:audio/mp3;base64,${mp3Buffer.toString('base64')}`;

    res.json({ audioDataUrl: mp3DataUrl, mimeType: 'audio/mp3' });
  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// ... (باقي كود static والـ fallback زي ما هو) ...
