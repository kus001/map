from os import getenv

from dotenv import load_dotenv
from openrouter import OpenRouter

load_dotenv()

API_KEY = getenv("OPEN_ROUTER_KEY", None)
URL     = getenv("OPEN_ROUTER_URL", "https://openrouter.ai")

client = OpenRouter(
    api_key=API_KEY,
    server_url="https://ai.hackclub.com/proxy/v1",
)

def ask(content="Tell me a joke.", model="anthropic/claude-haiku-5.5", role="user"):
    return client.chat.send(
        model=model,
        messages=[
            {"role": role, "content": content}
        ],
        stream=False,
    ).choices[0].message.content

if __name__ == '__main__':
    print(ask("wassup claude"))
