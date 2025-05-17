from fastapi import FastAPI, Request
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse
import json
import os
import asyncio
import traceback
import anyio
import sys
from typing import List, Union, Dict, Any
from typing import Literal

from custom_slack_agent import slack_user_id_var, _agent, ACTIVE_MCP_SERVERS

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)

MAX_AGENT_TURNS = int(os.getenv("AGENT_MAX_TURNS", "32"))

try:
    from agents import Runner
    from agents.exceptions import ModelBehaviorError, UserError
except ModuleNotFoundError:
    from openai_agents import Runner
    from openai_agents.exceptions import ModelBehaviorError, UserError

os.environ["LITELLM_LOG"] = "WARNING"

from openai.types.responses import ResponseTextDeltaEvent

app = FastAPI(title="Slack-Agent API")

# --- Pydantic models for incoming content (for validation/flexibility) ---
class BaseContentPart(BaseModel):
    type: str

class TextContentPartIncoming(BaseContentPart):
    type: Literal["input_text", "text"]
    text: str

class ImageContentPartIncoming(BaseContentPart):
    type: Literal["input_image", "image_url"]
    image_url: str

IncomingPromptItem = Union[TextContentPartIncoming, ImageContentPartIncoming, Dict[str, Any]]

class ChatRequest(BaseModel):
    prompt: Union[str, List[IncomingPromptItem]]
    history: List[Dict[str, Any]]
    slackUserId: str | None = None

# --- Application Startup Event ---
@app.on_event("startup")
async def startup_event():
    print("PY_AGENT_INFO (startup): Application startup event triggered.")
    if ACTIVE_MCP_SERVERS:
        print(f"PY_AGENT_INFO (startup): Attempting to connect to {len(ACTIVE_MCP_SERVERS)} MCP server(s) on startup...")
        for server_instance in ACTIVE_MCP_SERVERS:
            try:
                if hasattr(server_instance, 'cache_tools_list') and server_instance.cache_tools_list:
                    if hasattr(server_instance, 'invalidate_tools_cache'):
                        server_instance.invalidate_tools_cache()
                        print(f"PY_AGENT_DEBUG (startup): Invalidated tools cache for MCP server '{getattr(server_instance, 'name', 'N/A')}'.")
                try:
                    await server_instance.connect()
                    print(f"PY_AGENT_INFO (startup): Successfully connected to MCP server '{getattr(server_instance, 'name', 'N/A')}'.")
                except Exception as e_connect:
                    print(f"PY_AGENT_ERROR (startup): Failed to connect to MCP server '{getattr(server_instance, 'name', 'N/A')}' on startup: {e_connect}")
            except Exception as e:
                print(f"PY_AGENT_ERROR (startup): Error processing MCP server '{getattr(server_instance, 'name', 'N/A')}' on startup: {e}")
                print(f"PY_AGENT_ERROR (startup): Traceback: {traceback.format_exc()}")
    else:
        print("PY_AGENT_INFO (startup): No active MCP servers configured for initial connection.")

def format_message_content_for_agents_sdk(content_input: Union[str, List[Dict[str, Any]]]) -> Union[str, List[Dict[str, Any]], None]:
    """
    Formats message content to the structure expected by the OpenAI Agents SDK.
    - Text parts: {"type": "input_text", "text": "..."}
    - Image parts: {"type": "input_image", "image_url": "..."}
    - If content is only text (even if originally in a list), it's returned as a plain string.
    """
    if isinstance(content_input, str):
        return content_input

    if not isinstance(content_input, list):
        print(f"PY_AGENT_WARNING (format_content): Expected string or list for content, got {type(content_input)}")
        return None

    sdk_formatted_parts = []
    for item_data in content_input:
        item_dict = {}
        if isinstance(item_data, dict):
            item_dict = item_data
        elif hasattr(item_data, 'dict'):
            item_dict = item_data.dict()
        else:
            print(f"PY_AGENT_WARNING (format_content): Skipping non-dict item in content list: {type(item_data)}")
            continue

        item_type_original = item_dict.get("type")

        if item_type_original in ("input_text", "text"):
            text_value = item_dict.get("text")
            if text_value is not None:
                sdk_formatted_parts.append({"type": "input_text", "text": str(text_value)})
        elif item_type_original in ("input_image", "image_url"):
            image_url_value = item_dict.get("image_url")
            if isinstance(image_url_value, str) and image_url_value.startswith(("data:image/", "http://", "https://")):
                sdk_formatted_parts.append({"type": "input_image", "image_url": image_url_value})
            elif isinstance(image_url_value, dict) and "url" in image_url_value:
                print(f"PY_AGENT_WARNING (format_content): Received nested image_url object, using inner url for input_image.")
                actual_url = image_url_value["url"]
                if isinstance(actual_url, str) and actual_url.startswith(("data:image/", "http://", "https://")):
                    sdk_formatted_parts.append({"type": "input_image", "image_url": actual_url})
                else:
                    print(f"PY_AGENT_WARNING (format_content): Inner URL of image_url object is not a valid string: {actual_url}")
            else:
                print(f"PY_AGENT_WARNING (format_content): Invalid image_url value for input_image: {image_url_value}")
        else:
            print(f"PY_AGENT_WARNING (format_content): Unknown original content part type: {item_type_original}")

    if not sdk_formatted_parts:
        return ""

    if len(sdk_formatted_parts) == 1 and sdk_formatted_parts[0]["type"] == "input_text":
        return sdk_formatted_parts[0]["text"]

    return sdk_formatted_parts

async def stream_agent_events(agent, messages, *, max_retries: int = 2):
    print(f"PY_AGENT_DEBUG (stream_agent_events): Starting agent stream. Number of messages: {len(messages)}")
    if messages:
        print(f"PY_AGENT_DEBUG (stream_agent_events): First message (first 200 chars): {str(messages[0])[:200]}")
        print(f"PY_AGENT_DEBUG (stream_agent_events): Last message (first 200 chars): {str(messages[-1])[:200]}")
    attempts_left = max_retries
    while True:
        try:
            run_result = Runner.run_streamed(
                agent,
                messages,
                max_turns=MAX_AGENT_TURNS
            )
            print("PY_AGENT_DEBUG (stream_agent_events): Runner.run_streamed called, agent stream should start.")
            async for event in run_result.stream_events():
                raw_event_type = 'unknown_raw'
                if hasattr(event, 'type'):
                    raw_event_type = event.type
                elif hasattr(event, 'event') and isinstance(event.event, str):
                    raw_event_type = event.event
                print(f"PY_AGENT_DEBUG (stream_agent_events): Raw event from SDK: type='{raw_event_type}'")

                # (Tool call/result handling omitted for brevity, see previous code)

                if (
                    hasattr(event, 'type') and event.type == "raw_response_event"
                    and isinstance(event.data, ResponseTextDeltaEvent)
                ):
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Yielding llm_chunk: {event.data.delta}")
                    yield f"{json.dumps({'type': 'llm_chunk', 'data': event.data.delta})}\n"
                    await asyncio.sleep(0.01)
                    continue

                if hasattr(event, 'type') and event.type in (
                    "raw_response_event",
                    "agent_updated_stream_event",
                    "run_item_stream_event",
                ):
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Ignoring SDK chatter event: {event.type}, Data type: {type(getattr(event, 'data', None))}")
                    continue

                # Fallback processing for other event types (omitted for brevity)

            break

        except UserError as ue:
            print(f"PY_AGENT_ERROR (stream_agent_events): UserError during agent streaming: {str(ue)}")
            print(f"PY_AGENT_ERROR (stream_agent_events): Traceback: {traceback.format_exc()}")
            yield f"{json.dumps({'type': 'error', 'data': f'Input format error for AI agent: {str(ue)}. Please check data structure.'})}\n"
            await asyncio.sleep(0.01)
            break

        except ModelBehaviorError as mbe:
            print(f"PY_AGENT_ERROR (stream_agent_events): ModelBehaviorError: {str(mbe)}")
            print(f"PY_AGENT_ERROR (stream_agent_events): Traceback: {traceback.format_exc()}")
            import re
            if "not found in agent" in str(mbe) and attempts_left > 0:
                print(f"PY_AGENT_WARNING (stream_agent_events): Retrying due to ModelBehaviorError. Attempts left: {attempts_left}")
                attempts_left -= 1
                await asyncio.sleep(0.5)
                continue
            else:
                error_tool_name_match = re.search(r"Tool ([\w\d_]+) not found in agent", str(mbe))
                error_tool_name = error_tool_name_match.group(1) if error_tool_name_match else "unknown"
                error_msg = f"Tool '{error_tool_name}' issue or model misbehavior: {str(mbe)}"
                yield f"{json.dumps({'type': 'final_message', 'data': {'content': error_msg, 'metadata': {'error': 'model_behavior_error', 'tool': error_tool_name}}})}\n"
                await asyncio.sleep(0.01)
                break

        except anyio.ClosedResourceError as cre:
            print(f"PY_AGENT_ERROR (stream_agent_events): ClosedResourceError: {str(cre)}")
            yield f"{json.dumps({'type': 'error', 'data': f'A connection was lost: {str(cre)}. Please try again.'})}\n"
            await asyncio.sleep(0.01)
            break

        except Exception as e:
            print(f"PY_AGENT_ERROR (stream_agent_events): General exception during agent streaming: {str(e)}")
            print(f"PY_AGENT_ERROR (stream_agent_events): Traceback: {traceback.format_exc()}")
            yield f"{json.dumps({'type': 'error', 'data': f'An unexpected issue occurred: {str(e)}.'})}\n"
            await asyncio.sleep(0.01)
            break

    print("PY_AGENT_DEBUG (stream_agent_events): Agent stream generator finished.")


@app.post("/generate")
async def generate_stream(req: ChatRequest, request: Request):
    if req.slackUserId:
        slack_user_id_var.set(req.slackUserId)

    print(f"PY_AGENT_DEBUG (/generate): Received ChatRequest. Prompt type from Pydantic: {type(req.prompt)}")

    # Process History
    processed_history = []
    for hist_msg_dict in req.history:
        if not (isinstance(hist_msg_dict, dict) and "role" in hist_msg_dict and "content" in hist_msg_dict):
            print(f"PY_AGENT_WARNING (/generate): Skipping malformed history message: {hist_msg_dict}")
            continue
        if hist_msg_dict["role"] == "system":
            continue

        formatted_content = format_message_content_for_agents_sdk(hist_msg_dict["content"])
        if formatted_content is not None:
            processed_history.append({"role": hist_msg_dict["role"], "content": formatted_content})

    # Process Current Prompt
    current_prompt_formatted_content = format_message_content_for_agents_sdk(req.prompt)

    cleaned_messages = list(processed_history)

    if current_prompt_formatted_content is not None and (
        (isinstance(current_prompt_formatted_content, str) and current_prompt_formatted_content.strip() != "") or
        (isinstance(current_prompt_formatted_content, list) and len(current_prompt_formatted_content) > 0)
    ):
        cleaned_messages.append({"role": "user", "content": current_prompt_formatted_content})
    else:
        print("PY_AGENT_DEBUG (/generate): Current prompt resulted in no content to append.")
        if not cleaned_messages or cleaned_messages[-1]["role"] != "user":
            print("PY_AGENT_WARNING (/generate): No user message to send, this might cause issues.")

    print(f"PY_AGENT_DEBUG (/generate): Final 'messages' list prepared for agent. Count: {len(cleaned_messages)}")
    if cleaned_messages:
        last_msg_content_summary = str(cleaned_messages[-1].get("content"))
        if len(last_msg_content_summary) > 200:
            last_msg_content_summary = last_msg_content_summary[:200] + "..."
        print(f"PY_AGENT_DEBUG (/generate): Last message in 'messages': role='{cleaned_messages[-1].get('role')}', content_summary='{last_msg_content_summary}'")

    if ACTIVE_MCP_SERVERS:
        print(f"PY_AGENT_DEBUG (/generate): Checking/Re-establishing connection to {len(ACTIVE_MCP_SERVERS)} MCP server(s)...")
        for server_instance in ACTIVE_MCP_SERVERS:
            try:
                if hasattr(server_instance, 'cache_tools_list') and server_instance.cache_tools_list:
                    if hasattr(server_instance, 'invalidate_tools_cache'):
                        server_instance.invalidate_tools_cache()
                await server_instance.connect()
            except Exception as mcp_req_conn_err:
                server_name = getattr(server_instance, 'name', 'Unknown MCP Server')
                print(f"PY_AGENT_ERROR (/generate): Failed during per-request MCP server connect for '{server_name}': {mcp_req_conn_err}. It may be unavailable.")

    async def managed_stream_wrapper():
        print("PY_AGENT_DEBUG (managed_stream_wrapper): Starting.")
        try:
            if not cleaned_messages:
                print("PY_AGENT_ERROR (managed_stream_wrapper): No messages to send to agent.")
                yield f"{json.dumps({'type': 'error', 'data': 'No messages to process.'})}\n"
                return

            last_message_for_agent = cleaned_messages[-1]
            if not last_message_for_agent.get("content") and not isinstance(last_message_for_agent.get("content"), str):
                print(f"PY_AGENT_ERROR (managed_stream_wrapper): Last message for agent has invalid content. Message: {last_message_for_agent}")
                yield f"{json.dumps({'type': 'error', 'data': 'Last message prepared for agent is empty or malformed.'})}\n"
                return

            async for event_json_line in stream_agent_events(_agent, cleaned_messages, max_retries=2):
                yield event_json_line
        except Exception as wrap_err:
            print(f"PY_AGENT_ERROR (managed_stream_wrapper): Error: {wrap_err}")
            print(f"PY_AGENT_ERROR (managed_stream_wrapper): Traceback: {traceback.format_exc()}")
            try:
                yield f"{json.dumps({'type': 'error', 'data': f'Stream wrapper error: {str(wrap_err)}'})}\n"
            except Exception:
                pass
        finally:
            print("PY_AGENT_DEBUG (managed_stream_wrapper): Finished.")

    return StreamingResponse(
        managed_stream_wrapper(),
        media_type="application/x-json-stream"
    )
