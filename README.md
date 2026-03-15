# TacticAI — Live Football Tactical Coach

TacticAI is a real-time football tactical coaching web application built for the **Gemini Live Agent Challenge** hackathon. Point a camera at a live match (or upload a video), and an AI coach named **Coach T** watches continuously, listens to broadcast commentary, and responds to your voice questions with spoken tactical analysis — identifying formations, spotting defensive weaknesses, and suggesting adjustments on the fly.

---

## Table of Contents

1. [Demo & Features](#demo--features)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Frontend](#frontend)
5. [Backend](#backend)
6. [Environment Variables](#environment-variables)
7. [Local Development](#local-development)
8. [Deployment to Google Cloud Run](#deployment-to-google-cloud-run)

---

## Demo & Features

- **Live camera or video upload** — stream frames directly from your device camera or analyse a recorded match
- **Continuous visual context** — video frames are sent every 8 seconds and fused into a rolling tactical summary
- **Voice interaction** — tap the mic button to ask Coach T a question; it responds in spoken audio
- **Presenter Camera** — fixed circular PiP webcam view shows the presenter's face during demo screen recordings (only active during video file playback)
- **Automatic context fusion** — visual frames are automatically analysed by the Context Agent to give Coach T situational awareness

---

## Architecture

TacticAI uses a **two-agent architecture** to separate context-building from response generation. This is the key design decision that makes reliable audio responses possible.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser (React)                            │
│                                                                     │
│  Camera/Video ──► video frames (every 8s) ──────────────────────┐  │
│  User Voice ────► tap-to-talk button ───────► text + snapshot ──┤  │
│                                                                  │  │
│  Coach T audio ◄── base64 PCM chunks ◄──────────────────────────┘  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ WebSocket /ws
┌──────────────────────────────▼──────────────────────────────────────┐
│                        FastAPI Backend                              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Context Agent                            │   │
│  │   Model: gemini-2.5-flash (generate_content, non-live)      │   │
│  │                                                             │   │
│  │   Inputs:                                                   │   │
│  │   • Video frames ──► asyncio.Queue (capped at 30)          │   │
│  │                                                             │   │
│  │   Update: 8-second periodic fusion timer                   │   │
│  │                                                             │   │
│  │   Output: state.summary (plain-text tactical context)       │   │
│  └─────────────────────────┬───────────────────────────────────┘   │
│                            │ state.summary injected                 │
│  ┌─────────────────────────▼───────────────────────────────────┐   │
│  │                    Coach T (Live Session)                   │   │
│  │   Model: gemini-2.5-flash-native-audio-preview              │   │
│  │                                                             │   │
│  │   Receives ONLY:                                            │   │
│  │   • [MATCH CONTEXT]: {state.summary}                        │   │
│  │   • User's question (text)                                  │   │
│  │   • Optional: current frame snapshot                        │   │
│  │                                                             │   │
│  │   Output: native audio (PCM 24kHz) streamed to browser      │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Why Two Agents?

The Gemini native audio model (`gemini-2.5-flash-native-audio-preview`) produces its best audio responses when its Live session is clean — receiving only explicit conversational turns. When continuous video frames were streamed directly into the Live session, the model entered a "thinking/context" mode, emitting internal reasoning text but never generating audio output. Separating concerns fixes this completely:

| Agent | Model | Role | Input | Output |
|---|---|---|---|---|
| Context Agent | `gemini-2.5-flash` | Perception | Video frames | Plain-text tactical summary |
| Coach T | `gemini-2.5-flash-native-audio-preview` | Response | Summary + user question | Spoken audio |

### Context Agent — How It Works

The context agent runs as a background `asyncio.Task` per WebSocket connection.

1. **Video frames** arrive every 8 seconds from the browser and are placed into an `asyncio.Queue` (capped at 30 frames to prevent memory growth)
2. The agent runs a periodic loop every 8 seconds
3. On each update it takes the last 2 frames, sends them to `gemini-2.5-flash`, and stores the returned 2-3 sentence summary in `state.summary`

### Coach T — How It Works

Coach T lives inside a `client.aio.live.connect()` session (Gemini Live API) for the duration of the WebSocket connection. It never receives video frames or raw commentary. Every time the user asks a question, the backend prepends the latest context summary:

```
[MATCH CONTEXT]: Red team in a 4-3-3 pressing high, white team struggling
to play out from the back. Wide channels are overloaded on the left flank.

<user question>
```

This gives Coach T full situational awareness without polluting the Live session with streaming video data.

---

## Project Structure

```
TacticAI/
├── frontend/                   # Vite + React application
│   ├── src/
│   │   ├── App.jsx             # Main component — all UI and WebSocket logic
│   │   ├── App.css             # Component styles
│   │   └── index.css           # Global styles
│   ├── public/
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
├── backend/
│   ├── server.py               # FastAPI app — WebSocket, context agent, Coach T
│   ├── requirements.txt        # Python dependencies
│   ├── Dockerfile              # Container definition
│   ├── .env                    # Local secrets (never committed)
│   └── static/                 # Built frontend (copied here before deploy)
│       ├── index.html
│       └── assets/
│
└── README.md
```

---

## Frontend

Built with **React (Vite)**. All application logic lives in `App.jsx`. There are no external React libraries — it uses only browser-native APIs.

### Key Systems

#### WebSocket Connection
Connects to `ws://localhost:8000/ws` locally and `wss://<hostname>/ws` in production (auto-detected from `window.location.hostname`). Handles four message types from the server: `connected`, `audio`, `turn_complete`, `interrupted`.

#### Video Frame Streaming
A `setInterval` running every 8 seconds captures the current video frame to a hidden `<canvas>`, encodes it as JPEG at 50% quality, and sends it as a `video_frame` WebSocket message. Supports both live camera (`getUserMedia`) and uploaded video files.

#### Audio Playback Engine
A custom sequential audio engine buffers PCM chunks from the server and plays them back in order using the Web Audio API at 24kHz. The `nextStartTime` cursor ensures chunks are scheduled back-to-back without gaps or overlaps.

#### Tap-to-Talk Interaction
No background wake-word listeners are used to maximize audio reliability. Users interact with Coach T by holding the central mic orb. While the orb is active, the browser uses `SpeechRecognition` to capture the prompt.

#### Presenter Camera (Demo Mode)
To assist with demo screen recordings, the app includes a **Presenter Camera**. When a video file is uploaded, the browser automatically activates the user's front-facing camera and displays it in a stylized circular "picture-in-picture" view fixed to the top-right of the screen. This allows the presenter to be visible while explaining the tactical analysis of the recorded footage. This feature is automatically disabled when using the Live Camera source.

---

## Backend

Built with **FastAPI** and **Python asyncio**. The single `/ws` WebSocket endpoint manages the full lifecycle of a coaching session.

### Dependencies (`requirements.txt`)

```
fastapi
uvicorn[standard]
websockets
python-dotenv
google-genai
```

### Message Protocol

| Direction | Type | Payload | Description |
|---|---|---|---|
| Browser → Server | `video_frame` | `image` (base64 JPEG), `mime_type` | Continuous frame for context agent |
| Browser → Server | `text` | `text` | Voice question (text only) |
| Browser → Server | `text_with_image` | `text`, `image`, `mime_type` | Voice question + current frame snapshot |
| Server → Browser | `connected` | — | Session ready |
| Server → Browser | `audio` | `data` (base64 PCM) | Coach T audio chunk |
| Server → Browser | `transcript` | `text` | Coach T text transcript |
| Server → Browser | `turn_complete` | — | Coach T finished speaking |
| Server → Browser | `interrupted` | — | Turn was interrupted |
| Server → Browser | `error` | `message` | Server-side error |

### Concurrency Model

Each WebSocket connection runs two concurrent coroutines via `asyncio.gather`:
- `receive_from_gemini()` — streams audio chunks from the Live session to the browser
- `receive_from_browser()` — routes browser messages to the context agent queue or Live session

A third `asyncio.Task` (`run_context_agent`) runs independently and updates `state.summary` without blocking either coroutine.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_API_KEY` | Yes | Gemini API key from [aistudio.google.com](https://aistudio.google.com) |

Create a `.env` file in the `backend/` directory:

```env
GOOGLE_API_KEY=your_api_key_here
```

**Never commit this file.** Add `.env` to `.gitignore`.

To get an API key:
1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API Key** → **Create API key**
3. Select your GCP project (`tacticai-coach` or equivalent)
4. Copy the key into `.env`

> Note: TacticAI uses the Gemini API directly via API key — not Vertex AI authentication. The `GOOGLE_API_KEY` is passed to the `genai.Client` and authorises both the Live API session and the `generate_content` calls for the context agent.

---

## Local Development

### Prerequisites

- Python 3.10+
- Node.js 18+
- A Gemini API key (see above)

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python server.py
# Server starts at http://localhost:8000 with hot-reload enabled
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# Vite dev server starts at http://localhost:5173
```

Open `http://localhost:5173` in Chrome or Edge (required for Web Speech API support).

---

## Deployment to Google Cloud Run

TacticAI deploys as a **single container** — the FastAPI backend serves both the API and the pre-built React frontend as static files. No separate frontend hosting is needed.

### 1. GCP Console — Enable APIs

In the [Google Cloud Console](https://console.cloud.google.com) under **APIs & Services → Library**, enable:

- Vertex AI API
- Cloud Run Admin API
- Cloud Firestore API
- Artifact Registry API

During the first deployment, `gcloud` will also prompt you to enable:
- Cloud Build API
- Create an Artifact Registry Docker repository in `us-central1`

Accept both prompts.

### 2. Authenticate and Configure gcloud

```bash
gcloud auth login
gcloud config set project tacticai-coach
gcloud config set run/region us-central1
```

### 3. Build the Frontend

```bash
cd frontend
npm install
npm run build
```

This produces a `frontend/dist/` directory with the compiled static files.

### 4. Copy Static Files to Backend

```bash
# From the project root
cp -r frontend/dist/* backend/static/
```

The `backend/static/` folder must contain `index.html` and the `assets/` subdirectory before deployment.

### 5. Dockerfile

The `backend/Dockerfile` should contain:

```dockerfile
FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
```

> Note: Cloud Run uses port **8080** by default. The local dev server uses 8000. The `uvicorn` command in the Dockerfile should always target 8080.

### 6. Deploy to Cloud Run

```bash
cd backend
gcloud run deploy tacticai \
  --source . \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_API_KEY=your_api_key_here" \
  --port=8080 \
  --region=us-central1
```

This command:
1. Uploads the source to **Cloud Build** (no local Docker required)
2. Builds the container image remotely
3. Stores the image in **Artifact Registry**
4. Deploys it to **Cloud Run** and returns a public `https://` URL

### 7. Redeploy After Changes

Whenever you change frontend or backend code:

```bash
# 1. Rebuild frontend
cd frontend && npm run build

# 2. Copy to backend/static
cp -r dist/* ../backend/static/

# 3. Redeploy
cd ../backend
gcloud run deploy tacticai \
  --source . \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_API_KEY=your_api_key_here" \
  --port=8080 \
  --region=us-central1
```

### WebSocket URL — Local vs Production

The frontend automatically selects the correct WebSocket URL:

```js
const WS_URL =
  window.location.hostname === "localhost"
    ? "ws://localhost:8000/ws"
    : `wss://${window.location.hostname}/ws`;
```

In production the Cloud Run service serves both static files and the WebSocket from the same hostname, so `wss://<your-service>.run.app/ws` works without any additional configuration.

---

## Browser Support

Web Speech API (`SpeechRecognition`) is required for voice input and wake word detection.

| Browser | Supported |
|---|---|
| Chrome | Yes |
| Edge | Yes |
| Firefox | No |
| Safari | Partial (no wake word) |

Use **Chrome** or **Edge** for the full experience.
