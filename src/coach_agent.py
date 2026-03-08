import asyncio
import os
import time
import base64
from dotenv import load_dotenv
from google import genai
import pyaudio

load_dotenv()

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
- When you can see a match image, FIRST describe what you see (formations, player positions, ball location), THEN give your tactical analysis.
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

FORMAT = pyaudio.paInt16
CHANNELS = 1
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024

pya = pyaudio.PyAudio()


def log(tag, msg):
    timestamp = time.strftime("%H:%M:%S")
    print(f"  [{timestamp}] [{tag}] {msg}")


def load_image(path):
    """Load image and return as base64 with mime type."""
    ext = path.lower().split(".")[-1]
    mime_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
    mime = mime_map.get(ext, "image/jpeg")
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return data, mime


async def main():
    print("\n⚽ Coach T — Live Football Tactical Coach (with Vision)")
    print("=" * 55)
    print(f"📡 Model: {MODEL}")
    print(f"🔊 Speaker: {pya.get_default_output_device_info()['name']}")
    print("\nConnecting...\n")

    speaker = pya.open(
        format=FORMAT, channels=CHANNELS,
        rate=RECEIVE_SAMPLE_RATE, output=True,
        frames_per_buffer=CHUNK_SIZE,
    )

    async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
        log("CONNECT", "✅ Connected to Gemini Live API")
        print()
        print("🎙️  Coach T is ready! (now with vision)")
        print()
        print("   Commands:")
        print("   - Type a question normally")
        print("   - Type 'img <path>' to send an image with your next question")
        print("   - Type 'quit' to end")
        print()
        print("   Example: img match.jpg What formation is the team in blue playing?")
        print()

        responses = 0
        current_image = None

        while True:
            try:
                text = await asyncio.to_thread(input, "  You: ")
            except EOFError:
                break

            if text.strip().lower() in ("quit", "exit", "q"):
                break
            if not text.strip():
                continue

            # Check for image command
            parts = []
            if text.strip().lower().startswith("img "):
                tokens = text.strip().split(" ", 2)
                if len(tokens) >= 2:
                    img_path = tokens[1]
                    question = tokens[2] if len(tokens) > 2 else "What do you see in this match? Analyze the tactics."

                    if os.path.exists(img_path):
                        img_data, img_mime = load_image(img_path)
                        parts.append({
                            "inline_data": {"data": img_data, "mime_type": img_mime}
                        })
                        log("IMG", f"📸 Loaded: {img_path} ({img_mime})")
                    else:
                        print(f"  ⚠️  File not found: {img_path}")
                        continue
                else:
                    question = text
            else:
                question = text

            parts.append({"text": question})

            await session.send_client_content(
                turns={"role": "user", "parts": parts},
                turn_complete=True,
            )

            chunks = 0
            async for message in session.receive():
                server = getattr(message, "server_content", None)
                if not server:
                    continue

                if server.model_turn:
                    for part in server.model_turn.parts:
                        if hasattr(part, "inline_data") and part.inline_data:
                            await asyncio.to_thread(speaker.write, part.inline_data.data)
                            chunks += 1
                            if chunks == 1:
                                log("COACH", "🗣️  Speaking...")

                        if hasattr(part, "text") and part.text:
                            text_preview = part.text.replace("\n", " ")[:100]
                            log("COACH", f"📝 {text_preview}")

                if server.turn_complete:
                    responses += 1
                    log("COACH", f"✅ Response #{responses} done")
                    print()
                    break

    speaker.close()


try:
    asyncio.run(main())
except KeyboardInterrupt:
    print("\n\n⚽ Session ended. Good chat, gaffer!")
except Exception as e:
    print(f"\nError: {e}")
finally:
    pya.terminate()