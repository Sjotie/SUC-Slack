import axios, { AxiosResponse } from 'axios';
import { Readable } from 'stream';
import {
    AIProvider, AIResponse, ConversationMessage,
    GenerateOptions, MessageContent, ModelInfo
} from '../interfaces/provider';
import { env } from '../../config/environment';
import { logger, logEmoji } from '../../utils/logger';

// Interface for streamed events from Python agent
export interface AgentStreamEvent {
    type: string;
    data: any;
}

export class PythonAgentClient implements AIProvider {
    public readonly name = 'PythonAgent';

    /**
     * Generates a streaming response from the Python agent.
     * Yields events as they are received from the agent.
     */
    async *generateResponseStream(
        prompt: string | MessageContent[],
        conversationHistory: ConversationMessage[],
        _unused?: unknown,
        options?: GenerateOptions,
        extra?: { slackUserId?: string }
    ): AsyncIterable<AgentStreamEvent> {
        let responseStream: Readable | null = null;
        try {
            logger.debug(`${logEmoji.ai} Requesting streaming response from Python agent: ${env.PY_AGENT_URL}/generate`);
            const axiosResponse: AxiosResponse<Readable> = await axios.post(
                `${env.PY_AGENT_URL}/generate`,
                {
                    prompt,
                    history: conversationHistory,
                    // Pass along the Slack user ID if provided
                    ...(extra && extra.slackUserId ? { slackUserId: extra.slackUserId } : {})
                },
                {
                    responseType: 'stream',
                    timeout: 180000
                }
            );
            responseStream = axiosResponse.data;
            logger.debug(`${logEmoji.ai} Stream connection established with Python agent.`);
        } catch (error: any) {
            logger.error(`${logEmoji.error} Error initiating stream connection to Python agent`, {
                errorMessage: error?.message,
                responseStatus: error?.response?.status,
                responseData: error?.response?.data
            });
            yield { type: 'error', data: `Failed to connect to agent service: ${error?.message || 'Unknown connection error'}` };
            return;
        }

        let buffer = '';
        try {
            for await (const chunk of responseStream) {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line) {
                        try {
                            const event: AgentStreamEvent = JSON.parse(line);
                            logger.debug(`${logEmoji.ai} Parsed event from stream: ${event.type}`);
                            yield event;
                        } catch (parseError) {
                            logger.warn(`${logEmoji.warning} Failed to parse JSON line from stream: ${line}`, { parseError });
                        }
                    }
                }
            }
            if (buffer.trim()) {
                logger.debug(`${logEmoji.ai} Processing remaining buffer data: ${buffer.trim()}`);
                try {
                    const event: AgentStreamEvent = JSON.parse(buffer.trim());
                    yield event;
                } catch (parseError) {
                    logger.warn(`${logEmoji.warning} Failed to parse final JSON line from stream: ${buffer.trim()}`, { parseError });
                }
            }
            logger.info(`${logEmoji.ai} Finished processing stream from Python agent.`);
        } catch (streamError: any) {
            logger.error(`${logEmoji.error} Error reading stream from Python agent`, { streamError: streamError?.message });
            yield { type: 'error', data: `Stream reading error: ${streamError?.message || 'Unknown stream error'}` };
        } finally {
            if (responseStream && typeof responseStream.destroy === 'function' && !responseStream.destroyed) {
                logger.debug(`${logEmoji.ai} Destroying response stream.`);
                responseStream.destroy();
            }
        }
    }

    async generateResponse(
        prompt: string | MessageContent[],
        conversationHistory: ConversationMessage[],
        functions?: any,
        options?: GenerateOptions
    ): Promise<AIResponse> {
        logger.warn(`${logEmoji.warning} Non-streaming generateResponse called on PythonAgentClient. This will collect the full response without intermediate updates.`);

        let finalContent = '';
        let finalFunctionCalls: any[] | undefined;
        let finalMetadata: Record<string, any> = {};

        const stream = this.generateResponseStream(prompt, conversationHistory, functions, options);

        for await (const event of stream) {
            switch (event.type) {
                case 'llm_chunk':
                    if (typeof event.data === 'string') {
                        finalContent += event.data;
                    }
                    break;
                case 'tool_calls':
                    logger.info(`Tool call occurred during non-streaming call: ${JSON.stringify(event.data)}`);
                    finalMetadata.tool_calls_occurred = true;
                    break;
                case 'final_message':
                    if (event.data && typeof event.data.content === 'string') {
                        finalContent = event.data.content;
                    }
                    if (event.data && event.data.metadata) {
                        finalMetadata = { ...finalMetadata, ...event.data.metadata };
                    }
                    if (event.data && event.data.functionCalls) {
                        finalFunctionCalls = event.data.functionCalls;
                    }
                    break;
                case 'error':
                    throw new Error(`Agent stream returned an error: ${event.data}`);
            }
        }

        return {
            content: finalContent,
            functionCalls: finalFunctionCalls,
            metadata: finalMetadata,
        };
    }

    supportsFunctionCalling(): boolean {
        return true;
    }

    async getAvailableModels(): Promise<ModelInfo[]> {
        return Promise.resolve([{
            id: 'python-agent-model',
            name: 'Agent-via-Python',
            provider: 'python-agent-service',
            capabilities: { functionCalling: true, vision: false, streaming: true },
            contextWindow: 128000,
        }]);
    }
}
