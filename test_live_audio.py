import asyncio
import os
import base64
from dotenv import load_dotenv
from google import genai
import pyaudio

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
CONFIG = {
    "response_modalities": ["AUDIO"],
    "system_instruction": "You are Coach T, a veteran football tactical coach. Keep responses short."
}

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024

pya = pyaudio.PyAudio()

async def main():
    # List audio devices so we can verify mic works
    print("Available input devices:")
    for i in range(pya.get_device_count()):
        info = pya.get_device_info_by_index(i)
        if info["maxInputChannels"] > 0:
            print(f"  [{i}] {info['name']}")
    print()

    print("Connecting to Coach T...")

    async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
        print("Connected! Speak now...\n")

        audio_queue = asyncio.Queue()
        sending = True

        async def play_audio():
            stream = pya.open(format=FORMAT, channels=CHANNELS,
                            rate=RECEIVE_SAMPLE_RATE, output=True,
                            frames_per_buffer=CHUNK_SIZE)
            while True:
                data = await audio_queue.get()
                stream.write(data)

        async def send_audio():
            stream = pya.open(format=FORMAT, channels=CHANNELS,
                            rate=SEND_SAMPLE_RATE, input=True,
                            frames_per_buffer=CHUNK_SIZE)
            chunks_sent = 0
            while sending:
                try:
                    data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                    await session.send_realtime_input(
                        audio={"data": data, "mime_type": f"audio/pcm;rate={SEND_SAMPLE_RATE}"}
                    )
                    chunks_sent += 1
                    if chunks_sent % 50 == 0:
                        print(f"  [Sending audio... {chunks_sent} chunks]")
                except Exception as e:
                    print(f"Send error: {e}")
                    break
                await asyncio.sleep(0.01)

        async def receive_audio():
            async for message in session.receive():
                server = getattr(message, "server_content", None)
                if server:
                    if server.model_turn:
                        for part in server.model_turn.parts:
                            if hasattr(part, "inline_data") and part.inline_data:
                                print("  [Coach T is speaking...]")
                                await audio_queue.put(part.inline_data.data)
                    if server.turn_complete:
                        print("  [Coach T finished speaking]")

        await asyncio.gather(
            send_audio(),
            receive_audio(),
            play_audio()
        )

try:
    asyncio.run(main())
except KeyboardInterrupt:
    print("\nSession ended.")
finally:
    pya.terminate()