// voice.js - Robust Voice Notes
// Mobile-safe MediaRecorder implementation

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

  if (
    typeof MediaRecorder === "undefined" ||
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {
    alert("متصفحك لا يدعم تسجيل الصوت");
    micButton.style.opacity = "0.4";
    micButton.style.pointerEvents = "none";

    return { isRecording: () => false };
  }

  let mediaRecorder = null;
  let currentStream = null;
  let audioChunks = [];
  let audioBlob = null;
  let isRecording = false;
  let recordStartTime = 0;

  // =========================================================
  // Popup
  // =========================================================

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
    font-family: Arial, sans-serif;
  `;

  actionPopup.innerHTML = `
    <button id="sendVoiceConfirm" style="
      background:#1c8a0c;
      color:#fff;
      border:none;
      padding:9px 20px;
      border-radius:8px;
      cursor:pointer;
      font-weight:700;
      font-size:14px;
    ">
      إرسال ✓
    </button>

    <button id="cancelVoiceConfirm" style="
      background:#7a0a1d;
      color:#fff;
      border:none;
      padding:9px 20px;
      border-radius:8px;
      cursor:pointer;
      font-weight:700;
      font-size:14px;
    ">
      حذف ✕
    </button>
  `;

  document.body.appendChild(actionPopup);

  const sendButton =
    document.getElementById("sendVoiceConfirm");

  const cancelButton =
    document.getElementById("cancelVoiceConfirm");

  // =========================================================
  // MIME Type
  // =========================================================

  function getSupportedMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];

    for (const type of types) {
      try {
        if (MediaRecorder.isTypeSupported(type)) {
          console.log("[Voice] MIME:", type);
          return type;
        }
      } catch (err) {
        console.warn("[Voice] MIME check failed:", err);
      }
    }

    return "";
  }

  // =========================================================
  // Reset
  // =========================================================

  function resetButton() {
    micButton.classList.remove("recording-active");
    micButton.textContent = "🎤";
  }

  function resetRecordingState() {
    isRecording = false;

    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (err) {}
      });

      currentStream = null;
    }

    mediaRecorder = null;
    audioChunks = [];
    resetButton();
  }

  // =========================================================
  // Start Recording
  // =========================================================

  async function startRecording(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (isRecording) {
      return;
    }

    // إخفاء نافذة التأكيد
    actionPopup.style.display = "none";

    // تنظيف التسجيل السابق
    audioBlob = null;
    audioChunks = [];

    try {
      currentStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });

      const mimeType = getSupportedMimeType();

      const options = mimeType
        ? {
            mimeType: mimeType,
            audioBitsPerSecond: 96000
          }
        : {
            audioBitsPerSecond: 96000
          };

      mediaRecorder = new MediaRecorder(
        currentStream,
        options
      );

      console.log(
        "[Voice] Recorder MIME:",
        mediaRecorder.mimeType
      );

      // =====================================================
      // Data
      // =====================================================

      mediaRecorder.ondataavailable = event => {
        if (
          event.data &&
          event.data.size > 0
        ) {
          audioChunks.push(event.data);

          console.log(
            "[Voice] Chunk:",
            event.data.size
          );
        }
      };

      // =====================================================
      // Stop
      // =====================================================

      mediaRecorder.onstop = () => {
        console.log("[Voice] Recorder stopped");

        const duration =
          (Date.now() - recordStartTime) / 1000;

        // إيقاف المايك
        if (currentStream) {
          currentStream
            .getTracks()
            .forEach(track => {
              try {
                track.stop();
              } catch (err) {}
            });

          currentStream = null;
        }

        resetButton();

        // لا يوجد Audio Data
        if (audioChunks.length === 0) {
          console.warn("[Voice] No audio chunks");

          audioBlob = null;

          alert(
            "لم يتم تسجيل صوت. حاول مرة أخرى."
          );

          return;
        }

        // تسجيل قصير جداً
        if (duration < 0.7) {
          console.warn(
            "[Voice] Recording too short:",
            duration
          );

          audioBlob = null;
          audioChunks = [];

          alert(
            "التسجيل قصير جداً. اضغط لمدة ثانية على الأقل."
          );

          return;
        }

        // ===================================================
        // Create Blob
        // ===================================================

        const finalType =
          mediaRecorder?.mimeType ||
          audioChunks[0]?.type ||
          "audio/webm";

        audioBlob = new Blob(
          audioChunks,
          {
            type: finalType
          }
        );

        console.log(
          "[Voice] Final:",
          `${(audioBlob.size / 1024).toFixed(1)} KB`,
          finalType,
          `${duration.toFixed(1)} sec`
        );

        // حماية من Blob فاضي
        if (
          !audioBlob ||
          audioBlob.size < 800
        ) {
          console.warn(
            "[Voice] Blob too small:",
            audioBlob?.size
          );

          audioBlob = null;

          alert(
            "التسجيل فارغ أو صغير جداً. حاول مرة أخرى."
          );

          return;
        }

        // إظهار أزرار إرسال / حذف
        actionPopup.style.display = "flex";
      };

      // =====================================================
      // Error
      // =====================================================

      mediaRecorder.onerror = event => {
        console.error(
          "[Voice] MediaRecorder error:",
          event
        );

        alert(
          "حدث خطأ أثناء تسجيل الصوت."
        );

        resetRecordingState();
      };

      // =====================================================
      // Start
      // =====================================================

      mediaRecorder.start(250);

      isRecording = true;
      recordStartTime = Date.now();

      micButton.classList.add(
        "recording-active"
      );

      micButton.textContent = "🔴";

      console.log(
        "[Voice] Recording started"
      );

    } catch (err) {
      console.error(
        "[Voice] Start failed:",
        err
      );

      if (
        err.name === "NotAllowedError"
      ) {
        alert(
          "يجب السماح باستخدام الميكروفون."
        );
      } else if (
        err.name === "NotFoundError"
      ) {
        alert(
          "لم يتم العثور على ميكروفون."
        );
      } else {
        alert(
          "تعذر بدء التسجيل."
        );
      }

      resetRecordingState();
    }
  }

  // =========================================================
  // Stop Recording
  // =========================================================

  function stopRecording(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (
      !isRecording ||
      !mediaRecorder
    ) {
      return;
    }

    console.log(
      "[Voice] Stopping..."
    );

    isRecording = false;

    try {
      if (
        mediaRecorder.state === "recording"
      ) {
        mediaRecorder.stop();
      }
    } catch (err) {
      console.error(
        "[Voice] Stop error:",
        err
      );

      resetRecordingState();
    }
  }

  // =========================================================
  // Force Stop
  // =========================================================

  function forceStop() {
    isRecording = false;

    try {
      if (
        mediaRecorder &&
        mediaRecorder.state !== "inactive"
      ) {
        mediaRecorder.stop();
      }
    } catch (err) {
      console.warn(
        "[Voice] Force stop error:",
        err
      );
    }

    if (currentStream) {
      currentStream
        .getTracks()
        .forEach(track => {
          try {
            track.stop();
          } catch (err) {}
        });

      currentStream = null;
    }

    resetButton();
  }

  // =========================================================
  // Mouse Events
  // =========================================================

  micButton.addEventListener(
    "mousedown",
    startRecording
  );

  micButton.addEventListener(
    "mouseup",
    stopRecording
  );

  micButton.addEventListener(
    "mouseleave",
    () => {
      if (isRecording) {
        stopRecording();
      }
    }
  );

  // =========================================================
  // Mobile Touch Events
  // =========================================================

  micButton.addEventListener(
    "touchstart",
    startRecording,
    {
      passive: false
    }
  );

  micButton.addEventListener(
    "touchend",
    stopRecording,
    {
      passive: false
    }
  );

  micButton.addEventListener(
    "touchcancel",
    stopRecording,
    {
      passive: false
    }
  );

  micButton.addEventListener(
    "touchmove",
    e => {
      if (isRecording) {
        e.preventDefault();
      }
    },
    {
      passive: false
    }
  );

  // =========================================================
  // Prevent Context Menu
  // =========================================================

  micButton.addEventListener(
    "contextmenu",
    e => {
      e.preventDefault();
    }
  );

  // =========================================================
  // Send Voice
  // =========================================================

  sendButton.addEventListener(
    "click",
    async e => {
      e.preventDefault();

      if (!audioBlob) {
        alert(
          "لا يوجد تسجيل لإرساله."
        );

        return;
      }

      sendButton.disabled = true;

      try {
        const reader =
          new FileReader();

        reader.onload = async () => {
          try {
            const base64 =
              reader.result;

            if (!base64) {
              throw new Error(
                "Empty Base64"
              );
            }

            // حماية Firebase
            if (
              base64.length >
              900000
            ) {
              alert(
                "التسجيل طويل جداً."
              );

              sendButton.disabled = false;
              return;
            }

            await addDoc(
              messagesCol,
              {
                type: "voice",

                audioData: base64,

                audioType:
                  audioBlob.type,

                from: myId,

                fromName: myName,

                userId: myId,

                user: myName,

                color: "#39FF14",

                ts: Date.now()
              }
            );

            console.log(
              "[Voice] Sent successfully"
            );

            audioBlob = null;
            audioChunks = [];

            actionPopup.style.display =
              "none";

          } catch (err) {
            console.error(
              "[Voice] Firebase error:",
              err
            );

            alert(
              "فشل إرسال الرسالة الصوتية."
            );
          }

          sendButton.disabled = false;
        };

        reader.onerror = () => {
          console.error(
            "[Voice] FileReader error"
          );

          alert(
            "تعذر قراءة التسجيل."
          );

          sendButton.disabled = false;
        };

        reader.readAsDataURL(
          audioBlob
        );

      } catch (err) {
        console.error(
          "[Voice] Send failed:",
          err
        );

        alert(
          "فشل إرسال الرسالة الصوتية."
        );

        sendButton.disabled = false;
      }
    }
  );

  // =========================================================
  // Cancel
  // =========================================================

  cancelButton.addEventListener(
    "click",
    e => {
      e.preventDefault();

      actionPopup.style.display =
        "none";

      audioBlob = null;
      audioChunks = [];

      console.log(
        "[Voice] Recording deleted"
      );
    }
  );

  // =========================================================
  // Page Visibility
  // =========================================================

  document.addEventListener(
    "visibilitychange",
    () => {
      if (
        document.hidden &&
        isRecording
      ) {
        console.log(
          "[Voice] Page hidden - stopping"
        );

        forceStop();
      }
    }
  );

  // =========================================================
  // Cleanup
  // =========================================================

  window.addEventListener(
    "beforeunload",
    () => {
      if (isRecording) {
        forceStop();
      }
    }
  );

  console.log(
    "[Voice] Voice system initialized"
  );

  return {
    isRecording: () => isRecording
  };
}
