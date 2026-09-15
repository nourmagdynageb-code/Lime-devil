// voice.js
// Final bulletproof voice recorder & player.
// Converts data: URLs to blob: URLs before playback (Chrome WebM/Opus fix).

// ============================================================
//  REGISTRY
// ============================================================
const voiceDurationRegistry = new Map();

export function registerVoiceDuration(src, durationMs) {
  if (!src || !durationMs) return;
  voiceDurationRegistry.set(src, durationMs);
}

// ============================================================
//  DATA URL → BLOB URL  (الحل الجذري لمشكلة Chrome)
// ============================================================
const blobUrlCache = new Map(); // data URL → blob URL

function dataUrlToObjectUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return dataUrl;
  if (!dataUrl.startsWith("data:")) return dataUrl;

  if (blobUrlCache.has(dataUrl)) return blobUrlCache.get(dataUrl);

  try {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) throw new Error("No comma in data URL");

    const header = dataUrl.slice(0, commaIdx);
    const base64 = dataUrl.slice(commaIdx + 1);

    // استخرج mime وأزل ;codecs=... (Chrome مش بيحبها في data URLs)
    const mimeMatch = header.match(/^data:([^;,]+)/i);
    let mime = mimeMatch ? mimeMatch[1].toLowerCase() : "audio/webm";
    if (!mime || mime === "application/octet-stream") mime = "audio/webm";

    // فك الـ base64
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

    // أنشئ blob و URL
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    blobUrlCache.set(dataUrl, url);
    return url;
  } catch (e) {
    console.error("[VOICE] dataUrl→objectUrl failed:", e);
    return dataUrl; // fallback: نرجع الأصلي
  }
}

// ============================================================
//  UTILITIES
// ============================================================
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getAudioSrc(audioEl) {
  let src = audioEl.getAttribute("src");
  if (src) return src;
  if (audioEl.src) return audioEl.src;
  const sourceEl = audioEl.querySelector && audioEl.querySelector("source");
  if (sourceEl) {
    src = sourceEl.getAttribute("src") || sourceEl.src;
    if (src) return src;
  }
  if (audioEl.currentSrc) return audioEl.currentSrc;
  return null;
}

// ============================================================
//  CUSTOM AUDIO PLAYER
// ============================================================
function createCustomAudioPlayer(audioOrSrc, durationMs, accent = "#39FF14") {
  let audio;
  let ownsAudio = false;
  let finalSrc;

  if (typeof audioOrSrc === "string") {
    // ✅ الحل: حوّل data: → blob: قبل التشغيل
    finalSrc = dataUrlToObjectUrl(audioOrSrc);
    audio = new Audio();
    audio.src = finalSrc;
    audio.preload = "metadata";
    ownsAudio = true;
  } else if (audioOrSrc instanceof HTMLAudioElement) {
    audio = audioOrSrc;
    const raw = getAudioSrc(audio);
    finalSrc = dataUrlToObjectUrl(raw);
    // لو كان data URL، بدّله بـ blob URL
    if (finalSrc && finalSrc !== raw) {
      try { audio.src = finalSrc; audio.load(); } catch (_) {}
    }
    if (!audio.preload || audio.preload === "none") audio.preload = "metadata";
  } else {
    console.error("[VOICE] Invalid audio argument");
    return { element: document.createElement("div"), audio: null };
  }

  const wrap = document.createElement("div");
  wrap.className = "custom-audio-player";
  wrap.setAttribute("data-voice-player", "1");
  wrap.style.cssText = `
    display: flex; align-items: center; gap: 10px;
    background: #0a0d0a; border: 1px solid #1c8a0c;
    border-radius: 22px; padding: 6px 12px;
    width: 100%; max-width: 340px;
    font: 12px monospace; color: ${accent};
    box-sizing: border-box;
  `;

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.textContent = "▶";
  playBtn.setAttribute("aria-label", "play");
  playBtn.style.cssText = `
    background: transparent; border: none; color: ${accent};
    font-size: 18px; cursor: pointer; padding: 0;
    width: 32px; height: 32px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  `;

  const progressWrap = document.createElement("div");
  progressWrap.style.cssText = `
    flex: 1; height: 6px; background: #1a1a1a; border-radius: 3px;
    cursor: pointer; position: relative; overflow: hidden; min-width: 60px;
  `;

  const progressBar = document.createElement("div");
  progressBar.style.cssText = `
    height: 100%; background: ${accent}; border-radius: 3px;
    width: 0%; transition: width 0.08s linear;
  `;
  progressWrap.appendChild(progressBar);

  const timeLabel = document.createElement("span");
  timeLabel.style.cssText = `
    font: 11px monospace; color: ${accent}; min-width: 66px;
    text-align: right; flex-shrink: 0; opacity: .85;
  `;

  let totalDuration = (durationMs && durationMs > 0) ? durationMs / 1000 : 0;

  function updateLabel() {
    timeLabel.textContent = `${formatTime(audio.currentTime)} / ${formatTime(totalDuration)}`;
  }

  function refreshDurationFromElement() {
    if (isFinite(audio.duration) && audio.duration > 0) {
      totalDuration = audio.duration;
      updateLabel();
      return true;
    }
    return false;
  }

  if (audio.readyState >= 1) refreshDurationFromElement();

  audio.addEventListener("loadedmetadata", () => {
    if (!refreshDurationFromElement() && totalDuration === 0) {
      const onDur = () => {
        if (isFinite(audio.duration) && audio.duration > 0) {
          totalDuration = audio.duration;
          audio.removeEventListener("durationchange", onDur);
          try { audio.currentTime = 0; } catch (_) {}
          updateLabel();
        }
      };
      audio.addEventListener("durationchange", onDur);
      try { audio.currentTime = 1e101; } catch (_) {}
    }
    updateLabel();
  });

  audio.addEventListener("timeupdate", () => {
    if (totalDuration > 0) {
      progressBar.style.width =
        Math.min(100, (audio.currentTime / totalDuration) * 100) + "%";
    } else if (audio.currentTime > 0) {
      totalDuration = Math.max(totalDuration, audio.currentTime);
    }
    updateLabel();
  });

  audio.addEventListener("play", () => { playBtn.textContent = "⏸"; });
  audio.addEventListener("pause", () => { playBtn.textContent = "▶"; });
  audio.addEventListener("ended", () => {
    playBtn.textContent = "▶";
    progressBar.style.width = "0%";
    try { audio.currentTime = 0; } catch (_) {}
    updateLabel();
  });
  audio.addEventListener("error", (e) => {
    console.error("[VOICE] Audio error:", e, audio.error, "src =", String(audio.src).slice(0, 80));
  });

  playBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (audio.paused) {
      audio.play().then(() => {
        console.log("[VOICE] ▶ Playing. duration =", audio.duration);
      }).catch(err => {
        console.error("[VOICE] play failed:", err, "src =", String(audio.src).slice(0, 100));
      });
    } else {
      audio.pause();
    }
  });

  progressWrap.addEventListener("click", (e) => {
    if (!totalDuration || totalDuration <= 0) return;
    const rect = progressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    try { audio.currentTime = ratio * totalDuration; } catch (_) {}
  });

  updateLabel();
  wrap.append(playBtn, progressWrap, timeLabel);
  return { element: wrap, audio, ownsAudio };
}

// ============================================================
//  WRAP native <audio>
// ============================================================
function tryWrapAudio(audioEl) {
  if (!audioEl || audioEl.tagName !== "AUDIO") return;
  if (audioEl.dataset && audioEl.dataset.voiceWrapped === "1") return;
  if (audioEl.closest && audioEl.closest(".voice-preview-popup")) return;
  if (audioEl.closest && audioEl.closest("[data-voice-player='1']")) return;
  if (!audioEl.parentNode) return;

  const src = getAudioSrc(audioEl);
  if (!src) return;

  if (audioEl.dataset) audioEl.dataset.voiceWrapped = "1";

  const durationMs =
    voiceDurationRegistry.get(src) ||
    parseInt(audioEl.dataset.durationMs || "0", 10) ||
    0;

  const player = createCustomAudioPlayer(audioEl, durationMs);

  try {
    audioEl.parentNode.insertBefore(player.element, audioEl);
  } catch (e) {
    console.warn("[VOICE] insertBefore failed:", e);
    return;
  }

  audioEl.removeAttribute("controls");
  audioEl.controls = false;
  audioEl.style.cssText += `
    display: none !important;
    position: absolute !important;
    width: 0 !important; height: 0 !important;
    opacity: 0 !important; pointer-events: none !important;
  `;

  console.log("[VOICE] ✅ Wrapped audio | durationMs =", durationMs,
              "| src =", String(src).slice(0, 60));
}

function scanAndWrapAll() {
  try {
    document.querySelectorAll("audio").forEach(tryWrapAudio);
  } catch (_) {}
}

// ============================================================
//  BOOTSTRAP
// ============================================================
(function installVoiceHooks() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__voiceHooksInstalled) return;
  window.__voiceHooksInstalled = true;
  console.log("[VOICE] 🚀 Installing voice hooks…");

  try {
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag, ...rest) {
      const el = origCreate(tag, ...rest);
      if (typeof tag === "string" && tag.toLowerCase() === "audio") {
        setTimeout(() => tryWrapAudio(el), 0);
        setTimeout(() => tryWrapAudio(el), 300);
        setTimeout(() => tryWrapAudio(el), 1200);
      }
      return el;
    };
  } catch (e) { console.warn("[VOICE] Hook1:", e); }

  try {
    const OrigAudio = window.Audio;
    window.Audio = new Proxy(OrigAudio, {
      construct(target, args) {
        const el = Reflect.construct(target, args);
        setTimeout(() => tryWrapAudio(el), 0);
        setTimeout(() => tryWrapAudio(el), 300);
        return el;
      }
    });
  } catch (e) { console.warn("[VOICE] Hook2:", e); }

  try {
    const origAppend = Node.prototype.appendChild;
    const origInsert = Node.prototype.insertBefore;
    Node.prototype.appendChild = function (node) {
      const res = origAppend.call(this, node);
      if (node && node.tagName === "AUDIO") {
        setTimeout(() => tryWrapAudio(node), 0);
        setTimeout(() => tryWrapAudio(node), 300);
      }
      return res;
    };
    Node.prototype.insertBefore = function (node, ref) {
      const res = origInsert.call(this, node, ref);
      if (node && node.tagName === "AUDIO") {
        setTimeout(() => tryWrapAudio(node), 0);
        setTimeout(() => tryWrapAudio(node), 300);
      }
      return res;
    };
  } catch (e) { console.warn("[VOICE] Hook3:", e); }

  try {
    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === "AUDIO") tryWrapAudio(n);
          else if (n.querySelectorAll) n.querySelectorAll("audio").forEach(tryWrapAudio);
        }
      }
    });
    const startObs = () => {
      try { observer.observe(document.body, { childList: true, subtree: true }); }
      catch (e) { console.warn("[VOICE] observer:", e); }
    };
    if (document.body) startObs();
    else document.addEventListener("DOMContentLoaded", startObs, { once: true });
  } catch (e) { console.warn("[VOICE] Hook4:", e); }

  setInterval(scanAndWrapAll, 400);
  console.log("[VOICE] All 5 hooks installed.");

  const initialScan = () => {
    scanAndWrapAll();
    console.log("[VOICE] Initial scan. audio count:", document.querySelectorAll("audio").length);
  };
  if (document.body) initialScan();
  else document.addEventListener("DOMContentLoaded", initialScan, { once: true });

  window.__voiceDebug = {
    scan: scanAndWrapAll,
    list: () => Array.from(document.querySelectorAll("audio")),
    registry: voiceDurationRegistry,
    convert: dataUrlToObjectUrl,
    version: "blob-v7"
  };
})();

// ============================================================
//  MAIN: initVoiceSystem
// ============================================================
export function initVoiceSystem({ db, messagesCol, myId, myName, addDoc }) {
  console.log("[VOICE] initVoiceSystem called");

  const micBtn = document.getElementById("voiceMicBtn");
  if (!micBtn) { console.error("[VOICE] #voiceMicBtn not found."); return; }
  if (!navigator.mediaDevices || !("MediaRecorder" in window)) {
    console.error("[VOICE] MediaRecorder not supported.");
    micBtn.disabled = true; micBtn.title = "التسجيل الصوتي غير مدعوم";
    return;
  }

  let mediaRecorder = null;
  let mediaStream = null;
  let audioChunks = [];
  let audioBlob = null;
  let audioPreviewUrl = null;
  let isRecording = false;
  let isStopping = false;
  let recordingStartedAt = 0;
  let lastRecordingMs = 0;
  let stopWatchdog = null;
  const MIN_RECORDING_MS = 1200;
  const STOP_WATCHDOG_MS = 4000;

  function getSupportedMimeType() {
    const candidates = [
      "audio/webm;codecs=opus", "audio/webm",
      "audio/ogg;codecs=opus", "audio/ogg",
      "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/mpeg"
    ];
    for (const t of candidates) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
    }
    return "";
  }

  function cleanupStream() {
    if (mediaStream) mediaStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    mediaStream = null;
  }
  function clearWatchdog() { if (stopWatchdog) { clearTimeout(stopWatchdog); stopWatchdog = null; } }
  function cleanupRecorder() { clearWatchdog(); cleanupStream(); mediaRecorder = null; isStopping = false; }
  function resetButton() {
    micBtn.classList.remove("recording-active");
    micBtn.textContent = "🎤"; micBtn.title = "اضغط للتسجيل";
    micBtn.setAttribute("aria-pressed", "false");
  }
  function setRecordingButton() {
    micBtn.classList.add("recording-active");
    micBtn.textContent = "⏺️"; micBtn.title = "جارٍ التسجيل... اضغط للإيقاف";
    micBtn.setAttribute("aria-pressed", "true");
  }
  function revokePreviewUrl() {
    if (audioPreviewUrl) { URL.revokeObjectURL(audioPreviewUrl); audioPreviewUrl = null; }
  }
  function removeExistingPopup() {
    document.querySelectorAll(".voice-preview-popup").forEach(el => el.remove());
  }

  function createPreviewPopup(blob, durationMs) {
    removeExistingPopup();
    revokePreviewUrl();
    audioPreviewUrl = URL.createObjectURL(blob);

    const popup = document.createElement("div");
    popup.className = "voice-preview-popup";
    popup.style.cssText = `
      position: fixed; left: 50%;
      bottom: max(78px, calc(env(safe-area-inset-bottom) + 70px));
      transform: translateX(-50%); z-index: 60000;
      width: min(92vw, 420px);
      background: #0c0f0c; border: 1px solid #1c8a0c;
      border-radius: 10px; padding: 12px;
      box-shadow: 0 0 25px rgba(57,255,20,.16);
      display: flex; flex-direction: column; gap: 10px;
    `;
    const title = document.createElement("div");
    title.textContent = "// VOICE TRANSMISSION READY";
    title.style.cssText = `color:#39FF14;font:700 11px monospace;letter-spacing:.6px;`;

    const player = createCustomAudioPlayer(audioPreviewUrl, durationMs);

    const actions = document.createElement("div");
    actions.style.cssText = `display:flex;gap:8px;width:100%;`;
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button"; deleteBtn.textContent = "DELETE";
    deleteBtn.style.cssText = `flex:1;min-height:42px;border:1px solid #7a0a1d;background:#16070a;color:#ff1744;border-radius:6px;font:700 11px monospace;cursor:pointer;touch-action:manipulation;`;
    const sendBtn = document.createElement("button");
    sendBtn.type = "button"; sendBtn.textContent = "SEND ▶";
    sendBtn.style.cssText = `flex:1;min-height:42px;border:1px solid #1c8a0c;background:#0d1a0d;color:#39FF14;border-radius:6px;font:700 11px monospace;cursor:pointer;touch-action:manipulation;`;

    deleteBtn.addEventListener("click", () => {
      try { player.audio.pause(); } catch (_) {}
      popup.remove(); revokePreviewUrl(); audioBlob = null;
    });

    sendBtn.addEventListener("click", async () => {
      if (!audioBlob || audioBlob.size === 0) {
        alert("التسجيل فارغ، يرجى إعادة المحاولة."); return;
      }
      sendBtn.disabled = true; deleteBtn.disabled = true;
      sendBtn.textContent = "SENDING...";
      try {
        const dataUrl = await blobToDataURL(audioBlob);
        registerVoiceDuration(dataUrl, durationMs || 0);
        await addDoc(messagesCol, {
          type: "voice", audioData: dataUrl,
          audioType: audioBlob.type || "audio/webm",
          durationMs: durationMs || 0,
          from: myId, fromName: myName,
          userId: myId, user: myName, ts: Date.now()
        });
        setTimeout(scanAndWrapAll, 100);
        setTimeout(scanAndWrapAll, 500);
        setTimeout(scanAndWrapAll, 1500);
        try { player.audio.pause(); } catch (_) {}
        popup.remove(); revokePreviewUrl(); audioBlob = null;
      } catch (err) {
        console.error("[VOICE] send failed:", err);
        sendBtn.disabled = false; deleteBtn.disabled = false;
        sendBtn.textContent = "SEND ▶";
        alert("فشل إرسال التسجيل الصوتي");
      }
    });

    actions.append(deleteBtn, sendBtn);
    popup.append(title, player.element, actions);
    document.body.appendChild(popup);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error("FileReader failed"));
      r.readAsDataURL(blob);
    });
  }

  async function startRecording() {
    if (isRecording || isStopping) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      if (!mediaStream || !mediaStream.getAudioTracks().length) throw new Error("لا يوجد مسار صوتي.");
      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : {};
      mediaRecorder = new MediaRecorder(mediaStream, options);
      audioChunks = []; audioBlob = null;
      isStopping = false; isRecording = true;
      recordingStartedAt = Date.now();

      mediaRecorder.addEventListener("dataavailable", ev => {
        if (ev.data && ev.data.size > 0) audioChunks.push(ev.data);
      });
      mediaRecorder.addEventListener("error", ev => {
        console.error("[VOICE] recorder error:", ev?.error || ev);
      });
      mediaRecorder.addEventListener("stop", () => {
        clearWatchdog();
        const measuredMs = Date.now() - recordingStartedAt;
        lastRecordingMs = Math.max(measuredMs, MIN_RECORDING_MS);
        const finalType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || "audio/webm";
        if (audioChunks.length > 0) {
          audioBlob = new Blob(audioChunks, { type: finalType });
          if (audioBlob.size > 0) createPreviewPopup(audioBlob, lastRecordingMs);
          else alert("التسجيل قصير جداً أو فارغ.");
        } else alert("لم يتم تسجيل أي بيانات صوتية.");
        audioChunks = []; isRecording = false; isStopping = false;
        resetButton(); cleanupRecorder();
      });
      mediaRecorder.start();
      setRecordingButton();
    } catch (err) {
      console.error("[VOICE] start failed:", err);
      isRecording = false; isStopping = false; audioChunks = [];
      resetButton(); cleanupRecorder();
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") alert("تم رفض إذن الميكروفون.");
      else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") alert("لا يوجد ميكروفون متصل.");
      else alert("تعذر بدء التسجيل.");
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder || isStopping) return;
    isStopping = true;
    const elapsed = Date.now() - recordingStartedAt;
    const finish = () => {
      try { if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop(); }
      catch (err) {
        console.error("[VOICE] stop failed:", err);
        isRecording = false; isStopping = false;
        resetButton(); cleanupRecorder();
      }
    };
    if (elapsed < MIN_RECORDING_MS) setTimeout(finish, MIN_RECORDING_MS - elapsed);
    else finish();
    clearWatchdog();
    stopWatchdog = setTimeout(() => {
      if (isRecording || isStopping) {
        console.warn("[VOICE] watchdog fired");
        isRecording = false; isStopping = false; audioChunks = [];
        resetButton(); cleanupRecorder();
      }
    }, STOP_WATCHDOG_MS);
  }

  function cancelRecording() {
    if (!isRecording || !mediaRecorder) return;
    clearWatchdog();
    try { if (mediaRecorder.state !== "inactive") mediaRecorder.stop(); } catch (_) {}
    audioChunks = []; isRecording = false; isStopping = false;
    resetButton(); cleanupRecorder();
  }

  micBtn.addEventListener("click", e => {
    e.preventDefault();
    if (!isRecording) startRecording(); else stopRecording();
  });
  micBtn.addEventListener("contextmenu", e => e.preventDefault());
  window.addEventListener("pagehide", () => { if (isRecording) cancelRecording(); });
  resetButton();
}

// ============================================================
//  PUBLIC: create audio element for a chat message
// ============================================================
export function createAudioElementForMessage(messageData) {
  return createCustomAudioPlayer(
    messageData.audioData,
    messageData.durationMs || 0
  ).element;
}
