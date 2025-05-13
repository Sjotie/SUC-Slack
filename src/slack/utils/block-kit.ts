/**
 * Block Kit Utilities
 * 
 * This module provides utilities for building Slack Block Kit UI components.
 * It includes functions for creating various block types and composing them into messages.
 */

import { logger, logEmoji } from '../../utils/logger';

/**
 * Block types
 */
export enum BlockType {
    SECTION = 'section',
    DIVIDER = 'divider',
    IMAGE = 'image',
    ACTIONS = 'actions',
    CONTEXT = 'context',
    HEADER = 'header',
    INPUT = 'input',
}

/**
 * Element types
 */
export enum ElementType {
    BUTTON = 'button',
    STATIC_SELECT = 'static_select',
    MULTI_STATIC_SELECT = 'multi_static_select',
    OVERFLOW = 'overflow',
    DATEPICKER = 'datepicker',
    TIMEPICKER = 'timepicker',
    IMAGE = 'image',
    PLAIN_TEXT_INPUT = 'plain_text_input',
}

/**
 * Text types
 */
export enum TextType {
    PLAIN_TEXT = 'plain_text',
    MRKDWN = 'mrkdwn',
}

/**
 * Block interface
 */
export interface Block {
    type: BlockType;
    block_id?: string;
    [key: string]: any;
}

/**
 * Element interface
 */
export interface Element {
    type: ElementType;
    action_id?: string;
    [key: string]: any;
}

/**
 * Text interface
 */
export interface Text {
    type: TextType;
    text: string;
    emoji?: boolean;
    verbatim?: boolean;
}

/**
 * Create a plain text object
 * 
 * @param text The text content
 * @param emoji Whether to enable emoji
 * @returns A plain text object
 */
export function plainText(text: string, emoji: boolean = true): Text {
    return {
        type: TextType.PLAIN_TEXT,
        text,
        emoji,
    };
}

/**
 * Create a markdown text object
 * 
 * @param text The markdown text content
 * @param verbatim Whether to treat the text as verbatim
 * @returns A markdown text object
 */
export function mrkdwn(text: string, verbatim: boolean = false): Text {
    return {
        type: TextType.MRKDWN,
        text,
        verbatim,
    };
}

/**
 * Create a section block
 * 
 * @param text The text content
 * @param blockId Optional block ID
 * @param accessory Optional accessory element
 * @returns A section block
 */
export function section(text: string | Text, blockId?: string, accessory?: Element): Block {
    const textObj = typeof text === 'string' ? mrkdwn(text) : text;

    const block: Block = {
        type: BlockType.SECTION,
        text: textObj,
    };

    if (blockId) {
        block.block_id = blockId;
    }

    if (accessory) {
        block.accessory = accessory;
    }

    return block;
}

/**
 * Create a divider block
 * 
 * @param blockId Optional block ID
 * @returns A divider block
 */
export function divider(blockId?: string): Block {
    const block: Block = {
        type: BlockType.DIVIDER,
    };

    if (blockId) {
        block.block_id = blockId;
    }

    return block;
}

/**
 * Create a header block
 * 
 * @param text The header text
 * @param blockId Optional block ID
 * @returns A header block
 */
export function header(text: string, blockId?: string): Block {
    const block: Block = {
        type: BlockType.HEADER,
        text: plainText(text),
    };

    if (blockId) {
        block.block_id = blockId;
    }

    return block;
}

/**
 * Create an image block
 * 
 * @param imageUrl The image URL
 * @param altText The alt text
 * @param title Optional title
 * @param blockId Optional block ID
 * @returns An image block
 */
export function image(imageUrl: string, altText: string, title?: string, blockId?: string): Block {
    const block: Block = {
        type: BlockType.IMAGE,
        image_url: imageUrl,
        alt_text: altText,
    };

    if (title) {
        block.title = plainText(title);
    }

    if (blockId) {
        block.block_id = blockId;
    }

    return block;
}

/**
 * Create a context block
 * 
 * @param elements The context elements (text or images)
 * @param blockId Optional block ID
 * @returns A context block
 */
export function context(elements: (Text | Element)[], blockId?: string): Block {
    const block: Block = {
        type: BlockType.CONTEXT,
        elements,
    };

    if (blockId) {
        block.block_id = blockId;
    }

    return block;
}

/**
 * Create an actions block
 * 
 * @param elements The action elements
 * @param blockId Optional block ID
 * @returns An actions block
 */
export function actions(elements: Element[], blockId?: string): Block {
    const block: Block = {
        type: BlockType.ACTIONS,
        elements,
    };

    if (blockId) {
        block.block_id = blockId;
    }

    return block;
}

/**
 * Create a button element
 * 
 * @param text The button text
 * @param actionId The action ID
 * @param value The button value
 * @param style Optional button style ('primary', 'danger', or undefined for default)
 * @returns A button element
 */
export function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): Element {
    const element: Element = {
        type: ElementType.BUTTON,
        text: plainText(text),
        action_id: actionId,
        value,
    };

    if (style) {
        element.style = style;
    }

    return element;
}

/**
 * Create a select menu option
 * 
 * @param text The option text
 * @param value The option value
 * @returns A select menu option
 */
export function option(text: string, value: string): { text: Text; value: string } {
    return {
        text: plainText(text),
        value,
    };
}

/**
 * Create a select menu element
 * 
 * @param placeholder The placeholder text
 * @param actionId The action ID
 * @param options The select options
 * @param initialOption Optional initial option value
 * @returns A select menu element
 */
export function select(
    placeholder: string,
    actionId: string,
    options: { text: Text; value: string }[],
    initialOption?: { text: Text; value: string }
): Element {
    const element: Element = {
        type: ElementType.STATIC_SELECT,
        placeholder: plainText(placeholder),
        action_id: actionId,
        options,
    };

    if (initialOption) {
        element.initial_option = initialOption;
    }

    return element;
}

/**
 * Create a message with blocks
 * 
 * @param blocks The message blocks
 * @param text Optional fallback text
 * @returns A message object
 */
export function message(blocks: Block[], text?: string): { blocks: Block[]; text?: string } {
    const msg: { blocks: Block[]; text?: string } = { blocks };

    if (text) {
        msg.text = text;
    }

    return msg;
}

/**
 * Create a simple text message with optional formatting
 * 
 * @param text The message text
 * @param isMarkdown Whether to use markdown formatting
 * @returns A message object
 */
export function textMessage(text: string, isMarkdown: boolean = true): { blocks: Block[]; text: string } {
    return {
        blocks: [
            section(isMarkdown ? mrkdwn(text) : plainText(text)),
        ],
        text: text,
    };
}

/**
 * Create an error message
 * 
 * @param title The error title
 * @param message The error message
 * @param details Optional error details
 * @returns A message object
 */
export function errorMessage(
    title: string,
    message: string,
    details?: string
): { blocks: Block[]; text: string } {
    const blocks: Block[] = [
        header(`❌ ${title}`),
        section(message),
    ];

    if (details) {
        blocks.push(
            divider(),
            context([mrkdwn(`*Details:* ${details}`)]),
        );
    }

    return {
        blocks,
        text: `Error: ${title} - ${message}`,
    };
}

/**
 * Create a success message
 * 
 * @param title The success title
 * @param message The success message
 * @returns A message object
 */
export function successMessage(
    title: string,
    message: string
): { blocks: Block[]; text: string } {
    return {
        blocks: [
            header(`✅ ${title}`),
            section(message),
        ],
        text: `Success: ${title} - ${message}`,
    };
}

/**
 * Create a loading message
 * 
 * @param message The loading message
 * @returns A message object
 */
export function loadingMessage(message: string = 'Processing your request...'): { blocks: Block[]; text: string } {
    return {
        blocks: [
            section(`⏳ ${message}`),
        ],
        text: message,
    };
}

/**
 * Create an AI response message
 * 
 * @param content The AI response content
 * @param metadata Optional metadata to display
 * @param functionResults Optional function call results
 * @returns A message object
 */
export function aiResponseMessage(
    content: string,
    metadata?: Record<string, any>,
    functionResults?: string[]
): { blocks: Block[]; text: string } {
    // Slack requires at least one visible character.
    const safeContent = content && content.trim().length > 0
        ? content
        : '(no content)';

    // --- NEW BLOCK CREATION LOGIC ---
    const MAX_CHARS_PER_BLOCK = 250; // Limit lowered from 300 to 250

    // -------- helper: split `text` into sections on sentence boundaries --------
    function splitTextIntoSections(text: string, maxLen: number = MAX_CHARS_PER_BLOCK): string[] {
        const sentences = text.split(/(?<=[\.!?])\s+/);          // crude sentence split
        const sections: string[] = [];
        let buf = '';

        for (const s of sentences) {
            if ((buf + ' ' + s).trim().length <= maxLen) {
                buf = buf ? `${buf} ${s}` : s;
            } else {
                if (buf) sections.push(buf.trim());
                if (s.length > maxLen) {
                    // hard-split very long sentence
                    let rest = s;
                    while (rest.length > maxLen) {
                        sections.push(rest.slice(0, maxLen));
                        rest = rest.slice(maxLen);
                    }
                    buf = rest;
                } else {
                    buf = s;
                }
            }
        }
        if (buf) sections.push(buf.trim());
        return sections;
    }

    const finalContentBlocks: Block[] = [];
    for (const chunk of splitTextIntoSections(safeContent)) {
        if (chunk.trim() === '---') {
            finalContentBlocks.push(divider());
        } else {
            finalContentBlocks.push(section(chunk));
        }
    }
    // --- END NEW BLOCK CREATION LOGIC ---


    const blocks: Block[] = [...finalContentBlocks]; // Start with the generated content blocks

    // Helper to split long function results into blocks
    function createBlocksFromContent(text: string): Block[] {
        const blocks: Block[] = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= MAX_CHARS_PER_BLOCK) {
                blocks.push(section(remaining));
                break;
            }
            let splitPoint = remaining.lastIndexOf(' ', MAX_CHARS_PER_BLOCK);
            if (splitPoint <= 0) splitPoint = MAX_CHARS_PER_BLOCK;
            blocks.push(section(remaining.substring(0, splitPoint)));
            remaining = remaining.substring(splitPoint).trimStart();
        }
        return blocks;
    }

    // Add function results if provided
    if (functionResults && functionResults.length > 0) {
        blocks.push(divider());
        for (const result of functionResults) {
            const pretty = `\`\`\`\n${result}\n\`\`\``;
            for (const chunk of splitTextIntoSections(pretty)) {
                blocks.push(section(chunk));
            }
        }
    }

    // Add metadata if provided
    if (metadata && Object.keys(metadata).length > 0) {
        blocks.push(divider());
        const metadataElements: Text[] = [];
        if (metadata.model) {
             metadataElements.push(mrkdwn(`*Model:* ${metadata.model}`));
        }
        // Add other metadata fields if needed, separated by " | " or similar
        // Example: if (metadata.finishReason) { metadataElements.push(mrkdwn(`*Finish:* ${metadata.finishReason}`)) }

        if (metadataElements.length > 0) {
             blocks.push(context(metadataElements));
        }
    }

    // Generate fallback text for notifications (keep it short)
    const fallbackText = safeContent.substring(0, 150) + (safeContent.length > 150 ? '...' : '');

    return {
        blocks,
        text: fallbackText, // Use short fallback text
    };
}

// ---------------------------------------------------------------------------
// Utility: lightweight summary for function / tool calls
// ---------------------------------------------------------------------------
export function functionCallMessage(
    name: string,
    stage: 'start' | 'end',
    summary?: string
): { blocks: Block[]; text: string } {
    const verb = stage === 'start' ? ' Roept' : ' Resultaat van';
    const header = `${verb} functie \`${name}\``;
    const blocks: Block[] = [section(header)];
    if (summary) blocks.push(context([mrkdwn(summary)]));
    return { blocks, text: header };
}
