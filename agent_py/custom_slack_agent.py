import os
from dotenv import load_dotenv
load_dotenv()  # Load environment variables first

from typing import Any
import contextvars

# Single ContextVar instance shared by server & MCP filtering
slack_user_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "slack_user_id", default=None
)

# (LiteLLM integration: openai import and base_url override are not needed)
from agents import set_default_openai_api, Agent, ModelSettings
from agents.tracing import set_tracing_disabled

set_default_openai_api("chat_completions")  # switch away from /v1/responses
set_tracing_disabled(True)                 # silence 401 tracing errors

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

# --- NEW: EU2 Make.com MCP server (SSE) ---
eu2_make_server_url = "https://eu2.make.com/mcp/api/v1/u/6d0262c3-9c24-4f3d-a836-aab12ac5674a/sse"
class FilteredMCPServerSse(MCPServerSse):
    def __init__(self, *args, allowed_tools=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._allowed_tools = set(allowed_tools) if allowed_tools else None
        self._user_tool_map = {
            "U07G1UMQ64C": "wouter",
            "U08K4SFL5LP": "leonie",
            "U08K6QFBPB9": "sjoerd",
        }

    async def list_tools(self, *args, **kwargs):
        # Get Slack user-id that server.py stored in the shared ContextVar
        slack_user_id = slack_user_id_var.get()

        tools = await super().list_tools(*args, **kwargs)
        print(f"DEBUG: Tools available BEFORE filter ({self.name}):")
        for tool in tools:
            name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
            desc = tool.get("description") if isinstance(tool, dict) else getattr(tool, "description", "")
            print(f"  - {name}: {desc}")

        # Per-user filtering logic (match username anywhere in tool name or description, case-insensitive)
        user_tool_suffix = None
        if slack_user_id and slack_user_id in self._user_tool_map:
            user_tool_suffix = self._user_tool_map[slack_user_id]
            print(f"DEBUG: Filtering Make tools for Slack user {slack_user_id} ({user_tool_suffix})")
            filtered = []
            seen = set()
            for tool in tools:
                name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
                desc = tool.get("description") if isinstance(tool, dict) else getattr(tool, "description", "")

                match_for_user = False
                # 1) tool **name** contains username (case-insensitive)
                if name and user_tool_suffix.lower() in name.lower():
                    match_for_user = True
                # 2) tool **description** contains "| <Username>" (Makes default suffix)
                elif desc and f"| {user_tool_suffix}".lower() in desc.lower():
                    match_for_user = True

                if match_for_user and name not in seen:
                    filtered.append(tool)
                    seen.add(name)
            print(f"DEBUG: Tools available AFTER filter ({self.name}):")
            for tool in filtered:
                name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
                desc = tool.get("description") if isinstance(tool, dict) else getattr(tool, "description", "")
                print(f"  - {name}: {desc}")
            return filtered

        # Fallback to allowed_tools if set
        if self._allowed_tools is not None:
            filtered = []
            seen = set()
            for tool in tools:
                name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
                if name in self._allowed_tools and name not in seen:
                    filtered.append(tool)
                    seen.add(name)
            print(f"DEBUG: Tools available AFTER filter ({self.name}):")
            for tool in filtered:
                name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
                desc = tool.get("description") if isinstance(tool, dict) else getattr(tool, "description", "")
                print(f"  - {name}: {desc}")
            return filtered
        return tools

eu2_make_mcp_server = FilteredMCPServerSse(
    name="eu2_make",
    params={"url": eu2_make_server_url},
    client_session_timeout_seconds=60.0,
    cache_tools_list=True,
    allowed_tools=["scenario_5209853_get_meeting_transcripts_from_fireflies"]
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
            # Always set XDG_CONFIG_HOME to avoid "unbound variable" errors in npx shell scripts
            "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME") or os.getenv("XDG_CONFIG_HOME") or "/tmp",
        }
        # Optionally, add 'cwd' here if needed.
    },
    client_session_timeout_seconds=120.0,   # hubspot server needs a bit more time to start
    # cache_tools_list=True
)

# ------------------------------------------------------------------
# Monkey-patch: some HubSpot tools declare an array but forget to
# provide an `items` schema. That violates Gemini’s validator.
# We walk every “parameters” tree and drop in a permissive
# `{"type": "string"}` when it’s missing.
# ------------------------------------------------------------------

# def _ensure_items(node: Any) -> None:
#     """Recursively ensure each array schema has an `items` key."""
#     if isinstance(node, dict):
#         if node.get("type") == "array" and "items" not in node:
#             node["items"] = {"type": "string"}        # minimal, safe default
#         for value in node.values():
#             _ensure_items(value)
#     elif isinstance(node, list):
#         for item in node:
#             _ensure_items(item)

# if hubspot_mcp_server is not None:
#     _orig_list_tools = hubspot_mcp_server.list_tools

#     async def _patched_list_tools(*args, **kwargs):
#         tools = await _orig_list_tools(*args, **kwargs)
#         for tool in tools:
#             params = tool.get("parameters")
#             if params:
#                 _ensure_items(params)
#         return tools

#     hubspot_mcp_server.list_tools = _patched_list_tools

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
            "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME") or "/tmp",  # ← nieuw
        }
    },
    # You can adjust timeout or other params as needed
    client_session_timeout_seconds=60.0,
)

from datetime import datetime

# Format: Dinsdag 13 mei 2025
import locale
try:
    locale.setlocale(locale.LC_TIME, "nl_NL.UTF-8")
except Exception:
    # fallback for systems without Dutch locale
    pass

now = datetime.now()
# Map weekday number to Dutch day name
dagen = [
    "Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"
]
maanden = [
    "januari", "februari", "maart", "april", "mei", "juni",
    "juli", "augustus", "september", "oktober", "november", "december"
]
dag_vd_week = dagen[now.weekday()]
dag = now.day
maand = maanden[now.month - 1]
jaar = now.year
datum_str = f"{dag_vd_week} {dag} {maand} {jaar}"

with open(os.path.join(os.path.dirname(__file__), "system_prompt.md"), "r", encoding="utf-8") as f:
    base_system_prompt = f.read().rstrip()

def get_dutch_date():
    from datetime import datetime
    import locale
    try:
        locale.setlocale(locale.LC_TIME, "nl_NL.UTF-8")
    except Exception:
        pass
    dagen = [
        "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"
    ]
    maanden = [
        "januari", "februari", "maart", "april", "mei", "juni",
        "juli", "augustus", "september", "oktober", "november", "december"
    ]
    now = datetime.now()
    dag_vd_week = dagen[now.weekday()]
    dag = now.day
    maand = maanden[now.month - 1]
    jaar = now.year
    return f"{dag_vd_week.capitalize()} {dag} {maand} {jaar}"

system_prompt = f"{base_system_prompt}\n\nDatum: {get_dutch_date()}"

# Get the AGENT_MODEL from environment variables.
# This should now be prefixed with "litellm/", e.g., "litellm/together_ai/Qwen/Qwen3-235B-A22B-fp8-tput"
agent_model_name_from_env = os.getenv("AGENT_MODEL", "gpt-4o") # Default to gpt-4o if not set

# Optional: Add a check or logging for the model name format
if not agent_model_name_from_env.startswith("litellm/"):
    print(f"PY_AGENT_WARNING: AGENT_MODEL '{agent_model_name_from_env}' does not start with 'litellm/'. "
          f"Ensure it is correctly formatted for LiteLLM (e.g., 'litellm/provider/model').")

# --- ADD ModelSettings Configuration ---
desired_max_tokens = 124000
print(f"PY_AGENT_INFO: Attempting to set max_tokens to {desired_max_tokens} for the agent.")

custom_model_settings = ModelSettings(
    max_tokens=desired_max_tokens
    # You can also set other parameters here, for example:
    # temperature=0.7
)
# --- END ModelSettings Configuration ---

_agent = Agent(
    name="SlackAssistant",
    model=agent_model_name_from_env, # Use the model name directly
    instructions=system_prompt,
    mcp_servers=[primary_railway_mcp_server, eu2_make_mcp_server, slack_mcp_server, hubspot_mcp_server],
    model_settings=custom_model_settings
)

# For easier access in server.py, you can create a list of active servers
ACTIVE_MCP_SERVERS = _agent.mcp_servers if _agent.mcp_servers else []

# --- NEW: Log all available tools from each MCP server at startup ---
import asyncio

async def log_all_mcp_tools():
    print("INFO: Listing all available tools from each MCP server (after connect)...")
    for mcp_server in [primary_railway_mcp_server, eu2_make_mcp_server, slack_mcp_server]:
        try:
            await mcp_server.connect()
            tools = await mcp_server.list_tools()
            print(f"TOOLS ({mcp_server.name}):")
            for tool in tools:
                # Use attribute access if dict .get() fails
                name = getattr(tool, "name", None) or (tool["name"] if isinstance(tool, dict) and "name" in tool else "<unnamed>")
                desc = getattr(tool, "description", None) or (tool["description"] if isinstance(tool, dict) and "description" in tool else "")
                print(f"  - {name}: {desc}")
        except Exception as e:
            print(f"ERROR: Could not list tools for MCP server '{mcp_server.name}': {e}")

# Schedule the tool logging at startup (if running in an async context)
try:
    asyncio.get_event_loop().create_task(log_all_mcp_tools())
except Exception:
    # If not in an event loop, just print a warning
    print("WARNING: Could not schedule MCP tool logging at startup (no event loop running).")
