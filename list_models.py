import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

for model in client.models.list():
    if "live" in model.name.lower() or "native-audio" in model.name.lower():
        print(model.name)