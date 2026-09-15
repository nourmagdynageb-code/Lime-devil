// voice.js - Professional Hold-to-Record Voice Notes System
// يطلب صلاحية المايك فور التشغيل

export function initVoiceSystem({
  db,
  messagesCol,
  myId,
  myName,
  addDoc
}) {
  const micButton = document.getElementById("voiceMicBtn");

  if (!micButton) {
    console.warn("[Voice] #voiceMicBtn not found in DOM");
    return { isRecording: () => false };
  }

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let audioBlob = null;
  let currentStream = null;
  let micPermissionGranted = false;

  // ===== Popup تأكيد الإرسال / الحذف =====
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
      background: #1c8a0c;
      color: #fff;
      border: none;
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
    ">إرسال ✓</button>

    <button id="cancelVoiceConfirm" style="
      background: #7a0a1d;
      color: #fff;
      border: none;
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
    ">حذف ✕</button>
  `;

  document.body.appendChild(actionPopup);

  // =====================================================
  // طلب صلاحية المايك فور تشغيل النظام
  // =====================================================
  async function requestMicPermission() {
    try {
      console.log("[Voice] Requesting microphone permission...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // نوقف الـ stream فوراً بعد ما ناخد الصلاحية
      stream.getTracks().forEach(track => track.stop());

      micPermissionGranted = true;
      console.log("[Voice] Microphone permission granted");
      return true;
    } catch (err) {
      console.error("[Voice] Microphone permission denied:", err);
      micPermissionGranted = false;
      alert("يجب السماح بالوصول إلى الميكروفون لاستخدام الرسائل الصوتية.");
      return false;
    }
  }

  // نطلب الصلاحية فور استدعاء الدالة
  requestMicPermission();

  // ===== بدء التسجيل =====
  async function startRecording(e) {
    e.preventDefault();
    e.stopPropagation();

    if (isRecording) return;

    // لو الصلاحية لسه مش متاخدة، نحاول تاني
    if (!micPermissionGranted) {
      const granted = await requestMicPermission();
      if (!granted) return;
    }

    // إخفاء أي نافذة تأكيد قديمة
    actionPopup.style.display = "none";
    audioBlob = null;

    try {
      currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      mediaRecorder = new MediaRecorder(currentStream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm"
      });

      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        // إيقاف المايك نهائياً
        if (currentStream) {
          currentStream.getTracks().forEach(track => track.stop());
          currentStream = null;
        }

        if (audioChunks.length === 0) {
          console.warn("[Voice] No audio data recorded");
          return;
        }

        audioBlob = new Blob(audioChunks, { type: "audio/webm" });

        // إظهار أزرار التأكيد بجانب زر المايك
        const rect = micButton.getBoundingClientRect();
        actionPopup.style.top = `${window.scrollY + rect.top - 50}px`;
        actionPopup.style.left = `${window.scrollX + rect.left - 30}px`;
        actionPopup.style.display = "flex";
      };

      mediaRecorder.start(100);
      isRecording = true;
      micButton.classList.add("recording-active");

    } catch (err) {
      console.error("[Voice] Microphone access error:", err);
      alert("تعذر الوصول إلى الميكروفون. تأكد من إعطاء الصلاحية.");
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

  // ===== أحداث الضغط المطول =====
  // Desktop
  micButton.addEventListener("mousedown", startRecording);
  micButton.addEventListener("mouseup", stopRecording);
  micButton.addEventListener("mouseleave", stopRecording);

  // Mobile
  micButton.addEventListener("touchstart", startRecording, { passive: false });
  micButton.addEventListener("touchend", stopRecording);
  micButton.addEventListener("touchcancel", stopRecording);

  // ===== زر الإرسال =====
  document.getElementById("sendVoiceConfirm").addEventListener("click", async () => {
    actionPopup.style.display = "none";

    if (!audioBlob) return;

    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);

      reader.onloadend = async () => {
        const base64Audio = reader.result;

        // حماية من الملفات الكبيرة
        if (base64Audio.length > 900000) {
          alert("التسجيل طويل جداً. حاول تسجيل أقصر.");
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
        console.log("[Voice] Voice note sent successfully");
      };

      reader.onerror = () => {
        console.error("[Voice] FileReader error");
        alert("حدث خطأ أثناء قراءة التسجيل.");
      };

    } catch (err) {
      console.error("[Voice] Error sending voice note:", err);
      alert("فشل إرسال الرسالة الصوتية.");
    }
  });

  // ===== زر الحذف =====
  document.getElementById("cancelVoiceConfirm").addEventListener("click", () => {
    actionPopup.style.display = "none";
    audioBlob = null;
    console.log("[Voice] Voice note cancelled");
  });

  // إخفاء الـ popup لو ضغط في أي مكان تاني
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
