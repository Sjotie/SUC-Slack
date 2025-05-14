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
 * Streaming preview (single growing section, _no_ hard chunk-splits).
 * Use this while the SSE stream is still coming in; switch to
 * `aiResponseMessage` once the final chunk is received.
 */
export function streamingPreviewMessage(
    content: string,
    maxChars: number = 350        // keep preview short to avoid Slack Read more
): { blocks: Block[]; text: string } {
    if (!content.length) content = '';

    let preview = content;
    if (content.length > maxChars) {
        // show only the tail so the latest text is visible
        preview = ' ' + content.slice(-maxChars);
    }

    return {
        blocks: [ section(preview) ],
        text: preview.slice(0, 150),
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
    isStreamingOpenThinkBlock: boolean = false,
    metadata?: Record<string, any>,
    functionResults?: string[]
): { blocks: Block[]; text: string } {
    // --- BLOCK SIZE CONSTANTS ---
    const MAX_CHARS_PER_REGULAR_BLOCK = 250;
    const MAX_CHARS_PER_THINK_BLOCK = 3000;

    // Slack requires at least one visible character.
    const safeContent = content && content.trim().length > 0
        ? content
        : '(no content)';

    function findSafeSplitPoint(text: string, maxLength: number): number {
        if (maxLength >= text.length) return text.length;
        if (maxLength <= 0) return 0;

        // Prioritize splitting after natural terminators within the maxLength
        for (let i = Math.min(maxLength - 1, text.length - 1); i >= 0; i--) {
            if (text[i] === '\n') { // Newline is a strong candidate
                return i + 1;
            }
            // Sentence ending followed by space or end of string
            if (text[i].match(/[.!?]/) && (i + 1 === text.length || text[i + 1] === ' ' || text[i+1] === '\n')) {
                return i + 1; // Split after the punctuation
            }
        }

        // If no natural terminator, try last space within maxLength
        let splitPoint = text.lastIndexOf(' ', maxLength);
        if (splitPoint === -1 || splitPoint === 0) { // No space, or space at start
            splitPoint = maxLength; // Hard cut if no suitable space
        } else {
            splitPoint = splitPoint + 1; // Split after the space
        }

        // Heuristics to avoid breaking common markdown mid-sequence around the chosen splitPoint
        if (splitPoint > 0 && splitPoint < text.length) {
            const charBefore = text[splitPoint - 1];
            const twoCharsBefore = text.substring(Math.max(0, splitPoint - 2), splitPoint);

            // Avoid splitting like: **text | ** (where | is splitPoint)
            if (charBefore === '*' && text.lastIndexOf('**', splitPoint -1) > text.lastIndexOf('**', text.lastIndexOf('**', splitPoint -1)-1) && text.lastIndexOf('**', splitPoint-1) !== -1) {
                const openingStars = text.lastIndexOf('**', splitPoint - 1);
                if (openingStars !== -1) splitPoint = openingStars;
            } else if (charBefore === '*' && text.lastIndexOf('*', splitPoint -1) > text.lastIndexOf('*', text.lastIndexOf('*', splitPoint -1)-1) && text.lastIndexOf('*', splitPoint-1) !== -1 && twoCharsBefore !== '**') {
                const openingStar = text.lastIndexOf('*', splitPoint - 1);
                if (openingStar !== -1) splitPoint = openingStar;
            } else if (charBefore === '_' && text.lastIndexOf('_', splitPoint -1) > text.lastIndexOf('_', text.lastIndexOf('_', splitPoint -1)-1) && text.lastIndexOf('_', splitPoint-1) !== -1 ) {
                const openingUnderscore = text.lastIndexOf('_', splitPoint - 1);
                if (openingUnderscore !== -1) splitPoint = openingUnderscore;
            } else if (charBefore === '`' && text.lastIndexOf('`', splitPoint -1) > text.lastIndexOf('`', text.lastIndexOf('`', splitPoint -1)-1) && text.lastIndexOf('`', splitPoint-1) !== -1 && text.substring(Math.max(0, splitPoint - 3), splitPoint) !== '```' ) {
                const openingBacktick = text.lastIndexOf('`', splitPoint - 1);
                if (openingBacktick !== -1) splitPoint = openingBacktick;
            } else if (charBefore === '~' && text.lastIndexOf('~', splitPoint -1) > text.lastIndexOf('~', text.lastIndexOf('~', splitPoint -1)-1) && text.lastIndexOf('~', splitPoint-1) !== -1 ) {
                const openingTilde = text.lastIndexOf('~', splitPoint - 1);
                if (openingTilde !== -1) splitPoint = openingTilde;
            }
            // Avoid splitting common "label:" type structures if split is right after colon
            if (charBefore === ':' && splitPoint > 1 && text[splitPoint - 2].match(/\w/)) {
                // Could refine further if needed
            }
        }

        return Math.max(1, Math.min(splitPoint, text.length));
    }

    function splitTextIntoSections(text: string, maxLen: number): string[] {
        const sentences = text.split(/(?<=[\.!?])\s+/);
        const sections: string[] = [];
        let buf = '';

        for (const s of sentences) {
            const trimmedSentence = s.trim();
            if (!trimmedSentence) continue;

            if ((buf + (buf ? ' ' : '') + trimmedSentence).trim().length <= maxLen) {
                buf = buf ? `${buf} ${trimmedSentence}` : trimmedSentence;
            } else {
                if (buf.trim()) sections.push(buf.trim());
                if (trimmedSentence.length > maxLen) {
                    let rest = trimmedSentence;
                    while (rest.length > maxLen) {
                        const splitPoint = findSafeSplitPoint(rest, maxLen);
                        sections.push(rest.slice(0, splitPoint));
                        rest = rest.slice(splitPoint).trimStart();
                    }
                    buf = rest.trim();
                } else {
                    buf = trimmedSentence;
                }
            }
        }
        if (buf.trim()) sections.push(buf.trim());
        return sections.filter(section => section.length > 0);
    }

    const finalContentBlocks: Block[] = [];

    if (safeContent === '(no content)') {
        finalContentBlocks.push(section('(no content)'));
    } else {
        let remainingContentToProcess = safeContent;
        const thinkStartTag = "<think>";
        const thinkEndTag = "</think>";

        while (remainingContentToProcess.length > 0) {
            const lastOpenThinkPos = remainingContentToProcess.lastIndexOf(thinkStartTag);
            const lastCloseThinkPos = remainingContentToProcess.lastIndexOf(thinkEndTag);

            // Scenario 1: We are actively streaming an open think block
            if (isStreamingOpenThinkBlock && lastOpenThinkPos !== -1 && (lastCloseThinkPos === -1 || lastOpenThinkPos > lastCloseThinkPos)) {
                const textBeforeOpenThink = remainingContentToProcess.substring(0, lastOpenThinkPos);
                const openThinkContent = remainingContentToProcess.substring(lastOpenThinkPos + thinkStartTag.length);

                // Process text before the currently open think block (if any)
                if (textBeforeOpenThink.trim()) {
                    for (const chunk of splitTextIntoSections(textBeforeOpenThink.trim(), MAX_CHARS_PER_REGULAR_BLOCK)) {
                        if (chunk.trim() === '---') finalContentBlocks.push(divider());
                        else if (chunk.trim()) finalContentBlocks.push(section(chunk));
                    }
                }

                // Process the open think block content
                const truncatedThinkContent = openThinkContent.length > MAX_CHARS_PER_THINK_BLOCK
                    ? openThinkContent.substring(0, MAX_CHARS_PER_THINK_BLOCK) + "..."
                    : openThinkContent;
                finalContentBlocks.push(section(mrkdwn("```\n" + truncatedThinkContent + "\n```")));
                remainingContentToProcess = ""; // Consumed all for this special streaming case
                break; 
            }

            // Scenario 2: Normal processing (not specifically streaming an open think block, or it's the final call)
            // Use the regex for segmentation.
            const segmentRegex = /(<think>[\s\S]*?<\/think>)|([\s\S]+?(?=<think>|$))/g;
            let match;
            let lastProcessedIndex = 0;
            
            // Create a temporary string to apply the regex on, to avoid issues with global regex state if called multiple times.
            let tempStringToSegment = remainingContentToProcess;
            remainingContentToProcess = ""; // Assume we process it all now.

            while ((match = segmentRegex.exec(tempStringToSegment)) !== null) {
                lastProcessedIndex = match.index + match[0].length;
                const thinkSegmentWithTags = match[1];
                const regularSegment = match[2];

                if (thinkSegmentWithTags) {
                    const thinkContent = thinkSegmentWithTags.substring(thinkStartTag.length, thinkSegmentWithTags.length - thinkEndTag.length).trim();
                    if (thinkContent) {
                        const truncatedThinkContent = thinkContent.length > MAX_CHARS_PER_THINK_BLOCK
                            ? thinkContent.substring(0, MAX_CHARS_PER_THINK_BLOCK) + "..."
                            : thinkContent;
                        finalContentBlocks.push(section(mrkdwn("```\n" + truncatedThinkContent + "\n```")));
                    }
                } else if (regularSegment) {
                    const trimmedRegularSegment = regularSegment.trim();
                    if (trimmedRegularSegment) {
                        for (const chunk of splitTextIntoSections(trimmedRegularSegment, MAX_CHARS_PER_REGULAR_BLOCK)) {
                            if (chunk.trim() === '---') finalContentBlocks.push(divider());
                            else if (chunk.trim()) finalContentBlocks.push(section(chunk));
                        }
                    }
                }
            }
            // If regex didn't consume the whole tempStringToSegment (e.g. if it's empty or only partial match)
            // this path should ideally not be hit if regex is exhaustive for non-empty strings.
            if (lastProcessedIndex < tempStringToSegment.length) {
                const rest = tempStringToSegment.substring(lastProcessedIndex).trim();
                if (rest) {
                    for (const chunk of splitTextIntoSections(rest, MAX_CHARS_PER_REGULAR_BLOCK)) {
                        if (chunk.trim()) finalContentBlocks.push(section(chunk));
                    }
                }
            }
        }
    }

    const blocks: Block[] = [...finalContentBlocks];

    // Add function results and metadata (typically for the final message)
    if (!isStreamingOpenThinkBlock) {
        if (functionResults && functionResults.length > 0) {
            blocks.push(divider());
            for (const result of functionResults) {
                const pretty = `\`\`\`\n${result}\n\`\`\``;
                for (const chunk of splitTextIntoSections(pretty, MAX_CHARS_PER_REGULAR_BLOCK)) {
                    if (chunk.trim()) blocks.push(section(chunk));
                }
            }
        }

        if (metadata && Object.keys(metadata).length > 0) {
            blocks.push(divider());
            const metadataElements: Text[] = [];
            if (metadata.model) metadataElements.push(mrkdwn(`*Model:* ${metadata.model}`));
            if (metadataElements.length > 0) blocks.push(context(metadataElements));
        }
    }
    
    const fallbackText = safeContent.substring(0, 150) + (safeContent.length > 150 ? '...' : '');

    return {
        blocks: blocks.length > 0 ? blocks : [section(mrkdwn(fallbackText || '(empty response)'))],
        text: fallbackText,
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
