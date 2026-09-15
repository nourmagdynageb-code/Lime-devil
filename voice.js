// voice.js - Professional Hold-to-Record Voice Notes System (Fixed Empty Audio)

export function initVoiceSystem({
  db,
  messagesCol,
  myId,
  myName,
  addDoc
}) {
  const micButton = document.getElementById("voiceMicBtn");

  if (!micButton) {
    console.warn("[Voice] #voiceMicBtn not found");
    return { isRecording: () => false };
  }

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let audioBlob = null;
  let currentStream = null;
  let micPermissionGranted = false;

  // ===== Popup =====
  const actionPopup = document.createElement("div");
  actionPopup.className = "voice-action-popup";
  actionPopup.style.cssText = `
    display: none;
    position: absolute;
    background: #0c0f0c;
    border: 1px solid #39FF14;
    padding: 8px 12px;
    border-radius: 10px;
    z-index: 9999;
    gap: 10px;
    align-items: center;
    box-shadow: 0 0 15px rgba(57, 255, 20, 0.25);
    font-family: 'JetBrains Mono', monospace;
  `;

  actionPopup.innerHTML = `
    <button id="sendVoiceConfirm" style="
      background: #1c8a0c; color: #fff; border: none;
      padding: 7px 14px; border-radius: 6px; cursor: pointer;
      font-weight: 700; font-size: 13px;">إرسال ✓</button>
    <button id="cancelVoiceConfirm" style="
      background: #7a0a1d; color: #fff; border: none;
      padding: 7px 14px; border-radius: 6px; cursor: pointer;
      font-weight: 700; font-size: 13px;">حذف ✕</button>
  `;
  document.body.appendChild(actionPopup);

  // ===== طلب صلاحية المايك =====
  async function requestMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      micPermissionGranted = true;
      console.log("[Voice] Mic permission granted");
      return true;
    } catch (err) {
      console.error("[Voice] Mic permission denied:", err);
      micPermissionGranted = false;
      alert("يجب السماح بالوصول إلى الميكروفون.");
      return false;
    }
  }

  // نطلب الصلاحية فوراً
  requestMicPermission();

  // ===== اختيار أفضل صيغة صوت =====
  function getSupportedMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
      "audio/aac"
    ];
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log("[Voice] Using mimeType:", type);
        return type;
      }
    }
    return "audio/webm"; // fallback
  }

  // ===== بدء التسجيل =====
  async function startRecording(e) {
    e.preventDefault();
    e.stopPropagation();

    if (isRecording) return;

    if (!micPermissionGranted) {
      const ok = await requestMicPermission();
      if (!ok) return;
    }

    actionPopup.style.display = "none";
    audioBlob = null;
    audioChunks = [];

    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      });

      const mimeType = getSupportedMimeType();

      mediaRecorder = new MediaRecorder(currentStream, {
        mimeType: mimeType,
        audioBitsPerSecond: 128000
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (currentStream) {
          currentStream.getTracks().forEach(t => t.stop());
          currentStream = null;
        }

        // حماية من التسجيل الفاضي
        if (audioChunks.length === 0) {
          console.warn("[Voice] Empty recording");
          alert("التسجيل فاضي. اضغط مع الاستمرار لفترة أطول.");
          return;
        }

        audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });

        // لو الحجم صغير جداً (أقل من 1 كيلو) يبقى فاضي
        if (audioBlob.size < 1000) {
          console.warn("[Voice] Recording too small:", audioBlob.size);
          alert("التسجيل قصير جداً. حاول تاني واضغط أطول.");
          audioBlob = null;
          return;
        }

        console.log("[Voice] Recording size:", (audioBlob.size / 1024).toFixed(1), "KB");

        // إظهار أزرار التأكيد
        const rect = micButton.getBoundingClientRect();
        actionPopup.style.top = `${window.scrollY + rect.top - 50}px`;
        actionPopup.style.left = `${window.scrollX + rect.left - 30}px`;
        actionPopup.style.display = "flex";
      };

      mediaRecorder.start(250); // كل 250ms
      isRecording = true;
      micButton.classList.add("recording-active");

    } catch (err) {
      console.error("[Voice] Start recording error:", err);
      alert("تعذر بدء التسجيل.");
      isRecording = false;
      micButton.classList.remove("recording-active");
    }
  }

  // ===== إيقاف التسجيل =====
  function stopRecording(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!isRecording) return;

    isRecording = false;
    micButton.classList.remove("recording-active");

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  // ===== الأحداث =====
  micButton.addEventListener("mousedown", startRecording);
  micButton.addEventListener("mouseup", stopRecording);
  micButton.addEventListener("mouseleave", stopRecording);

  micButton.addEventListener("touchstart", startRecording, { passive: false });
  micButton.addEventListener("touchend", stopRecording);
  micButton.addEventListener("touchcancel", stopRecording);

  // ===== إرسال =====
  document.getElementById("sendVoiceConfirm").addEventListener("click", async () => {
    actionPopup.style.display = "none";
    if (!audioBlob) return;

    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);

      reader.onloadend = async () => {
        const base64Audio = reader.result;

        // حماية من الحجم الكبير
        if (base64Audio.length > 850000) {
          alert("التسجيل طويل جداً (أكبر من الحد المسموح).");
          audioBlob = null;
          return;
        }

        await addDoc(messagesCol, {
          type: "voice",
          audioData: base64Audio,
          from: myId,
          fromName: myName,
          userId: myId,
          user: myName,
          color: "#39FF14",
          ts: Date.now()
        });

        audioBlob = null;
        console.log("[Voice] Sent successfully");
      };

      reader.onerror = () => {
        alert("خطأ في قراءة التسجيل.");
      };

    } catch (err) {
      console.error("[Voice] Send error:", err);
      alert("فشل إرسال الرسالة الصوتية.");
    }
  });

  // ===== حذف =====
  document.getElementById("cancelVoiceConfirm").addEventListener("click", () => {
    actionPopup.style.display = "none";
    audioBlob = null;
  });

  // إخفاء الـ popup عند الضغط برا
  document.addEventListener("click", (e) => {
    if (
      actionPopup.style.display === "flex" &&
      !actionPopup.contains(e.target) &&
      e.target !== micButton
    ) {
      actionPopup.style.display = "none";
      audioBlob = null;
    }
  });

  return {
    isRecording: () => isRecording
  };
}
