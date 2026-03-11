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

// ── Component ─────────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [coachSpeaking, setCoachSpeaking] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [lastFrame, setLastFrame] = useState(null);
  const [listening, setListening] = useState(false);
  const [commentaryActive, setCommentaryActive] = useState(false);
  const [commentaryDevices, setCommentaryDevices] = useState([]);
  const [selectedCommentaryDevice, setSelectedCommentaryDevice] = useState("");
  const [awaitingPrompt, setAwaitingPrompt] = useState(false);

  const wsRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const recognitionRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const commentaryStreamRef = useRef(null);
  const commentaryRecorderRef = useRef(null);
  const wakeWordRef = useRef(null);
  // Mirror refs for closures
  const coachSpeakingRef = useRef(false);
  const commentaryActiveRef = useRef(false);
  const awaitingPromptRef = useRef(false);
  const cameraActiveRef = useRef(false);
  const lastFrameRef = useRef(null);
  const connectedRef = useRef(false);

  useEffect(() => { coachSpeakingRef.current = coachSpeaking; }, [coachSpeaking]);
  useEffect(() => { cameraActiveRef.current = cameraActive; }, [cameraActive]);
  useEffect(() => { lastFrameRef.current = lastFrame; }, [lastFrame]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  // ── Device enumeration: request permission first so labels are visible ──────
  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((devices) =>
        setCommentaryDevices(devices.filter((d) => d.kind === "audioinput"))
      )
      .catch(() => {
        navigator.mediaDevices
          ?.enumerateDevices()
          .then((devices) =>
            setCommentaryDevices(devices.filter((d) => d.kind === "audioinput"))
          );
      });
  }, []);

  // ── Continuous frame streaming ───────────────────────────────────────────────
  useEffect(() => {
    if (cameraActive && connected) {
      frameIntervalRef.current = setInterval(() => {
        if (!videoRef.current || !canvasRef.current || !wsRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = 640;
        canvas.height = 480;
        canvas.getContext("2d").drawImage(videoRef.current, 0, 0, 640, 480);
        const base64 = canvas.toDataURL("image/jpeg", 0.5).split(",")[1];
        wsRef.current.send(
          JSON.stringify({ type: "video_frame", image: base64, mime_type: "image/jpeg" })
        );
      }, 3000);
    } else {
      clearInterval(frameIntervalRef.current);
    }
    return () => clearInterval(frameIntervalRef.current);
  }, [cameraActive, connected]);

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
        case "error":
          console.error("[ERROR]", data.message);
          break;
      }
    };

    ws.onclose = () => { setConnected(false); console.log("[WS] Disconnected"); };
    return () => ws.close();
  }, []);

  // ── Camera ───────────────────────────────────────────────────────────────────
  const toggleCamera = useCallback(async () => {
    if (cameraActive) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setCameraActive(false);
      setLastFrame(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: 640, height: 480 },
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraActive(true);
    } catch (err) {
      console.error("Camera error:", err);
    }
  }, [cameraActive]);

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    canvas.width = 640;
    canvas.height = 480;
    canvas.getContext("2d").drawImage(videoRef.current, 0, 0, 640, 480);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    setLastFrame(dataUrl);
    return dataUrl.split(",")[1];
  }, []);

  // ── Send prompt ──────────────────────────────────────────────────────────────
  const sendVoicePrompt = useCallback(
    (text) => {
      if (!text.trim() || !wsRef.current) return;
      if (coachSpeakingRef.current) { stopAudioPlayback(); setCoachSpeaking(false); }
      const frame = cameraActiveRef.current ? captureFrame() : null;
      if (frame) {
        wsRef.current.send(
          JSON.stringify({ type: "text_with_image", text: text.trim(), image: frame, mime_type: "image/jpeg" })
        );
      } else {
        wsRef.current.send(JSON.stringify({ type: "text", text: text.trim() }));
      }
    },
    [captureFrame]
  );

  // ── Wake word listener ────────────────────────────────────────────────────────
  const startWakeWordListener = useCallback(() => {
    if (wakeWordRef.current) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || !connectedRef.current) return;

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";

    rec.onresult = (event) => {
      if (coachSpeakingRef.current) return;
      const transcript = event.results[event.results.length - 1][0].transcript.trim();
      const lower = transcript.toLowerCase();

      if (awaitingPromptRef.current) {
        awaitingPromptRef.current = false;
        setAwaitingPrompt(false);
        sendVoicePrompt(transcript);
        return;
      }

      if (lower.includes("hey coach")) {
        const idx = lower.indexOf("hey coach");
        const after = transcript.slice(idx + 9).replace(/^[\s,t]+/i, "").trim();
        if (after.length > 2) sendVoicePrompt(after);
        else { awaitingPromptRef.current = true; setAwaitingPrompt(true); }
      }
    };

    rec.onend = () => {
      wakeWordRef.current = null;
      if (connectedRef.current && !coachSpeakingRef.current)
        setTimeout(() => startWakeWordListener(), 300);
    };

    rec.onerror = (e) => {
      if (e.error !== "no-speech") console.error("[WAKE] Error:", e.error);
      wakeWordRef.current = null;
    };

    try { rec.start(); wakeWordRef.current = rec; } catch { wakeWordRef.current = null; }
  }, [sendVoicePrompt]);

  // Start wake word listener as soon as we're connected
  useEffect(() => {
    if (connected) startWakeWordListener();
    else { wakeWordRef.current?.stop(); wakeWordRef.current = null; }
  }, [connected, startWakeWordListener]);

  // Restart wake word after coach finishes speaking
  useEffect(() => {
    if (!coachSpeaking) startWakeWordListener();
  }, [coachSpeaking, startWakeWordListener]);

  // ── Commentary ───────────────────────────────────────────────────────────────
  const toggleCommentary = useCallback(async () => {
    if (commentaryActive) {
      commentaryRecorderRef.current?.stop();
      commentaryStreamRef.current?.getTracks().forEach((t) => t.stop());
      commentaryRecorderRef.current = null;
      commentaryStreamRef.current = null;
      wakeWordRef.current?.stop();
      wakeWordRef.current = null;
      commentaryActiveRef.current = false;
      awaitingPromptRef.current = false;
      setCommentaryActive(false);
      setAwaitingPrompt(false);
      return;
    }

    if (!selectedCommentaryDevice) {
      alert("Select a commentary microphone first.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: selectedCommentaryDevice } },
      });
      commentaryStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      commentaryRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0 || coachSpeakingRef.current || !wsRef.current) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(",")[1];
          wsRef.current?.send(
            JSON.stringify({ type: "commentary_chunk", data: base64, mime_type: e.data.type || mimeType })
          );
        };
        reader.readAsDataURL(e.data);
      };

      recorder.start(5000);
      commentaryActiveRef.current = true;
      setCommentaryActive(true);
      startWakeWordListener();
    } catch (err) {
      console.error("[COMMENTARY] Error:", err);
      alert("Could not access the selected microphone.");
    }
  }, [commentaryActive, selectedCommentaryDevice, startWakeWordListener]);

  // ── Mic button ───────────────────────────────────────────────────────────────
  const toggleListening = useCallback(() => {
    if (listening) { recognitionRef.current?.stop(); return; }

    if (wakeWordRef.current) { wakeWordRef.current.stop(); wakeWordRef.current = null; }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Speech recognition not supported. Use Chrome or Edge."); return; }

    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      setListening(true);
      if (coachSpeakingRef.current) { stopAudioPlayback(); setCoachSpeaking(false); }
    };

    rec.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++)
        transcript += event.results[i][0].transcript;
      setInput(transcript);

      if (event.results[event.results.length - 1].isFinal) {
        const text = transcript.trim();
        if (!text) return;
        setInput("");
        rec.stop();
        sendVoicePrompt(text);
      }
    };

    rec.onend = () => {
      setListening(false);
      startWakeWordListener();
    };

    rec.onerror = (e) => {
      console.error("[MIC] Error:", e.error);
      if (e.error === "not-allowed") alert("Microphone permission denied.");
      setListening(false);
    };

    recognitionRef.current = rec;
    try { rec.start(); } catch (err) { console.error("[MIC] Failed:", err); setListening(false); }
  }, [listening, sendVoicePrompt, startWakeWordListener]);

  // ── Derive UI state label ─────────────────────────────────────────────────────
  const stateLabel = !connected
    ? "Connecting…"
    : coachSpeaking
    ? "Coach T is speaking"
    : listening
    ? "Listening…"
    : awaitingPrompt
    ? "Say your question…"
    : 'Say "Hey Coach" or tap';

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
          {cameraActive && connected && <div className="streaming-badge">LIVE</div>}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={cameraActive ? "active" : "hidden"}
          />
          {!cameraActive && (
            <div className="camera-placeholder">
              <div className="camera-placeholder-icon">📷</div>
              <p>Enable camera to let Coach T watch the match live</p>
            </div>
          )}
          <canvas ref={canvasRef} style={{ display: "none" }} />

          <div className="video-panel-controls">
            <button
              className={`camera-btn ${cameraActive ? "active" : ""}`}
              onClick={toggleCamera}
            >
              {cameraActive ? "📷 Camera On" : "📷 Enable Camera"}
            </button>
            <div className="commentary-controls">
              <select
                className="device-select"
                value={selectedCommentaryDevice}
                onChange={(e) => setSelectedCommentaryDevice(e.target.value)}
                disabled={commentaryActive}
              >
                <option value="">Commentary mic…</option>
                {commentaryDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Mic (${d.deviceId.slice(0, 6)})`}
                  </option>
                ))}
              </select>
              <button
                className={`commentary-btn ${commentaryActive ? "active" : ""}`}
                onClick={toggleCommentary}
                disabled={!connected}
              >
                {commentaryActive ? "🔊 On" : "🔊 Off"}
              </button>
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
    </div>
  );
}
