// call.js - نظام المكالمات الكامل (WebRTC + Signaling)
// يتم استدعاؤه فقط بعد نجاح الـ Unlock

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
  let localStream = null;
  let peerConnection = null;
  let isMicActive = true;
  let isCamActive = false;
  let isSpeakerActive = true;
  let currentCallId = null;
  let isCaller = false;
  let signalingUnsub = null;
  let signalingReady = false;
  let pendingIceCandidates = [];

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
      { urls: "stun:stun.stunprotocol.org:3478" },
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
      console.error("Signaling cleanup error:", e);
    }
  }

  async function flushPendingCandidates() {
    if (!peerConnection || pendingIceCandidates.length === 0) return;
    for (const cand of pendingIceCandidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {}
    }
    pendingIceCandidates = [];
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
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localVideo.srcObject = localStream;
      callStatusText.textContent = "MIC READY — CREATING OFFER...";
      isMicActive = true;
      isCamActive = false;
      updateCallUI();

      peerConnection = new RTCPeerConnection(iceServers);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      peerConnection.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteVideo.srcObject = event.streams[0];
          remotePlaceholder.style.display = "none";
          callStatusText.textContent = "CONNECTED TO PEER";
          remoteVideo.play().catch(() => {});
        }
      };

      peerConnection.onicecandidate = async (event) => {
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
      listenForSignaling();
    } catch (err) {
      console.error("Media error:", err);
      callStatusText.textContent = "PERMISSION DENIED OR DEVICE ERROR";
      alert("تعذر الوصول إلى المايك. تأكد من إعطاء صلاحية الميكروفون.");
      stopCall();
    }
  }

  function listenForSignaling() {
    if (signalingUnsub) signalingUnsub();
    signalingReady = false;
    signalingUnsub = onSnapshot(query(signalingCol, orderBy("ts", "desc"), limit(30)), async (snapshot) => {
      if (!signalingReady) {
        signalingReady = true;
        return;
      }
      for (const change of snapshot.docChanges()) {
        if (change.type !== "added") continue;
        const data = change.doc.data();
        if (!data || data.from === myId) continue;

        if (data.type === "offer" && !isCaller && !peerConnection && data.callId) {
          await handleIncomingOffer(data);
        }
        if (data.type === "answer" && data.callId === currentCallId && isCaller && peerConnection) {
          try {
            if (!peerConnection.currentRemoteDescription) {
              await peerConnection.setRemoteDescription({ type: "answer", sdp: data.sdp });
              callStatusText.textContent = "ANSWER RECEIVED — CONNECTING...";
              await flushPendingCandidates();
            }
          } catch (e) {}
        }
        if (data.type === "candidate" && data.callId === currentCallId && peerConnection) {
          try {
            if (data.candidate) {
              if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
              } else {
                pendingIceCandidates.push(data.candidate);
              }
            }
          } catch (e) {}
        }
      }
    });
  }

  async function handleIncomingOffer(offerData) {
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
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localVideo.srcObject = localStream;
      }
      isMicActive = true;
      isCamActive = false;
      updateCallUI();

      peerConnection = new RTCPeerConnection(iceServers);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      peerConnection.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          remoteVideo.srcObject = event.streams[0];
          remotePlaceholder.style.display = "none";
          callStatusText.textContent = "CONNECTED TO PEER";
          remoteVideo.play().catch(() => {});
        }
      };

      peerConnection.onicecandidate = async (event) => {
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

      await peerConnection.setRemoteDescription({ type: "offer", sdp: offerData.sdp });
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
      listenForSignaling();
    } catch (err) {
      console.error("Incoming call error:", err);
      callStatusText.textContent = "FAILED TO JOIN CALL";
      stopCall();
    }
  }

  async function stopCall() {
    const callIdToClean = currentCallId;
    if (localStream) {
      localStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      localStream = null;
    }
    if (peerConnection) {
      try {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.close();
      } catch (e) {}
      peerConnection = null;
    }
    if (signalingUnsub) {
      signalingUnsub();
      signalingUnsub = null;
    }
    signalingReady = false;
    pendingIceCandidates = [];
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    localVideo.style.display = "none";
    videoPlaceholder.style.display = "flex";
    videoPlaceholder.textContent = "CAMERA IS OFF";
    remotePlaceholder.style.display = "flex";
    remotePlaceholder.textContent = "WAITING FOR PEER...";
    isMicActive = true;
    isCamActive = false;
    isSpeakerActive = true;
    callOverlay.style.display = "none";
    currentCallId = null;
    isCaller = false;
    callStatusText.textContent = "CALL ENDED";
    if (callIdToClean) await cleanupSignaling(callIdToClean);
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

  // Event Listeners
  if (callBtnDesktop) {
    callBtnDesktop.addEventListener("click", startCall);
  }

  if (toggleMicBtn) {
    toggleMicBtn.addEventListener("click", () => {
      if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
          isMicActive = !isMicActive;
          audioTrack.enabled = isMicActive;
          updateCallUI();
        }
      }
    });
  }

  if (toggleCamBtn) {
    toggleCamBtn.addEventListener("click", async () => {
      if (!localStream) return;
      let videoTrack = localStream.getVideoTracks()[0];
      if (!videoTrack && !isCamActive) {
        try {
          callStatusText.textContent = "REQUESTING CAMERA...";
          const camStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
          });
          videoTrack = camStream.getVideoTracks()[0];
          localStream.addTrack(videoTrack);
          if (peerConnection) peerConnection.addTrack(videoTrack, localStream);
          localVideo.srcObject = localStream;
          isCamActive = true;
          localVideo.style.display = "block";
          videoPlaceholder.style.display = "none";
          callStatusText.textContent = "CAMERA ON";
          updateCallUI();
        } catch (err) {
          callStatusText.textContent = "CAMERA PERMISSION DENIED";
          alert("تعذر فتح الكاميرا.");
        }
        return;
      }
      if (videoTrack) {
        isCamActive = !isCamActive;
        videoTrack.enabled = isCamActive;
        localVideo.style.display = isCamActive ? "block" : "none";
        videoPlaceholder.style.display = isCamActive ? "none" : "flex";
        videoPlaceholder.textContent = "CAMERA IS OFF";
        updateCallUI();
      }
    });
  }

  if (toggleSpeakerBtn) {
    toggleSpeakerBtn.addEventListener("click", () => {
      isSpeakerActive = !isSpeakerActive;
      if (remoteVideo) remoteVideo.muted = !isSpeakerActive;
      updateCallUI();
    });
  }

  if (hangupBtn) {
    hangupBtn.addEventListener("click", stopCall);
  }

  // إرجاع دالة لإيقاف المكالمة من الخارج إن لزم
  return { stopCall };
}
