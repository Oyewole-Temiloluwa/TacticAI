from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import asyncio
import os
import base64
import time
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="TacticAI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(
    api_key=os.getenv("GOOGLE_API_KEY"),
    http_options={"api_version": "v1alpha"},
)

AUDIO_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
CONTEXT_MODEL = "gemini-2.5-flash"

TIMELINE_CAP = 200  # Max key events stored per session

# ── Coach T persona ───────────────────────────────────────────────────────────
COACH_PERSONA = """You are Coach T — a world-class football tactical analyst and coach.

PERSONALITY:
- Confident but not arrogant. You speak like a top pundit who also coached at elite level.
- Passionate about the game. You get excited about clever tactical moves.
- Direct and concise. You give analysis in 2-3 sentences, not lectures.
- You use football terminology naturally: "back line", "pressing trigger", "half-spaces", "inverted fullback", "false 9", "double pivot".

BEHAVIOR:
- When asked about formations, describe the shape AND why it works in context.
- When asked about weaknesses, be specific about the gaps.
- Keep every response under 15 seconds of speech. Be punchy, not professorial.
- You receive a [MATCH TIMELINE] of key events and a [CURRENT SITUATION] with every question.
  Use the full timeline to answer questions about things that happened earlier in the match.
  Use the current situation to answer questions about what is happening right now.
- If the image is unclear, say so honestly.

WHAT YOU DO NOT DO:
- Never give long monologues. Short, sharp analysis.
- Never make up specific player names unless the user mentions them.
- Never break character. You ARE Coach T, always.
- Never use markdown formatting. No bold, no headers, no bullet points, no asterisks. Speak in plain, natural sentences as if talking out loud.
"""

# ── Context agent prompt ──────────────────────────────────────────────────────
CONTEXT_AGENT_PROMPT = """You are an elite football match analyst. You maintain two things simultaneously:
1. A live tactical picture of what is happening RIGHT NOW on the pitch.
2. A permanent timeline of significant match events that must never be lost.

═══════════════════════════════════════════
CURRENT SITUATION (previous):
{prev_context}

MATCH TIMELINE (already recorded — do NOT duplicate these):
{timeline_block}
═══════════════════════════════════════════

You have been given video frames of the current moment alongside the above context.

YOUR TWO TASKS:

TASK 1 — CURRENT SITUATION UPDATE:
Write 2-3 sentences describing the tactical picture RIGHT NOW. Cover:
- The current state of the match: is play active, is it pre-match rituals (anthems, handshakes, team photos, coin toss), or is there a break in play (injury, VAR review, hydration break, goal celebration)?
- Which team has the ball and what phase of play (attack / defence / transition / set-piece) IF play is active.
- The visible shape or formation of both teams if discernible.
- The key tactical dynamic or pressure point at this moment (or what the players/officials are doing during a break).
- Any immediate threat, opportunity, or positional pattern worth noting.
Be specific. Be factual. No speculation beyond what you can see or hear.

TASK 2 — KEY EVENT DECISION:
Decide if a new KEY EVENT should be permanently recorded in the match timeline.
Only record an event if it meets ONE OR MORE of these criteria:
  • Pre-match rituals concluded (kick-off imminent)
  • Goal scored or disallowed
  • Shot on target, save, or effort hitting the woodwork
  • Yellow card, red card, or penalty awarded
  • VAR review or overturned decision
  • Substitution with a tactical consequence
  • Formation or system change (e.g. 4-3-3 switching to 5-4-1)
  • Clear momentum shift — a team seizing or losing sustained control
  • Pressing trigger adopted or abandoned (high press on / off)
  • Defensive line shift (high line dropped, low block established)
  • Set piece in a dangerous area (corner, free kick within 30 yards)
  • Significant individual tactical moment (key interception, pressing trap sprung, defensive error leading to chance)
  • End of first half / second half
  • Injury or VAR review causing a significant delay or tactical shift

DO NOT record a KEY EVENT if:
  • Play is in normal flow with no notable change from the previous situation
  • The same event or pattern is already in the timeline above
  • It is a minor positional shuffle with no tactical significance
  • You are uncertain — only record what you are confident happened

═══════════════════════════════════════════
RESPOND IN EXACTLY THIS FORMAT — NO EXTRA TEXT, NO MARKDOWN, NO PREAMBLE:

CURRENT: <2-3 sentences describing the situation right now>
KEY_EVENT: <1 crisp sentence — what happened and its tactical significance> [OMIT THIS ENTIRE LINE if nothing significant occurred]
═══════════════════════════════════════════"""


# ── Per-connection state ──────────────────────────────────────────────────────
class ConnectionContext:
    """
    Two-tier memory per WebSocket session.
    - summary   : current tactical picture (overwritten each update)
    - timeline  : permanent append-only log of key match events (capped at TIMELINE_CAP)
    """
    def __init__(self):
        self.summary: str = ""
        self.timeline: list[str] = []
        self.session_start: float = time.time()
        self.frame_queue: asyncio.Queue = asyncio.Queue(maxsize=30)
        self.ui_update_queue: asyncio.Queue = asyncio.Queue(maxsize=20)  # pushes to frontend
        self.running: bool = True

    def elapsed(self) -> str:
        """Returns match elapsed time as MM:SS string."""
        secs = int(time.time() - self.session_start)
        return f"{secs // 60}:{secs % 60:02d}"

    def build_context_for_coach(self) -> str:
        """Builds the full context block injected into every Coach T question."""
        parts = []
        if self.timeline:
            entries = "\n".join(self.timeline)
            parts.append(f"[MATCH TIMELINE]:\n{entries}")
        if self.summary:
            parts.append(f"[CURRENT SITUATION]:\n{self.summary}")
        return "\n\n".join(parts)


# ── Context agent ─────────────────────────────────────────────────────────────
async def run_context_agent(state: ConnectionContext):
    """
    Fuses video frames into a two-tier memory:
      - state.summary  : current tactical picture (overwritten)
      - state.timeline : permanent append-only key event log
    Triggers periodically every 8 s from video alone.
    """
    frame_buffer: list[dict] = []
    UPDATE_INTERVAL = 8.0

    while state.running:
        await asyncio.sleep(UPDATE_INTERVAL)
        # Drain frame queue
        try:
            while True:
                frame_buffer.append(state.frame_queue.get_nowait())
        except asyncio.QueueEmpty:
            pass

        if not frame_buffer:
            continue

        frames_to_use = frame_buffer[-2:]
        frame_buffer.clear()

        try:
            parts = []

            # Video frames
            for f in frames_to_use:
                parts.append({
                    "inline_data": {
                        "mime_type": f["mime_type"],
                        "data": f["data"],
                    }
                })

            # Build prompt substitutions
            prev_context = state.summary or "Match just kicked off — no prior situation recorded."

            if state.timeline:
                timeline_block = "\n".join(state.timeline)
            else:
                timeline_block = "(No key events recorded yet)"

            parts.append({
                "text": CONTEXT_AGENT_PROMPT.format(
                    prev_context=prev_context,
                    timeline_block=timeline_block,
                )
            })

            response = await asyncio.to_thread(
                client.models.generate_content,
                model=CONTEXT_MODEL,
                contents=[{"parts": parts}],
            )

            raw = (response.text or "").strip()
            if not raw:
                continue

            # ── Parse the two-line response ───────────────────────────────────
            new_summary = ""
            key_event = ""

            for line in raw.splitlines():
                line = line.strip()
                if line.startswith("CURRENT:"):
                    new_summary = line[len("CURRENT:"):].strip()
                elif line.startswith("KEY_EVENT:"):
                    key_event = line[len("KEY_EVENT:"):].strip()

            # Update current situation
            if new_summary:
                state.summary = new_summary

            # Append key event to timeline (with timestamp, capped)
            if key_event and len(state.timeline) < TIMELINE_CAP:
                entry = f"[{state.elapsed()}] {key_event}"
                state.timeline.append(entry)
                print(f"[TIMELINE +] {entry}")

            # Logging
            sources = []
            if frames_to_use:
                sources.append(f"{len(frames_to_use)} frames")
            print(f"[CONTEXT] ({', '.join(sources)}) {state.summary[:120]}")
            print(f"[TIMELINE] {len(state.timeline)} events recorded")
            # Push summary to frontend debug panel
            try:
                state.ui_update_queue.put_nowait({"type": "context_update", "summary": state.summary})
            except asyncio.QueueFull:
                pass

        except Exception as e:
            print(f"[CONTEXT AGENT ERROR] {e}")


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "model": AUDIO_MODEL}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    print("[WS] Client connected")

    state = ConnectionContext()
    context_task = asyncio.create_task(run_context_agent(state))

    try:
        async with client.aio.live.connect(
            model=AUDIO_MODEL,
            config={"response_modalities": ["AUDIO"], "system_instruction": COACH_PERSONA},
        ) as session:
            print("[GEMINI] Connected to Live API")
            await ws.send_json({"type": "connected"})

            async def flush_ui_updates():
                """Drain context agent updates and send to frontend."""
                while True:
                    try:
                        msg = state.ui_update_queue.get_nowait()
                        await ws.send_json(msg)
                    except asyncio.QueueEmpty:
                        pass
                    await asyncio.sleep(1)

            async def receive_from_gemini():
                """Forward Coach T's audio responses to the browser."""
                while True:
                    async for message in session.receive():
                        server = getattr(message, "server_content", None)
                        if not server:
                            continue

                        if server.model_turn:
                            for part in server.model_turn.parts:
                                if hasattr(part, "inline_data") and part.inline_data:
                                    audio_b64 = base64.b64encode(
                                        part.inline_data.data
                                    ).decode("utf-8")
                                    await ws.send_json({"type": "audio", "data": audio_b64})

                                if hasattr(part, "text") and part.text:
                                    text = part.text.strip()
                                    # Skip thinking tokens (markdown-heavy blocks)
                                    if not text.startswith("**"):
                                        await ws.send_json({"type": "transcript", "text": text})

                        if server.turn_complete:
                            await ws.send_json({"type": "turn_complete"})
                            print("[GEMINI] Turn complete")

                        if server.interrupted:
                            await ws.send_json({"type": "interrupted"})

            async def receive_from_browser():
                """Route browser messages to the right destination."""
                while True:
                    data = await ws.receive_json()
                    msg_type = data.get("type")

                    if msg_type == "text":
                        text = data.get("text", "")
                        print(f"[USER] {text}")
                        context_block = state.build_context_for_coach()
                        full_prompt = f"{context_block}\n\n{text}" if context_block else text
                        await session.send_client_content(
                            turns={"role": "user", "parts": [{"text": full_prompt}]},
                            turn_complete=True,
                        )

                    elif msg_type == "text_with_image":
                        text = data.get("text", "Analyze this match frame.")
                        img_b64 = data.get("image", "")
                        img_mime = data.get("mime_type", "image/jpeg")
                        print(f"[USER] {text} (with image, {len(img_b64)} chars)")
                        context_block = state.build_context_for_coach()
                        full_text = f"{context_block}\n\n{text}" if context_block else text
                        await session.send_client_content(
                            turns={
                                "role": "user",
                                "parts": [
                                    {"inline_data": {"mime_type": img_mime, "data": img_b64}},
                                    {"text": full_text},
                                ],
                            },
                            turn_complete=True,
                        )

                    elif msg_type == "video_frame":
                        img_b64 = data.get("image", "")
                        img_mime = data.get("mime_type", "image/jpeg")
                        try:
                            state.frame_queue.put_nowait({"data": img_b64, "mime_type": img_mime})
                        except asyncio.QueueFull:
                            pass

            await asyncio.gather(
                receive_from_gemini(),
                receive_from_browser(),
                flush_ui_updates(),
            )

    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print(f"[ERROR] {e}")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
    finally:
        state.running = False
        context_task.cancel()
        try:
            await context_task
        except asyncio.CancelledError:
            pass


# ── Static frontend ───────────────────────────────────────────────────────────
app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")


@app.get("/{full_path:path}")
async def serve_frontend(full_path: str):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
