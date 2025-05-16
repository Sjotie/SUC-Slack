import os
import json
from agents.mcp import MCPServerSse, MCPServerStdio

import contextvars
from custom_slack_agent import slack_user_id_var

# --- User Config: How your Python agent maps Slack IDs to URL Tokens ---
# These tokens will be part of the URL and must match what your Node.js
# server expects in getNotionApiKeyForUserToken (e.g., "sjoerd_token")
SLACK_ID_TO_URL_TOKEN_MAP = {
    "U08K6QFBPB9": "sjoerd_url_token", # This token will be used in the URL
    "U07G1UMQ64C": "wouter_url_token",
    "U08K4SFL5LP": "leonie_url_token",
    # Ensure Node.js server has corresponding SJOERD_URL_TOKEN_NOTION_API_KEY, etc.
}
DEFAULT_URL_TOKEN = "default_user_token" # Fallback token

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

# --- Node.js Notion MCP Server (URL-based user token) ---
class NotionMCPByURL(MCPServerSse):
    def __init__(self, name: str, base_server_url: str, **kwargs):
        self.base_server_url = base_server_url.rstrip('/') # e.g., http://127.0.0.1:8080/mcp
        self._dynamic_params = None # Will hold params with the dynamic URL
        
        # Initialize super with placeholder params.
        # The actual URL will be determined dynamically in connect().
        super().__init__(name=name, params={"url": "http://placeholder.com/mcp/invalid"}, **kwargs)
        print(f"INFO ({self.name}): Initialized for URL-based user tokens.")
        print(f"INFO ({self.name}): IMPORTANT - SDK's handling of 202 Accepted + SSE responses still applies.")

    def _get_user_specific_url(self):
        current_slack_user_id = slack_user_id_var.get()
        user_token = DEFAULT_URL_TOKEN
        if current_slack_user_id:
            token_from_map = SLACK_ID_TO_URL_TOKEN_MAP.get(current_slack_user_id)
            if token_from_map:
                user_token = token_from_map
                print(f"DEBUG ({self.name}): Using URL token '{user_token}' for Slack user {current_slack_user_id}.")
            else:
                print(f"WARNING ({self.name}): No URL token for Slack user {current_slack_user_id}. Using default token '{user_token}'.")
        else:
            print(f"WARNING ({self.name}): No Slack user ID in context. Using default URL token '{user_token}'.")
        
        return f"{self.base_server_url}/{user_token}" # e.g., http://127.0.0.1:8080/mcp/sjoerd_url_token

    # Override connect to set the dynamic URL before the actual connection happens
    async def connect(self):
        dynamic_url_for_connection = self._get_user_specific_url()
        
        # The `params` attribute is used by the base class's connect/create_streams method.
        # We need to update it here.
        if not hasattr(self, 'params') or self.params is None:
            self.params = {}
        self.params['url'] = dynamic_url_for_connection
        # If you needed static headers for the GET SSE connection, set them here:
        # self.params['headers'] = {"Some-Static-Header": "Value"}
        
        print(f"DEBUG ({self.name}): Attempting to connect to: {self.params['url']}")
        try:
            await super().connect()
            print(f"DEBUG ({self.name}): Successfully connected to {self.params['url']}.")
        except Exception as e:
            print(f"ERROR ({self.name}): Failed to connect to {self.params['url']}: {e}")
            raise

    # The `initialize` method in this class no longer needs to inject notionApiKey
    # into initializationOptions, as the Node.js server derives it from the URL token.
    # We can rely on the base class's `initialize` method.
    # If you need to pass *other* initializationOptions, you can still override it.
    async def initialize(self, capabilities=None, client_info=None, initialization_options=None, **kwargs):
        print(f"DEBUG ({self.name}): Calling super().initialize (URL token identifies user). Options from agent: {initialization_options}")
        # The Node.js server will extract user context from the URL token.
        # Any `initialization_options` passed here by the agent framework will still be sent.
        return await super().initialize(capabilities, client_info, initialization_options, **kwargs)

    # list_tools and call_tool will use the base class implementations.
    # The main challenge for them is that the SDK's SseClientTransport must POST
    # messages to the correct unique URL (e.g., http://.../mcp/USER_TOKEN)
    # if that's how your Node.js POST route is defined.
    # If the SDK always POSTs messages to the *original base URL without the token path*,
    # then your Node.js POST route must be `/mcp` and it would need the `X-MCP-Session-ID` again,
    # which this Python class isn't currently set up to send easily.

# --- Instantiate your new server class in mcp_servers.py ---
local_notion_server_by_url = NotionMCPByURL(
    name="local_notion_via_url",
    base_server_url="http://127.0.0.1:8080/mcp", # Base path, token will be appended
    client_session_timeout_seconds=60.0,
    cache_tools_list=False
)

# --- Log all available tools from each MCP server at startup ---
import asyncio

async def log_all_mcp_tools():
    print("INFO: Listing all available tools from each MCP server (after connect)...")
    for mcp_server in [primary_railway_mcp_server, eu2_make_mcp_server, slack_mcp_server, local_notion_server_by_url]:
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
