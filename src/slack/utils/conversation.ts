/**
 * Conversation Utilities
 * 
 * This module provides utilities for managing Slack conversations.
 * It includes functions for thread management, context tracking, and message formatting.
 */

import { App } from '@slack/bolt';
import { ConversationMessage, MessageRole, MessageContent, ImageContent } from '../../ai/interfaces/provider';
import { contextManager } from '../../ai/context/manager';
import { logger, logEmoji } from '../../utils/logger';
import * as blockKit from './block-kit';

// --- local helpers to replace removed openrouter/formatter ---
function createUserMessage(
  content: string | MessageContent[],
  userId?: string,
): ConversationMessage {
  return {
    role: 'user',
    content,
    name: userId,
    timestamp: new Date().toISOString(),
  };
}

function createAssistantMessage(
  content: string | MessageContent[],
): ConversationMessage {
  return {
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
  };
}

function createTextContent(text: string): MessageContent {
  return { type: 'input_text', text };
}

function createImageContent(url: string): MessageContent {
  return { type: 'input_image', image_url: url };
}

function createMultimodalUserMessage(
  text: string,
  imageUrls: string[],
  userId?: string,
): ConversationMessage {
  const content: MessageContent[] = [
    createTextContent(text),
    ...imageUrls.map((url) => ({ type: 'input_image', image_url: url } as ImageContent)),
  ];
  return createUserMessage(content, userId);
}
// ----------------------------------------------------------------

/**
 * Thread information
 */
export interface ThreadInfo {
    channelId: string;
    threadTs: string;
    userId?: string;
    botId?: string;
}

/**
 * Get thread information from a message
 * 
 * @param message The Slack message
 * @returns Thread information
 */
export function getThreadInfo(message: any): ThreadInfo {
    const channelId = message.channel || message.channel_id;
    const threadTs = message.thread_ts || message.ts;
    const userId = message.user;

    return {
        channelId,
        threadTs,
        userId,
    };
}

/**
 * Convert a Slack message to a conversation message
 * 
 * @param message The Slack message
 * @param botId The bot's user ID
 * @returns A conversation message
 */
export function slackMessageToConversationMessage(message: any, botId?: string): ConversationMessage {
    // Determine the role based on the user ID
    const role: MessageRole = message.user === botId ? 'assistant' : 'user';

    // Extract the text content
    const content = message.text || '';

    // Create the conversation message
    return {
        role,
        content,
        timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
    };
}

/**
 * Add a message to a conversation thread
 * 
 * @param threadInfo Thread information
 * @param message The conversation message to add
 * @returns The updated conversation context
 */
export function addMessageToThread(threadInfo: ThreadInfo, message: ConversationMessage) {
    return contextManager.addMessage(
        threadInfo.threadTs,
        threadInfo.channelId,
        message
    );
}

/**
 * Add a user message to a conversation thread
 * 
 * @param threadInfo Thread information
 * @param content The message content (text or multimodal)
 * @returns The updated conversation context
 */
export function addUserMessageToThread(threadInfo: ThreadInfo, content: string | MessageContent[]) {
    const message = createUserMessage(content, threadInfo.userId);
    return addMessageToThread(threadInfo, message);
}

/**
 * Add a multimodal user message to a conversation thread
 * 
 * @param threadInfo Thread information
 * @param text The text content
 * @param imageUrls Array of image URLs
 * @returns The updated conversation context
 */
export function addMultimodalUserMessageToThread(
    threadInfo: ThreadInfo,
    text: string,
    imageUrls: string[]
) {
    const message = createMultimodalUserMessage(text, imageUrls, threadInfo.userId);
    return addMessageToThread(threadInfo, message);
}

/**
 * Add an assistant message to a conversation thread
 * 
 * @param threadInfo Thread information
 * @param content The message content
 * @returns The updated conversation context
 */
export function addAssistantMessageToThread(threadInfo: ThreadInfo, content: string) {
    const message = createAssistantMessage(content);
    return addMessageToThread(threadInfo, message);
}

/**
 * Update the system message for a conversation thread
 * 
 * @param threadInfo Thread information
 * @param content The system message content
 * @returns The updated conversation context
 */
export function updateSystemMessageForThread(threadInfo: ThreadInfo, content: string) {
    return contextManager.updateSystemMessage(
        threadInfo.threadTs,
        threadInfo.channelId,
        content
    );
}

/**
 * Clear a conversation thread
 * 
 * @param threadInfo Thread information
 * @param keepSystemMessage Whether to keep the system message
 * @returns True if the thread was cleared, false if it wasn't found
 */
export function clearThread(threadInfo: ThreadInfo, keepSystemMessage: boolean = true) {
    return contextManager.clearContext(
        threadInfo.threadTs,
        threadInfo.channelId,
        keepSystemMessage
    );
}

/**
 * Get conversation history for a thread
 * 
 * @param threadInfo Thread information
 * @returns The conversation messages
 */
export function getThreadHistory(threadInfo: ThreadInfo): ConversationMessage[] {
    const context = contextManager.getContext(
        threadInfo.threadTs,
        threadInfo.channelId
    );

    return context ? context.messages : [];
}

/**
 * Send a thinking message to a thread
 * 
 * @param app The Slack app
 * @param threadInfo Thread information
 * @returns Promise resolving to the message timestamp
 */
export async function sendThinkingMessage(app: App, threadInfo: ThreadInfo): Promise<string> {
    try {
        const result = await app.client.chat.postMessage({
            channel: threadInfo.channelId,
            thread_ts: threadInfo.threadTs,
            ...blockKit.loadingMessage('Thinking...'),
        });

        logger.debug(`${logEmoji.slack} Sent thinking message to thread ${threadInfo.threadTs}`);

        return result.ts as string;
    } catch (error) {
        logger.error(`${logEmoji.error} Error sending thinking message`, { error });
        throw error;
    }
}

/**
 * Update a message in a thread
 * 
 * @param app The Slack app
 * @param channelId The channel ID
 * @param ts The message timestamp
 * @param blocks The new message blocks
 * @param text The new message text
 * @returns Promise resolving to the updated message
 */
export async function updateMessage(
    app: App,
    channelId: string,
    ts: string,
    blocks: blockKit.Block[],
    text: string
) {
    try {
        const result = await app.client.chat.update({
            channel: channelId,
            ts,
            blocks,
            text,
        });

        logger.debug(`${logEmoji.slack} Updated message ${ts} in channel ${channelId}`);

        return result;
    } catch (error) {
        logger.error(`${logEmoji.error} Error updating message`, { error });
        throw error;
    }
}

/**
 * Send an AI response to a thread
 * 
 * @param app The Slack app
 * @param threadInfo Thread information
 * @param content The AI response content
 * @param metadata Optional metadata to display
 * @param functionResults Optional function call results
 * @returns Promise resolving to the message timestamp
 */
export async function sendAIResponse(
    app: App,
    threadInfo: ThreadInfo,
    content: string,
    metadata?: Record<string, any>,
    functionResults?: string[]
): Promise<string> {
    try {
        // Create the message
        const message = blockKit.aiResponseMessage(content, false, metadata, functionResults);

        // Send the message
        const result = await app.client.chat.postMessage({
            channel: threadInfo.channelId,
            thread_ts: threadInfo.threadTs,
            ...message,
        });

        // Add the message to the conversation context
        addAssistantMessageToThread(threadInfo, content);

        logger.debug(`${logEmoji.slack} Sent AI response to thread ${threadInfo.threadTs}`);

        return result.ts as string;
    } catch (error) {
        logger.error(`${logEmoji.error} Error sending AI response`, { error });
        throw error;
    }
}

/**
 * Update a thinking message with an AI response
 * 
 * @param app The Slack app
 * @param threadInfo Thread information
 * @param thinkingMessageTs The thinking message timestamp
 * @param content The AI response content
 * @param metadata Optional metadata to display
 * @param functionResults Optional function call results
 * @returns Promise resolving to the updated message
 */
export async function updateThinkingMessageWithAIResponse(
    app: App,
    threadInfo: ThreadInfo,
    thinkingMessageTs: string,
    content: string,
    metadata?: Record<string, any>,
    functionResults?: string[]
) {
    try {
        // Create the message
        const message = blockKit.aiResponseMessage(content, false, metadata, functionResults);

        // Update the message
        const result = await updateMessage(
            app,
            threadInfo.channelId,
            thinkingMessageTs,
            message.blocks,
            message.text
        );

        // Add the message to the conversation context
        addAssistantMessageToThread(threadInfo, content);

        logger.debug(`${logEmoji.slack} Updated thinking message with AI response in thread ${threadInfo.threadTs}`);

        return result;
    } catch (error) {
        logger.error(`${logEmoji.error} Error updating thinking message with AI response`, { error });
        throw error;
    }
}

/**
 * Send an error message to a thread
 * 
 * @param app The Slack app
 * @param threadInfo Thread information
 * @param title The error title
 * @param message The error message
 * @param details Optional error details
 * @returns Promise resolving to the message timestamp
 */
export async function sendErrorMessage(
    app: App,
    threadInfo: ThreadInfo,
    title: string,
    message: string,
    details?: string
): Promise<string> {
    try {
        // Create the message
        const errorMessage = blockKit.errorMessage(title, message, details);

        // Send the message
        const result = await app.client.chat.postMessage({
            channel: threadInfo.channelId,
            thread_ts: threadInfo.threadTs,
            ...errorMessage,
        });

        logger.debug(`${logEmoji.slack} Sent error message to thread ${threadInfo.threadTs}`);

        return result.ts as string;
    } catch (error) {
        logger.error(`${logEmoji.error} Error sending error message`, { error });
        throw error;
    }
}

/**
 * Fetch conversation history from Slack
 * 
 * @param app The Slack app
 * @param channelId The channel ID
 * @param threadTs The thread timestamp
 * @param limit The maximum number of messages to fetch
 * @returns Promise resolving to the conversation history
 */
export async function fetchConversationHistory(
    app: App,
    channelId: string,
    threadTs: string,
    limit: number = 100
) {
    try {
        const result = await app.client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit,
        });

        logger.debug(`${logEmoji.slack} Fetched conversation history for thread ${threadTs}`);

        return result.messages || [];
    } catch (error) {
        logger.error(`${logEmoji.error} Error fetching conversation history`, { error });
        throw error;
    }
}

/**
 * Initialize conversation context from Slack history
 * 
 * @param app The Slack app
 * @param threadInfo Thread information
 * @param botId The bot's user ID
 * @returns Promise resolving to the conversation context
 */
export async function initializeContextFromHistory(
    app: App,
    threadInfo: ThreadInfo,
    botId: string
) {
    try {
        // Check if context already exists
        const existingContext = contextManager.getContext(
            threadInfo.threadTs,
            threadInfo.channelId
        );

        if (existingContext && existingContext.messages.length > 0) {
            logger.debug(`${logEmoji.slack} Context already exists for thread ${threadInfo.threadTs}`);
            return existingContext;
        }

        // Fetch conversation history
        const messages = await fetchConversationHistory(
            app,
            threadInfo.channelId,
            threadInfo.threadTs
        );

        // Create a new context
        const context = contextManager.createContext(
            threadInfo.threadTs,
            threadInfo.channelId,
            threadInfo.userId
        );

        // Add messages to the context
        for (const message of messages) {
            // Skip messages that don't have text
            if (!message.text) {
                continue;
            }

            // Convert to conversation message
            const conversationMessage = slackMessageToConversationMessage(message, botId);

            // Add to context (skip the first system message)
            if (conversationMessage.role !== 'system' || context.messages.length === 0) {
                contextManager.addMessage(
                    threadInfo.threadTs,
                    threadInfo.channelId,
                    conversationMessage
                );
            }
        }

        logger.debug(`${logEmoji.slack} Initialized context from history for thread ${threadInfo.threadTs}`);

        return context;
    } catch (error) {
        logger.error(`${logEmoji.error} Error initializing context from history`, { error });
        throw error;
    }
}
