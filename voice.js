// voice.js - Robust Voice Notes (Fixed empty audio on Mobile)

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

  if (typeof MediaRecorder === "undefined") {
    alert("متصفحك لا يدعم تسجيل الصوت");
    micButton.style.opacity = "0.4";
    micButton.style.pointerEvents = "none";
    return { isRecording: () => false };
  }

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let audioBlob = null;
  let currentStream = null;
  let recordStartTime = 0;
  let stopTimeout = null;

  // ===== Popup =====
  const actionPopup = document.createElement("div");
  actionPopup.id = "voiceActionPopup";
  actionPopup.style.cssText = `
    display: none;
    position: fixed;
    bottom: 90px;
    left: 50%;
    transform: translateX(-50%);
    background: #0c0f0c;
    border: 1px solid #39FF14;
    padding: 12px 18px;
    border-radius: 12px;
    z-index: 99999;
    gap: 14px;
    align-items: center;
    box-shadow: 0 0 25px rgba(57, 255, 20, 0.35);
    font-family: 'JetBrains Mono', monospace;
  `;
  actionPopup.innerHTML = `
    <button id="sendVoiceConfirm" style="
      background:#1c8a0c;color:#fff;border:none;padding:9px 20px;
      border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;">
      إرسال ✓
    </button>
    <button id="cancelVoiceConfirm" style="
      background:#7a0a1d;color:#fff;border:none;padding:9px 20px;
      border-radius:8px;cursor:pointer;font-weight:700;font-size:14px;">
      حذف ✕
    </button>
  `;
  document.body.appendChild(actionPopup);

  // ===== أفضل MIME Type متاح =====
  function getSupportedMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
      "audio/aac"
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log("[Voice] Using:", type);
        return type;
      }
    }
    return ""; // خليه المتصفح يختار
  }

  // ===== طلب صلاحية المايك =====
  async function ensureMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      return true;
    } catch (err) {
      console.error("[Voice] Permission error:", err);
      alert("يجب السماح باستخدام الميكروفون");
      return false;
    }
  }

  // نطلب الصلاحية مرة واحدة في البداية
  ensureMicPermission();

  // ===== بدء التسجيل =====
  async function startRecording(e) {
    e.preventDefault();
    e.stopPropagation();

    if (isRecording) return;

    // تنظيف أي حالة قديمة
    actionPopup.style.display = "none";
    audioBlob = null;
    audioChunks = [];
    if (stopTimeout) {
      clearTimeout(stopTimeout);
      stopTimeout = null;
    }

    const hasPermission = await ensureMicPermission();
    if (!hasPermission) return;

    try {
      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const mimeType = getSupportedMimeType();
      const options = mimeType ? { mimeType, audioBitsPerSecond: 96000 } : { audioBitsPerSecond: 96000 };

      mediaRecorder = new MediaRecorder(currentStream, options);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        // إيقاف الـ stream
        if (currentStream) {
          currentStream.getTracks().forEach(t => t.stop());
          currentStream = null;
        }

        const durationSec = (Date.now() - recordStartTime) / 1000;

        // حماية قوية ضد التسجيل الفاضي
        if (audioChunks.length === 0 || durationSec < 0.7) {
          console.warn("[Voice] Empty or too short recording");
          alert("التسجيل قصير جداً. اضغط مع الاستمرار لمدة ثانية على الأقل.");
          resetButton();
          return;
        }

        audioBlob = new Blob(audioChunks, {
          type: mediaRecorder.mimeType || "audio/webm"
        });

        if (audioBlob.size < 800) {
          console.warn("[Voice] Blob too small:", audioBlob.size);
          alert("التسجيل فاضي. حاول مرة أخرى.");
          audioBlob = null;
          resetButton();
          return;
        }

        console.log(`[Voice] OK → ${(audioBlob.size / 1024).toFixed(1)} KB | ${durationSec.toFixed(1)}s`);
        actionPopup.style.display = "flex";
      };

      mediaRecorder.onerror = (err) => {
        console.error("[Voice] Recorder error:", err);
        alert("حدث خطأ أثناء التسجيل");
        forceStop();
      };

      // مهم: نبدأ بدون timeslice عشان الموبايل
      mediaRecorder.start();
      isRecording = true;
      recordStartTime = Date.now();
      micButton.classList.add("recording-active");
      micButton.textContent = "🔴";

    } catch (err) {
      console.error("[Voice] Start failed:", err);
      alert("تعذر بدء التسجيل");
      resetButton();
    }
  }

  // ===== إيقاف التسجيل (الطريقة الصحيحة) =====
  function stopRecording(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (!isRecording || !mediaRecorder) return;

    // تأخير بسيط جداً عشان نضمن إن آخر البيانات اتجمعت (مهم على الموبايل)
    stopTimeout = setTimeout(() => {
      try {
        if (mediaRecorder.state === "recording") {
          // نطلب آخر جزء من البيانات قبل الإيقاف
          mediaRecorder.requestData();
          mediaRecorder.stop();
        }
      } catch (err) {
        console.warn("[Voice] stop error:", err);
      }
      isRecording = false;
      resetButton();
    }, 180); // 180ms كافية جداً
  }

  function forceStop() {
    isRecording = false;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (e) {}
    }
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
      currentStream = null;
    }
    resetButton();
  }

  function resetButton() {
    micButton.classList.remove("recording-active");
    micButton.textContent = "🎤";
  }

  // ===== الأحداث =====
  // Desktop
  micButton.addEventListener("mousedown", startRecording);
  micButton.addEventListener("mouseup", stopRecording);
  micButton.addEventListener("mouseleave", stopRecording);

  // Mobile (مهم جداً)
  micButton.addEventListener("touchstart", startRecording, { passive: false });
  micButton.addEventListener("touchend", stopRecording, { passive: false });
  micButton.addEventListener("touchcancel", stopRecording, { passive: false });

  // منع السكرول أثناء التسجيل
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
          alert("التسجيل طويل جداً");
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
      console.error("[Voice] Send failed:", err);
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
