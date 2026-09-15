// voice.js
// Final bulletproof voice recorder & player.
// Auto-replaces native <audio controls> with a custom player (MutationObserver).

// ============================================================
//  GLOBAL REGISTRY: data URL → durationMs
// ============================================================
const voiceDurationRegistry = new Map();

export function registerVoiceDuration(src, durationMs) {
  if (!src || !durationMs) return;
  voiceDurationRegistry.set(src, durationMs);
}

// ============================================================
//  CUSTOM AUDIO PLAYER (module-level, shared everywhere)
// ============================================================
function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function createCustomAudioPlayer(src, durationMs, accent = "#39FF14") {
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
    cursor: pointer; position: relative; overflow: hidden;
    min-width: 60px;
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

  const audio = new Audio();
  audio.src = src;
  audio.preload = "metadata";

  let totalDuration = (durationMs && durationMs > 0) ? durationMs / 1000 : 0;

  function updateLabel() {
    timeLabel.textContent = `${formatTime(audio.currentTime)} / ${formatTime(totalDuration)}`;
  }

  audio.addEventListener("loadedmetadata", () => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      totalDuration = audio.duration;
    } else if (totalDuration === 0) {
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

  playBtn.addEventListener("click", () => {
    if (audio.paused) audio.play().catch(err => console.warn("[VOICE] play failed:", err));
    else audio.pause();
  });

  progressWrap.addEventListener("click", (e) => {
    if (!totalDuration || totalDuration <= 0) return;
    const rect = progressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    try { audio.currentTime = ratio * totalDuration; } catch (_) {}
  });

  updateLabel();
  wrap.append(playBtn, progressWrap, timeLabel);
  return { element: wrap, audio };
}

// ============================================================
//  AUTO-REPLACE native <audio controls> in the DOM
// ============================================================
function installAudioReplacer() {
  if (typeof window === "undefined") return;
  if (window.__voiceAudioReplacerInstalled) return;
  window.__voiceAudioReplacerInstalled = true;

  // CSS لإخفاء المشغلات الأصلية فوراً لمنع الوميض
  const style = document.createElement("style");
  style.textContent = `
    audio[controls][data-voice-native="1"] { display: none !important; }
  `;
  document.head.appendChild(style);

  const replaceOne = (audioEl) => {
    if (!audioEl || audioEl.tagName !== "AUDIO") return;
    if (audioEl.dataset.voiceNativeHandled === "1") return;
    if (!audioEl.controls) return;
    if (audioEl.closest(".voice-preview-popup")) return;
    if (audioEl.closest("[data-voice-player='1']")) return;

    const src = audioEl.getAttribute("src") || audioEl.src || audioEl.currentSrc;
    if (!src || !src.startsWith("data:audio")) return;

    audioEl.dataset.voiceNativeHandled = "1";
    audioEl.dataset.voiceNative = "1";

    const durationMs = voiceDurationRegistry.get(src) || 0;
    const player = createCustomAudioPlayer(src, durationMs);

    try {
      audioEl.replaceWith(player.element);
    } catch (_) {
      // fallback: append after and hide
      audioEl.parentNode?.insertBefore(player.element, audioEl.nextSibling);
    }
    console.log("[VOICE] Native audio replaced. durationMs =", durationMs);
  };

  const scan = (root) => {
    if (!root) return;
    if (root.nodeType !== 1) return;
    if (root.tagName === "AUDIO") replaceOne(root);
    else if (root.querySelectorAll) root.querySelectorAll("audio").forEach(replaceOne);
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) scan(node);
    }
  });

  const start = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll("audio").forEach(replaceOne);
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

// ============================================================
//  MAIN: initVoiceSystem
// ============================================================
export function initVoiceSystem({ db, messagesCol, myId, myName, addDoc }) {
  // ✅ نثبّت المستبدل أول حاجة
  installAudioReplacer();

  const micBtn = document.getElementById("voiceMicBtn");
  if (!micBtn) {
    console.error("[VOICE] #voiceMicBtn not found.");
    return;
  }

  if (!navigator.mediaDevices || !("MediaRecorder" in window)) {
    console.error("[VOICE] MediaRecorder or getUserMedia is not supported.");
    micBtn.disabled = true;
    micBtn.title = "التسجيل الصوتي غير مدعوم في هذا المتصفح";
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
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/mpeg"
    ];
    for (const type of candidates) {
      try { if (MediaRecorder.isTypeSupported(type)) return type; } catch (_) {}
    }
    return "";
  }

  function cleanupStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    }
    mediaStream = null;
  }

  function clearWatchdog() {
    if (stopWatchdog) { clearTimeout(stopWatchdog); stopWatchdog = null; }
  }

  function cleanupRecorder() {
    clearWatchdog();
    cleanupStream();
    mediaRecorder = null;
    isStopping = false;
  }

  function resetButton() {
    micBtn.classList.remove("recording-active");
    micBtn.textContent = "🎤";
    micBtn.title = "اضغط للتسجيل";
    micBtn.setAttribute("aria-pressed", "false");
  }

  function setRecordingButton() {
    micBtn.classList.add("recording-active");
    micBtn.textContent = "⏺️";
    micBtn.title = "جارٍ التسجيل... اضغط للإيقاف";
    micBtn.setAttribute("aria-pressed", "true");
  }

  function revokePreviewUrl() {
    if (audioPreviewUrl) {
      URL.revokeObjectURL(audioPreviewUrl);
      audioPreviewUrl = null;
    }
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
      position: fixed;
      left: 50%;
      bottom: max(78px, calc(env(safe-area-inset-bottom) + 70px));
      transform: translateX(-50%);
      z-index: 60000;
      width: min(92vw, 420px);
      background: #0c0f0c;
      border: 1px solid #1c8a0c;
      border-radius: 10px;
      padding: 12px;
      box-shadow: 0 0 25px rgba(57,255,20,.16);
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;

    const title = document.createElement("div");
    title.textContent = "// VOICE TRANSMISSION READY";
    title.style.cssText = `
      color: #39FF14; font: 700 11px monospace; letter-spacing: .6px;
    `;

    const player = createCustomAudioPlayer(audioPreviewUrl, durationMs);

    const actions = document.createElement("div");
    actions.style.cssText = `display: flex; gap: 8px; width: 100%;`;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "DELETE";
    deleteBtn.style.cssText = `
      flex: 1; min-height: 42px; border: 1px solid #7a0a1d;
      background: #16070a; color: #ff1744; border-radius: 6px;
      font: 700 11px monospace; cursor: pointer; touch-action: manipulation;
    `;

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "SEND ▶";
    sendBtn.style.cssText = `
      flex: 1; min-height: 42px; border: 1px solid #1c8a0c;
      background: #0d1a0d; color: #39FF14; border-radius: 6px;
      font: 700 11px monospace; cursor: pointer; touch-action: manipulation;
    `;

    deleteBtn.addEventListener("click", () => {
      try { player.audio.pause(); } catch (_) {}
      popup.remove();
      revokePreviewUrl();
      audioBlob = null;
    });

    sendBtn.addEventListener("click", async () => {
      if (!audioBlob || audioBlob.size === 0) {
        alert("التسجيل فارغ، يرجى إعادة المحاولة.");
        return;
      }
      sendBtn.disabled = true;
      deleteBtn.disabled = true;
      sendBtn.textContent = "SENDING...";
      try {
        const dataUrl = await blobToDataURL(audioBlob);

        // ✅ سجّل المدة في الـ registry عشان الـ observer يستخدمها
        registerVoiceDuration(dataUrl, durationMs || 0);

        await addDoc(messagesCol, {
          type: "voice",
          audioData: dataUrl,
          audioType: audioBlob.type || "audio/webm",
          durationMs: durationMs || 0,
          from: myId,
          fromName: myName,
          userId: myId,
          user: myName,
          ts: Date.now()
        });
        try { player.audio.pause(); } catch (_) {}
        popup.remove();
        revokePreviewUrl();
        audioBlob = null;
      } catch (err) {
        console.error("[VOICE] Failed to send voice note:", err);
        sendBtn.disabled = false;
        deleteBtn.disabled = false;
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
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function startRecording() {
    if (isRecording || isStopping) return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      if (!mediaStream || !mediaStream.getAudioTracks().length) {
        throw new Error("لم يتم العثور على مسار صوتي من الميكروفون.");
      }

      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType } : {};

      mediaRecorder = new MediaRecorder(mediaStream, options);
      audioChunks = [];
      audioBlob = null;
      isStopping = false;
      isRecording = true;
      recordingStartedAt = Date.now();

      mediaRecorder.addEventListener("dataavailable", event => {
        if (event.data && event.data.size > 0) audioChunks.push(event.data);
      });

      mediaRecorder.addEventListener("error", event => {
        console.error("[VOICE] MediaRecorder error:", event?.error || event);
      });

      mediaRecorder.addEventListener("stop", () => {
        clearWatchdog();
        const measuredMs = Date.now() - recordingStartedAt;
        lastRecordingMs = Math.max(measuredMs, MIN_RECORDING_MS);

        const finalType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || "audio/webm";

        if (audioChunks.length > 0) {
          audioBlob = new Blob(audioChunks, { type: finalType });
          if (audioBlob.size > 0) {
            createPreviewPopup(audioBlob, lastRecordingMs);
          } else {
            alert("التسجيل قصير جداً أو فارغ.");
          }
        } else {
          alert("لم يتم تسجيل أي بيانات صوتية.");
        }

        audioChunks = [];
        isRecording = false;
        isStopping = false;
        resetButton();
        cleanupRecorder();
      });

      mediaRecorder.start();
      setRecordingButton();
    } catch (err) {
      console.error("[VOICE] Could not start recording:", err);
      isRecording = false;
      isStopping = false;
      audioChunks = [];
      resetButton();
      cleanupRecorder();

      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        alert("تم رفض إذن الميكروفون. يرجى السماح به من إعدادات المتصفح.");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        alert("لم يتم اكتشاف أي ميكروفون متصل بجهازك.");
      } else {
        alert("تعذر بدء التسجيل الصوتي، تأكد من صلاحيات الميكروفون.");
      }
    }
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder || isStopping) return;
    isStopping = true;
    const elapsed = Date.now() - recordingStartedAt;

    const finish = () => {
      try {
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          mediaRecorder.stop();
        }
      } catch (err) {
        console.error("[VOICE] Failed to stop recorder:", err);
        isRecording = false;
        isStopping = false;
        resetButton();
        cleanupRecorder();
      }
    };

    if (elapsed < MIN_RECORDING_MS) {
      setTimeout(finish, MIN_RECORDING_MS - elapsed);
    } else {
      finish();
    }

    clearWatchdog();
    stopWatchdog = setTimeout(() => {
      if (isRecording || isStopping) {
        console.warn("[VOICE] Stop watchdog fired — cleaning up.");
        isRecording = false;
        isStopping = false;
        audioChunks = [];
        resetButton();
        cleanupRecorder();
      }
    }, STOP_WATCHDOG_MS);
  }

  function cancelRecording() {
    if (!isRecording || !mediaRecorder) return;
    clearWatchdog();
    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch (_) {}
    audioChunks = [];
    isRecording = false;
    isStopping = false;
    resetButton();
    cleanupRecorder();
  }

  micBtn.addEventListener("click", event => {
    event.preventDefault();
    if (!isRecording) startRecording();
    else stopRecording();
  });

  micBtn.addEventListener("contextmenu", event => event.preventDefault());

  window.addEventListener("pagehide", () => {
    if (isRecording) cancelRecording();
  });

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
