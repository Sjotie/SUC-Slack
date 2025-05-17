/**
 * Slack App Configuration
 * 
 * This module initializes and configures the Slack Bolt app.
 * It sets up the app with the appropriate tokens and middleware.
 */

import { App, LogLevel } from '@slack/bolt';
import { logger, logEmoji } from '../utils/logger';
import { env } from '../config/environment';
import { registerMiddleware } from './middleware';
import { SLACK_CONFIG } from '../config/constants';

// Map Winston log levels to Bolt log levels
const getBoltLogLevel = (): LogLevel => {
    switch (env.LOG_LEVEL) {
        case 'debug':
            return LogLevel.DEBUG;
        case 'info':
            return LogLevel.INFO;
        case 'warn':
            return LogLevel.WARN;
        case 'error':
            return LogLevel.ERROR;
        default:
            return LogLevel.INFO;
    }
};

// Create and configure the Slack app
export const app = new App({
    token: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: env.SLACK_APP_TOKEN,
    logLevel: getBoltLogLevel(),
    logger: {
        debug: (...msgs) => logger.debug(msgs.join(' ')),
        info: (...msgs) => logger.info(msgs.join(' ')),
        warn: (...msgs) => logger.warn(msgs.join(' ')),
        error: (...msgs) => logger.error(msgs.join(' ')),
        setLevel: () => { }, // No-op as we're using our own logger
        getLevel: () => getBoltLogLevel(),
        setName: () => { }, // No-op
    },
    customRoutes: [
        {
            path: '/health',
            method: ['GET'],
            handler: (req, res) => {
                res.writeHead(200);
                res.end('Health check: OK');
            },
        },
    ],
});

import axios from 'axios';
import { MessageContent } from '../ai/interfaces/provider';

function isImageFile(file: any): boolean {
    return file && typeof file.mimetype === 'string' && file.mimetype.startsWith('image/');
}

export function registerMessageEvents(app: App) {
    app.message(async ({ message, say, client, context, event }) => {
        // Ignore bot messages, message changes, etc.
        if ((message as any).subtype || (message as any).bot_id) {
            return;
        }

        const userText = (message as any).text || '';
        const files = (message as any).files || [];
        const userId = (message as any).user;

        const contentParts: MessageContent[] = [];

        // 1. Add text part if present
        if (userText && userText.trim()) {
            contentParts.push({ type: 'input_text', text: userText.trim() });
        }

        // 2. Process images
        if (files.length > 0) {
            for (const file of files) {
                if (isImageFile(file) && file.url_private_download) {
                    try {
                        const response = await axios.get(file.url_private_download, {
                            headers: { 'Authorization': `Bearer ${context.botToken || env.SLACK_BOT_TOKEN}` },
                            responseType: 'arraybuffer',
                        });
                        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
                        const dataUri = `data:${file.mimetype};base64,${base64Image}`;
                        contentParts.push({ type: 'input_image', image_url: dataUri });
                        logger.debug(`Processed image ${file.name} for user ${userId}`);
                    } catch (error) {
                        logger.error(`Failed to download or process image ${file.name}:`, error);
                        await say(`Sorry, I couldn't process the image "${file.name}".`);
                    }
                }
            }
        }

        if (contentParts.length === 0) {
            logger.debug(`No processable content from user ${userId}.`);
            return;
        }

        // TODO: Integrate with your backend call here.
        // Example:
        // const payloadToPython = {
        //     prompt: contentParts,
        //     history: [], // Populate with actual history
        //     slackUserId: userId
        // };
        // await axios.post('http://localhost:8000/generate', payloadToPython);

        logger.info(`Sending message with ${contentParts.length} parts to backend for user ${userId}`);
    });
}

function initializeApp() {
    try {
        // Register middleware
        registerMiddleware(app);

        // Register message event handler for image+text support
        registerMessageEvents(app);

        // Import event handlers (if you have other event handlers)
        require('./events');

        // Store the original start method
        const originalStart = app.start.bind(app);

        // Create a new start method that logs when the app starts
        app.start = async function () {
            try {
                // Call the original start method
                const server = await originalStart();

                // Log that the app is running
                logger.info(`${logEmoji.slack} Slack Bolt app is running!`);

                // Return the server
                return server;
            } catch (error) {
                logger.error(`${logEmoji.error} Failed to start Slack Bolt app`, { error });
                throw error;
            }
        };

        logger.info(`${logEmoji.slack} Slack app initialized successfully`);
    } catch (error) {
        logger.error(`${logEmoji.error} Failed to initialize Slack app`, { error });
        throw error;
    }
}

initializeApp();

export default app;
