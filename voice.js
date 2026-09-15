// voice.js
// Final bulletproof voice recorder with helper for UI rendering.
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
  let activePointerId = null;
  let recordingStartedAt = 0;
  const MIN_RECORDING_MS = 600;

  function getSupportedMimeType() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const candidates = isIOS ? [
      "audio/mp4",
      "audio/aac"
    ] : [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];

    for (const type of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(type)) return type;
      } catch (_) {}
    }
    return "";
  }

  function cleanupStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
    }
    mediaStream = null;
  }

  function cleanupRecorder() {
    cleanupStream();
    mediaRecorder = null;
    isStopping = false;
    activePointerId = null;
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
    micBtn.title = "ارفع إصبعك لإيقاف التسجيل";
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
    if (blob.type) {
      audio.type = blob.type;
    }

    // إصلاح مشكلة 0:00 للمتصفحات
    audio.addEventListener("loadedmetadata", () => {
      if (audio.duration === Infinity || isNaN(audio.duration)) {
        audio.currentTime = 1e101;
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null;
          audio.currentTime = 0;
        };
      }
    });

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

  async function startRecording(pointerId = null) {
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
      activePointerId = pointerId;
      recordingStartedAt = Date.now();

      mediaRecorder.addEventListener("dataavailable", event => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      });

      mediaRecorder.addEventListener("stop", () => {
        const finalType = mediaRecorder?.mimeType || mimeType || "audio/webm";
        if (audioChunks.length > 0) {
          audioBlob = new Blob(audioChunks, { type: finalType });
          if (audioBlob.size > 0) {
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
        isStopping, isStopping = false;
        resetButton();
        cleanupRecorder();
      }
    };

    if (elapsed < MIN_RECORDING_MS) {
      setTimeout(finish, MIN_RECORDING_MS - elapsed);
    } else {
      finish();
    }
  }

  function cancelRecording() {
    if (!isRecording || !mediaRecorder) return;
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

  micBtn.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    activePointerId = event.pointerId;
    startRecording(event.pointerId);
  });

  micBtn.addEventListener("pointerup", event => {
    event.preventDefault();
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    if (isRecording) {
      stopRecording();
    }
    activePointerId = null;
  });

  micBtn.addEventListener("pointercancel", event => {
    event.preventDefault();
    cancelRecording();
  });

  micBtn.addEventListener("contextmenu", event => event.preventDefault());

  window.addEventListener("pagehide", () => {
    if (isRecording) cancelRecording();
  });

  resetButton();
}

/**
 * دالة مساعدة لتوليد عنصر الـ Audio الخاص بالرسائل الواردة (Chat Message Renderer)
 * يجب استخدام هذه الدالة في الكود المسؤول عن عرض الرسائل في الشاشة لتجنب مشكلة 0:00 على الأجهزة الأخرى.
 */
export function createAudioElementForMessage(messageData) {
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = messageData.audioData;
  if (messageData.audioType) {
    audio.type = messageData.audioType;
  }
  
  // حل مشكلة 0:00 نهائياً عند استقبال الفويس في الأجهزة الأخرى
  audio.addEventListener("loadedmetadata", () => {
    if (audio.duration === Infinity || isNaN(audio.duration)) {
      audio.currentTime = 1e101;
      audio.ontimeupdate = () => {
        audio.ontimeupdate = null;
        audio.currentTime = 0;
      };
    }
  });

  return audio;
}
