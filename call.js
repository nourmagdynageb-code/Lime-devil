// call.js - Professional WebRTC Call System (Fully Rewritten)
// Fixed: Signaling races, ICE candidate ordering, renegotiation for camera,
//        proper cleanup of listeners & resources. No more signalingReady hacks.

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

  // Track the last processed signaling document timestamp to avoid re-processing
  // and to guarantee chronological order without skipping the first snapshot.
  let lastProcessedTs = 0;

  // Bound handlers so we can remove them cleanly later (prevents memory leaks)
  let boundHandlers = {
    startCall: null,
    toggleMic: null,
    toggleCam: null,
    toggleSpeaker: null,
    hangup: null
  };

  // ─────────────────────────────────────────────
  // DOM REFERENCES
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

  /**
   * Clean all signaling documents belonging to a specific callId.
   * Uses a batch write for efficiency and atomicity.
   */
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
      console.error("[Call] Signaling cleanup error:", e);
    }
  }

  /**
   * Flush any ICE candidates that arrived before the remote description was set.
   * This is the correct place to add them (after setRemoteDescription).
   */
  async function flushPendingCandidates() {
    if (!peerConnection || pendingIceCandidates.length === 0) return;

    const candidates = [...pendingIceCandidates];
    pendingIceCandidates = [];

    for (const cand of candidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {
        // Ignore errors for already-added or outdated candidates
        console.warn("[Call] Failed to add pending ICE candidate:", e.message);
      }
    }
  }

  /**
   * Safely add an ICE candidate. If remote description is not yet set,
   * queue it. Otherwise add immediately.
   */
  async function addIceCandidateSafe(candidate) {
    if (!peerConnection || !candidate) return;

    try {
      if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        pendingIceCandidates.push(candidate);
      }
    } catch (e) {
      console.warn("[Call] ICE candidate error:", e.message);
    }
  }

  /**
   * Create a fresh RTCPeerConnection with all necessary event handlers.
   * Centralized so both caller and callee use identical setup.
   */
  function createPeerConnection() {
    const pc = new RTCPeerConnection(iceServers);

    // Remote track arrived → show remote video
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        remotePlaceholder.style.display = "none";
        callStatusText.textContent = "CONNECTED TO PEER";
        remoteVideo.play().catch(() => {});
      }
    };

    // Local ICE candidate → send to signaling
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
          console.warn("[Call] Failed to send ICE candidate:", e.message);
        }
      }
    };

    // Optional: useful for debugging connection state
    pc.onconnectionstatechange = () => {
      console.log("[Call] Connection state:", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        callStatusText.textContent = "CONNECTION LOST";
      }
    };

    return pc;
  }

  /**
   * Add all tracks from localStream to the peer connection.
   * Safe to call multiple times (tracks are only added once by the browser).
   */
  function addLocalTracksToPC() {
    if (!peerConnection || !localStream) return;
    localStream.getTracks().forEach(track => {
      // Avoid adding the same track twice
      const alreadyAdded = peerConnection.getSenders().some(s => s.track === track);
      if (!alreadyAdded) {
        peerConnection.addTrack(track, localStream);
      }
    });
  }

  // ─────────────────────────────────────────────
  // SIGNALING LISTENER (Race-condition free)
  // ─────────────────────────────────────────────

  /**
   * Start listening to signaling messages.
   * Key design decisions that eliminate races:
   * 1. We never skip the first snapshot with a boolean flag.
   * 2. We track lastProcessedTs and only process documents newer than it.
   * 3. Messages are processed in chronological order (orderBy ts desc + limit,
   *    then we reverse the changes so older ones are handled first).
   * 4. Offers, answers and candidates are handled based on current state,
   *    not on arrival order alone.
   */
  function listenForSignaling() {
    if (signalingUnsub) {
      signalingUnsub();
      signalingUnsub = null;
    }

    // Reset processed timestamp when starting a new listening session
    // (but keep it if we are already in a call so late candidates are still processed)
    if (!currentCallId) {
      lastProcessedTs = 0;
    }

    const q = query(signalingCol, orderBy("ts", "desc"), limit(40));

    signalingUnsub = onSnapshot(q, async (snapshot) => {
      // Collect only newly added documents that are newer than lastProcessedTs
      // and that do not come from ourselves.
      const newDocs = [];

      snapshot.docChanges().forEach(change => {
        if (change.type !== "added") return;
        const data = change.doc.data();
        if (!data || data.from === myId) return;
        if (data.ts && data.ts <= lastProcessedTs) return;

        newDocs.push({ id: change.doc.id, ...data });
      });

      if (newDocs.length === 0) return;

      // Sort ascending by timestamp so we process in correct temporal order
      newDocs.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      // Update the watermark
      lastProcessedTs = Math.max(lastProcessedTs, ...newDocs.map(d => d.ts || 0));

      // Process in order
      for (const data of newDocs) {
        try {
          await processSignalingMessage(data);
        } catch (e) {
          console.error("[Call] Error processing signaling message:", e);
        }
      }
    }, (error) => {
      console.error("[Call] Signaling listener error:", error);
    });
  }

  /**
   * Single entry point for every signaling message.
   * Makes the state machine explicit and race-free.
   */
  async function processSignalingMessage(data) {
    if (!data || !data.type) return;

    // ── Incoming Offer (Callee side) ──
    if (data.type === "offer" && data.callId) {
      // Only accept if we are not already in a call
      if (!peerConnection && !isCaller) {
        await handleIncomingOffer(data);
      }
      return;
    }

    // ── Answer (Caller side) ──
    if (data.type === "answer" && data.callId === currentCallId && isCaller && peerConnection) {
      try {
        // Only set remote description once
        if (!peerConnection.currentRemoteDescription) {
          await peerConnection.setRemoteDescription({
            type: "answer",
            sdp: data.sdp
          });
          callStatusText.textContent = "ANSWER RECEIVED — CONNECTING...";
          await flushPendingCandidates();
        }
      } catch (e) {
        console.error("[Call] setRemoteDescription (answer) failed:", e);
      }
      return;
    }

    // ── ICE Candidate ──
    if (data.type === "candidate" && data.callId === currentCallId && peerConnection) {
      await addIceCandidateSafe(data.candidate);
      return;
    }

    // ── Renegotiation Offer (when the other side turns camera on) ──
    if (data.type === "renegotiate-offer" && data.callId === currentCallId && peerConnection) {
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
        console.error("[Call] Renegotiation answer failed:", e);
      }
      return;
    }

    // ── Renegotiation Answer ──
    if (data.type === "renegotiate-answer" && data.callId === currentCallId && peerConnection) {
      try {
        if (peerConnection.signalingState === "have-local-offer") {
          await peerConnection.setRemoteDescription({
            type: "answer",
            sdp: data.sdp
          });
          await flushPendingCandidates();
        }
      } catch (e) {
        console.error("[Call] Renegotiation setRemoteDescription failed:", e);
      }
      return;
    }
  }

  // ─────────────────────────────────────────────
  // CALL FLOW
  // ─────────────────────────────────────────────

  async function startCall() {
    // Guard against double-start
    if (peerConnection || currentCallId) return;

    // Reset UI
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
    lastProcessedTs = 0;

    try {
      // Get microphone only (camera is optional and added later via renegotiation)
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });
      localVideo.srcObject = localStream;
      isMicActive = true;
      isCamActive = false;
      updateCallUI();
      callStatusText.textContent = "MIC READY — CREATING OFFER...";

      // Create peer connection + add tracks
      peerConnection = createPeerConnection();
      addLocalTracksToPC();

      isCaller = true;
      currentCallId = "call_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);

      // Create and send offer
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
      console.error("[Call] Media error:", err);
      callStatusText.textContent = "PERMISSION DENIED OR DEVICE ERROR";
      alert("تعذر الوصول إلى المايك. تأكد من إعطاء صلاحية الميكروفون.");
      await stopCall();
    }
  }

  async function handleIncomingOffer(offerData) {
    callOverlay.style.display = "flex";
    callStatusText.textContent = "INCOMING CALL FROM " + (offerData.fromName || "UNKNOWN");
    currentCallId = offerData.callId;
    isCaller = false;
    pendingIceCandidates = [];
    lastProcessedTs = offerData.ts || 0; // Start from this offer's timestamp

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

      // Set remote offer first, then flush any candidates that may have arrived early
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
      listenForSignaling();
    } catch (err) {
      console.error("[Call] Incoming call error:", err);
      callStatusText.textContent = "FAILED TO JOIN CALL";
      await stopCall();
    }
  }

  /**
   * Proper renegotiation when camera is turned on mid-call.
   * Simply calling addTrack is not enough for many browsers / network conditions.
   * We create a new offer and exchange it via signaling.
   */
  async function renegotiateForCamera() {
    if (!peerConnection || !currentCallId) return;

    try {
      callStatusText.textContent = "RENEGOTIATING FOR CAMERA...";

      // Make sure the new video track is already added
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
      console.error("[Call] Renegotiation failed:", e);
      callStatusText.textContent = "CAMERA RENEGOTIATION FAILED";
    }
  }

  // ─────────────────────────────────────────────
  // STOP / CLEANUP (Memory-leak free)
  // ─────────────────────────────────────────────

  async function stopCall() {
    const callIdToClean = currentCallId;

    // 1. Stop all media tracks
    if (localStream) {
      localStream.getTracks().forEach(track => {
        try { track.stop(); } catch (_) {}
      });
      localStream = null;
    }

    // 2. Close peer connection and remove handlers
    if (peerConnection) {
      try {
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
      } catch (_) {}
      peerConnection = null;
    }

    // 3. Unsubscribe from signaling
    if (signalingUnsub) {
      signalingUnsub();
      signalingUnsub = null;
    }

    // 4. Reset state
    pendingIceCandidates = [];
    lastProcessedTs = 0;
    currentCallId = null;
    isCaller = false;
    isMicActive = true;
    isCamActive = false;
    isSpeakerActive = true;

    // 5. Reset UI
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

    // 6. Clean signaling documents
    if (callIdToClean) {
      await cleanupSignaling(callIdToClean);
    }
  }

  // ─────────────────────────────────────────────
  // UI UPDATES
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
  // EVENT HANDLERS (bound once, removable)
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

    // First time turning camera on → acquire video track + renegotiate
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

        // Add to peer connection
        if (peerConnection) {
          peerConnection.addTrack(videoTrack, localStream);
        }

        localVideo.srcObject = localStream;
        isCamActive = true;
        localVideo.style.display = "block";
        videoPlaceholder.style.display = "none";
        updateCallUI();

        // Critical: perform proper renegotiation so the remote side receives the new track
        await renegotiateForCamera();
        callStatusText.textContent = "CAMERA ON";
      } catch (err) {
        console.error("[Call] Camera error:", err);
        callStatusText.textContent = "CAMERA PERMISSION DENIED";
        alert("تعذر فتح الكاميرا.");
      }
      return;
    }

    // Subsequent toggles → just enable/disable the existing track
    if (videoTrack) {
      isCamActive = !isCamActive;
      videoTrack.enabled = isCamActive;
      localVideo.style.display = isCamActive ? "block" : "none";
      videoPlaceholder.style.display = isCamActive ? "none" : "flex";
      videoPlaceholder.textContent = "CAMERA IS OFF";
      updateCallUI();

      // Optional: you can also renegotiate on disable if you want the remote
      // side to stop receiving the track, but usually enabling/disabling is enough.
    }
  };

  boundHandlers.toggleSpeaker = () => {
    isSpeakerActive = !isSpeakerActive;
    if (remoteVideo) remoteVideo.muted = !isSpeakerActive;
    updateCallUI();
  };

  boundHandlers.hangup = () => stopCall();

  // ─────────────────────────────────────────────
  // ATTACH / DETACH LISTENERS
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

  function detachEventListeners() {
    if (callBtnDesktop) callBtnDesktop.removeEventListener("click", boundHandlers.startCall);
    if (toggleMicBtn) toggleMicBtn.removeEventListener("click", boundHandlers.toggleMic);
    if (toggleCamBtn) toggleCamBtn.removeEventListener("click", boundHandlers.toggleCam);
    if (toggleSpeakerBtn) toggleSpeakerBtn.removeEventListener("click", boundHandlers.toggleSpeaker);
    if (hangupBtn) hangupBtn.removeEventListener("click", boundHandlers.hangup);
  }

  // Attach listeners on init
  attachEventListeners();

  // ─────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────
  return {
    stopCall: async () => {
      await stopCall();
      // Optionally detach listeners if the whole system is being destroyed
      // detachEventListeners();
    },
    // Expose for advanced use / debugging
    getPeerConnection: () => peerConnection,
    getCurrentCallId: () => currentCallId
  };
}
