import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

const WS_URL = "ws://localhost:8000/ws";

// Audio playback context
let audioCtx = null;
let nextStartTime = 0;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 24000 });
  }
  return audioCtx;
}

function playAudioChunk(base64Data) {
  const ctx = getAudioCtx();
  const raw = atob(base64Data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  // Convert 16-bit PCM to Float32
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

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
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [coachSpeaking, setCoachSpeaking] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [lastFrame, setLastFrame] = useState(null);

  const [listening, setListening] = useState(false);

  const wsRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const messagesEndRef = useRef(null);
  const recognitionRef = useRef(null);

  // Auto-scroll chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Connect WebSocket
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

        case "transcript":
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "coach" && !last.complete) {
              return [
                ...prev.slice(0, -1),
                { ...last, text: last.text + data.text },
              ];
            }
            return [...prev, { role: "coach", text: data.text, complete: false }];
          });
          break;

        case "turn_complete":
          setCoachSpeaking(false);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "coach") {
              return [...prev.slice(0, -1), { ...last, complete: true }];
            }
            return prev;
          });
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

    ws.onclose = () => {
      setConnected(false);
      console.log("[WS] Disconnected");
    };

    return () => ws.close();
  }, []);

  // Camera toggle
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

  // Capture current camera frame
  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, 640, 480);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    const base64 = dataUrl.split(",")[1];
    setLastFrame(dataUrl);
    return base64;
  }, []);

  // Speech recognition toggle
  const toggleListening = useCallback(() => {
    console.log("[MIC] toggleListening called, listening =", listening);

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser. Try Chrome or Edge.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setListening(true);
      if (coachSpeaking) {
        stopAudioPlayback();
        setCoachSpeaking(false);
      }
    };

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(transcript);

      if (event.results[event.results.length - 1].isFinal) {
        const text = transcript.trim();
        if (!text || !wsRef.current) return;

        setInput("");

        if (coachSpeaking) {
          stopAudioPlayback();
          setCoachSpeaking(false);
        }

        let frame = null;
        if (cameraActive) {
          frame = captureFrame();
        }

        setMessages((prev) => [
          ...prev,
          { role: "user", text, image: frame ? lastFrame : null },
        ]);

        if (frame) {
          wsRef.current.send(
            JSON.stringify({
              type: "text_with_image",
              text,
              image: frame,
              mime_type: "image/jpeg",
            })
          );
        } else {
          wsRef.current.send(JSON.stringify({ type: "text", text }));
        }
      }
    };

    recognition.onend = () => setListening(false);

    recognition.onerror = (e) => {
      console.error("[MIC] Error:", e.error);
      if (e.error === "not-allowed") {
        alert("Microphone permission denied. Please allow mic access and try again.");
      } else if (e.error === "network") {
        alert("Speech recognition network error. Check your internet connection.");
      }
      setListening(false);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch (err) {
      console.error("[MIC] Failed to start:", err);
      setListening(false);
    }
  }, [listening, coachSpeaking, cameraActive, captureFrame, lastFrame]);

  // Send message
  const sendMessage = useCallback(() => {
    if (!input.trim() || !wsRef.current) return;

    const text = input.trim();
    setInput("");

    // Stop coach if speaking
    if (coachSpeaking) {
      stopAudioPlayback();
      setCoachSpeaking(false);
    }

    // Capture frame if camera is active
    let frame = null;
    if (cameraActive) {
      frame = captureFrame();
    }

    // Add user message to chat
    setMessages((prev) => [
      ...prev,
      { role: "user", text, image: frame ? lastFrame : null },
    ]);

    // Send to backend
    if (frame) {
      wsRef.current.send(
        JSON.stringify({
          type: "text_with_image",
          text,
          image: frame,
          mime_type: "image/jpeg",
        })
      );
    } else {
      wsRef.current.send(JSON.stringify({ type: "text", text }));
    }
  }, [input, cameraActive, coachSpeaking, captureFrame, lastFrame]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

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
            {connected ? "● Connected" : "● Disconnected"}
          </span>
        </div>
      </header>

      <div className="main">
        {/* Video panel */}
        <div className="video-panel">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={cameraActive ? "active" : "hidden"}
          />
          {!cameraActive && (
            <div className="camera-placeholder">
              <p>📷 Camera off</p>
              <p>Enable camera to let Coach T see the match</p>
            </div>
          )}
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <button
            className={`camera-btn ${cameraActive ? "active" : ""}`}
            onClick={toggleCamera}
          >
            {cameraActive ? "📷 Camera On" : "📷 Enable Camera"}
          </button>
        </div>

        {/* Chat panel */}
        <div className="chat-panel">
          <div className="messages">
            {messages.length === 0 && (
              <div className="welcome">
                <h2>👋 Hey! I'm Coach T.</h2>
                <p>Ask me anything about football tactics.</p>
                <p>Turn on the camera to show me a match!</p>
                <div className="suggestions">
                  <button onClick={() => setInput("What formation beats a 4-3-3?")}>
                    What beats a 4-3-3?
                  </button>
                  <button onClick={() => setInput("Explain gegenpressing to me")}>
                    Explain gegenpressing
                  </button>
                  <button onClick={() => setInput("How do I break a low block?")}>
                    Breaking a low block
                  </button>
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <div className="message-header">
                  {msg.role === "coach" ? "🏆 Coach T" : "You"}
                </div>
                {msg.image && (
                  <img src={msg.image} alt="Match frame" className="msg-image" />
                )}
                <div className="message-text">{msg.text}</div>
              </div>
            ))}

            {coachSpeaking && (
              <div className="message coach speaking">
                <div className="message-header">🏆 Coach T</div>
                <div className="speaking-indicator">
                  <span></span><span></span><span></span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="input-area">
            <button
              className={`mic-btn ${listening ? "active" : ""}`}
              onClick={toggleListening}
              disabled={!connected}
            >
              {listening ? "🔴" : "🎙️"}
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                listening
                  ? "Listening..."
                  : connected
                  ? "Ask Coach T about tactics..."
                  : "Connecting..."
              }
              disabled={!connected}
            />
            <button onClick={sendMessage} disabled={!connected || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}