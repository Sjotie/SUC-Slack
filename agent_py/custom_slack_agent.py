import os
from dotenv import load_dotenv
load_dotenv()  # Load environment variables first

import openai
# Allow OPENAI_BASE_URL from .env to override the default.
# The OpenAI library reads env vars automatically, but setting it
# explicitly makes local/debug runs fool-proof.
if os.getenv("OPENAI_BASE_URL"):
    openai.base_url = os.environ["OPENAI_BASE_URL"]

# ------------------------------------------------------------------
# Geminis OpenAI-compatible endpoint supports *chat completions*,
# not the newer *responses* API that the Agents SDK defaults to.
# Tell the SDK to use chat-completions globally and turn off tracing
# (otherwise it tries to upload traces with a real OpenAI key and
# shows the 401 youre seeing).
# ------------------------------------------------------------------
from agents import set_default_openai_api
from agents.tracing import set_tracing_disabled

set_default_openai_api("chat_completions")  # switch away from /v1/responses
set_tracing_disabled(True)                 # silence 401 tracing errors

from agents import Agent
from agents.mcp import MCPServerSse, MCPServerStdio

# Define your MCP server(s)
railway_server_url = "https://eu1.make.com/mcp/api/v1/u/2a183f33-4498-4ebe-b558-49e956ee0c29/sse"
primary_railway_server_url = "https://primary-nj0x-production.up.railway.app/mcp/1b39de32-b22f-4323-ad9e-e332c41930ce/sse"

# Original Make.com MCP server
railway_mcp_server = MCPServerSse(
    name="railway",
    params={"url": railway_server_url},
    client_session_timeout_seconds=60.0,  # Increased timeout to 60 seconds
    cache_tools_list=True
)

# Your primary Railway-hosted MCP server
primary_railway_mcp_server = MCPServerSse(
    name="primary_railway",
    params={"url": primary_railway_server_url},
    client_session_timeout_seconds=60.0,  # Increased timeout to 60 seconds
    cache_tools_list=True
)

# --- HubSpot MCP Server definition ---
hubspot_mcp_token = os.getenv("HUBSPOT_PRIVATE_APP_ACCESS_TOKEN")
if not hubspot_mcp_token:
    print("WARNING: HUBSPOT_PRIVATE_APP_ACCESS_TOKEN is not set. HubSpot MCP may not start correctly.")

hubspot_mcp_server = MCPServerStdio(
    name="hubspot",
    params={
        # Use the right shell command per OS
        "command": "cmd" if os.name == "nt" else "npx",
        "args": (
            ["/c", "npx", "-y", "@hubspot/mcp-server"]
            if os.name == "nt"
            else ["-y", "@hubspot/mcp-server"]
        ),
        "env": {
            "PRIVATE_APP_ACCESS_TOKEN": hubspot_mcp_token or "",
            # npx under some shells insists that this exists
            "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME", "/tmp"),
        }
        # Optionally, add 'cwd' here if needed.
    },
    client_session_timeout_seconds=120.0,   # hubspot server needs a bit more time to start
    # cache_tools_list=True
)

# --- Slack MCP Server definition ---
slack_bot_token = os.getenv("SLACK_BOT_TOKEN")
slack_team_id = os.getenv("SLACK_TEAM_ID")
if not slack_bot_token or not slack_team_id:
    print("WARNING: SLACK_BOT_TOKEN or SLACK_TEAM_ID is not set. Slack MCP may not start correctly.")

slack_mcp_server = MCPServerStdio(
    name="slack",
    params={
        "command": "npx",
        "args": [
            "-y",
            "@modelcontextprotocol/server-slack"
        ],
        "env": {
            "SLACK_BOT_TOKEN": slack_bot_token or "",
            "SLACK_TEAM_ID": slack_team_id or "",
        }
    },
    # You can adjust timeout or other params as needed
    client_session_timeout_seconds=60.0,
)

from datetime import datetime

with open(os.path.join(os.path.dirname(__file__), "system_prompt.md"), "r", encoding="utf-8") as f:
    system_prompt = f"Current date and time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n" + f.read()

_agent = Agent(
    name="SlackAssistant",
    model=os.getenv("AGENT_MODEL", "gpt-4o"),
    instructions=system_prompt,
    mcp_servers=[primary_railway_mcp_server, hubspot_mcp_server, slack_mcp_server],
)

# For easier access in server.py, you can create a list of active servers
ACTIVE_MCP_SERVERS = _agent.mcp_servers if _agent.mcp_servers else []
