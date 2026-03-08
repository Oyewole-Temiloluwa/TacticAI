import asyncio
import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

model = "gemini-2.5-flash"

config = {
    "response_modalities": ["TEXT"],
    "system_instruction": "You are Coach T, a veteran football tactical coach. You speak confidently and use football terminology naturally."
}

async def main():
    async with client.aio.live.connect(model=model, config=config) as session:
        print("Connected to Live API!")
        
        await session.send_client_content(
            turns={"role": "user", "parts": [{"text": "What's the best way to beat a high press?"}]}
        )
        
        response_text = ""
        async for message in session.receive():
            if hasattr(message, "server_content") and message.server_content:
                if message.server_content.model_turn:
                    for part in message.server_content.model_turn.parts:
                        if hasattr(part, "text") and part.text:
                            response_text += part.text
                if message.server_content.turn_complete:
                    break
        
        print(f"\nCoach T says:\n{response_text}")

asyncio.run(main())