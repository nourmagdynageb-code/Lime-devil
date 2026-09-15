const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
//  إزالة أي headers قد تمنع blob: URLs
// ============================================================
app.use((req, res, next) => {
  // شيل أي قيود صارمة بتحطها Railway افتراضياً
  res.removeHeader('Cross-Origin-Embedder-Policy');
  res.removeHeader('Cross-Origin-Opener-Policy');
  res.removeHeader('Cross-Origin-Resource-Policy');
  res.removeHeader('Content-Security-Policy');

  // حط CSP مرن بيدعم كل احتياجاتك (Firebase + blob + data + webrtc)
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
//  تقديم الملفات الثابتة (index.html, voice.js, call.js, ...)
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

// fallback: أي route غير معروف → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Lime Devil server running on port ${PORT}`);
});
