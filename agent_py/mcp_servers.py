import os
from agents.mcp import MCPServerSse, MCPServerStdio

import contextvars
from agent_py.custom_slack_agent import slack_user_id_var

# --- MCP Server Definitions ---

# Define your MCP server(s)
railway_server_url = "https://eu1.make.com/mcp/api/v1/u/2a183f33-4498-4ebe-b558-49e956ee0c29/sse"
primary_railway_server_url = "https://primary-nj0x-production.up.railway.app/mcp/1b39de32-b22f-4323-ad9e-e332c41930ce/sse"

railway_mcp_server = MCPServerSse(
    name="railway",
    params={"url": railway_server_url},
    client_session_timeout_seconds=60.0,
    cache_tools_list=True
)

primary_railway_mcp_server = MCPServerSse(
    name="primary_railway",
    params={"url": primary_railway_server_url},
    client_session_timeout_seconds=60.0,
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
        slack_user_id = slack_user_id_var.get()
        tools = await super().list_tools(*args, **kwargs)
        print(f"DEBUG: Tools available BEFORE filter ({self.name}):")
        for tool in tools:
            name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
            desc = tool.get("description") if isinstance(tool, dict) else getattr(tool, "description", "")
            print(f"  - {name}: {desc}")

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
                if name and user_tool_suffix.lower() in name.lower():
                    match_for_user = True
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

from agents.mcp import MCPServerStdio

hubspot_mcp_server = MCPServerStdio(
    name="hubspot",
    params={
        "command": "cmd" if os.name == "nt" else "npx",
        "args": (
            ["/c", "npx", "-y", "@hubspot/mcp-server"]
            if os.name == "nt"
            else ["-y", "@hubspot/mcp-server"]
        ),
        "env": {
            "PRIVATE_APP_ACCESS_TOKEN": hubspot_mcp_token or "",
            "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME") or os.getenv("XDG_CONFIG_HOME") or "/tmp",
        }
    },
    client_session_timeout_seconds=120.0,
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
            "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME") or "/tmp",
        }
    },
    client_session_timeout_seconds=60.0,
)

# --- Log all available tools from each MCP server at startup ---
import asyncio

async def log_all_mcp_tools():
    print("INFO: Listing all available tools from each MCP server (after connect)...")
    for mcp_server in [primary_railway_mcp_server, eu2_make_mcp_server, slack_mcp_server]:
        try:
            await mcp_server.connect()
            tools = await mcp_server.list_tools()
            print(f"TOOLS ({mcp_server.name}):")
            for tool in tools:
                name = getattr(tool, "name", None) or (tool["name"] if isinstance(tool, dict) and "name" in tool else "<unnamed>")
                desc = getattr(tool, "description", None) or (tool["description"] if isinstance(tool, dict) and "description" in tool else "")
                print(f"  - {name}: {desc}")
        except Exception as e:
            print(f"ERROR: Could not list tools for MCP server '{mcp_server.name}': {e}")

try:
    asyncio.get_event_loop().create_task(log_all_mcp_tools())
except Exception:
    print("WARNING: Could not schedule MCP tool logging at startup (no event loop running).")
