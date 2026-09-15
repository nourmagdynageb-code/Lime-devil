// voice.js
// Stable press-and-hold voice recorder for desktop + mobile.
// Uses Pointer Events so one physical interaction does not trigger
// both mouse and touch handlers.

export function initVoiceSystem({ db, messagesCol, myId, myName, addDoc }) {
  const micBtn = document.getElementById("voiceMicBtn");

  if (!micBtn) {
    console.error("[VOICE] #voiceMicBtn not found.");
    return;
  }

  if (!("MediaRecorder" in window)) {
    console.error("[VOICE] MediaRecorder is not supported.");
    micBtn.disabled = true;
    micBtn.title = "Voice recording is not supported on this browser";
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
  let pressTimer = null;
  let recordingStartedAt = 0;

  const LONG_PRESS_MS = 350;
  const MIN_RECORDING_MS = 250;

  function getSupportedMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
      "audio/aac"
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

  function clearPressTimer() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function resetButton() {
    micBtn.classList.remove("recording-active");
    micBtn.textContent = "🎤";
    micBtn.title = "اضغط مع الاستمرار للتسجيل";
    micBtn.setAttribute("aria-pressed", "false");
  }

  function setRecordingButton() {
    micBtn.classList.add("recording-active");
    micBtn.textContent = "⏺️";
    micBtn.title = "اترك الزر لإيقاف التسجيل";
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
      position:fixed;
      left:50%;
      bottom:max(78px, calc(env(safe-area-inset-bottom) + 70px));
      transform:translateX(-50%);
      z-index:60000;
      width:min(92vw,420px);
      background:#0c0f0c;
      border:1px solid #1c8a0c;
      border-radius:10px;
      padding:12px;
      box-shadow:0 0 25px rgba(57,255,20,.16);
      display:flex;
      flex-direction:column;
      gap:10px;
    `;

    const title = document.createElement("div");
    title.textContent = "// VOICE TRANSMISSION READY";
    title.style.cssText = `
      color:#39FF14;
      font:700 11px JetBrains Mono,monospace;
      letter-spacing:.6px;
    `;

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = audioPreviewUrl;
    audio.style.width = "100%";
    audio.setAttribute("type", blob.type || "audio/webm");

    const actions = document.createElement("div");
    actions.style.cssText = `
      display:flex;
      gap:8px;
      width:100%;
    `;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "DELETE";
    deleteBtn.style.cssText = `
      flex:1;
      min-height:42px;
      border:1px solid #7a0a1d;
      background:#16070a;
      color:#ff1744;
      border-radius:6px;
      font:700 11px JetBrains Mono,monospace;
      cursor:pointer;
      touch-action:manipulation;
    `;

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = "SEND ▶";
    sendBtn.style.cssText = `
      flex:1;
      min-height:42px;
      border:1px solid #1c8a0c;
      background:#0d1a0d;
      color:#39FF14;
      border-radius:6px;
      font:700 11px JetBrains Mono,monospace;
      cursor:pointer;
      touch-action:manipulation;
    `;

    deleteBtn.addEventListener("click", () => {
      audio.pause();
      popup.remove();
      revokePreviewUrl();
      audioBlob = null;
    });

    sendBtn.addEventListener("click", async () => {
      if (!audioBlob) return;

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
        alert("FAILED TO SEND VOICE NOTE");
      }
    });

    actions.append(deleteBtn, sendBtn);
    popup.append(title, audio, actions);
    document.body.appendChild(popup);
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => {
        const result = String(reader.result || "");
        if (!result.startsWith("data:")) {
          reject(new Error("FileReader did not return a valid Data URL."));
          return;
        }
        resolve(result);
      };

      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function startRecording(pointerId = null) {
    if (isRecording || isStopping) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("MICROPHONE ACCESS IS NOT SUPPORTED ON THIS BROWSER");
      return;
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (!mediaStream || !mediaStream.getAudioTracks().length) {
        throw new Error("No microphone audio track was returned.");
      }

      const mimeType = getSupportedMimeType();

      const options = mimeType
        ? { mimeType, audioBitsPerSecond: 64000 }
        : { audioBitsPerSecond: 64000 };

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

      mediaRecorder.addEventListener("error", event => {
        console.error("[VOICE] MediaRecorder error:", event.error || event);
      });

      mediaRecorder.addEventListener("stop", () => {
        const recorder = mediaRecorder;
        const finalType =
          recorder?.mimeType ||
          audioChunks.find(chunk => chunk.type)?.type ||
          mimeType ||
          "audio/webm";

        if (audioChunks.length) {
          audioBlob = new Blob(audioChunks, { type: finalType });

          if (audioBlob.size > 0) {
            createPreviewPopup(audioBlob);
          } else {
            console.error("[VOICE] Final audio blob is empty.");
          }
        } else {
          console.error("[VOICE] No audio chunks were produced.");
        }

        audioChunks = [];
        isRecording = false;
        isStopping = false;
        resetButton();
        cleanupRecorder();
      });

      mediaRecorder.start(250);
      setRecordingButton();

    } catch (err) {
      console.error("[VOICE] Could not start recording:", err);

      isRecording = false;
      isStopping = false;
      audioChunks = [];
      resetButton();
      cleanupRecorder();

      if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
        alert("MICROPHONE PERMISSION WAS DENIED");
      } else if (err?.name === "NotFoundError") {
        alert("NO MICROPHONE WAS FOUND");
      } else {
        alert("FAILED TO START VOICE RECORDING");
      }
    }
  }

  function stopRecording() {
    clearPressTimer();

    if (!isRecording || !mediaRecorder || isStopping) return;

    isStopping = true;

    const recorder = mediaRecorder;
    const elapsed = Date.now() - recordingStartedAt;

    const finish = () => {
      if (!recorder) return;

      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
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
  }

  function cancelRecording() {
    clearPressTimer();

    if (!isRecording || !mediaRecorder) return;

    const recorder = mediaRecorder;

    try {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    } catch (_) {}

    audioChunks = [];
    isRecording = false;
    isStopping = false;
    resetButton();
    cleanupRecorder();
  }

  // Pointer Events avoid the old mouse+touch double-trigger problem.
  micBtn.addEventListener("pointerdown", event => {
    if (event.button !== undefined && event.button !== 0) return;
    if (isRecording || isStopping) return;

    event.preventDefault();

    activePointerId = event.pointerId;

    try {
      micBtn.setPointerCapture(event.pointerId);
    } catch (_) {}

    clearPressTimer();

    pressTimer = setTimeout(() => {
      pressTimer = null;
      startRecording(event.pointerId);
    }, LONG_PRESS_MS);
  });

  micBtn.addEventListener("pointerup", event => {
    event.preventDefault();

    if (activePointerId !== null && event.pointerId !== activePointerId) return;

    clearPressTimer();

    if (isRecording) {
      stopRecording();
    } else {
      activePointerId = null;
    }

    try {
      micBtn.releasePointerCapture(event.pointerId);
    } catch (_) {}
  });

  micBtn.addEventListener("pointercancel", event => {
    event.preventDefault();
    clearPressTimer();
    cancelRecording();

    try {
      micBtn.releasePointerCapture(event.pointerId);
    } catch (_) {}
  });

  micBtn.addEventListener("pointerleave", event => {
    // On a captured pointer this event does not cancel the recording.
    // This makes dragging slightly outside the button less likely to
    // accidentally produce an unusable recording.
    if (!micBtn.hasPointerCapture?.(event.pointerId)) {
      clearPressTimer();
      if (!isRecording) activePointerId = null;
    }
  });

  micBtn.addEventListener("contextmenu", event => {
    event.preventDefault();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && isRecording) {
      stopRecording();
    }
  });

  window.addEventListener("beforeunload", () => {
    clearPressTimer();

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (_) {}
    }

    cleanupStream();
  });

  window.addEventListener("pagehide", () => {
    clearPressTimer();
    if (isRecording) cancelRecording();
  });

  resetButton();
}
