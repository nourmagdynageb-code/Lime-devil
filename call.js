// call.js - Professional WebRTC Call System
// Fixed: Ignore all old signaling documents before current session + strict callId isolation + better cleanup

export function initCallSystem({
  db,
  signalingCol,
  myId,
  myName,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  writeBatch,
  onSnapshot
}) {
  // ─────────────────────────────────────────────
  // SESSION START TIME – أهم إصلاح لمشكلة التوجيه التلقائي
  // أي مستند تم إنشاؤه قبل هذا الوقت سيتم تجاهله تماماً
  // ─────────────────────────────────────────────
  const sessionStartTime = Date.now();

  // ─────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────
  let localStream = null;
  let peerConnection = null;
  let isMicActive = true;
  let isCamActive = false;
  let isSpeakerActive = true;
  let currentCallId = null;
  let isCaller = false;
  let signalingUnsub = null;

  // Queue for ICE candidates that arrive before remote description is set
  let pendingIceCandidates = [];

  // Prevent processing the same document twice
  const processedDocIds = new Set();

  // Bound handlers (for clean removal later)
  const boundHandlers = {
    startCall: null,
    toggleMic: null,
    toggleCam: null,
    toggleSpeaker: null,
    hangup: null
  };

  // ─────────────────────────────────────────────
  // DOM
  // ─────────────────────────────────────────────
  const callOverlay = document.getElementById("callOverlay");
  const localVideo = document.getElementById("localVideo");
  const remoteVideo = document.getElementById("remoteVideo");
  const videoPlaceholder = document.getElementById("videoPlaceholder");
  const remotePlaceholder = document.getElementById("remotePlaceholder");
  const callStatusText = document.getElementById("callStatusText");
  const toggleMicBtn = document.getElementById("toggleMicBtn");
  const toggleCamBtn = document.getElementById("toggleCamBtn");
  const toggleSpeakerBtn = document.getElementById("toggleSpeakerBtn");
  const hangupBtn = document.getElementById("hangupBtn");
  const callBtnDesktop = document.getElementById("callBtnDesktop");

  // ─────────────────────────────────────────────
  // ICE SERVERS
  // ─────────────────────────────────────────────
  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:stun.stunprotocol.org:3478" },
      { urls: "stun:openrelay.metered.ca:80" }
    ]
  };

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  async function cleanupSignaling(callId) {
    if (!callId) return;
    try {
      const q = query(signalingCol, where("callId", "==", callId));
      const snap = await getDocs(q);
      if (snap.empty) return;

      const batch = writeBatch(db);
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log("[Call] Cleaned signaling docs for callId:", callId);
    } catch (e) {
      console.error("[Call] cleanupSignaling error:", e);
    }
  }

  async function flushPendingCandidates() {
    if (!peerConnection || pendingIceCandidates.length === 0) return;

    const candidates = [...pendingIceCandidates];
    pendingIceCandidates = [];

    for (const cand of candidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {
        // Ignore outdated / already added candidates
      }
    }
  }

  async function addIceCandidateSafe(candidate) {
    if (!peerConnection || !candidate) return;

    try {
      if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        pendingIceCandidates.push(candidate);
      }
    } catch (e) {
      console.warn("[Call] addIceCandidateSafe:", e.message);
    }
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection(iceServers);

    pc.ontrack = (event) => {
      if (event.streams?.[0]) {
        remoteVideo.srcObject = event.streams[0];
        remotePlaceholder.style.display = "none";
        callStatusText.textContent = "CONNECTED TO PEER";
        remoteVideo.play().catch(() => {});
      }
    };

    pc.onicecandidate = async (event) => {
      if (event.candidate && currentCallId) {
        try {
          await addDoc(signalingCol, {
            callId: currentCallId,
            type: "candidate",
            candidate: event.candidate.toJSON(),
            from: myId,
            ts: Date.now()
          });
        } catch (e) {
          console.warn("[Call] send candidate failed:", e.message);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("[Call] connectionState →", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        callStatusText.textContent = "CONNECTION LOST";
      }
    };

    return pc;
  }

  function addLocalTracksToPC() {
    if (!peerConnection || !localStream) return;
    localStream.getTracks().forEach(track => {
      const alreadyAdded = peerConnection.getSenders().some(s => s.track === track);
      if (!alreadyAdded) {
        peerConnection.addTrack(track, localStream);
      }
    });
  }

  // ─────────────────────────────────────────────
  // SIGNALING LISTENER (Always Active + Session Filter)
  // ─────────────────────────────────────────────

  function startSignalingListener() {
    if (signalingUnsub) {
      signalingUnsub();
      signalingUnsub = null;
    }

    // نستمع لآخر 60 رسالة
    const q = query(signalingCol, orderBy("ts", "desc"), limit(60));

    signalingUnsub = onSnapshot(q, async (snapshot) => {
      const changes = snapshot.docChanges();
      const newMessages = [];

      for (const change of changes) {
        if (change.type !== "added") continue;

        const data = change.doc.data();
        const docId = change.doc.id;

        // 1. تجاهل رسائلنا نحن
        if (!data || data.from === myId) continue;

        // 2. تجاهل الرسائل المعالجة مسبقاً
        if (processedDocIds.has(docId)) continue;

        // 3. ★★★ الإصلاح الجذري لمشكلة التوجيه التلقائي ★★★
        // تجاهل أي مستند تم إنشاؤه قبل بدء الجلسة الحالية
        if (!data.ts || data.ts < sessionStartTime) {
          // نسجلها كمعالجة حتى لا نعود إليها مرة أخرى
          processedDocIds.add(docId);
          continue;
        }

        processedDocIds.add(docId);
        newMessages.push({ id: docId, ...data });
      }

      if (newMessages.length === 0) return;

      // ترتيب زمني تصاعدي
      newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      for (const msg of newMessages) {
        try {
          await processSignalingMessage(msg);
        } catch (err) {
          console.error("[Call] processSignalingMessage error:", err);
        }
      }
    }, (error) => {
      console.error("[Call] Signaling listener error:", error);
    });
  }

  /**
   * معالج مركزي لكل أنواع الرسائل مع فلترة صارمة حسب callId
   */
  async function processSignalingMessage(data) {
    if (!data?.type) return;

    // ═══════════════════════════════════════
    // 1. Incoming Offer (فقط العروض الجديدة بعد sessionStartTime)
    // ═══════════════════════════════════════
    if (data.type === "offer" && data.callId) {
      // حماية إضافية: لا نقبل عروض قديمة حتى لو تجاوزت الفلترة
      if (data.ts < sessionStartTime) return;

      // نقبل الـ Offer فقط إذا لم نكن داخل مكالمة حالياً
      if (!peerConnection && !currentCallId) {
        console.log("[Call] Incoming offer detected from:", data.fromName || data.from, "callId:", data.callId);
        await handleIncomingOffer(data);
      }
      return;
    }

    // من هنا فصاعداً: الرسائل يجب أن تكون لنفس الـ callId النشط فقط
    // هذا يمنع تماماً تداخل المكالمات القديمة أو المنتهية
    if (!currentCallId || data.callId !== currentCallId) {
      return;
    }

    // ═══════════════════════════════════════
    // 2. Answer (للـ Caller)
    // ═══════════════════════════════════════
    if (data.type === "answer" && isCaller && peerConnection) {
      try {
        if (!peerConnection.currentRemoteDescription) {
          await peerConnection.setRemoteDescription({
            type: "answer",
            sdp: data.sdp
          });
          callStatusText.textContent = "ANSWER RECEIVED — CONNECTING...";
          await flushPendingCandidates();
        }
      } catch (e) {
        console.error("[Call] setRemoteDescription(answer) failed:", e);
      }
      return;
    }

    // ═══════════════════════════════════════
    // 3. ICE Candidate
    // ═══════════════════════════════════════
    if (data.type === "candidate" && peerConnection) {
      await addIceCandidateSafe(data.candidate);
      return;
    }

    // ═══════════════════════════════════════
    // 4. Renegotiation (للكاميرا)
    // ═══════════════════════════════════════
    if (data.type === "renegotiate-offer" && peerConnection) {
      try {
        await peerConnection.setRemoteDescription({
          type: "offer",
          sdp: data.sdp
        });
        await flushPendingCandidates();

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        await addDoc(signalingCol, {
          callId: currentCallId,
          type: "renegotiate-answer",
          sdp: answer.sdp,
          from: myId,
          ts: Date.now()
        });
      } catch (e) {
        console.error("[Call] renegotiate-offer failed:", e);
      }
      return;
    }

    if (data.type === "renegotiate-answer" && peerConnection) {
      try {
        if (peerConnection.signalingState === "have-local-offer") {
          await peerConnection.setRemoteDescription({
            type: "answer",
            sdp: data.sdp
          });
          await flushPendingCandidates();
        }
      } catch (e) {
        console.error("[Call] renegotiate-answer failed:", e);
      }
      return;
    }
  }

  // ─────────────────────────────────────────────
  // CALL FLOW
  // ─────────────────────────────────────────────

  async function startCall() {
    if (peerConnection || currentCallId) return;

    // UI reset
    callOverlay.style.display = "flex";
    callStatusText.textContent = "REQUESTING MIC...";
    remotePlaceholder.style.display = "flex";
    remotePlaceholder.textContent = "WAITING FOR PEER...";
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;
    localVideo.style.display = "none";
    videoPlaceholder.style.display = "flex";
    videoPlaceholder.textContent = "CAMERA IS OFF";
    pendingIceCandidates = [];

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      localVideo.srcObject = localStream;
      isMicActive = true;
      isCamActive = false;
      updateCallUI();
      callStatusText.textContent = "MIC READY — CREATING OFFER...";

      peerConnection = createPeerConnection();
      addLocalTracksToPC();

      isCaller = true;
      // إنشاء callId فريد مرتبط بالجلسة الحالية
      currentCallId = "call_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // إرسال الـ Offer مع timestamp حديث
      await addDoc(signalingCol, {
        callId: currentCallId,
        type: "offer",
        sdp: offer.sdp,
        from: myId,
        fromName: myName,
        ts: Date.now()
      });

      callStatusText.textContent = "OFFER SENT — WAITING FOR ANSWER...";
    } catch (err) {
      console.error("[Call] startCall media error:", err);
      callStatusText.textContent = "PERMISSION DENIED OR DEVICE ERROR";
      alert("تعذر الوصول إلى المايك. تأكد من إعطاء صلاحية الميكروفون.");
      await stopCall();
    }
  }

  async function handleIncomingOffer(offerData) {
    // منع الدخول مرتين
    if (peerConnection || currentCallId) return;

    // حماية إضافية ضد العروض القديمة
    if (!offerData.ts || offerData.ts < sessionStartTime) {
      console.warn("[Call] Rejected old offer");
      return;
    }

    callOverlay.style.display = "flex";
    callStatusText.textContent = "INCOMING CALL FROM " + (offerData.fromName || "UNKNOWN");
    currentCallId = offerData.callId;          // ربط دقيق بالـ callId
    isCaller = false;
    pendingIceCandidates = [];

    localVideo.srcObject = null;
    localVideo.style.display = "none";
    videoPlaceholder.style.display = "flex";
    videoPlaceholder.textContent = "CAMERA IS OFF";

    try {
      if (!localStream) {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false
        });
        localVideo.srcObject = localStream;
      }
      isMicActive = true;
      isCamActive = false;
      updateCallUI();

      peerConnection = createPeerConnection();
      addLocalTracksToPC();

      // تعيين الـ Remote Description أولاً
      await peerConnection.setRemoteDescription({
        type: "offer",
        sdp: offerData.sdp
      });
      await flushPendingCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      // إرسال الـ Answer مرتبط بنفس الـ callId
      await addDoc(signalingCol, {
        callId: currentCallId,
        type: "answer",
        sdp: answer.sdp,
        from: myId,
        ts: Date.now()
      });

      callStatusText.textContent = "ANSWER SENT — CONNECTING...";
    } catch (err) {
      console.error("[Call] handleIncomingOffer error:", err);
      callStatusText.textContent = "FAILED TO JOIN CALL";
      await stopCall();
    }
  }

  /**
   * إعادة التفاوض عند تشغيل الكاميرا أثناء المكالمة
   */
  async function renegotiateForCamera() {
    if (!peerConnection || !currentCallId) return;

    try {
      callStatusText.textContent = "RENEGOTIATING FOR CAMERA...";
      addLocalTracksToPC();

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      await addDoc(signalingCol, {
        callId: currentCallId,
        type: "renegotiate-offer",
        sdp: offer.sdp,
        from: myId,
        ts: Date.now()
      });
    } catch (e) {
      console.error("[Call] renegotiateForCamera failed:", e);
      callStatusText.textContent = "CAMERA RENEGOTIATION FAILED";
    }
  }

  // ─────────────────────────────────────────────
  // STOP / CLEANUP (تنظيف أدق)
  // ─────────────────────────────────────────────

  async function stopCall() {
    const callIdToClean = currentCallId;

    // Stop media
    if (localStream) {
      localStream.getTracks().forEach(t => {
        try { t.stop(); } catch (_) {}
      });
      localStream = null;
    }

    // Close peer connection
    if (peerConnection) {
      try {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
      } catch (_) {}
      peerConnection = null;
    }

    // Reset state
    pendingIceCandidates = [];
    currentCallId = null;
    isCaller = false;
    isMicActive = true;
    isCamActive = false;
    isSpeakerActive = true;

    // UI reset
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    localVideo.style.display = "none";
    videoPlaceholder.style.display = "flex";
    videoPlaceholder.textContent = "CAMERA IS OFF";
    remotePlaceholder.style.display = "flex";
    remotePlaceholder.textContent = "WAITING FOR PEER...";
    callOverlay.style.display = "none";
    callStatusText.textContent = "CALL ENDED";
    updateCallUI();

    // ★★★ تنظيف دقيق لكل مستندات الإشارة الخاصة بهذه المكالمة ★★★
    if (callIdToClean) {
      await cleanupSignaling(callIdToClean);
    }

    // ملاحظة مهمة: لا نوقف الـ listener هنا
    // حتى يستطيع الجهاز استقبال مكالمات جديدة في نفس الجلسة
  }

  // ─────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────

  function updateCallUI() {
    if (toggleMicBtn) {
      toggleMicBtn.textContent = isMicActive ? "🎤 MUTE MIC" : "🎙 UNMUTE MIC";
      toggleMicBtn.classList.toggle("off", !isMicActive);
    }
    if (toggleCamBtn) {
      toggleCamBtn.textContent = isCamActive ? "📷 TURN OFF CAM" : "📹 TURN ON CAM";
      toggleCamBtn.classList.toggle("off", !isCamActive);
    }
    if (toggleSpeakerBtn) {
      toggleSpeakerBtn.textContent = isSpeakerActive ? "🔊 SPEAKER: ON" : "🔈 SPEAKER: OFF";
      toggleSpeakerBtn.classList.toggle("off", !isSpeakerActive);
    }
  }

  // ─────────────────────────────────────────────
  // EVENT HANDLERS
  // ─────────────────────────────────────────────

  boundHandlers.startCall = () => startCall();

  boundHandlers.toggleMic = () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      isMicActive = !isMicActive;
      audioTrack.enabled = isMicActive;
      updateCallUI();
    }
  };

  boundHandlers.toggleCam = async () => {
    if (!localStream) return;

    let videoTrack = localStream.getVideoTracks()[0];

    // تشغيل الكاميرا لأول مرة
    if (!videoTrack && !isCamActive) {
      try {
        callStatusText.textContent = "REQUESTING CAMERA...";
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 }
          },
          audio: false
        });

        videoTrack = camStream.getVideoTracks()[0];
        localStream.addTrack(videoTrack);

        if (peerConnection) {
          peerConnection.addTrack(videoTrack, localStream);
        }

        localVideo.srcObject = localStream;
        isCamActive = true;
        localVideo.style.display = "block";
        videoPlaceholder.style.display = "none";
        updateCallUI();

        // إعادة التفاوض حتى يستقبل الطرف الآخر مسار الفيديو
        await renegotiateForCamera();
        callStatusText.textContent = "CAMERA ON";
      } catch (err) {
        console.error("[Call] camera error:", err);
        callStatusText.textContent = "CAMERA PERMISSION DENIED";
        alert("تعذر فتح الكاميرا.");
      }
      return;
    }

    // تبديل الكاميرا
    if (videoTrack) {
      isCamActive = !isCamActive;
      videoTrack.enabled = isCamActive;
      localVideo.style.display = isCamActive ? "block" : "none";
      videoPlaceholder.style.display = isCamActive ? "none" : "flex";
      videoPlaceholder.textContent = "CAMERA IS OFF";
      updateCallUI();
    }
  };

  boundHandlers.toggleSpeaker = () => {
    isSpeakerActive = !isSpeakerActive;
    if (remoteVideo) remoteVideo.muted = !isSpeakerActive;
    updateCallUI();
  };

  boundHandlers.hangup = () => stopCall();

  // ─────────────────────────────────────────────
  // ATTACH LISTENERS
  // ─────────────────────────────────────────────

  function attachEventListeners() {
    if (callBtnDesktop) {
      callBtnDesktop.removeEventListener("click", boundHandlers.startCall);
      callBtnDesktop.addEventListener("click", boundHandlers.startCall);
    }
    if (toggleMicBtn) {
      toggleMicBtn.removeEventListener("click", boundHandlers.toggleMic);
      toggleMicBtn.addEventListener("click", boundHandlers.toggleMic);
    }
    if (toggleCamBtn) {
      toggleCamBtn.removeEventListener("click", boundHandlers.toggleCam);
      toggleCamBtn.addEventListener("click", boundHandlers.toggleCam);
    }
    if (toggleSpeakerBtn) {
      toggleSpeakerBtn.removeEventListener("click", boundHandlers.toggleSpeaker);
      toggleSpeakerBtn.addEventListener("click", boundHandlers.toggleSpeaker);
    }
    if (hangupBtn) {
      hangupBtn.removeEventListener("click", boundHandlers.hangup);
      hangupBtn.addEventListener("click", boundHandlers.hangup);
    }
  }

  // ─────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────

  // نبدأ الاستماع فوراً مع فلترة sessionStartTime
  startSignalingListener();
  attachEventListeners();

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────
  return {
    stopCall,
    getPeerConnection: () => peerConnection,
    getCurrentCallId: () => currentCallId
  };
}
