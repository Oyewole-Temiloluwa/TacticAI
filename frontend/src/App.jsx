import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

const WS_URL =
  window.location.hostname === "localhost"
    ? "ws://localhost:8000/ws"
    : `wss://${window.location.hostname}/ws`;

// ── Audio engine ──────────────────────────────────────────────────────────────
let audioCtx = null;
let nextStartTime = 0;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 24000 });
  return audioCtx;
}

function playAudioChunk(base64Data) {
  const ctx = getAudioCtx();
  const raw = atob(base64Data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++)
    samples[i] = view.getInt16(i * 2, true) / 32768;
  const buffer = ctx.createBuffer(1, samples.length, 24000);
  buffer.getChannelData(0).set(samples);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const now = ctx.currentTime;
  if (nextStartTime < now) nextStartTime = now;
  source.start(nextStartTime);
  nextStartTime += buffer.duration;
}

function stopAudioPlayback() {
  nextStartTime = 0;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

// ── Wake word removed — we now use a simple tap-to-talk system ──

// ── Component ─────────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [coachSpeaking, setCoachSpeaking] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [lastFrame, setLastFrame] = useState(null);
  const [listening, setListening] = useState(false);
  const [videoFileUrl, setVideoFileUrl] = useState(null);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [contextSummary, setContextSummary] = useState("");  // latest context snapshot
  const [presenterActive, setPresenterActive] = useState(false); // presenter PiP state

  const wsRef = useRef(null);
  const lingerTimerRef = useRef(null);
  const videoRef = useRef(null);
  const presenterVideoRef = useRef(null);
  const presenterStreamRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const recognitionRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const fileInputRef = useRef(null);
  // User mic stream — removed because holding it open locks Windows mics
  // and crashes SpeechRecognition.
  const userMicStreamRef = useRef(null);
  const commentaryMicStreamRef = useRef(null);
  // Mirror refs for closures
  const coachSpeakingRef = useRef(false);
  const isVideoPlayingRef = useRef(false);
  const isManualMicActiveRef = useRef(false);
  const connectedRef = useRef(false);
  const videoFileUrlRef = useRef(null);

  useEffect(() => { coachSpeakingRef.current = coachSpeaking; }, [coachSpeaking]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { videoFileUrlRef.current = videoFileUrl; }, [videoFileUrl]);
  useEffect(() => { isVideoPlayingRef.current = isVideoPlaying; }, [isVideoPlaying]);

  // ── Continuous frame streaming ───────────────────────────────────────────────
  useEffect(() => {
    if ((cameraActive || (videoFileUrl && isVideoPlaying)) && connected) {
      frameIntervalRef.current = setInterval(() => {
        if (!videoRef.current || !canvasRef.current || !wsRef.current) return;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");

        // Maintain aspect ratio instead of stretching to 640x480
        const videoRatio = video.videoWidth / video.videoHeight;
        let drawWidth = 640;
        let drawHeight = 640 / videoRatio;

        if (drawHeight > 480) {
            drawHeight = 480;
            drawWidth = 480 * videoRatio;
        }

        canvas.width = drawWidth;
        canvas.height = drawHeight;
        
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, drawWidth, drawHeight);
        ctx.drawImage(video, 0, 0, drawWidth, drawHeight);
        
        const base64 = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
        wsRef.current.send(
          JSON.stringify({ type: "video_frame", image: base64, mime_type: "image/jpeg" })
        );
      }, 8000);
    } else {
      clearInterval(frameIntervalRef.current);
    }
    return () => clearInterval(frameIntervalRef.current);
  }, [cameraActive, videoFileUrl, isVideoPlaying, connected]);

  // ── WebSocket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => console.log("[WS] Connected");

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "connected":
          setConnected(true);
          break;
        case "audio":
          setCoachSpeaking(true);
          playAudioChunk(data.data);
          break;
        case "turn_complete":
          setCoachSpeaking(false);
          break;
        case "interrupted":
          setCoachSpeaking(false);
          stopAudioPlayback();
          break;
        case "context_update":
          // Backend sends latest context summary for display
          setContextSummary(data.summary);
          break;
        case "error":
          console.error("[ERROR]", data.message);
          break;
      }
    };

    ws.onclose = () => { setConnected(false); console.log("[WS] Disconnected"); };
    return () => ws.close();
  }, []);

  // ── Camera & Video File ───────────────────────────────────────────────────────
  const toggleCamera = useCallback(async () => {
    if (videoFileUrl) {
      // Clear video file if switching to camera
      URL.revokeObjectURL(videoFileUrl);
      setVideoFileUrl(null);
      setIsVideoPlaying(false);
      
      // Stop presenter camera if it was running alongside video file
      if (presenterActive) {
          presenterStreamRef.current?.getTracks().forEach((t) => t.stop());
          setPresenterActive(false);
          if (presenterVideoRef.current) presenterVideoRef.current.srcObject = null;
      }

      if (fileInputRef.current) fileInputRef.current.value = "";
    }

    if (cameraActive) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setCameraActive(false);
      setLastFrame(null);
      if (videoRef.current) videoRef.current.srcObject = null;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: 640, height: 480 },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
      }
      setCameraActive(true);
    } catch (err) {
      console.error("Camera error:", err);
    }
  }, [cameraActive, videoFileUrl]);

  const handleVideoUpload = useCallback((event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (cameraActive) {
      // Stop camera if it's running
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setCameraActive(false);
      setLastFrame(null);
    }

    const url = URL.createObjectURL(file);
    setVideoFileUrl(url);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.src = url;
      // When uploading a video, user might want audio, but to avoid 
      // recursive echoes during dev we keep it muted by default unless they enable it in the controls later
      videoRef.current.muted = false;
      
      // Also automatically start the presenter camera for screen recording
      navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 320, height: 240 },
      })
      .then((stream) => {
          presenterStreamRef.current = stream;
          if (presenterVideoRef.current) {
              presenterVideoRef.current.srcObject = stream;
              presenterVideoRef.current.muted = true;
          }
          setPresenterActive(true);
      })
      .catch((err) => console.error("Presenter camera error:", err));
    }
  }, [cameraActive, presenterActive]);

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;
    const canvas = canvasRef.current;
    
    // Maintain aspect ratio for voice-prompt capture too
    const videoRatio = video.videoWidth / video.videoHeight;
    let drawWidth = 640;
    let drawHeight = 640 / videoRatio;

    if (drawHeight > 480) {
        drawHeight = 480;
        drawWidth = 480 * videoRatio;
    }

    canvas.width = drawWidth;
    canvas.height = drawHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, drawWidth, drawHeight);
    ctx.drawImage(video, 0, 0, drawWidth, drawHeight);
    
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    setLastFrame(dataUrl);
    return dataUrl.split(",")[1];
  }, []);

  // ── Send prompt ──────────────────────────────────────────────────────────────
  const sendVoicePrompt = useCallback(
    (text) => {
      if (!text.trim() || !wsRef.current) return;
      if (coachSpeakingRef.current) { stopAudioPlayback(); setCoachSpeaking(false); }
      const frame = (cameraActive || (videoFileUrlRef.current && isVideoPlayingRef.current)) ? captureFrame() : null;
      if (frame) {
        wsRef.current.send(
          JSON.stringify({ type: "text_with_image", text: text.trim(), image: frame, mime_type: "image/jpeg" })
        );
      } else {
        wsRef.current.send(JSON.stringify({ type: "text", text: text.trim() }));
      }
    },
    [captureFrame, cameraActive]
  );

  // ── Mic button ───────────────────────────────────────────────────────────────
  const toggleListening = useCallback(() => {
    if (listening) {
        isManualMicActiveRef.current = false;
        recognitionRef.current?.stop(); 
        setListening(false);
        return; 
    }

    // Lock the mic active state so we don't accidentally handle other logic
    isManualMicActiveRef.current = true;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { 
       alert("Speech recognition not supported. Use Chrome or Edge."); 
       isManualMicActiveRef.current = false;
       return; 
    }

    // Use a small delay so Chrome finishes aborting the old listener before we launch the new one
    setTimeout(() => {
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "en-US";

    rec.onstart = () => {
      console.log("[PROMPT MIC] recognition onstart event fired");
      setListening(true);
      // Wait to stop coach speaking until SR actually starts to maintain illusion
      if (coachSpeakingRef.current) { 
        stopAudioPlayback(); 
        setCoachSpeaking(false); 
      }
    };

    rec.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++)
        transcript += event.results[i][0].transcript;
      setInput(transcript);
      console.log(`[PROMPT MIC] interim transcript: "${transcript}"`);

      if (event.results[event.results.length - 1].isFinal) {
        const text = transcript.trim();
        console.log(`[PROMPT MIC] Final transcript: "${text}"`);
        if (!text) return;
        setInput("");
        isManualMicActiveRef.current = false;
        rec.stop();
        sendVoicePrompt(text);
      }
    };

    rec.onend = () => {
      console.log("[PROMPT MIC] recognition onend event fired");
      setListening(false);
      isManualMicActiveRef.current = false;
    };

    rec.onerror = (e) => {
      console.error("[PROMPT MIC] Error event fired:", e.error, e.message || "");
      if (e.error === "not-allowed") alert("Microphone permission denied.");
      setListening(false);
      isManualMicActiveRef.current = false;
    };

    rec.onaudiostart = () => console.log("[PROMPT MIC] Audio capturing started");
    rec.onaudioend = () => console.log("[PROMPT MIC] Audio capturing ended");
    rec.onspeechstart = () => console.log("[PROMPT MIC] Speech detected");
    rec.onspeechend = () => console.log("[PROMPT MIC] Speech ended");

    // The prompt SR temporarily takes over the recognitionRef
    recognitionRef.current = rec;
    try { 
      rec.start(); 
      console.log("[PROMPT MIC] start() called successfully");
    } catch (err) { 
      console.error("[PROMPT MIC] start() Failed:", err); 
      setListening(false); 
      isManualMicActiveRef.current = false;
    }
  }, 300);
  }, [listening, sendVoicePrompt]);

  // ── Derive UI state label ─────────────────────────────────────────────────────
  const stateLabel = !connected
    ? "Connecting…"
    : coachSpeaking
    ? "Coach T is speaking"
    : listening
    ? "Listening…"
    : 'Tap to ask Coach T';

  const orbState = listening ? "listening" : coachSpeaking ? "speaking" : "idle";

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="logo">⚽</span>
          <h1>TacticAI</h1>
          <span className="subtitle">Live Football Tactical Coach</span>
        </div>
        <div className="header-right">
          <span className={`status ${connected ? "online" : "offline"}`}>
            <span className="status-dot" />
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      <div className="main">
        {/* ── Video panel ── */}
        <div className="video-panel">
          {(cameraActive || (videoFileUrl && isVideoPlaying)) && connected && <div className="streaming-badge">LIVE</div>}
          <video
            ref={videoRef}
            autoPlay={cameraActive}
            controls={!!videoFileUrl}
            playsInline
            muted={cameraActive}
            className={cameraActive || videoFileUrl ? "active" : "hidden"}
            onPlay={() => setIsVideoPlaying(true)}
            onPause={() => setIsVideoPlaying(false)}
            onEnded={() => setIsVideoPlaying(false)}
          />
          {!cameraActive && !videoFileUrl && (
            <div className="camera-placeholder">
              <div className="camera-placeholder-icon">📷</div>
              <p>Enable camera or upload a video to let Coach T watch</p>
            </div>
          )}
          <canvas ref={canvasRef} style={{ display: "none" }} />
          
          {/* Presenter PiP for screen recording demos */}
          <div className={`presenter-pip ${presenterActive && videoFileUrl ? 'active' : ''}`}>
             <video
               ref={presenterVideoRef}
               autoPlay
               playsInline
               muted
             />
          </div>

          <div className="video-panel-controls">
            <div className="source-controls">
              <button
                className={`camera-btn ${cameraActive ? "active" : ""}`}
                onClick={toggleCamera}
              >
                {cameraActive ? "📷 Stop Camera" : "📷 Live Camera"}
              </button>
              <div className="upload-wrapper">
                <input
                  type="file"
                  accept="video/*"
                  onChange={handleVideoUpload}
                  ref={fileInputRef}
                  id="video-upload"
                  className="hidden-file-input"
                />
                <label
                  htmlFor="video-upload"
                  className={`camera-btn ${videoFileUrl ? "active" : ""}`}
                >
                  {videoFileUrl ? "📁 Change Video" : "📁 Upload Video"}
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* ── Voice panel ── */}
        <div className="voice-panel">
          {/* Waveform visualizer — shown when coach speaks */}
          <div className="vis-area">
            {coachSpeaking && (
              <div className="voice-waveform">
                <span /><span /><span /><span /><span /><span /><span />
              </div>
            )}
          </div>

          {/* Central orb */}
          <div className={`orb-wrap ${orbState}`}>
            <div className="orb-ring ring-1" />
            <div className="orb-ring ring-2" />
            <div className="orb-ring ring-3" />
            <button
              className={`voice-orb ${orbState}`}
              onClick={toggleListening}
              disabled={!connected}
              aria-label={listening ? "Stop listening" : "Start speaking"}
            >
              <span className="orb-icon">{listening ? "■" : "🎙️"}</span>
            </button>
          </div>

          {/* Status + interim transcript */}
          <div className="voice-footer">
            <p className={`voice-label ${orbState}`}>{stateLabel}</p>
            {listening && input && (
              <p className="interim-text">"{input}"</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Debug panel ── */}
      {contextSummary && (
        <div className="debug-panel">
          <div className="debug-section">
            <p className="debug-label">CURRENT CONTEXT</p>
            <p className="debug-context">{contextSummary}</p>
          </div>
        </div>
      )}
    </div>
  );
}
