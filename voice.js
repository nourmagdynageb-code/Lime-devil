// voice.js - Fixed for Mobile + Empty Audio Issue

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

  // فحص دعم MediaRecorder
  if (!window.MediaRecorder) {
    alert("جهازك أو متصفحك لا يدعم تسجيل الصوت");
    micButton.style.display = "none";
    return { isRecording: () => false };
  }

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let audioBlob = null;
  let currentStream = null;
  let recordStartTime = 0;

  // ===== Popup =====
  const actionPopup = document.createElement("div");
  actionPopup.id = "voiceActionPopup";
  actionPopup.style.cssText = `
    display: none;
    position: fixed;
    bottom: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: #0c0f0c;
    border: 1px solid #39FF14;
    padding: 10px 16px;
    border-radius: 12px;
    z-index: 99999;
    gap: 12px;
    align-items: center;
    box-shadow: 0 0 20px rgba(57, 255, 20, 0.3);
    font-family: 'JetBrains Mono', monospace;
  `;

  actionPopup.innerHTML = `
    <button id="sendVoiceConfirm" style="
      background: #1c8a0c; color: white; border: none;
      padding: 8px 18px; border-radius: 8px; cursor: pointer;
      font-weight: 700; font-size: 14px;">إرسال ✓</button>
    <button id="cancelVoiceConfirm" style="
      background: #7a0a1d; color: white; border: none;
      padding: 8px 18px; border-radius: 8px; cursor: pointer;
      font-weight: 700; font-size: 14px;">حذف ✕</button>
  `;
  document.body.appendChild(actionPopup);

  // ===== طلب صلاحية المايك =====
  async function requestMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      return true;
    } catch (err) {
      console.error("[Voice] Permission denied:", err);
      alert("يجب السماح باستخدام الميكروفون");
      return false;
    }
  }

  // نطلب الصلاحية فوراً
  requestMicPermission();

  // ===== اختيار أفضل صيغة =====
  function getBestMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
      "audio/aac",
      "audio/wav"
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  // ===== بدء التسجيل =====
  async function startRecording(e) {
    e.preventDefault();
    e.stopPropagation();

    if (isRecording) return;

    // إخفاء أي popup قديم
    actionPopup.style.display = "none";
    audioBlob = null;
    audioChunks = [];

    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      const mimeType = getBestMimeType();
      const options = mimeType ? { mimeType } : {};

      mediaRecorder = new MediaRecorder(currentStream, options);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        // إيقاف المايك
        if (currentStream) {
          currentStream.getTracks().forEach(t => t.stop());
          currentStream = null;
        }

        const duration = (Date.now() - recordStartTime) / 1000;

        if (audioChunks.length === 0 || duration < 0.8) {
          alert("التسجيل قصير جداً. اضغط مع الاستمرار لمدة ثانية على الأقل.");
          return;
        }

        audioBlob = new Blob(audioChunks, {
          type: mediaRecorder.mimeType || "audio/webm"
        });

        if (audioBlob.size < 500) {
          alert("التسجيل فاضي. حاول مرة أخرى.");
          audioBlob = null;
          return;
        }

        console.log("[Voice] Recorded:", (audioBlob.size / 1024).toFixed(1), "KB |", duration.toFixed(1), "s");

        // إظهار أزرار التأكيد في منتصف الشاشة من تحت
        actionPopup.style.display = "flex";
      };

      mediaRecorder.onerror = (err) => {
        console.error("[Voice] MediaRecorder error:", err);
        alert("حدث خطأ أثناء التسجيل");
        stopRecording();
      };

      // نبدأ التسجيل بدون timeslice عشان الموبايل
      mediaRecorder.start();
      isRecording = true;
      recordStartTime = Date.now();
      micButton.classList.add("recording-active");
      micButton.textContent = "🔴";

    } catch (err) {
      console.error("[Voice] Start error:", err);
      alert("تعذر بدء التسجيل. تأكد من صلاحية الميكروفون.");
      isRecording = false;
      micButton.classList.remove("recording-active");
      micButton.textContent = "🎤";
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
    micButton.textContent = "🎤";

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      // مهم جداً: نطلب آخر جزء من البيانات قبل الإيقاف
      try {
        mediaRecorder.requestData();
      } catch (err) {}
      mediaRecorder.stop();
    }
  }

  // ===== الأحداث (مهمة جداً للموبايل) =====
  // Desktop
  micButton.addEventListener("mousedown", startRecording);
  micButton.addEventListener("mouseup", stopRecording);
  micButton.addEventListener("mouseleave", stopRecording);

  // Mobile - مهم جداً
  micButton.addEventListener("touchstart", startRecording, { passive: false });
  micButton.addEventListener("touchend", stopRecording, { passive: false });
  micButton.addEventListener("touchcancel", stopRecording, { passive: false });

  // منع السكرول أثناء الضغط على الزر
  micButton.addEventListener("touchmove", (e) => {
    if (isRecording) e.preventDefault();
  }, { passive: false });

  // ===== إرسال =====
  document.getElementById("sendVoiceConfirm").addEventListener("click", async () => {
    actionPopup.style.display = "none";
    if (!audioBlob) return;

    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);

      reader.onloadend = async () => {
        const base64 = reader.result;

        if (base64.length > 900000) {
          alert("التسجيل طويل جداً.");
          return;
        }

        await addDoc(messagesCol, {
          type: "voice",
          audioData: base64,
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
    } catch (err) {
      console.error("[Voice] Send error:", err);
      alert("فشل إرسال الرسالة الصوتية");
    }
  });

  // ===== حذف =====
  document.getElementById("cancelVoiceConfirm").addEventListener("click", () => {
    actionPopup.style.display = "none";
    audioBlob = null;
  });

  return {
    isRecording: () => isRecording
  };
}
