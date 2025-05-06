/**
 * Slack Event Handlers
 * 
 * This module registers event handlers for various Slack events.
 * It serves as the entry point for all event-related functionality.
 */

import { app } from '../app';
import { logger, logEmoji } from '../../utils/logger';
import { PythonAgentClient, AgentStreamEvent } from '../../ai/agent-api/client';
import { MessageContent, ImageContent } from '../../ai/interfaces/provider';
import { contextManager } from '../../ai/context/manager';
import * as conversationUtils from '../utils/conversation';
import * as blockKit from '../utils/block-kit';
import { ThreadInfo } from '../utils/conversation';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';

// Helper function to download image and convert to Base64 data URI
async function downloadAndEncodeImage(fileUrl: string, filetype: string): Promise<string | null> {
    try {
        logger.info(`${logEmoji.info} Downloading image for Base64 encoding: ${fileUrl}`);
        const response = await axios.get<Buffer>(
            fileUrl,
            {
                responseType: 'arraybuffer',
                headers: {
                    'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
                }
            }
        );

        if (response.status === 200 && response.data) {
            const base64String = Buffer.from(response.data).toString('base64');
            const mimeType = `image/${filetype.toLowerCase()}`;
            const dataUri = `data:${mimeType};base64,${base64String}`;
            logger.info(`${logEmoji.info} Successfully encoded image to data URI (length: ${dataUri.length})`);
            return dataUri;
        } else {
            logger.error(`${logEmoji.error} Failed to download image, status: ${response.status}`);
            return null;
        }
    } catch (error: any) {
        logger.error(`${logEmoji.error} Error downloading or encoding image`, {
             errorMessage: error?.message,
             status: error?.response?.status
            });
        return null;
    }
}

const aiClient = new PythonAgentClient();
let botUserId: string | undefined;

app.event('app_home_opened', async ({ client }) => {
    try {
        if (!botUserId) {
            const authInfo = await client.auth.test();
            botUserId = authInfo.user_id;
            logger.info(`${logEmoji.slack} Bot user ID initialized: ${botUserId}`);
        }
    } catch (error) {
        logger.error(`${logEmoji.error} Error initializing bot user ID`, { error });
    }
});

/**
 * Process a message using the streaming AI agent and update Slack.
 */
async function processMessageAndGenerateResponse(
    threadInfo: ThreadInfo,
    messageTextOrContent: string | MessageContent[],
    client: any
): Promise<void> {
    let thinkingMessageTs: string | undefined;
    let lastMessageTs: string | undefined;
    let accumulatedContent = '';
    let finalMetadata: Record<string, any> | undefined;

    try {
        // --- START TOEGEVOEGDE CODE ---
        // Haal botUserId op indien nog niet bekend
        if (!botUserId) {
            try {
                logger.info(`${logEmoji.slack} Bot user ID not initialized, fetching...`);
                const authInfo = await client.auth.test();
                botUserId = authInfo.user_id;
                if (!botUserId) {
                    throw new Error('Failed to get bot user ID from auth.test');
                }
                logger.info(`${logEmoji.slack} Bot user ID initialized: ${botUserId}`);
            } catch (authError) {
                logger.error(`${logEmoji.error} CRITICAL: Could not determine bot user ID. Cannot process message.`, { authError });
                await conversationUtils.sendErrorMessage(
                    app,
                    threadInfo,
                    'Bot Initialization Error',
                    'Sorry, I could not retrieve my own user ID. Please notify an administrator.'
                );
                return;
            }
        }
        // Hierna is botUserId gegarandeerd een string
        const currentBotUserIdForHistory = botUserId;
        // --- EINDE TOEGEVOEGDE CODE ---

        // 1. Send initial "Thinking..." message
        const thinkingMessage = await client.chat.postMessage({
            channel: threadInfo.channelId,
            thread_ts: threadInfo.threadTs,
            ...blockKit.loadingMessage('Thinking...')
        });
        thinkingMessageTs = thinkingMessage.ts as string;
        lastMessageTs = thinkingMessageTs;
        logger.debug(`${logEmoji.slack} Sent thinking message ${thinkingMessageTs} to thread ${threadInfo.threadTs}`);

        // 2. Initialize context (fetch history etc.)
        await conversationUtils.initializeContextFromHistory(app, threadInfo, currentBotUserIdForHistory);
        const conversationHistory = conversationUtils.getThreadHistory(threadInfo);
        conversationUtils.addUserMessageToThread(threadInfo, messageTextOrContent);

        // 3. Call the STREAMING function of the AI client
        const eventStream = aiClient.generateResponseStream(
            messageTextOrContent,
            conversationHistory
        );

        // 4. Process the events from the stream
        let updateScheduled = false;
        const UPDATE_INTERVAL_MS = 750;

        const scheduleUpdate = async () => {
            if (updateScheduled) return;
            updateScheduled = true;

            setTimeout(async () => {
                try {
                    if (!lastMessageTs) return;
                    const messageUpdate = blockKit.aiResponseMessage(accumulatedContent + ' ');
                    await conversationUtils.updateMessage(
                        app,
                        threadInfo.channelId,
                        lastMessageTs,
                        messageUpdate.blocks as any[],
                        messageUpdate.text + ' '
                    );
                    logger.debug(`${logEmoji.slack} Updated message ${lastMessageTs} with streamed content chunk.`);
                } catch (error) {
                    logger.error(`${logEmoji.error} Failed to update Slack message during stream`, { ts: lastMessageTs, error });
                } finally {
                    updateScheduled = false;
                }
            }, UPDATE_INTERVAL_MS);
        };

        for await (const event of eventStream) {
            logger.debug(`${logEmoji.ai} Received agent event: ${event.type}`);

            switch (event.type) {
                case 'llm_chunk':
                    if (typeof event.data === 'string' && event.data) {
                        accumulatedContent += event.data;
                        scheduleUpdate();
                    }
                    break;

                case 'tool_calls':
                    if (lastMessageTs) {
                        const finalChunkUpdate = blockKit.aiResponseMessage(accumulatedContent);
                        await conversationUtils.updateMessage(app, threadInfo.channelId, lastMessageTs, finalChunkUpdate.blocks as any[], finalChunkUpdate.text);
                    }
                    const toolCallsData = event.data;
                    if (Array.isArray(toolCallsData) && toolCallsData.length > 0) {
                        const toolName = toolCallsData[0]?.function?.name || toolCallsData[0]?.name || 'een tool';
                        const thinkingText = `Oké, ik gebruik nu de tool \`${toolName}\`... ${logEmoji.mcp}`;
                        try {
                            const toolThinkingMsg = await client.chat.postMessage({
                                channel: threadInfo.channelId,
                                thread_ts: threadInfo.threadTs,
                                ...blockKit.loadingMessage(thinkingText)
                            });
                            lastMessageTs = toolThinkingMsg.ts as string;
                            accumulatedContent = '';
                            logger.info(`${logEmoji.slack} Posted tool usage message ${lastMessageTs} for tool ${toolName}`);
                        } catch (postError) {
                            logger.error(`${logEmoji.error} Failed to post tool usage message`, { postError });
                            lastMessageTs = lastMessageTs || thinkingMessageTs;
                        }
                    }
                    break;

                case 'tool_result':
                    if (lastMessageTs) {
                        const toolResultData = event.data;
                        const resultSummary = typeof toolResultData === 'string' ? toolResultData.substring(0, 100) + '...' : '[resultaat ontvangen]';
                        const messageUpdate = blockKit.aiResponseMessage(`Tool \`${event.data?.tool_name || 'tool'}\` klaar. ${resultSummary}`);
                        await conversationUtils.updateMessage(app, threadInfo.channelId, lastMessageTs, messageUpdate.blocks as any[], messageUpdate.text);
                        logger.info(`${logEmoji.slack} Updated tool usage message ${lastMessageTs} with result.`);
                    }
                    break;

                case 'final_message':
                    const finalData = event.data;
                    if (finalData && typeof finalData.content === 'string') {
                        accumulatedContent = finalData.content;
                    }
                    if (finalData && finalData.metadata) {
                        finalMetadata = finalData.metadata;
                    }
                    break;

                case 'error':
                    logger.error(`${logEmoji.error} Error received from agent stream:`, event.data);
                    if (lastMessageTs) {
                        const errorBlocks = blockKit.errorMessage('Agent Error', 'Er is een fout opgetreden bij de agent.', String(event.data));
                        await conversationUtils.updateMessage(app, threadInfo.channelId, lastMessageTs, errorBlocks.blocks as any[], errorBlocks.text);
                    }
                    return;

                default:
                    logger.warn(`${logEmoji.warning} Received unknown/unhandled agent event type: ${event.type}`);
            }
        }

        // 5. Final update after the stream
        if (lastMessageTs) {
            logger.info(`${logEmoji.slack} Stream finished. Updating final message ${lastMessageTs}.`);
            await new Promise(resolve => setTimeout(resolve, UPDATE_INTERVAL_MS + 100));
            const finalMessage = blockKit.aiResponseMessage(accumulatedContent, finalMetadata);
            await conversationUtils.updateMessage(
                app,
                threadInfo.channelId,
                lastMessageTs,
                finalMessage.blocks as any[],
                finalMessage.text
            );
            conversationUtils.addAssistantMessageToThread(threadInfo, accumulatedContent);
        } else {
            logger.error(`${logEmoji.error} No message TS found to update after stream completed.`);
        }

    } catch (error) {
        logger.error(`${logEmoji.error} Error processing message stream or initial setup`, {
            errorMessage: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        if (thinkingMessageTs) {
            try {
                const errorBlocks = blockKit.errorMessage('Error Processing Request', 'An error occurred while generating the response.', error instanceof Error ? error.message : String(error));
                await conversationUtils.updateMessage(
                    app,
                    threadInfo.channelId,
                    thinkingMessageTs,
                    errorBlocks.blocks as any[],
                    errorBlocks.text
                );
            } catch (updateError) {
                logger.error(`${logEmoji.error} Failed to update thinking message ${thinkingMessageTs} with processing error`, { updateError });
            }
        } else {
            await conversationUtils.sendErrorMessage(
                app,
                threadInfo,
                'Error Processing Request',
                'An error occurred while generating the response.',
                error instanceof Error ? error.message : String(error)
            );
        }
    }
}


async function transcribeAudioWithOpenAI(fileUrl: string, prompt?: string, filetype?: string): Promise<string> {
    // Use the filetype from Slack if available, default to mp3
    const ext = filetype ? filetype.toLowerCase() : 'mp3';
    const tempDir = os.tmpdir();               // cross-platform temp directory
    const tempFilePath = path.join(
      tempDir,
      `${Date.now()}-audio-upload.${ext}`
    );
    require('fs').mkdirSync(tempDir, { recursive: true });  // ensure dir exists
    const writer = require('fs').createWriteStream(tempFilePath);

    // Add Slack auth header if needed
    const headers: Record<string, string> = {};
    if (process.env.SLACK_BOT_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.SLACK_BOT_TOKEN}`;
    }

    logger.info(`${logEmoji.info} Downloading audio file from Slack: ${fileUrl}`);
    logger.info(`[DEBUG] Slack download headers: ${JSON.stringify(headers)}`);
    const response = await axios.get(fileUrl, { responseType: 'stream', headers });
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    logger.info(`${logEmoji.info} Audio file downloaded to: ${tempFilePath}`);

    // Prepare form data for OpenAI API
    const FormData = require('form-data');
    const formData = new FormData();
    // Pass the filename explicitly so OpenAI can infer the format
    formData.append('file', require('fs').createReadStream(tempFilePath), { filename: `audio.${ext}` });
    formData.append('model', 'gpt-4o-transcribe');
    if (prompt) {
        formData.append('prompt', prompt);
    }
    formData.append('response_format', 'text');

    logger.info(`${logEmoji.info} Sending audio file to OpenAI for transcription...`);
    // Use only OPENAI_API_KEY for direct OpenAI calls
    const openaiApiKey = process.env.OPENAI_API_KEY;
    logger.info(`[DEBUG] OpenAI transcription headers: ${JSON.stringify({
        ...formData.getHeaders(),
        'Authorization': `Bearer ${openaiApiKey}`,
    })}`);
    // Call OpenAI API
    try {
        const openaiResponse = await axios.post(
            'https://api.openai.com/v1/audio/transcriptions',
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'Authorization': `Bearer ${openaiApiKey}`,
                },
            }
        );

        logger.info(`${logEmoji.info} Received transcription from OpenAI`);
        logger.info(`[DEBUG] OpenAI transcription response: ${JSON.stringify(openaiResponse.data)}`);

        // Clean up temp file
        require('fs').unlinkSync(tempFilePath);

        // Defensive: OpenAI returns { text: ... } for JSON, or a string for 'text' response_format
        if (typeof openaiResponse.data === 'string') {
            return openaiResponse.data;
        }
        if (typeof openaiResponse.data.text === 'undefined' || openaiResponse.data.text === null) {
            logger.warn(`${logEmoji.warning} OpenAI transcription returned undefined or null text`);
            return '[transcriptie niet beschikbaar]';
        }
        if (typeof openaiResponse.data.text !== 'string') {
            logger.warn(`${logEmoji.warning} OpenAI transcription returned non-string text: ${typeof openaiResponse.data.text}`);
            return '[transcriptie niet beschikbaar]';
        }

        return openaiResponse.data.text;
    } catch (err: any) {
        logger.error(`[DEBUG] OpenAI transcription error: ${err?.message || err}`);
        if (err?.response) {
            logger.error(`[DEBUG] OpenAI error response data: ${JSON.stringify(err.response.data)}`);
            logger.error(`[DEBUG] OpenAI error response headers: ${JSON.stringify(err.response.headers)}`);
        }
        // Clean up temp file even on error
        try { require('fs').unlinkSync(tempFilePath); } catch {}
        throw err;
    }
}

app.message(async ({ message, client, context }) => {
    try {
        logger.debug(`${logEmoji.slack} Received message event: ${JSON.stringify(message)}`);

        // Ensure we have a proper message with a user
        if (!('user' in message) || !message.user) {
            logger.debug(`${logEmoji.slack} Ignoring message without user`);
            return;
        }

        // Ignore messages from the bot itself
        if (botUserId && message.user === botUserId) {
            return;
        }

        // Check for file uploads
        // Defensive: files may not exist on all message types, so use optional chaining and fallback to []
        const files: any[] = (message as any)?.files && Array.isArray((message as any).files)
            ? (message as any).files
            : [];
        let transcript: string | undefined;
        let postedTranscript = false;

        // --- Detect and handle image uploads (jpg, png, gif, webp, etc.) ---
        const imageFileTypes = ['jpg','jpeg','png','gif','webp','bmp','tiff'];
        const imageFiles = files.filter((f: any) =>
            f.url_private_download &&
            imageFileTypes.includes((f.filetype || '').toLowerCase())
        );

        if (imageFiles.length) {
            logger.info(`${logEmoji.info} Found ${imageFiles.length} image file(s) to process.`);
            const imageDataUris: string[] = [];

            for (const file of imageFiles) {
                const dataUri = await downloadAndEncodeImage(file.url_private_download, file.filetype);
                if (dataUri) {
                    imageDataUris.push(dataUri);
                } else {
                    logger.warn(`${logEmoji.warning} Could not process image file: ${file.name} (ID: ${file.id})`);
                }
            }

            if (imageDataUris.length === 0) {
                logger.error(`${logEmoji.error} No images could be successfully downloaded and encoded.`);
                return;
            }

            // Combine optional text + all successfully encoded images
            const multimodalContent: MessageContent[] = [];
            if (message.text && message.text.trim()) {
                multimodalContent.push({ type: 'text', text: message.text.trim() });
            }
            multimodalContent.push(
                ...imageDataUris.map(dataUri => ({
                    type: 'input_image' as const,
                    image_url: dataUri
                }))
            );

            const threadInfo: ThreadInfo = {
                channelId: message.channel,
                threadTs: 'thread_ts' in message && message.thread_ts ? message.thread_ts : message.ts,
                userId: message.user,
            };

            await processMessageAndGenerateResponse(threadInfo, multimodalContent, client);
            return; // text + images already handled
        }

        if (files.length > 0) {
            // Accept all OpenAI-supported audio types, including mp4
            const audioFile = files.find((f: any) =>
                ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'flac', 'ogg', 'oga'].includes((f.filetype || '').toLowerCase())
            );
            if (audioFile && audioFile.url_private_download) {
                // Download and transcribe
                const fileUrl = audioFile.url_private_download;
                // Use the user's message as prompt if present
                const userPrompt = message.text || undefined;
                logger.info(`${logEmoji.info} Starting transcription for uploaded audio file: ${fileUrl}`);
                transcript = await transcribeAudioWithOpenAI(fileUrl, userPrompt, audioFile.filetype);

                // Post the raw transcript in a code block
                const threadInfo: ThreadInfo = {
                    channelId: message.channel,
                    threadTs: 'thread_ts' in message && message.thread_ts ? message.thread_ts : message.ts,
                    userId: message.user,
                };
                logger.info(`${logEmoji.info} Posting transcript to Slack thread ${threadInfo.threadTs}`);
                // Strip trailing newlines from transcript to avoid extra empty line in code block
                const cleanedTranscript = typeof transcript === 'string' ? transcript.replace(/[\r\n]+$/, '') : transcript;
                await client.chat.postMessage({
                    channel: threadInfo.channelId,
                    thread_ts: threadInfo.threadTs,
                    text: `Transcript:\n\`\`\`\n${cleanedTranscript}\n\`\`\``,
                });
                postedTranscript = true;

                // Only for DMs and "wiz" channels, also send transcript+user message to the AI model
                let shouldRespond = false;
                let isWizChannel = false;
                if (message.channel_type === 'im') {
                    shouldRespond = true;
                } else if (message.channel_type === 'channel' || message.channel_type === 'group') {
                    try {
                        const channelInfo = await client.conversations.info({ channel: message.channel });
                        const channelName = channelInfo.channel?.name || '';
                        if (channelName.startsWith('wiz')) {
                            shouldRespond = true;
                            isWizChannel = true;
                        }
                    } catch (err) {
                        logger.error(`${logEmoji.error} Failed to fetch channel info for channel ${message.channel}`, { err });
                    }
                }

                if (shouldRespond) {
                    // Compose input: transcript + user message (if any)
                    let aiInput = transcript;
                    if (message.text && message.text.trim()) {
                        aiInput = `${transcript}\n\nUser message: ${message.text}`;
                    }
                    logger.info(`${logEmoji.info} Sending transcript and user message to AI model for thread ${threadInfo.threadTs}`);
                    await processMessageAndGenerateResponse(threadInfo, aiInput, client);
                } else {
                    logger.info(`${logEmoji.info} Not sending transcript to AI model (not a DM or wiz channel)`);
                }
                // For non-wiz channels and non-DMs, do not send to AI, only post transcript
                return;
            }
        }

        // Only respond in DMs or if channel name starts with "wiz"
        let shouldRespond = false;
        if (message.channel_type === 'im') {
            shouldRespond = true;
        } else if (message.channel_type === 'channel' || message.channel_type === 'group') {
            try {
                const channelInfo = await client.conversations.info({ channel: message.channel });
                const channelName = channelInfo.channel?.name || '';
                if (channelName.startsWith('wiz')) {
                    shouldRespond = true;
                }
            } catch (err) {
                logger.error(`${logEmoji.error} Failed to fetch channel info for channel ${message.channel}`, { err });
            }
        }

        if (!shouldRespond) {
            logger.debug(`${logEmoji.slack} Not responding: not a DM and channel name does not start with "wiz"`);
            return;
        }

        // Only process text if not already handled as audio
        if (!postedTranscript && message.text) {
            const threadInfo: ThreadInfo = {
                channelId: message.channel,
                threadTs: 'thread_ts' in message && message.thread_ts ? message.thread_ts : message.ts,
                userId: message.user,
            };
            await processMessageAndGenerateResponse(threadInfo, message.text, client);
        }
    } catch (error) {
        logger.error(`${logEmoji.error} Error handling message event`, { error });
    }
});

// Handle app_mention events
app.event('app_mention', async ({ event, client }) => {
    try {
        logger.debug(`${logEmoji.slack} Received app_mention event: ${JSON.stringify(event)}`);

        // Create thread info
        const threadInfo: ThreadInfo = {
            channelId: event.channel,
            threadTs: 'thread_ts' in event && event.thread_ts ? event.thread_ts : event.ts,
            userId: event.user,
        };

        // Process the message and generate a response
        await processMessageAndGenerateResponse(threadInfo, event.text, client);
    } catch (error) {
        logger.error(`${logEmoji.error} Error handling app_mention event`, { error });
    }
});

// Handle assistant_thread_started events
app.event('assistant_thread_started', async ({ event, client }) => {
    try {
        logger.debug(`${logEmoji.slack} Received assistant_thread_started event: ${JSON.stringify(event)}`);

        // Type assertion for the event object to handle potential structure variations
        const assistantEvent = event as any;
        const channelId = assistantEvent.channel || '';
        const threadTs = assistantEvent.ts || '';
        const userId = assistantEvent.user || '';

        if (!channelId || !threadTs) {
            logger.warn(`${logEmoji.warning} Missing channel or thread info in assistant_thread_started event`);
            return;
        }

        // Create thread info
        const threadInfo: ThreadInfo = {
            channelId,
            threadTs,
            userId,
        };

        // Create a new context for this thread
        contextManager.createContext(threadTs, channelId, userId);

        // Send a welcome message
        await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            ...blockKit.aiResponseMessage(
                "Hello! I'm your AI assistant. How can I help you today?"
            )
        });
    } catch (error) {
        logger.error(`${logEmoji.error} Error handling assistant_thread_started event`, { error });
    }
});

// Handle assistant_thread_context_changed events
app.event('assistant_thread_context_changed', async ({ event }) => {
    try {
        logger.debug(`${logEmoji.slack} Received assistant_thread_context_changed event: ${JSON.stringify(event)}`);

        // Type assertion for the event object
        const contextEvent = event as any;
        const channelId = contextEvent.channel || '';
        const threadTs = contextEvent.thread_ts || '';
        const contextPayload = contextEvent.context_payload;

        if (!channelId || !threadTs) {
            logger.warn(`${logEmoji.warning} Missing channel or thread info in assistant_thread_context_changed event`);
            return;
        }

        // Update the system message if context payload is provided
        if (contextPayload && typeof contextPayload === 'string') {
            conversationUtils.updateSystemMessageForThread(
                { channelId, threadTs },
                contextPayload
            );
            logger.info(`${logEmoji.slack} Updated system message for thread ${threadTs} with new context`);
        }
    } catch (error) {
        logger.error(`${logEmoji.error} Error handling assistant_thread_context_changed event`, { error });
    }
});

logger.info(`${logEmoji.slack} Slack event handlers registered`);
