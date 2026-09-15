const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const app = express();
const PORT = process.env.PORT || 3000;

ffmpeg.setFfmpegPath(ffmpegPath);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  next();
});

// ============================================================
//  إصلاح WebM duration باستخدام ts-ebml
//  المشكلة: MediaRecorder بيكتب WebM بدون Duration element
//  الحل: نستخدم ts-ebml نضيف Duration للـ header
// ============================================================
async function fixWebmDuration(inputBuffer) {
  try {
    const tsEbml = require('ts-ebml');
    const { Decoder, tools, Reader } = tsEbml;

    const decoder = new Decoder();
    const reader = new Reader();
    reader.logging = false;

    // حوّل Buffer لـ ArrayBuffer
    const arrayBuffer = inputBuffer.buffer.slice(
      inputBuffer.byteOffset,
      inputBuffer.byteOffset + inputBuffer.byteLength
    );

    const elms = decoder.decode(arrayBuffer);
    elms.forEach((elm) => reader.read(elm));
    reader.stop();

    if (!reader.duration || reader.duration <= 0) {
      console.log('[fix-webm] no duration detected, skipping');
      return inputBuffer;
    }

    const refinedMetadataBuf = tools.makeMetadataSeekable(
      reader.metadatas,
      reader.duration,
      reader.cues
    );

    const body = arrayBuffer.slice(reader.metadataSize);
    const fixedBuffer = Buffer.concat([
      Buffer.from(refinedMetadataBuf),
      Buffer.from(body)
    ]);

    console.log(`[fix-webm] ✅ duration=${reader.duration}ms newSize=${fixedBuffer.length}`);
    return fixedBuffer;
  } catch (err) {
    console.warn('[fix-webm] failed:', err.message);
    return inputBuffer;
  }
}

// ============================================================
//  API: تحويل الصوت إلى MP3
// ============================================================
app.post('/api/convert-audio', async (req, res) => {
  let inputPath = null;
  let fixedPath = null;
  let outputPath = null;

  try {
    const { audioDataUrl } = req.body;
    if (!audioDataUrl || typeof audioDataUrl !== 'string' || !audioDataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Invalid audio data' });
    }

    const commaIdx = audioDataUrl.indexOf(',');
    if (commaIdx === -1) return res.status(400).json({ error: 'No comma' });

    const header = audioDataUrl.slice(0, commaIdx);
    const base64Data = audioDataUrl.slice(commaIdx + 1);

    const mimeMatch = header.match(/^data:([^;]+)/i);
    const inputMime = mimeMatch ? mimeMatch[1].toLowerCase() : 'audio/webm';

    let inputBuffer;
    try {
      inputBuffer = Buffer.from(base64Data, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64' });
    }

    if (!inputBuffer || inputBuffer.length === 0) {
      return res.status(400).json({ error: 'Empty audio' });
    }

    let inputExt = 'webm';
    if (inputMime.includes('mp4') || inputMime.includes('m4a')) inputExt = 'mp4';
    else if (inputMime.includes('ogg')) inputExt = 'ogg';
    else if (inputMime.includes('webm')) inputExt = 'webm';
    else if (inputMime.includes('mpeg') || inputMime.includes('mp3')) inputExt = 'mp3';
    else if (inputMime.includes('wav')) inputExt = 'wav';

    console.log(`[convert] mime=${inputMime} ext=${inputExt} size=${inputBuffer.length}`);

    // ✅ لو WebM، نصلّح الـ duration الأول
    let workingBuffer = inputBuffer;
    if (inputExt === 'webm') {
      workingBuffer = await fixWebmDuration(inputBuffer);
    }

    const id = crypto.randomBytes(8).toString('hex');
    inputPath = path.join(os.tmpdir(), `voice-in-${id}.${inputExt}`);
    outputPath = path.join(os.tmpdir(), `voice-out-${id}.mp3`);

    fs.writeFileSync(inputPath, workingBuffer);

    // ✅ ffmpeg مع flags لتحسين الدقة
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .inputOptions([
          '-analyzeduration', '100M',
          '-probesize', '100M'
        ])
        .audioCodec('libmp3lame')
        .audioBitrate(128)
        .audioChannels(1)
        .audioFrequency(44100)
        .format('mp3')
        .outputOptions([
          '-write_xing', '1',
          '-id3v2_version', '3',
          '-write_id3v1', '1'
        ])
        .on('start', () => console.log('[convert] ffmpeg started'))
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
      return res.status(500).json({ error: 'Output missing' });
    }

    const mp3Buffer = fs.readFileSync(outputPath);
    if (!mp3Buffer || mp3Buffer.length === 0) {
      return res.status(500).json({ error: 'Empty output' });
    }

    // ✅ اطبع المدة الحقيقية للـ MP3 الناتج
    const duration = await getMp3Duration(outputPath);
    console.log(`[convert] ✅ size=${mp3Buffer.length} duration=${duration}s`);

    const mp3DataUrl = `data:audio/mpeg;base64,${mp3Buffer.toString('base64')}`;
    res.json({ audioDataUrl: mp3DataUrl, mimeType: 'audio/mpeg', duration });

  } catch (error) {
    console.error('Conversion error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Conversion failed', details: String(error) });
    }
  } finally {
    [inputPath, outputPath].forEach((p) => {
      if (p) { try { fs.unlinkSync(p); } catch (_) {} }
    });
  }
});

// ============================================================
//  helper: استخرج مدة MP3
// ============================================================
function getMp3Duration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(0);
      resolve(metadata.format.duration || 0);
    });
  });
}

// ============================================================
//  Static
// ============================================================
app.use(express.static(__dirname));

app.get('*', (req, res) => {
  if (/\.\w+$/.test(req.path)) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Lime Devil server running on port ${PORT}`);
  console.log(`✅ ffmpeg path: ${ffmpegPath}`);
});
