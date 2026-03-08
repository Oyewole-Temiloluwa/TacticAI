import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))

response = client.models.generate_content(
    model="gemini-2.5-flash",
    contents="You are a football tactical coach. What formation would you recommend against a team that plays 4-3-3 with high pressing?"
)

print(response.text)