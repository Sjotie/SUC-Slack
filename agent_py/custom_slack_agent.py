import os
from dotenv import load_dotenv
load_dotenv()  # Load environment variables first

import contextvars


# Single ContextVar instance shared by server & MCP filtering
slack_user_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "slack_user_id", default=None
)

from agents import set_default_openai_api, Agent, ModelSettings
from agents.tracing import set_tracing_disabled

set_default_openai_api("chat_completions")  # switch away from /v1/responses
set_tracing_disabled(True)                 # silence 401 tracing errors

# Import MCP servers from the new module
from mcp_servers import (
    primary_railway_mcp_server,
    eu2_make_mcp_server,
    slack_mcp_server,
    hubspot_mcp_server,
    local_notion_server_by_url,
)

from datetime import datetime

# Format: Dinsdag 13 mei 2025
import locale
try:
    locale.setlocale(locale.LC_TIME, "nl_NL.UTF-8")
except Exception:
    pass

now = datetime.now()
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

system_prompt = f"{base_system_prompt}\n\nde datum van vandaag is {get_dutch_date()}"

agent_model_name_from_env = os.getenv("AGENT_MODEL", "gpt-4o") # Default to gpt-4o if not set

if not agent_model_name_from_env.startswith("litellm/"):
    print(f"PY_AGENT_WARNING: AGENT_MODEL '{agent_model_name_from_env}' does not start with 'litellm/'. "
          f"Ensure it is correctly formatted for LiteLLM (e.g., 'litellm/provider/model').")

# Set a safe default for max_tokens to avoid model errors.
# Claude 3 Sonnet max is 64,000, GPT-4o is 128,000, most OpenAI models are 4,096-128,000.
# You may want to make this dynamic per model in the future.
desired_max_tokens = 64000
print(f"PY_AGENT_INFO: Setting max_tokens to {desired_max_tokens} for the agent (Claude 3 Sonnet safe limit).")

# Construct the thinking parameter for Anthropic
anthropic_thinking_params = {
    "thinking": {
        "type": "enabled",
        "budget_tokens": 1024  # Or your desired budget
    }
}

custom_model_settings = ModelSettings(
    max_tokens=desired_max_tokens,
    temperature=0.7,  # Example of another standard parameter
    # Pass provider-specific parameters via extra_body
    extra_body=anthropic_thinking_params
)

print("--- Initializing Agent with MCP Servers ---")
current_mcp_servers = [
    primary_railway_mcp_server,
    eu2_make_mcp_server,
    local_notion_server_by_url,
    hubspot_mcp_server,
    slack_mcp_server,
]
for server_idx, server_instance in enumerate(current_mcp_servers):
    print(f"MCP Server [{server_idx}] Name: {getattr(server_instance, 'name', 'N/A')}, Type: {type(server_instance)}")
print("------------------------------------------")

_agent = Agent(
    name="SlackAssistant",
    model=agent_model_name_from_env,
    instructions=system_prompt,
    mcp_servers=current_mcp_servers,
    model_settings=custom_model_settings
)

ACTIVE_MCP_SERVERS = _agent.mcp_servers if _agent.mcp_servers else []
