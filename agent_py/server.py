from fastapi import FastAPI, Request
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
import json
import os
import asyncio
import traceback  # Import traceback
import anyio      # For ClosedResourceError handling
import contextvars

# ------------------------------------------------------------------
# Verhoog de standaard-limiet van 10 beurten in de Agents-SDK.
# Stuur zelf `AGENT_MAX_TURNS` in je .env om dit dynamisch te zetten.
# ------------------------------------------------------------------
MAX_AGENT_TURNS = int(os.getenv("AGENT_MAX_TURNS", "32"))

# The Agents SDK usually installs an *agents* top-level package.
# If it isnt importable (e.g. the wheel exposes `openai_agents`
# instead), fall back gracefully:
try:
    from agents import Runner          # normal path (openai-agents  0.0.7)
    from agents.exceptions import ModelBehaviorError
except ModuleNotFoundError:
    from openai_agents import Runner   # fallback for some installs
    from openai_agents.exceptions import ModelBehaviorError
from custom_slack_agent import _agent, ACTIVE_MCP_SERVERS

from openai.types.responses import ResponseTextDeltaEvent
#  Well need the SDK exception class for targeted retries
from agents.exceptions import ModelBehaviorError

app = FastAPI(title="Slack-Agent API")

# --- Application Startup Event ---
@app.on_event("startup")
async def startup_event():
    print("PY_AGENT_INFO (startup): Application startup event triggered.")
    if ACTIVE_MCP_SERVERS:
        print(f"PY_AGENT_INFO (startup): Attempting to connect to {len(ACTIVE_MCP_SERVERS)} MCP server(s) on startup...")
        for server_instance in ACTIVE_MCP_SERVERS:
            try:
                # Invalidate cache before initial connect if caching is enabled
                if hasattr(server_instance, 'cache_tools_list') and server_instance.cache_tools_list:
                    if hasattr(server_instance, 'invalidate_tools_cache'):
                        server_instance.invalidate_tools_cache()
                        print(f"PY_AGENT_DEBUG (startup): Invalidated tools cache for MCP server '{server_instance.name}'.")
                await server_instance.connect()
                print(f"PY_AGENT_INFO (startup): Successfully connected to MCP server '{server_instance.name}'.")
            except Exception as e:
                print(f"PY_AGENT_ERROR (startup): Failed to connect to MCP server '{server_instance.name}' on startup: {e}")
                print(f"PY_AGENT_ERROR (startup): Traceback: {traceback.format_exc()}")
    else:
        print("PY_AGENT_INFO (startup): No active MCP servers configured for initial connection.")

class ChatRequest(BaseModel):
    prompt: str | list
    history: list
    slackUserId: str | None = None

class ChatResponse(BaseModel):
    content: str
    metadata: dict = {}

# --- Streaming generator for agent events ---
# (No longer manages connect/cleanup, only yields agent events)
async def stream_agent_events(agent, messages, *, max_retries: int = 2):
    print(f"PY_AGENT_DEBUG (stream_agent_events): Starting agent stream. Number of messages: {len(messages)}")

    # ------------------------------------------------------------------
    # Automatic retry loop for the well-known duplicated-tool-name bug
    # (Tool web_searchweb_search not found in agent , raised as
    # `agents.exceptions.ModelBehaviorError`).  We retry the whole turn
    # up to `max_retries` times before surfacing the error.
    # ------------------------------------------------------------------
    attempts_left = max_retries

    while True:        # <-- everything that follows is now inside this loop
        if messages:
            print(f"PY_AGENT_DEBUG (stream_agent_events): First message: {messages[0]}")
            print(f"PY_AGENT_DEBUG (stream_agent_events): Last message: {messages[-1]}")
        # For very detailed debugging of all messages (can be verbose):
        # print(f"PY_AGENT_DEBUG (stream_agent_events): Full messages list: {messages}")
        try:
            run_result = Runner.run_streamed(
                agent,
                messages,
                max_turns=MAX_AGENT_TURNS
            )
            print("PY_AGENT_DEBUG (stream_agent_events): Runner.run_streamed called, agent stream should start.")
            async for event in run_result.stream_events():
                # --- VERY RAW LOGGING FOR DEBUGGING ---
                print("PY_AGENT_RAW (stream_agent_events): event object repr:", repr(event))
                print("PY_AGENT_RAW (stream_agent_events): event object dir:", dir(event))
                try:
                    print("PY_AGENT_RAW (stream_agent_events): event as dict:", event.__dict__)
                except Exception:
                    print("PY_AGENT_RAW (stream_agent_events): event has no __dict__")
                # Let's log the raw event type before your processing
                raw_event_type = 'unknown_raw'
                if hasattr(event, 'type'):
                    raw_event_type = event.type
                elif hasattr(event, 'event') and isinstance(event.event, str): # For some SDK versions
                     raw_event_type = event.event

                print(f"PY_AGENT_DEBUG (stream_agent_events): Raw event from SDK: type='{raw_event_type}'")
                print(f"PY_AGENT_DEBUG (stream_agent_events): Raw event from SDK: type='{raw_event_type}'")

                # --- MCP/Tool use logging ---
                # Detect tool/function call events and log them
                # Common event types: 'tool_call', 'tool_result', 'tool_error', 'function_call', 'function_result', etc.
                # Also log errors and truncated payloads for debugging.
                if hasattr(event, 'type'):
                    # Tool/function call initiated
                    if event.type in ("tool_call", "function_call"):
                        # Try to extract function/tool name and arguments
                        call_name = getattr(event, "name", None) or getattr(event, "tool_name", None)
                        call_args = getattr(event, "arguments", None) or getattr(event, "args", None)
                        # Truncate arguments for log
                        if call_args is not None:
                            try:
                                call_args_str = json.dumps(call_args)
                            except Exception:
                                call_args_str = str(call_args)
                            if len(call_args_str) > 300:
                                call_args_str = call_args_str[:300] + "...[truncated]"
                        else:
                            call_args_str = "<none>"
                        print(f"========== MCP/TOOL CALL ==========")
                        print(f"PY_AGENT_MCP (tool_call): Calling tool/function '{call_name}' with args: {call_args_str}")
                        print(f"===================================")

                        # ----------  emit structured event naar Slack ----------
                        try:
                            yield (
                                json.dumps(
                                    {
                                        "type": "tool_calls",           # <- plural zodat Slack-handler het herkent
                                        "data": [
                                            {
                                                "function": {
                                                    "name": call_name,
                                                    "arguments": call_args,
                                                },
                                                "name": call_name          # back-compat
                                            }
                                        ],
                                    }
                                )
                                + "\n"
                            )
                            await asyncio.sleep(0.01)
                        except Exception as ser_err:
                            print(f"PY_AGENT_ERROR (stream_agent_events): Failed to serialize tool_call: {ser_err}")

                    # --- NEW: Handle tool/function calls from RunItemStreamEvent/tool_call_item ---
                    elif event.type == "run_item_stream_event":
                        # Handle `run_item_stream_event` variations
                        event_name = getattr(event, "name", None)

                        # ---------- 1. tool_called    tool_calls ----------
                        if event_name == "tool_called":
                            tool_item = getattr(event, "item", None)
                            if tool_item is not None:
                                raw_item = getattr(tool_item, "raw_item", None)

                                # helper om eigenschappen veilig op te halen
                                def _get_attr(obj, *names):
                                    for n in names:
                                        if hasattr(obj, n):
                                            return getattr(obj, n)
                                    return None

                                call_name = _get_attr(raw_item, "name", "tool_name") or _get_attr(tool_item, "name", "tool_name")
                                call_args = _get_attr(raw_item, "arguments", "args") or _get_attr(tool_item, "arguments", "args")

                                # Parse JSON-string naar dict indien nodig
                                if isinstance(call_args, str):
                                    try:
                                        call_args = json.loads(call_args)
                                    except Exception:
                                        pass
                                # Truncate arguments for log
                                if call_args is not None:
                                    try:
                                        call_args_str = json.dumps(call_args)
                                    except Exception:
                                        call_args_str = str(call_args)
                                    if len(call_args_str) > 300:
                                        call_args_str = call_args_str[:300] + "...[truncated]"
                                else:
                                    call_args_str = "<none>"
                                print(f"========== MCP/TOOL CALL (run_item_stream_event) ==========")
                                print(f"PY_AGENT_MCP (tool_call): Calling tool/function '{call_name}' with args: {call_args_str}")
                                print(f"==========================================================")

                                # Emit the tool_calls event
                                try:
                                    yield (
                                        json.dumps(
                                            {
                                                "type": "tool_calls",
                                                "data": [
                                                    {
                                                        "function": {
                                                            "name": call_name,
                                                            "arguments": call_args,
                                                        },
                                                        "name": call_name
                                                    }
                                                ],
                                            }
                                        )
                                        + "\n"
                                    )
                                    await asyncio.sleep(0.01)
                                except Exception as ser_err:
                                    print(f"PY_AGENT_ERROR (stream_agent_events): Failed to serialize tool_call (run_item_stream_event): {ser_err}")

                        # ---------- 2. tool_output    tool_result ----------
                        elif event_name == "tool_output":
                            output_item = getattr(event, "item", None)
                            if output_item is not None:
                                raw_item = getattr(output_item, "raw_item", None)
                                result_data = None

                                if raw_item is not None:
                                    result_data = getattr(raw_item, "output", None)
                                if result_data is None:
                                    result_data = getattr(output_item, "output", None)

                                # Parse JSON-string indien nodig
                                if isinstance(result_data, str):
                                    try:
                                        result_data = json.loads(result_data)
                                    except Exception:
                                        pass

                                try:
                                    yield (
                                        json.dumps(
                                            {
                                                "type": "tool_result",
                                                "data": {"result": result_data},
                                            }
                                        )
                                        + "\n"
                                    )
                                    await asyncio.sleep(0.01)
                                except Exception as ser_err:
                                    print(f"PY_AGENT_ERROR (stream_agent_events): Failed to serialize tool_result (run_item_stream_event): {ser_err}")
                    # Tool/function result
                    elif event.type in ("tool_result", "function_result"):
                        result = getattr(event, "result", None) or getattr(event, "data", None)
                        try:
                            result_str = json.dumps(result)
                        except Exception:
                            result_str = str(result)
                        if len(result_str) > 300:
                            result_str = result_str[:300] + "...[truncated]"
                        print(f"========== MCP/TOOL RESULT ==========")
                        print(f"PY_AGENT_MCP (tool_result): Tool/function result: {result_str}")
                        print(f"=====================================")

                        # ----------  emit structured result event ------------
                        try:
                            yield (
                                json.dumps(
                                    {
                                        "type": "tool_result",
                                        "data": {
                                            "tool_name": getattr(event, 'tool_name', None),
                                            "result": result,
                                        },
                                    }
                                )
                                + "\n"
                            )
                            await asyncio.sleep(0.01)
                        except Exception as ser_err:
                            print(f"PY_AGENT_ERROR (stream_agent_events): Failed to serialize tool_result: {ser_err}")
                    # Tool/function error
                    elif event.type in ("tool_error", "function_error"):
                        error_info = getattr(event, "error", None) or getattr(event, "data", None)
                        try:
                            error_str = json.dumps(error_info)
                        except Exception:
                            error_str = str(error_info)
                        if len(error_str) > 300:
                            error_str = error_str[:300] + "...[truncated]"
                        print(f"PY_AGENT_MCP (tool_error): Tool/function error: {error_str}")

                # --- Start of your existing event processing logic for 'raw_response_event' etc.
                if (
                    hasattr(event, 'type') and event.type == "raw_response_event"
                    and isinstance(event.data, ResponseTextDeltaEvent)
                ):
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Yielding llm_chunk: {event.data.delta}")
                    yield f"{json.dumps({'type': 'llm_chunk', 'data': event.data.delta})}\n"
                    await asyncio.sleep(0.01)
                    continue

                if hasattr(event, 'type') and event.type == "raw_response_event":
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Ignoring raw_response_event (not ResponseTextDeltaEvent). Data: {type(event.data)}")
                    continue
                if hasattr(event, 'type') and event.type == "raw_response_event":
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Ignoring raw_response_event (not ResponseTextDeltaEvent). Data: {type(event.data)}")
                    continue

                if hasattr(event, 'type') and event.type in (
                    "agent_updated_stream_event",
                    "run_item_stream_event",
                ):
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Ignoring SDK chatter event: {event.type}")
                    continue
                
                # Fallback processing
                output_event = None
                event_type_str = 'unknown_fallback'
                event_data_processed = None
                try:
                    event_type_str = getattr(event, 'type', 'unknown_fallback_attr')
                    event_data_raw = getattr(event, 'data', None)
                    try:
                        json.dumps(event_data_raw) # Test serializability
                        event_data_processed = event_data_raw
                    except TypeError:
                        print(f"PY_AGENT_DEBUG (stream_agent_events): Warning: Event data for type '{event_type_str}' is not directly JSON serializable. Converting to string.")
                        event_data_processed = str(event_data_raw)
                    output_event = {"type": event_type_str, "data": event_data_processed}
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Streaming event (fallback): type='{event_type_str}'")
                except Exception as processing_error:
                    print(f"PY_AGENT_DEBUG (stream_agent_events): Error processing event structure: {processing_error}")
                    output_event = {"type": "processing_error", "data": f"Failed to process event: {str(processing_error)}"}
                
                if output_event:
                    try:
                        yield f"{json.dumps(output_event)}\n"
                        await asyncio.sleep(0.01)
                    except TypeError as json_error:
                        print(f"PY_AGENT_DEBUG (stream_agent_events): Error serializing processed event to JSON: {json_error}")
                        yield f"{json.dumps({'type': 'error', 'data': f'JSON serialization error for event type {event_type_str}'})}\n"
                        await asyncio.sleep(0.01)
                # --- End of your existing event processing logic
                
        except Exception as e:
            # This will catch errors from Runner.run_streamed or during the async for loop setup
            print(f"PY_AGENT_ERROR (stream_agent_events): Exception during agent streaming execution: {str(e)}")
            print(f"PY_AGENT_ERROR (stream_agent_events): Traceback: {traceback.format_exc()}")

            # --- Automatic retry for duplicated-tool-name ModelBehaviorError ---
            if isinstance(e, ModelBehaviorError) and "not found in agent" in str(e):
                if attempts_left > 0:
                    print(
                        f"PY_AGENT_WARNING (stream_agent_events): Retrying turn "
                        f"because of ModelBehaviorError. Attempts left: {attempts_left}"
                    )
                    attempts_left -= 1
                    await asyncio.sleep(0.5)   # brief back-off
                    continue                   # restart the outer while-loop

                # If out of attempts, notify the AI model and user
                error_tool_name = None
                import re
                match = re.search(r"Tool ([\w\d_]+) not found in agent", str(e))
                if match:
                    error_tool_name = match.group(1)
                error_msg = (
                    f"De gevraagde tool '{error_tool_name}' is niet beschikbaar voor deze gebruiker of is niet correct geconfigureerd. "
                    "Probeer een andere tool of neem contact op met de beheerder."
                )
                # Yield a final_message event to the AI client so it can show this as a user-facing message
                yield f"{json.dumps({'type': 'final_message', 'data': {'content': error_msg, 'metadata': {'error': 'tool_not_found', 'tool': error_tool_name}}})}\n"
                await asyncio.sleep(0.01)
                break

            # Check if it's a ClosedResourceError and try to reset the MCP connection flag
            if isinstance(e, anyio.ClosedResourceError):
                print(f"PY_AGENT_WARNING (stream_agent_events): ClosedResourceError detected. Resetting MCP connection flag.")
                # Try to reset the _connected flag on the global railway_mcp_server object
                if 'railway_mcp_server' in globals():
                    railway = globals()['railway_mcp_server']
                    if hasattr(railway, "_connected"):
                        try:
                            setattr(railway, "_connected", False)
                            print(f"PY_AGENT_DEBUG (stream_agent_events): MCP _connected flag reset to False.")
                        except Exception as flag_err:
                            print(f"PY_AGENT_ERROR (stream_agent_events): Could not reset MCP flag: {flag_err}")

            yield f"{json.dumps({'type': 'error', 'data': f'Agent execution failed: {str(e)}'})}\n"
            await asyncio.sleep(0.01)
        finally:
            print("PY_AGENT_DEBUG (stream_agent_events): Agent stream generator finished.")

        # Successful completion  break out of the retry loop
        break


@app.post("/generate")
async def generate_stream(req: ChatRequest, request: Request):
    # Set the slack_user_id in a context variable for downstream use in tool filtering
    slack_user_id_var = contextvars.ContextVar("slack_user_id")
    if req.slackUserId:
        slack_user_id_var.set(req.slackUserId)
    print(f"PY_AGENT_DEBUG (/generate): Received request. Prompt type: {type(req.prompt)}")
    if isinstance(req.prompt, list):
        # Log only a summary if prompt is a list to avoid huge logs, e.g., for images
        prompt_summary = []
        for item in req.prompt:
            if isinstance(item, dict) and item.get("type") == "input_image":
                prompt_summary.append({"type": "input_image", "image_url_type": type(item.get("image_url")).__name__})
            elif isinstance(item, dict) and item.get("type") == "text":
                 prompt_summary.append({"type": "text", "text_len": len(item.get("text",""))})
            else:
                prompt_summary.append(str(item)[:100]) # Truncate other types
        print(f"PY_AGENT_DEBUG (/generate): Prompt (summarized list): {prompt_summary}")
    else:
        print(f"PY_AGENT_DEBUG (/generate): Prompt: {str(req.prompt)[:500]}") # Truncate long strings

    print(f"PY_AGENT_DEBUG (/generate): History - Number of messages: {len(req.history)}")
    if req.history:
        # Log summary of history
        history_summary = [{"role": msg.get("role", "N/A"), "content_type": type(msg.get("content")).__name__} for msg in req.history]
        print(f"PY_AGENT_DEBUG (/generate): History (summarized): {history_summary}")

    # Log the Slack user ID if present
    if req.slackUserId:
        print(f"PY_AGENT_DEBUG (/generate): Slack user ID received: {req.slackUserId}")


    cleaned_messages = []
    for hist_msg in req.history:
        if isinstance(hist_msg, dict) and "role" in hist_msg and "content" in hist_msg:
            # Skip system messages from history to ensure only the agent's system prompt is used
            if hist_msg["role"] == "system":
                print(f"PY_AGENT_DEBUG (/generate): Ignoring incoming system message from history: '{str(hist_msg.get('content', ''))[:100]}...'")
                continue  # Do not include system messages from client history
            cleaned_msg = {"role": hist_msg["role"], "content": hist_msg["content"]}
            if hist_msg["role"] == "tool":
                if "tool_call_id" in hist_msg:
                    cleaned_msg["tool_call_id"] = hist_msg["tool_call_id"]
                if "name" in hist_msg:
                    cleaned_msg["name"] = hist_msg["name"]
            elif hist_msg["role"] == "assistant" and "tool_calls" in hist_msg:
                cleaned_msg["tool_calls"] = hist_msg["tool_calls"]
            cleaned_messages.append(cleaned_msg)
    
    # Check type of req.prompt before appending
    if isinstance(req.prompt, str) or isinstance(req.prompt, list):
        cleaned_messages.append({"role": "user", "content": req.prompt})
    else:
        # Fallback if req.prompt is neither string nor list (should not happen with Pydantic validation)
        print(f"PY_AGENT_WARNING (/generate): req.prompt is of unexpected type: {type(req.prompt)}. Converting to string.")
        cleaned_messages.append({"role": "user", "content": str(req.prompt)})

    print(f"PY_AGENT_DEBUG (/generate): Cleaned messages prepared for agent. Count: {len(cleaned_messages)}")
    if cleaned_messages:
        print(f"PY_AGENT_DEBUG (/generate): Last cleaned message (current user prompt part): {cleaned_messages[-1]}")

    # Per-request MCP connection check and re-establishment
    if ACTIVE_MCP_SERVERS:
        print(f"PY_AGENT_DEBUG (/generate): Checking/Re-establishing connection to {len(ACTIVE_MCP_SERVERS)} MCP server(s) before agent run...")
        for server_instance in ACTIVE_MCP_SERVERS:
            try:
                # Always invalidate cache before connect if caching is on,
                # as connect() might establish a new session.
                if hasattr(server_instance, 'cache_tools_list') and server_instance.cache_tools_list:
                    if hasattr(server_instance, 'invalidate_tools_cache'):
                        server_instance.invalidate_tools_cache()
                        print(f"PY_AGENT_DEBUG (/generate): Invalidated tools cache for MCP server '{server_instance.name}'.")
                await server_instance.connect()  # Attempt to connect or re-establish
                print(f"PY_AGENT_DEBUG (/generate): MCP server '{server_instance.name}' connect() call completed for request.")
            except Exception as mcp_req_conn_err:
                print(f"PY_AGENT_ERROR (/generate): Failed during per-request MCP server connect for '{server_instance.name}': {mcp_req_conn_err}")
                # If MCP is critical, you might want to yield an error here and stop.
                # Example:
                # return StreamingResponse(
                #     (f"{json.dumps({'type': 'error', 'data': f'Critical MCP connection failed for {server_instance.name}: {str(mcp_req_conn_err)}'})}\n" async for _ in []),
                #     media_type="application/x-json-stream"
                # )


    async def managed_stream_wrapper():
        print("PY_AGENT_DEBUG (managed_stream_wrapper): Starting.")
        try:
            async for event_json_line in stream_agent_events(_agent, cleaned_messages, max_retries=2):
                yield event_json_line
        except Exception as wrap_err:
            print(f"PY_AGENT_ERROR (managed_stream_wrapper): Error: {wrap_err}")
            print(f"PY_AGENT_ERROR (managed_stream_wrapper): Traceback: {traceback.format_exc()}")
            try:
                yield f"{json.dumps({'type': 'error', 'data': f'Stream wrapper error: {str(wrap_err)}'})}\n"
            except Exception:
                pass # Avoid error in error reporting
        finally:
            print("PY_AGENT_DEBUG (managed_stream_wrapper): Finished.")


    return StreamingResponse(
        managed_stream_wrapper(),
        media_type="application/x-json-stream"
    )
