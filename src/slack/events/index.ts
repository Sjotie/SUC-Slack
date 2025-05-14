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
import { SLACK_CONFIG } from '../../config/constants';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';

// Simple cache for usernames
const userNameCache = new Map<string, string>();

// Function to get username (fetches from Slack API if not cached)
async function getUserName(userId: string, client: any): Promise<string> {
    if (!userId) return 'Gebruiker'; // Fallback
    if (userNameCache.has(userId)) {
        return userNameCache.get(userId)!;
    }

    try {
        logger.debug(`${logEmoji.slack} Fetching user info for ${userId}`);
        const userInfo = await client.users.info({ user: userId });
        if (userInfo.ok && userInfo.user) {
            // Use display_name if available and non-empty, otherwise real_name, fallback to id
            const displayName = userInfo.user.profile?.display_name_normalized || userInfo.user.profile?.display_name;
            const realName = userInfo.user.profile?.real_name_normalized || userInfo.user.profile?.real_name;
            const userName = displayName || realName || userInfo.user.name || userId;
            userNameCache.set(userId, userName);
            logger.debug(`${logEmoji.slack} Cached username ${userName} for ${userId}`);
            return userName;
        } else {
             logger.warn(`${logEmoji.warning} Failed to fetch user info for ${userId}`, userInfo.error);
        }
    } catch (error) {
        logger.error(`${logEmoji.error} Error fetching user info for ${userId}`, { error });
    }

    // Fallback if API fails
    userNameCache.set(userId, userId); // Cache the ID as fallback to prevent retries
    return userId;
}
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
    // Attach the Slack user ID to the threadInfo for downstream use
    (threadInfo as any).__slackUserId = threadInfo.userId;
    let thinkingMessageTs: string | undefined;
    let lastMessageTs: string | undefined;
    let toolMessageTs: string | undefined;
    let currentToolName: string | undefined;
    let finalMetadata: Record<string, any> | undefined;

    // Use a single buffer for the raw response from the LLM
    let rawResponseBuffer = '';

    // --- Streaming flush control constants and state ---
    const MIN_FLUSH_LEN_REGULAR = 250;  // Increased: e.g., target ~2-3 sentences
    const MIN_FLUSH_LEN_THINK = 400;    // Increased: target larger updates for think blocks
    const SENTENCE_END_RE = /[.!?]\s|[.\n]\n/;
    const MIN_SENTENCES_THINK = 2;      // Keep this for think blocks

    let lastUpdateTime = 0;
    const MIN_UPDATE_INTERVAL_MS = 1500; // Increased: e.g., 1.5 seconds

    // New state variable to track new content since last flush
    let contentAccumulatedSinceLastFlush = "";

    try {
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
        const currentBotUserIdForHistory = botUserId;

        // Fetch username for the current message
        const userName = await getUserName(threadInfo.userId || '', client);

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

        // Prevent duplicating the user message: add it only if it is
        // *not* already the last entry in history.
        const lastMsg = conversationHistory[conversationHistory.length - 1];
        const alreadyPresent =
            lastMsg &&
            lastMsg.role === 'user' &&
            (
                (typeof lastMsg.content === 'string' &&
                 typeof messageTextOrContent === 'string' &&
                 lastMsg.content === messageTextOrContent) ||
                (Array.isArray(messageTextOrContent) &&
                 Array.isArray(lastMsg.content) &&
                 JSON.stringify(lastMsg.content) === JSON.stringify(messageTextOrContent))
            );

        if (!alreadyPresent) {
            conversationUtils.addUserMessageToThread(threadInfo, messageTextOrContent);
        }

        // --- Prepare prompt for AI ---
        let promptForAI: string | MessageContent[];

        if (typeof messageTextOrContent === 'string') {
            promptForAI = `[${userName}] ${messageTextOrContent}`;
        } else {
            promptForAI = messageTextOrContent.map((part, index) => {
                if (part.type === 'input_text' && index === messageTextOrContent.findIndex(p => p.type === 'input_text')) {
                    return {
                        ...part,
                        text: `[${userName}] ${part.text}`
                    };
                }
                return part;
            });
        }

        const eventStream = aiClient.generateResponseStream(
            promptForAI,
            conversationHistory,
            undefined,
            undefined,
            { slackUserId: (threadInfo as any).__slackUserId }
        );

        for await (const event of eventStream) {
            logger.debug(`${logEmoji.ai} Received agent event: ${event.type}`);

            switch (event.type) {
                case 'llm_chunk':
                    if (typeof event.data === 'string' && event.data) {
                        rawResponseBuffer += event.data;
                        contentAccumulatedSinceLastFlush += event.data; // Track new content

                        if (lastMessageTs) { // Only update if a message exists
                            const currentTime = Date.now();
                            const isCurrentlyMidThink = rawResponseBuffer.includes("<think>") &&
                                                     (!rawResponseBuffer.includes("</think>") ||
                                                      rawResponseBuffer.lastIndexOf("<think>") > rawResponseBuffer.lastIndexOf("</think>"));
                            
                            let shouldUpdateSlack = false;

                            if (currentTime - lastUpdateTime >= MIN_UPDATE_INTERVAL_MS) {
                                if (isCurrentlyMidThink) {
                                    // For think blocks: update if substantial new content accumulated
                                    const sentencesInNewThinkContent = (contentAccumulatedSinceLastFlush.match(SENTENCE_END_RE) || []).length;
                                    if (contentAccumulatedSinceLastFlush.length >= MIN_FLUSH_LEN_THINK || sentencesInNewThinkContent >= MIN_SENTENCES_THINK ) {
                                        shouldUpdateSlack = true;
                                    }
                                } else {
                                    // For regular content: update if sentence end AND substantial new content
                                    if (SENTENCE_END_RE.test(contentAccumulatedSinceLastFlush) && // Check new content for sentence end
                                        contentAccumulatedSinceLastFlush.length >= MIN_FLUSH_LEN_REGULAR) {
                                        shouldUpdateSlack = true;
                                    }
                                }
                            }
                            
                            // Override: Always update if a think block just closed
                            // Check if the *newly added data specifically* closes a think block
                            // and the overall buffer now reflects that.
                            if (event.data.includes("</think>") && !isCurrentlyMidThink) { 
                                shouldUpdateSlack = true;
                            }

                            // Override: Safety net - update if the total buffer is very large
                            if (rawResponseBuffer.length > 2800) {
                                shouldUpdateSlack = true;
                            }

                            if (shouldUpdateSlack) {
                                const msgPayload = blockKit.aiResponseMessage(rawResponseBuffer, isCurrentlyMidThink);
                                try {
                                    await conversationUtils.updateMessage(
                                        app, threadInfo.channelId, lastMessageTs,
                                        msgPayload.blocks as any[], msgPayload.text
                                    );
                                    lastUpdateTime = Date.now();
                                    contentAccumulatedSinceLastFlush = ""; // Reset after successful flush
                                    logger.debug(`${logEmoji.slack} Stream update to ${lastMessageTs}. Mid-think: ${isCurrentlyMidThink}. TotalLen: ${rawResponseBuffer.length}`);
                                } catch (updateError: any) {
                                    logger.warn(`${logEmoji.warning} Slack update error: ${updateError.message}`, { code: updateError.code });
                                }
                            }
                        }
                    }
                    break;

                case 'tool_call':
                case 'tool_calls': {
                    // Before processing tool call, flush any pending rawResponseBuffer
                    if (rawResponseBuffer.trim() && lastMessageTs) {
                        // Determine if the content being flushed is part of an open think block
                        const isMidThinkFinalBeforeTool = rawResponseBuffer.includes("<think>") && 
                                                         (!rawResponseBuffer.includes("</think>") || 
                                                          rawResponseBuffer.lastIndexOf("<think>") > rawResponseBuffer.lastIndexOf("</think>"));
                        const finalPreToolPayload = blockKit.aiResponseMessage(rawResponseBuffer, isMidThinkFinalBeforeTool);
                        await conversationUtils.updateMessage(app, threadInfo.channelId, lastMessageTs, finalPreToolPayload.blocks as any[], finalPreToolPayload.text);
                        if(rawResponseBuffer.trim()){
                           conversationUtils.addAssistantMessageToThread(threadInfo, rawResponseBuffer);
                        }
                        lastUpdateTime = Date.now();
                    }
                    rawResponseBuffer = ''; 
                    contentAccumulatedSinceLastFlush = ''; // Reset for content after tool call

                    let toolName: string | undefined;
                    let argPreview: string = '';
                    if (event.type === 'tool_calls' && Array.isArray(event.data)) {
                        const firstCall = event.data[0]?.function;
                        toolName = firstCall?.name || event.data[0]?.name || 'tool';
                        argPreview = firstCall?.arguments ? JSON.stringify(firstCall.arguments).slice(0, 80) : '';
                    } else { 
                        toolName = event.data?.tool_name || event.data?.name || 'tool';
                        argPreview = event.data?.arguments ? JSON.stringify(event.data.arguments).slice(0, 80) : '';
                    }
                    currentToolName = toolName; // Ensure currentToolName is defined in this scope

                    const toolMsgResponse = await client.chat.postMessage({
                        channel: threadInfo.channelId,
                        thread_ts: threadInfo.threadTs,
                        ...blockKit.functionCallMessage(toolName || 'tool', 'start', argPreview),
                    });
                    toolMessageTs = toolMsgResponse.ts as string;
                    lastMessageTs = toolMsgResponse.ts as string; 
                    logger.info(`${logEmoji.slack} Posted tool usage message ${toolMessageTs} for ${toolName}`);
                    break;
                }

                case 'tool_result':
                    if (toolMessageTs) {
                        const toolResultData = event.data?.result ?? event.data;
                        const resultSummary = typeof toolResultData === 'string'
                            ? toolResultData.substring(0, 120) + (toolResultData.length > 120 ? "..." : "")
                            : '[result data received]';

                        const messageUpdate = blockKit.functionCallMessage(
                            currentToolName || event.data?.tool_name || 'tool',
                            'end',
                            resultSummary
                        );
                        await conversationUtils.updateMessage(
                            app,
                            threadInfo.channelId,
                            toolMessageTs,
                            messageUpdate.blocks as any[],
                            messageUpdate.text
                        );
                        logger.info(`${logEmoji.slack} Updated tool usage message ${toolMessageTs} with result.`);

                        lastMessageTs = undefined; 
                        rawResponseBuffer = ''; 
                        contentAccumulatedSinceLastFlush = '';
                        toolMessageTs = undefined; 
                        currentToolName = undefined;
                    }
                    break;

                case 'final_message':
                    // ... (Your existing final_message logic to append to rawResponseBuffer and set finalMetadata) ...
                    // Make sure to add to contentAccumulatedSinceLastFlush as well if this event might trigger a final stream update.
                    const finalData = event.data;
                    if (finalData && typeof finalData.content === 'string') {
                        rawResponseBuffer += finalData.content;
                        // contentAccumulatedSinceLastFlush += finalData.content; // Not strictly needed here as final update is unconditional
                    }
                    if (finalData && finalData.metadata) {
                        finalMetadata = finalData.metadata;
                    }
                    break;

                case 'error':
                    logger.error(`${logEmoji.error} Agent stream error:`, event.data);
                    const errorMsgContent = String(event.data?.message || event.data || "Unknown agent error");
                    if (lastMessageTs) {
                        const errorBlocks = blockKit.errorMessage('Agent Error', 'An error occurred with the AI agent.', errorMsgContent);
                        await conversationUtils.updateMessage(app, threadInfo.channelId, lastMessageTs, errorBlocks.blocks as any[], errorBlocks.text);
                    } else if (thinkingMessageTs) {
                        const errorBlocks = blockKit.errorMessage('Agent Error', 'An error occurred with the AI agent.', errorMsgContent);
                        await conversationUtils.updateMessage(app, threadInfo.channelId, thinkingMessageTs, errorBlocks.blocks as any[], errorBlocks.text);
                    } else {
                        await conversationUtils.sendErrorMessage(app, threadInfo, 'Agent Stream Error', errorMsgContent);
                    }
                    return;

                default:
                    logger.warn(`${logEmoji.warning} Unknown agent event: ${event.type}`);
            }
        }

        logger.debug(`${logEmoji.ai} Final processing. Raw buffer length: ${rawResponseBuffer.length}`);
        
        if (lastMessageTs || (rawResponseBuffer.trim() || (finalMetadata && Object.keys(finalMetadata).length > 0))) {
            const finalMsgPayload = blockKit.aiResponseMessage(rawResponseBuffer, false, finalMetadata); // isStreamingOpenThinkBlock = false

            const targetTsForFinalUpdate = lastMessageTs || thinkingMessageTs;

            if (targetTsForFinalUpdate) {
                logger.info(`${logEmoji.slack} Updating message ${targetTsForFinalUpdate} with final content.`);
                await conversationUtils.updateMessage(app, threadInfo.channelId, targetTsForFinalUpdate, finalMsgPayload.blocks as any[], finalMsgPayload.text);
                if (!lastMessageTs) lastMessageTs = targetTsForFinalUpdate; // Ensure lastMessageTs is set if we updated thinkingMessageTs
            } else { 
                logger.info(`${logEmoji.slack} Posting new final message.`);
                const res = await client.chat.postMessage({
                    channel: threadInfo.channelId, thread_ts: threadInfo.threadTs,
                    ...finalMsgPayload,
                });
                lastMessageTs = res.ts as string;
            }
            if(rawResponseBuffer.trim()){
                conversationUtils.addAssistantMessageToThread(threadInfo, rawResponseBuffer);
            }
        }

    } catch (error: any) {
        logger.error(`${logEmoji.error} Error in processMessageAndGenerateResponse`, { errorMessage: error.message, stack: error.stack });
        const errorTitle = 'Error Processing Request';
        const errorDetail = error.message || 'An unexpected error occurred.';
        if (thinkingMessageTs) {
            try {
                const errorBlocks = blockKit.errorMessage(errorTitle, 'An error occurred while generating the response.', errorDetail);
                await conversationUtils.updateMessage(app, threadInfo.channelId, thinkingMessageTs, errorBlocks.blocks as any[], errorBlocks.text);
            } catch (updateError) {
                logger.error(`${logEmoji.error} Failed to update thinking message with error`, { updateError });
                await conversationUtils.sendErrorMessage(app, threadInfo, errorTitle, errorDetail);
            }
        } else {
            await conversationUtils.sendErrorMessage(app, threadInfo, errorTitle, errorDetail);
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
                multimodalContent.push({ type: 'input_text', text: message.text.trim() });
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

        // Only respond in DMs, if channel name starts with "wiz", or if bot is mentioned
        // But: If this is a mention, only respond in app_mention handler, not here!
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
            // Do NOT check for bot mention here; let app_mention handler handle that
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
