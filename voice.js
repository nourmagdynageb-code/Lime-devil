// voice.js - Professional Hold-to-Record Voice Notes System

export function initVoiceSystem({
  db,
  messagesCol,
  myId,
  myName,
  addDoc
}) {
  const micButton = document.getElementById("voiceMicBtn"); // زر المايك اللي على الشمال خالص
  
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let audioBlob = null;

  // إنشاء واجهة مصغرة للتأكيد (إرسال / مسح) تظهر بجانب زر المايك بعد ترك الزر
  const actionPopup = document.createElement("div");
  actionPopup.className = "voice-action-popup";
  actionPopup.style.cssText = "display:none; position:absolute; background:#222; border:1px solid #444; padding:5px 10px; border-radius:8px; z-index:1000; gap:10px; align-items:center;";
  actionPopup.innerHTML = `
    <button id="sendVoiceConfirm" style="background:green; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">إرسال ✓</button>
    <button id="cancelVoiceConfirm" style="background:red; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">حذف ✕</button>
  `;
  document.body.appendChild(actionPopup);

  async function startRecording(e) {
    e.preventDefault();
    if (isRecording) return;

    // إخفاء أي نافذة تأكيد قديمة لو ظهرت
    actionPopup.style.display = "none";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      audioChunks = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        // إيقاف تراك المايك لتطفئ لمبة التسجيل في المتصفح
        stream.getTracks().forEach(track => track.stop());

        // إظهار أزرار التأكيد بجانب زر المايك
        const rect = micButton.getBoundingClientRect();
        actionPopup.style.top = `${rect.top - 40}px`;
        actionPopup.style.left = `${rect.left - 100}px`;
        actionPopup.style.display = "flex";
      };

      mediaRecorder.start();
      isRecording = true;
      if (micButton) micButton.classList.add("recording-active"); // تأثير بصري للتسجيل
    } catch (err) {
      console.error("Microphone access error:", err);
      alert("تعذر الوصول إلى المايكروفون.");
    }
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    if (micButton) micButton.classList.remove("recording-active");
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  // أحداث الضغط المطول (للهواتف والأجهزة المكتبية)
  if (micButton) {
    // البدء بالضغط
    micButton.addEventListener("mousedown", startRecording);
    micButton.addEventListener("touchstart", startRecording);

    // الانتهاء عند رفع الإصبع
    micButton.addEventListener("mouseup", stopRecording);
    micButton.addEventListener("touchend", stopRecording);
  }

  // تأكيد الإرسال
  document.getElementById("sendVoiceConfirm").addEventListener("click", async () => {
    actionPopup.style.display = "none";
    if (!audioBlob) return;

    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
        const base64Audio = reader.result;

        // إرسال الصوت لقاعدة بيانات الفايرستور
        await addDoc(messagesCol, {
          type: "voice",
          audioData: base64Audio,
          from: myId,
          fromName: myName,
          ts: Date.now()
        });
        audioBlob = null;
      };
    } catch (e) {
      console.error("Error sending voice note:", e);
    }
  });

  // إلغاء / حذف التسجيل
  document.getElementById("cancelVoiceConfirm").addEventListener("click", () => {
    actionPopup.style.display = "none";
    audioBlob = null;
    console.log("Voice note cancelled.");
  });

  return {
    isRecording: () => isRecording
  };
}
