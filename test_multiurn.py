import asyncio
import os
from dotenv import load_dotenv
from google import genai
import pyaudio

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
CONFIG = {
    "response_modalities": ["AUDIO"],
    "system_instruction": "You are Coach T, a football tactical coach. Keep responses under 10 seconds.",
}

FORMAT = pyaudio.paInt16
CHANNELS = 1
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024
pya = pyaudio.PyAudio()

questions = [
    "Describe a 4-3-3 formation briefly.",
    "What are its main weaknesses?",
    "How would you exploit those weaknesses?",
]

async def main():
    speaker = pya.open(format=FORMAT, channels=CHANNELS,
                       rate=RECEIVE_SAMPLE_RATE, output=True,
                       frames_per_buffer=CHUNK_SIZE)

    async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
        print("Connected!\n")

        for i, question in enumerate(questions):
            print(f"--- Turn {i+1}: {question}")

            await session.send_client_content(
                turns={"role": "user", "parts": [{"text": question}]},
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
                            speaker.write(part.inline_data.data)
                            chunks += 1
                        if hasattr(part, "text") and part.text:
                            print(f"  📝 {part.text[:80]}")
                if server.turn_complete:
                    print(f"  ✅ Done ({chunks} audio chunks)\n")
                    break

    speaker.close()

asyncio.run(main())