import os
import json
import pathlib  # Add this import
print("!!! MCP_SERVERS.PY - FILE VERSION 20240516-153000 HAS BEEN LOADED !!!", flush=True)
from agents.mcp import MCPServerSse, MCPServerStdio

import contextvars
from custom_slack_agent import slack_user_id_var

# --- NEW: Schema Patching Function ---
import json

def _ensure_items_in_schema_recursive(schema_part, path="schema", depth=0, max_depth=8):
    # print(f"!!!!!!!!!! ENTERED _ensure_items_in_schema_recursive FOR PATH: {path} (depth={depth}) !!!!!!!!!", flush=True)
    # print(f"ENTER_RECURSE: Path='{path}', TypeOfSchemaPart='{type(schema_part)}', Depth={depth}")
    if depth > max_depth:
        print(f"WARNING: Max schema recursion depth ({max_depth}) exceeded at path '{path}'. Stopping recursion to avoid excessive nesting.", flush=True)
        return
    if depth > 5:
        print(f"NOTICE: _ensure_items_in_schema_recursive nesting level {depth} at path '{path}'", flush=True)
    # if isinstance(schema_part, dict):
    #     print(f"ENTER_RECURSE_DICT_CONTENT: {json.dumps(schema_part, indent=2)}")
    # else:
    #     print(f"ENTER_RECURSE_NON_DICT_CONTENT: {str(schema_part)[:200]}")
    # --- End Log EVERY entry ---

    if not isinstance(schema_part, dict):
        return

    is_array_type = schema_part.get("type") == "array"
    items_value = schema_part.get("items")
    param_name_for_log = "N/A"
    if ".param:'" in path:
        try:
            param_name_for_log = path.split(".param:'")[-1].split("'")[0]
        except Exception:
            pass

    items_is_missing_or_invalid = False

    if "items" not in schema_part:
        items_is_missing_or_invalid = True
    elif not isinstance(items_value, dict):
        items_is_missing_or_invalid = True
        print(f"DEBUG_PATCH_ACTION_WARN: Path='{path}', ParamName='{param_name_for_log}', 'items' key exists but its value is NOT A DICT. Value: {str(items_value)[:100]}. Will attempt to patch.", flush=True)
    elif not items_value:
        items_is_missing_or_invalid = True
        print(f"DEBUG_PATCH_ACTION_WARN: Path='{path}', ParamName='{param_name_for_log}', 'items' is an EMPTY DICT {{}}. Will patch.", flush=True)
    elif "type" not in items_value:
        items_is_missing_or_invalid = True
        print(f"DEBUG_PATCH_ACTION_WARN: Path='{path}', ParamName='{param_name_for_log}', 'items' IS A DICT BUT LACKS A 'type' KEY. Items content: {json.dumps(items_value)}. Will patch.", flush=True)
    else:
        items_is_missing_or_invalid = False

    needs_items_patch = is_array_type and items_is_missing_or_invalid

    # if is_array_type:
    #     print(f"DETAILED_INSPECT_ARRAY: Path='{path}', EffectiveParamName='{param_name_for_log}', IsArray={is_array_type}")
    #     print(f"DETAILED_INSPECT_ARRAY: Current schema_part: {json.dumps(schema_part, indent=2)}")
    #     print(f"DETAILED_INSPECT_ARRAY: Value of 'items' key (schema_part.get(\"items\")): {json.dumps(items_value)}")
    #     print(f"DETAILED_INSPECT_ARRAY: Is 'items' key missing? {'items' not in schema_part}")
    #     print(f"DETAILED_INSPECT_ARRAY: Is 'items' value NOT a dict? {not isinstance(items_value, dict)}")
    #     print(f"DETAILED_INSPECT_ARRAY: Calculated 'items_is_missing_or_invalid': {items_is_missing_or_invalid}")
    #     print(f"DETAILED_INSPECT_ARRAY: Calculated 'needs_items_patch': {needs_items_patch}")

    if needs_items_patch:
        print(f"DEBUG_PATCH_ACTION: Patching 'items' for array at path '{path}'. Setting to {{'type': 'string'}}.", flush=True)
        schema_part["items"] = {"type": "string"}

    # --- NEW: If items is a dict and type is array, recurse into its items ---
    if is_array_type and isinstance(schema_part.get("items"), dict):
        items_dict = schema_part["items"]
        if items_dict.get("type") == "array":
            print(f"DEBUG_PATCH_ACTION: Recursing into nested array 'items' at path '{path}.items'", flush=True)
            _ensure_items_in_schema_recursive(items_dict, f"{path}.items", depth=depth+1, max_depth=max_depth)
        # If items_dict is a dict but missing type, still recurse to patch further
        elif "type" not in items_dict:
            print(f"DEBUG_PATCH_ACTION: Recursing into 'items' dict missing type at path '{path}.items'", flush=True)
            _ensure_items_in_schema_recursive(items_dict, f"{path}.items", depth=depth+1, max_depth=max_depth)

    for key, value in list(schema_part.items()):
        new_path = f"{path}.{key}"
        if isinstance(value, dict):
            _ensure_items_in_schema_recursive(value, new_path, depth=depth+1, max_depth=max_depth)
        elif isinstance(value, list) and key in ("allOf", "anyOf", "oneOf", "prefixItems"):
            for i, sub_schema in enumerate(value):
                if isinstance(sub_schema, dict):
                    _ensure_items_in_schema_recursive(sub_schema, f"{new_path}[{i}]", depth=depth+1, max_depth=max_depth)

def patch_tool_list_schemas_V2(tools_list):
    print(f"!!!!!!!!!! ENTERED patch_tool_list_schemas_V2 with {len(tools_list) if isinstance(tools_list, list) else 'NON-LIST OBJECT'} tools !!!!!!!!!", flush=True)
    if not isinstance(tools_list, list):
        print(f"DEBUG_PATCH: tools_list is not a list (type: {type(tools_list)}), skipping patch.", flush=True)
        return tools_list

    print(f"DEBUG_PATCH: Attempting to patch schemas for {len(tools_list)} tools (V2 - FORCED PARAM SCHEMA LOGGING).", flush=True)
    for i, tool_def in enumerate(tools_list):
        parameters_schema = None
        tool_name_for_debug = f"tool_at_index_{i}" # Default tool name for logging

        if isinstance(tool_def, dict):
            # If tool_def is a dictionary, try to get 'name' and 'parameters'
            tool_name_for_debug = tool_def.get("name", f"tool_dict_at_index_{i}")
            parameters_schema = tool_def.get("parameters")
            # Fallback for dicts that might use inputSchema, though less common for pure dicts
            if parameters_schema is None and "inputSchema" in tool_def:
                print(f"DEBUG_PATCH_INFO: Tool '{tool_name_for_debug}' is a dict, using 'inputSchema' as parameters_schema.", flush=True)
                parameters_schema = tool_def.get("inputSchema")
        elif hasattr(tool_def, "name"): # For Tool objects or similar
            tool_name_for_debug = getattr(tool_def, "name", f"tool_obj_at_index_{i}")
            if hasattr(tool_def, "inputSchema"):
                parameters_schema = getattr(tool_def, "inputSchema", None)
                print(f"DEBUG_PATCH_INFO: Tool '{tool_name_for_debug}' is an object, using 'inputSchema' attribute for parameters. Type: {type(parameters_schema)}", flush=True)
            elif hasattr(tool_def, "parameters"): # Fallback if it's an object with 'parameters'
                parameters_schema = getattr(tool_def, "parameters", None)
                print(f"DEBUG_PATCH_INFO: Tool '{tool_name_for_debug}' is an object, using 'parameters' attribute for parameters. Type: {type(parameters_schema)}", flush=True)
            else:
                print(f"DEBUG_PATCH_WARN: Tool '{tool_name_for_debug}' is an object but has neither 'inputSchema' nor 'parameters' attribute.", flush=True)
        else:
            # Fallback if tool_def is neither a dict nor a recognizable Tool object
            print(f"DEBUG_PATCH_WARN: Tool at index {i} is of unrecognized type '{type(tool_def)}'. Attempting to get 'name' and 'parameters' by common fallbacks.", flush=True)
            if hasattr(tool_def, "get"): # Check if it behaves like a dict
                tool_name_for_debug = tool_def.get("name", tool_name_for_debug)
                parameters_schema = tool_def.get("parameters") or tool_def.get("inputSchema")
            # else: parameters_schema remains None

        if not isinstance(parameters_schema, dict):
            print(f"DEBUG_PATCH: Tool '{tool_name_for_debug}' has no valid parameters schema (or not a dict). Type: {type(parameters_schema)}. Skipping its params.", flush=True)
            print(f"RAW_TOOL_OBJECT: {repr(tool_def)}", flush=True)
            continue

        # --- Log the entire parameters_schema for this tool BEFORE any modifications in this function ---
        # print(f"\n======================================================================", flush=True)
        # print(f"PROCESSING PARAMETERS FOR TOOL: '{tool_name_for_debug}' (Index: {i})", flush=True)
        # print(f"======================================================================", flush=True)
        # print(f"RAW_PARAMS_SCHEMA_LOG (PRE-PATCHING_V2): Tool='{tool_name_for_debug}'", flush=True)
        # if parameters_schema is None:
        #     print("  Parameters schema is None.", flush=True)
        # elif not parameters_schema:
        #     print("  Parameters schema is an empty dictionary {}.", flush=True)
        # else:
        #     try:
        #         print(json.dumps(parameters_schema, indent=2, default=str), flush=True)
        #     except Exception as e:
        #         print(f"  ERROR JSON-DUMPING PRE-PATCH SCHEMA for tool '{tool_name_for_debug}': {e}", flush=True)
        #         print(f"  RAW SCHEMA (PRE-PATCH) AS STRING: {str(parameters_schema)[:1000]}", flush=True)
        # ---

        # Basic schema type enforcement
        if "properties" in parameters_schema:
            if parameters_schema.get("type") != "object":
                print(f"DEBUG_PATCH_INFO: Tool '{tool_name_for_debug}' main params schema: Forcing type to 'object' as 'properties' key exists. Original type: '{parameters_schema.get('type')}'", flush=True)
                parameters_schema["type"] = "object"
        elif not parameters_schema: 
             print(f"DEBUG_PATCH_INFO: Tool '{tool_name_for_debug}' main params schema: Is empty, setting to type object with empty properties.", flush=True)
             parameters_schema.update({"type": "object", "properties": {}})
        else:
            # If no 'properties' and not empty, log its type to see what it is
            print(f"DEBUG_PATCH_INFO: Tool '{tool_name_for_debug}' main params schema has no 'properties' and is not empty. Type: '{parameters_schema.get('type')}'. Schema: {json.dumps(parameters_schema, indent=2)}", flush=True)

        # --- Patch empty or missing-type parameter schemas ---
        current_schema_type_for_iteration = parameters_schema.get('type')
        if current_schema_type_for_iteration == "object" and "properties" in parameters_schema and isinstance(parameters_schema["properties"], dict):
            for param_name, param_schema_dict_val in list(parameters_schema["properties"].items()):
                if isinstance(param_schema_dict_val, dict) and not param_schema_dict_val:
                    # print(f"DEBUG_PATCH_FIX_EMPTY_PARAM: Tool '{tool_name_for_debug}', Param '{param_name}' was {{}}. Defaulting to {{'type': 'string', 'description': 'Patched: Was an empty schema'}}.", flush=True)
                    parameters_schema["properties"][param_name] = {"type": "string", "description": "Patched: Was an empty schema"}
                elif isinstance(param_schema_dict_val, dict) and "type" not in param_schema_dict_val and param_schema_dict_val:
                    if not any(k in param_schema_dict_val for k in ["allOf", "anyOf", "oneOf", "not", "$ref"]):
                        # print(f"DEBUG_PATCH_FIX_MISSING_TYPE_PARAM: Tool '{tool_name_for_debug}', Param '{param_name}' is a dict but missing 'type'. Defaulting to 'string'. Original: {json.dumps(param_schema_dict_val)}", flush=True)
                        original_desc = param_schema_dict_val.get("description", "Patched: Was a dict missing type")
                        parameters_schema["properties"][param_name] = {"type": "string", "description": original_desc, **param_schema_dict_val}
                        parameters_schema["properties"][param_name].pop("type", None)
                        parameters_schema["properties"][param_name]["type"] = "string"

        current_schema_type_for_iteration = parameters_schema.get('type')
        if current_schema_type_for_iteration == "object":
            if "properties" in parameters_schema and isinstance(parameters_schema["properties"], dict):
                # print(f"DEBUG_PATCH: Tool '{tool_name_for_debug}': Iterating properties for items check.", flush=True)
                for param_name, param_schema_dict in parameters_schema["properties"].items():
                    path_for_recursive_call = f"tool:'{tool_name_for_debug}'.param:'{param_name}'"
                    
                    # --- Explicitly log the param_schema_dict being passed to the recursive function ---
                    # print(f"  INSPECT_CALL_TO_RECURSIVE: Tool='{tool_name_for_debug}', Param='{param_name}'", flush=True)
                    # print(f"  INSPECT_CALL_TO_RECURSIVE:   param_schema_dict type: {type(param_schema_dict)}", flush=True)
                    # if isinstance(param_schema_dict, dict):
                    #      print(f"  INSPECT_CALL_TO_RECURSIVE:   param_schema_dict content: {json.dumps(param_schema_dict, indent=4)}", flush=True)
                    # else:
                    #      print(f"  INSPECT_CALL_TO_RECURSIVE:   param_schema_dict content: {str(param_schema_dict)}", flush=True)
                    # ---
                    
                    _ensure_items_in_schema_recursive(param_schema_dict, path_for_recursive_call)
            else:
                # print(f"DEBUG_PATCH: Tool '{tool_name_for_debug}' (type object) has no 'properties' dict OR 'properties' is not a dict. Properties: {parameters_schema.get('properties')}", flush=True)
                pass
        elif current_schema_type_for_iteration == "array":
            # print(f"DEBUG_PATCH: Tool '{tool_name_for_debug}' params is type 'array'. Path: tool:'{tool_name_for_debug}'.params_direct_array", flush=True)
            _ensure_items_in_schema_recursive(parameters_schema, f"tool:'{tool_name_for_debug}'.params_direct_array")
        else:
            # print(f"DEBUG_PATCH: Parameters schema for '{tool_name_for_debug}' (type: {current_schema_type_for_iteration}) not an 'object' with properties or 'array'. Full schema: {json.dumps(parameters_schema, indent=2)}", flush=True)
            if isinstance(parameters_schema, dict):
                _ensure_items_in_schema_recursive(parameters_schema, f"tool:'{tool_name_for_debug}'.params_unknown_structure")


        # --- Log the entire parameters_schema for this tool AFTER all modifications in this function ---
        # print(f"\nRAW_PARAMS_SCHEMA_LOG (POST-PATCHING_V2): Tool='{tool_name_for_debug}'", flush=True)
        # if parameters_schema is None:
        #     print("  Parameters schema is None.", flush=True)
        # elif not parameters_schema:
        #     print("  Parameters schema is an empty dictionary {}.", flush=True)
        # else:
        #     try:
        #         print(json.dumps(parameters_schema, indent=2, default=str), flush=True)
        #     except Exception as e:
        #         print(f"  ERROR JSON-DUMPING POST-PATCH SCHEMA for tool '{tool_name_for_debug}': {e}", flush=True)
        #         print(f"  RAW SCHEMA (POST-PATCH) AS STRING: {str(parameters_schema)[:1000]}", flush=True)
        # print(f"RAW_PARAMS_SCHEMA_LOG (POST-PATCHING_V2): ---------------------------------------\n", flush=True)
        # ---
            
    return tools_list
# --- END: Schema Patching Function ---

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

# --- Patched MCPServerSse for primary_railway_mcp_server ---
class PatchedMCPServerSse(MCPServerSse):
    async def list_tools(self, *args, **kwargs):
        tools = await super().list_tools(*args, **kwargs)
        print(f"DEBUG_PATCH: Applying V2 schema patching to tools from '{self.name}' (PatchedMCPServerSse).")
        return patch_tool_list_schemas_V2(tools)

primary_railway_mcp_server = PatchedMCPServerSse(
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
        print(f"DEBUG_PATCH: Applying V2 schema patching to tools from '{self.name}' server.")
        tools = patch_tool_list_schemas_V2(tools)
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

# --- Patched MCPServerStdio for HubSpot ---
class PatchedMCPServerStdio(MCPServerStdio):
    async def list_tools(self, *args, **kwargs):
        tools = await super().list_tools(*args, **kwargs)
        print(f"DEBUG_PATCH: Applying V2 schema patching to tools from '{self.name}' (PatchedMCPServerStdio).")
        return patch_tool_list_schemas_V2(tools)

hubspot_mcp_server = PatchedMCPServerStdio(
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
# --- Common default config directory for MCP servers ---
default_mcp_config_path = pathlib.Path(os.getcwd()) / ".mcp_configs" / "default"
default_mcp_config_path.mkdir(parents=True, exist_ok=True)

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
            "XDG_CONFIG_HOME": str(default_mcp_config_path),
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
        
        if not hasattr(self, 'params') or self.params is None:
            self.params = {}
        self.params['url'] = dynamic_url_for_connection

        # Try to force the transport/client_session to use the new URL if possible
        if hasattr(self, 'client_session') and self.client_session and \
           hasattr(self.client_session, 'transport') and self.client_session.transport and \
           hasattr(self.client_session.transport, 'url'):
            print(f"DEBUG ({self.name}): Current transport URL before override: {self.client_session.transport.url}")
            self.client_session.transport.url = dynamic_url_for_connection
            print(f"DEBUG ({self.name}): Attempted to override transport URL directly.")

        print(f"DEBUG ({self.name}): Attempting to connect to (from self.params): {self.params.get('url')}")
        try:
            await super().connect()
            print(f"DEBUG ({self.name}): Successfully connected to (according to super().connect()): {self.params.get('url')}.")
        except Exception as e:
            print(f"ERROR ({self.name}): Failed to connect to {self.params.get('url')}: {e}")
            import traceback
            print(f"TRACEBACK ({self.name}): {traceback.format_exc()}")
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

# --- Patched MCPServerSse for primary_railway_mcp_server ---
class PatchedMCPServerSse(MCPServerSse):
    async def list_tools(self, *args, **kwargs):
        tools = await super().list_tools(*args, **kwargs)
        print(f"DEBUG_PATCH: Applying V2 schema patching to tools from '{self.name}' (PatchedMCPServerSse).")
        return patch_tool_list_schemas_V2(tools)

# --- Patched NotionMCPByURL for local_notion_server_by_url ---
class PatchedNotionMCPByURL(NotionMCPByURL):
    async def list_tools(self, *args, **kwargs):
        tools = await super().list_tools(*args, **kwargs)
        print(f"DEBUG_PATCH: Applying V2 schema patching to tools from '{self.name}' (PatchedNotionMCPByURL).")
        return patch_tool_list_schemas_V2(tools)

# --- Instantiate your new server class in mcp_servers.py ---
primary_railway_mcp_server = PatchedMCPServerSse(
    name="primary_railway",
    params={"url": primary_railway_server_url},
    client_session_timeout_seconds=60.0,
    cache_tools_list=True
)

local_notion_server_by_url = PatchedNotionMCPByURL(
    name="local_notion_via_url",
    base_server_url="https://notionmcp-production.up.railway.app/mcp", # Base path, token will be appended
    client_session_timeout_seconds=60.0,
    cache_tools_list=False
)

# --- Log all available tools from each MCP server at startup ---
import asyncio

async def log_all_mcp_tools():
    print("INFO: Listing all available tools from each MCP server (after connect)...")
    for mcp_server in [primary_railway_mcp_server, eu2_make_mcp_server, local_notion_server_by_url, hubspot_mcp_server]:
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
