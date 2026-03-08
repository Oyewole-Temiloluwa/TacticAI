import asyncio
import os
import json
import base64
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai

load_dotenv()

app = FastAPI(title="TacticAI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

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
- When you can see a match image, FIRST describe what you see, THEN give tactical analysis.
- If the image is unclear, say so honestly.

CONTEXT AWARENESS:
- Track the flow of conversation. Remember what was discussed.
- Build on previous observations.
- If someone shares score or time info, factor it into tactical advice.

WHAT YOU DO NOT DO:
- Never give long monologues. Short, sharp analysis.
- Never make up specific player names unless the user mentions them.
- Never break character. You ARE Coach T, always.
"""

CONFIG = {
    "response_modalities": ["AUDIO"],
    "system_instruction": COACH_PERSONA,
}


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    print("[WS] Client connected")

    try:
        async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
            print("[GEMINI] Connected to Live API")
            await ws.send_json({"type": "connected"})

            async def receive_from_gemini():
                """Receive audio/text from Gemini and forward to browser."""
                while True:
                    async for message in session.receive():
                        server = getattr(message, "server_content", None)
                        if not server:
                            continue

                        if server.model_turn:
                            for part in server.model_turn.parts:
                                # Audio chunk -> send as base64 to browser
                                if hasattr(part, "inline_data") and part.inline_data:
                                    audio_b64 = base64.b64encode(part.inline_data.data).decode("utf-8")
                                    await ws.send_json({
                                        "type": "audio",
                                        "data": audio_b64,
                                    })

                                # Text transcript
                                if hasattr(part, "text") and part.text:
                                    await ws.send_json({
                                        "type": "transcript",
                                        "text": part.text,
                                    })

                        if server.turn_complete:
                            await ws.send_json({"type": "turn_complete"})
                            print("[GEMINI] Turn complete")

                        if server.interrupted:
                            await ws.send_json({"type": "interrupted"})

            async def receive_from_browser():
                """Receive text/images from browser and forward to Gemini."""
                while True:
                    data = await ws.receive_json()
                    msg_type = data.get("type")

                    if msg_type == "text":
                        # Text-only message
                        text = data.get("text", "")
                        print(f"[USER] {text}")
                        await session.send_client_content(
                            turns={"role": "user", "parts": [{"text": text}]},
                            turn_complete=True,
                        )

                    elif msg_type == "text_with_image":
                        text = data.get("text", "Analyze this match frame.")
                        img_b64 = data.get("image", "")
                        img_mime = data.get("mime_type", "image/jpeg")
                        print(f"[USER] {text} (with image, {len(img_b64)} chars)")

                        # Send image and text together in one turn
                        await session.send_client_content(
                            turns={
                                "role": "user",
                                "parts": [
                                    {"inline_data": {"mime_type": img_mime, "data": img_b64}},
                                    {"text": text},
                                ],
                            },
                            turn_complete=True,
                        )

                    elif msg_type == "image_frame":
                        # Camera frame sent as realtime input (for continuous video)
                        img_data = data.get("image", "")
                        img_mime = data.get("mime_type", "image/jpeg")
                        await session.send_realtime_input(
                            media_chunks=[{"data": base64.b64decode(img_data), "mime_type": img_mime}]
                        )

            await asyncio.gather(
                receive_from_gemini(),
                receive_from_browser(),
            )

    except WebSocketDisconnect:
        print("[WS] Client disconnected")
    except Exception as e:
        print(f"[ERROR] {e}")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)