// call.js - Professional WebRTC Call System (Fixed & Target-Locked)

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
  // وقت بدء الجلسة لفلترة أي رسائل قديمة في قاعدة البيانات (يمنع الدخول التلقائي للمكالمات القديمة)
  const sessionStartTime = Date.now();

  let localStream = null;
  let peerConnection = null;
  let isMicActive = true;
  let isCamActive = false;
  let isSpeakerActive = true;
  let currentCallId = null;
  let isCaller = false;
  let signalingUnsub = null;

  let pendingIceCandidates = [];
  const processedDocIds = new Set();

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

  const iceServers = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:stunprot.org:3478" },
      { urls: "stun:openrelay.metered.ca:80" }
    ]
  };

  async function cleanupSignaling(callId) {
    if (!callId) return;
    try {
      const q = query(signalingCol, where("callId", "==", callId));
      const snap = await getDocs(q);
      if (snap.empty) return;
      const batch = writeBatch(db);
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
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
      } catch (e) {}
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
    } catch (e) {}
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
        } catch (e) {}
      }
    };

    pc.onconnectionstatechange = () => {
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

  function startSignalingListener() {
    if (signalingUnsub) {
      signalingUnsub();
      signalingUnsub = null;
    }

    const q = query(signalingCol, orderBy("ts", "desc"), limit(50));

    signalingUnsub = onSnapshot(q, async (snapshot) => {
      const changes = snapshot.docChanges();
      const newMessages = [];

      for (const change of changes) {
        if (change.type !== "added") continue;

        const data = change.doc.data();
        const docId = change.doc.id;

        // الفلترة الأساسية:
        // 1. تجاهل رسائلنا
        // 2. تجاهل المستندات المعالجة
        // 3. (الإصلاح الجذري): تجاهل أي رسالة قديمة تم إنشاؤها قبل فتح الصفحة الحالية (يمنع الدخول التلقائي عند كتابة الباسورد)
        if (!data || data.from === myId || processedDocIds.has(docId)) continue;
        if ((data.ts || 0) < sessionStartTime) continue;

        processedDocIds.add(docId);
        newMessages.push({ id: docId, ...data });
      }

      if (newMessages.length === 0) return;

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

  async function processSignalingMessage(data) {
    if (!data?.type) return;

    if (data.type === "offer" && data.callId) {
      // قبول الاتصال فقط إذا لم نكن داخل مكالمة ولدينا معرفات صحيحة
      if (!peerConnection && !currentCallId) {
        console.log("[Call] Incoming offer detected from:", data.fromName || data.from);
        await handleIncomingOffer(data);
      }
      return;
    }

    if (!currentCallId || data.callId !== currentCallId) return;

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
      } catch (e) {}
      return;
    }

    if (data.type === "candidate" && peerConnection) {
      await addIceCandidateSafe(data.candidate);
      return;
    }

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
      } catch (e) {}
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
      } catch (e) {}
      return;
    }
  }

  async function startCall() {
    if (peerConnection || currentCallId) return;

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
      currentCallId = "call_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

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
      callStatusText.textContent = "PERMISSION DENIED OR DEVICE ERROR";
      alert("تعذر الوصول إلى المايك. تأكد من إعطاء صلاحية الميكروفون.");
      await stopCall();
    }
  }

  async function handleIncomingOffer(offerData) {
    if (peerConnection || currentCallId) return;

    callOverlay.style.display = "flex";
    callStatusText.textContent = "INCOMING CALL FROM " + (offerData.fromName || "UNKNOWN");
    currentCallId = offerData.callId;
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

      await peerConnection.setRemoteDescription({
        type: "offer",
        sdp: offerData.sdp
      });
      await flushPendingCandidates();

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      await addDoc(signalingCol, {
        callId: currentCallId,
        type: "answer",
        sdp: answer.sdp,
        from: myId,
        ts: Date.now()
      });

      callStatusText.textContent = "ANSWER SENT — CONNECTING...";
    } catch (err) {
      callStatusText.textContent = "FAILED TO JOIN CALL";
      await stopCall();
    }
  }

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
    } catch (e) {}
  }

  async function stopCall() {
    const callIdToClean = currentCallId;

    if (localStream) {
      localStream.getTracks().forEach(t => {
        try { t.stop(); } catch (_) {}
      });
      localStream = null;
    }

    if (peerConnection) {
      try {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
      } catch (_) {}
      peerConnection = null;
    }

    pendingIceCandidates = [];
    currentCallId = null;
    isCaller = false;
    isMicActive = true;
    isCamActive = false;
    isSpeakerActive = true;

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

    if (callIdToClean) {
      await cleanupSignaling(callIdToClean);
    }
  }

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

  const boundHandlers = {
    startCall: () => startCall(),
    toggleMic: () => {
      if (!localStream) return;
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        isMicActive = !isMicActive;
        audioTrack.enabled = isMicActive;
        updateCallUI();
      }
    },
    toggleCam: async () => {
      if (!localStream) return;
      let videoTrack = localStream.getVideoTracks()[0];
      if (!videoTrack && !isCamActive) {
        try {
          const camStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
          });
          videoTrack = camStream.getVideoTracks()[0];
          localStream.addTrack(videoTrack);
          if (peerConnection) peerConnection.addTrack(videoTrack, localStream);
          localVideo.srcObject = localStream;
          isCamActive = true;
          localVideo.style.display = "block";
          videoPlaceholder.style.display = "none";
          updateCallUI();
          await renegotiateForCamera();
        } catch (err) {}
        return;
      }
      if (videoTrack) {
        isCamActive = !isCamActive;
        videoTrack.enabled = isCamActive;
        localVideo.style.display = isCamActive ? "block" : "none";
        videoPlaceholder.style.display = isCamActive ? "none" : "flex";
        updateCallUI();
      }
    },
    toggleSpeaker: () => {
      isSpeakerActive = !isSpeakerActive;
      if (remoteVideo) remoteVideo.muted = !isSpeakerActive;
      updateCallUI();
    },
    hangup: () => stopCall()
  };

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

  startSignalingListener();
  attachEventListeners();

  return {
    stopCall,
    getPeerConnection: () => peerConnection,
    getCurrentCallId: () => currentCallId
  };
}
