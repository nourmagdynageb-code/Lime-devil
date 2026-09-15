// voice.js
// Final bulletproof voice recorder & player renderer for desktop & mobile.
// Fixes: duration 0:00 in webm via ts-ebml metadata patching + codec negotiation + watchdog.

import { Decoder, tools, Reader } from "ts-ebml";

export function initVoiceSystem({ db, messagesCol, myId, myName, addDoc }) {
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
  let stopWatchdog = null;
  const MIN_RECORDING_MS = 1200;
  const STOP_WATCHDOG_MS = 4000;

  /**
   * اختيار صيغة مدعومة مع codec صريح.
   * الأولوية لـ webm/opus لأنه الأفضل دعماً للمدة على Chrome/Firefox/Edge.
   * ثم mp4/aac لـ Safari/iOS.
   */
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
      try {
        if (MediaRecorder.isTypeSupported(type)) return type;
      } catch (_) {}
    }
    return "";
  }

  /**
   * إصلاح ملفات webm بإضافة metadata المدة الصحيحة.
   * الحل ده ضروري لأن Chrome ما بيكتبش حقل Duration في تسجيلات MediaRecorder.
   * لو فشل لأي سبب، نرجع الـ blob الأصلي (fallback آمن).
   */
  async function fixWebmDuration(blob) {
    if (!blob || !blob.type || !blob.type.includes("webm")) {
      return blob;
    }

    try {
      const arrayBuffer = await blob.arrayBuffer();
      const decoder = new Decoder();
      const reader = new Reader();
      reader.logging = false;

      const elms = decoder.decode(arrayBuffer);
      elms.forEach((elm) => reader.read(elm));
      reader.stop();

      const refinedMetadataBuf = tools.makeMetadataSeekable(
        reader.metadatas,
        reader.duration,
        reader.cues
      );

      const body = arrayBuffer.slice(reader.metadataSize);
      const fixedBlob = new Blob([refinedMetadataBuf, body], {
        type: blob.type
      });

      console.log(
        "[VOICE] Duration fixed. New size:",
        fixedBlob.size,
        "Duration(ms):",
        reader.duration
      );

      return fixedBlob;
    } catch (err) {
      console.warn("[VOICE] fixWebmDuration failed, using original blob:", err);
      return blob;
    }
  }

  function cleanupStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
    }
    mediaStream = null;
  }

  function clearWatchdog() {
    if (stopWatchdog) {
      clearTimeout(stopWatchdog);
      stopWatchdog = null;
    }
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

  function createPreviewPopup(blob) {
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
      color: #39FF14;
      font: 700 11px monospace;
      letter-spacing: .6px;
    `;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = audioPreviewUrl;
    audio.style.width = "100%";

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
      audio.pause();
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
        await addDoc(messagesCol, {
          type: "voice",
          audioData: dataUrl,
          audioType: audioBlob.type || "audio/webm",
          from: myId,
          fromName: myName,
          userId: myId,
          user: myName,
          ts: Date.now()
        });
        audio.pause();
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
    popup.append(title, audio, actions);
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
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
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
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      });

      mediaRecorder.addEventListener("error", event => {
        console.error("[VOICE] MediaRecorder error:", event?.error || event);
      });

      mediaRecorder.addEventListener("stop", async () => {
        clearWatchdog();
        const finalType =
          (mediaRecorder && mediaRecorder.mimeType) ||
          mimeType ||
          "audio/webm";

        if (audioChunks.length > 0) {
          const rawBlob = new Blob(audioChunks, { type: finalType });

          if (rawBlob.size > 0) {
            // ✅ إصلاح مدة الـ webm قبل العرض
            audioBlob = await fixWebmDuration(rawBlob);
            createPreviewPopup(audioBlob);
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
      if (mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    } catch (_) {}
    audioChunks = [];
    isRecording = false;
    isStopping = false;
    resetButton();
    cleanupRecorder();
  }

  micBtn.addEventListener("click", event => {
    event.preventDefault();
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  micBtn.addEventListener("contextmenu", event => event.preventDefault());

  window.addEventListener("pagehide", () => {
    if (isRecording) cancelRecording();
  });

  resetButton();
}

/**
 * دالة إنشاء عنصر الـ Audio للرسائل الواردة والصادرة.
 */
export function createAudioElementForMessage(messageData) {
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = messageData.audioData;
  return audio;
}
