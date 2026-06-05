// pipeline/llm-clean.js
// LLM Gateway → Text Cleaning + Slide Breakpoints
// Uses badkid-llama-chat (local, tools-capable, 128K context)
// Proper multi-turn tool loop — sends results back to LLM.

const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────

const GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://192.168.0.100:3400';
const MODEL = 'badkid-llama-chat';
const MAX_TOOL_TURNS = 80; // 31 messages × ~2 turns + intro/outro/interludes

// Voice config — override in .env
const VOICES = {
    narrator: {
        voice: process.env.VOICE_NARRATOR || 'en-US-Male',
        speed: parseFloat(process.env.VOICE_NARRATOR_SPEED) || 0.95
    },
    participantA: {
        voice: process.env.VOICE_PARTICIPANT_A || 'en-US-Female',
        speed: parseFloat(process.env.VOICE_PARTICIPANT_A_SPEED) || 1.0
    },
    participantB: {
        voice: process.env.VOICE_PARTICIPANT_B || 'en-UK-Male',
        speed: parseFloat(process.env.VOICE_PARTICIPANT_B_SPEED) || 1.0
    }
};

// ─── Tool Definitions ─────────────────────────────────────────

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_source',
            description: 'Get all raw conversation messages from the Arena export. Call this first to see what needs to be cleaned.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_deck',
            description: 'Get the current slide deck state.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_slide',
            description: 'Create a new slide. Use this to build the deck one slide at a time.',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['title', 'narration', 'conversation', 'end'],
                        description: 'Slide type: title (opening card), narration (intro/interlude/outro, spoken by narrator), conversation (cleaned message), end (closing card)'
                    },
                    speaker: {
                        type: 'string',
                        enum: ['narrator', 'participantA', 'participantB'],
                        description: 'Who speaks: narrator, participantA (first speaker in conversation), participantB (second speaker)'
                    },
                    label: {
                        type: 'string',
                        description: 'Display label for the speaker (e.g. "Narrator", "Kimi K2.5", "GLM5")'
                    },
                    text: {
                        type: 'string',
                        description: 'The main text shown on screen. For conversation slides, this is the cleaned TTS-friendly speech text. Clean aggressively: strip markdown, expand contractions, normalize punctuation, make it speakable. DO NOT include asterisks, markdown, or formatting.'
                    },
                    subtitle: {
                        type: 'string',
                        description: 'Optional secondary text (only for title/end slides)'
                    },
                    narration: {
                        type: 'string',
                        description: 'Optional spoken narration text (only for title/end slides). Different from the visual text.'
                    },
                    originalIdx: {
                        type: 'number',
                        description: 'For conversation slides only: the index of the original message in the source array'
                    },
                    position: {
                        type: 'number',
                        description: 'Insert at this position in the deck. Omit to append at end.'
                    }
                },
                required: ['type', 'speaker', 'label', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_slide',
            description: 'Modify an existing slide by index.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'number', description: 'Zero-based slide index to update' },
                    text: { type: 'string', description: 'New cleaned text for the slide' },
                    type: { type: 'string', enum: ['title', 'narration', 'conversation', 'end'] },
                    speaker: { type: 'string', enum: ['narrator', 'participantA', 'participantB'] },
                    label: { type: 'string' }
                },
                required: ['index']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delete_slide',
            description: 'Remove a slide by index. Use to fix mistakes or reorganize.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'number', description: 'Zero-based slide index to delete' }
                },
                required: ['index']
            }
        }
    }
];

// ─── Tool Executor ────────────────────────────────────────────

class SlideDeckBuilder {
    constructor(source) {
        this.source = source; // Raw Arena data
        this.slides = [];
    }

    execute(toolCall) {
        const name = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments || '{}');
        console.log(`  [Tool] ${name} type=${args.type} speaker=${args.speaker} text="${(args.text||'').substring(0, 80)}"`);

        switch (name) {
            case 'get_source':
                return JSON.stringify({
                    topic: this.source.topic,
                    participants: this.source.participants,
                    messageCount: this.source.messages.length,
                    messages: this.source.messages.map((m, i) => ({
                        index: i,
                        speaker: m.speaker || m.model,
                        content: m.content || m.text,
                        createdAt: m.createdAt
                    }))
                });

            case 'get_deck':
                return JSON.stringify({
                    slideCount: this.slides.length,
                    slides: this.slides.map((s, i) => ({
                        index: i,
                        type: s.type,
                        speaker: s.speaker,
                        label: s.label,
                        text: s.text
                    }))
                });

            case 'create_slide': {
                const slideType = args.type || 'conversation'; // Default if LLM omits
                const slide = {
                    type: slideType,
                    speaker: args.speaker,
                    label: args.label,
                    text: args.text,
                    subtitle: args.subtitle || undefined,
                    narration: args.narration || undefined,
                    originalIdx: args.originalIdx,
                    tts: null
                };
                // Remove undefined fields
                Object.keys(slide).forEach(k => slide[k] === undefined && delete slide[k]);

                const pos = args.position !== undefined ? args.position : this.slides.length;
                this.slides.splice(pos, 0, slide);
                return JSON.stringify({ status: 'created', index: pos, totalSlides: this.slides.length });
            }

            case 'update_slide': {
                if (args.index < 0 || args.index >= this.slides.length) {
                    return JSON.stringify({ error: `Index ${args.index} out of bounds (0-${this.slides.length - 1})` });
                }
                const s = this.slides[args.index];
                if (args.text !== undefined) s.text = args.text;
                if (args.type !== undefined) s.type = args.type;
                if (args.speaker !== undefined) s.speaker = args.speaker;
                if (args.label !== undefined) s.label = args.label;
                s.tts = null; // Invalidate TTS
                return JSON.stringify({ status: 'updated', index: args.index });
            }

            case 'delete_slide': {
                if (args.index < 0 || args.index >= this.slides.length) {
                    return JSON.stringify({ error: `Index ${args.index} out of bounds (0-${this.slides.length - 1})` });
                }
                this.slides.splice(args.index, 1);
                return JSON.stringify({ status: 'deleted', index: args.index, totalSlides: this.slides.length });
            }

            default:
                return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    }
}

// ─── Gateway Chat (Multi-Turn Tool Loop) ──────────────────────

async function gatewayChat(messages, tools) {
    const body = {
        model: MODEL,
        messages: messages,
        tools: tools,
        temperature: 0.3 // Lower temp for consistent cleaning
    };

    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        throw new Error(`Gateway HTTP ${res.status}: ${errText.substring(0, 500)}`);
    }

    return res.json();
}

async function runToolLoop(source) {
    const builder = new SlideDeckBuilder(source);
    const participants = source.participants.filter(Boolean);

    const systemPrompt = `You are the Slide Deck Director for the Arena Slideshow system.
Your job: turn raw LLM conversation transcripts into a clean, speakable slide deck for TTS narration.

CRITICAL RULES — follow exactly:
1. FIRST: call get_source to read the messages.
2. THEN build the deck IN ORDER using create_slide. Every create_slide call MUST include the "type" field.
3. SLIDE STRUCTURE (in this exact order):
   a. Create 1 "title" slide (type="title", speaker="narrator", label="Narrator"). The text should be the conversation topic. The narration should briefly explain the experiment: two large language models, ${participants[0] || 'model A'} and ${participants[1] || 'model B'}, talking to each other without human intervention — and state the topic.
   b. For EACH source message: create 1+ "conversation" slides (type="conversation") with the CORRECT speaker mapping and cleaned text. Split long messages at natural thought boundaries (1-4 sentences per slide). Preserve the full content — do NOT summarize, shorten, or paraphrase. Every thought the LLMs expressed must appear.
   c. Create 1 "end" slide (type="end", speaker="narrator", label="Narrator") with a brief closing.
4. NARRATOR RULES — THE NARRATOR SPEAKS EXACTLY ONCE, at the title slide:
   - The narrator explains the experiment setup and states the topic.
   - After the title slide, the narrator is SILENT. NO commentary, NO interludes, NO summarization between messages.
   - Do NOT create "narration" slides between conversation slides.
   - Do NOT editorialize. The conversation speaks for itself.
5. SPEAKER MAPPING — use EXACTLY these:
   - participantA = ${participants[0] || 'first speaker'} (label="${participants[0] || 'Speaker A'}")
   - participantB = ${participants[1] || 'second speaker'} (label="${participants[1] || 'Speaker B'}")
   - narrator = narrator (label="Narrator")
6. TEXT CLEANING — clean aggressively for speech:
   - Strip ALL markdown: bold, italic, code blocks, etc. — convert to plain text
   - Remove asterisk action descriptions like "*settling in*" → replace with "Settling in."
   - Expand common contractions: don't→do not, I'm→I am, can't→cannot, it's→it is, they're→they are
   - Normalize punctuation: use periods for pauses, not dashes or ellipses
   - NO markdown, NO asterisks, NO formatting characters in final text
7. DO NOT skip any source message. Every message index must appear in at least one slide. Do NOT summarize or shorten messages — preserve the full content.
8. After creating ALL slides, call get_deck to verify, then respond with a brief summary.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Build the complete slide deck. Start with get_source, then create a title slide (narrator explains the experiment), ALL conversation messages as individual slides (cleaned, split if long, NO summarization), and an end slide. The narrator speaks ONLY on the title slide — NO narration between messages. Verify with get_deck when done.' }
    ];

    let turnCount = 0;

    while (turnCount < MAX_TOOL_TURNS) {
        turnCount++;
        console.log(`\n[LLM] Turn ${turnCount} — ${messages.length} messages in context`);

        const response = await gatewayChat(messages, TOOLS);
        const choice = response.choices?.[0];
        if (!choice) {
            console.error('[LLM] Unexpected response format:', JSON.stringify(response).substring(0, 500));
            break;
        }

        const msg = choice.message;

        // Check for tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
            console.log(`[LLM] ${msg.tool_calls.length} tool call(s)`);

            // Add assistant message with tool_calls to history
            messages.push({
                role: 'assistant',
                content: msg.content || null,
                tool_calls: msg.tool_calls
            });

            // Execute each tool and add results
            for (const call of msg.tool_calls) {
                const result = builder.execute(call);
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: result
                });
            }
            // Continue loop — LLM will process tool results
            continue;
        }

        // No tool calls — LLM is done
        console.log(`[LLM] Final response: "${(msg.content || '').substring(0, 200)}"`);
        break;
    }

    if (turnCount >= MAX_TOOL_TURNS) {
        console.warn(`[LLM] WARNING: Reached max tool turns (${MAX_TOOL_TURNS}). Deck may be incomplete.`);
    }

    return builder;
}

// ─── Main ─────────────────────────────────────────────────────

async function cleanWithLLM(sourceData, outputDir) {
    console.log(`\n[LLM Clean] Starting — Gateway: ${GATEWAY_URL}, Model: ${MODEL}`);
    console.log(`[LLM Clean] Source: "${sourceData.topic}", ${sourceData.source?.messages?.length || sourceData.messages?.length} messages`);

    // Normalize: accept both raw Arena JSON and pre-parsed source objects
    const source = {
        topic: sourceData.topic || sourceData.source?.topic || 'Untitled',
        participants: sourceData.participants || sourceData.source?.participants || [],
        messages: sourceData.messages || sourceData.source?.messages || []
    };

    if (source.messages.length === 0) {
        throw new Error('No messages found in source data');
    }

    const builder = await runToolLoop(source);

    console.log(`\n[LLM Clean] Deck built: ${builder.slides.length} slides`);

    // ─── Post-Process: Ensure Required Structure ──────────────
    // The LLM sometimes omits outro/end slides. Inject defaults if missing.

    const slides = builder.slides;

    // Remove duplicate consecutive slides (same text + same speaker)
    for (let i = slides.length - 1; i > 0; i--) {
        if (slides[i].text === slides[i - 1].text && slides[i].speaker === slides[i - 1].speaker) {
            console.log(`  [Post] Removing duplicate slide ${i}: "${(slides[i].text || '').substring(0, 50)}"`);
            slides.splice(i, 1);
        }
    }

    // Ensure first slide is title type
    if (slides.length === 0 || slides[0].type !== 'title') {
        slides.unshift({
            type: 'title',
            speaker: 'narrator',
            label: 'Narrator',
            text: source.topic,
            narration: `This is an experiment: two large language models, ${participants.join(' and ')}, talking to each other without human intervention. The topic: "${source.topic}".`,
            tts: null
        });
        console.log('  [Post] Injected title slide');
    }

    // Ensure end slide exists
    const hasEnd = slides[slides.length - 1]?.type === 'end';
    if (!hasEnd) {
        slides.push({
            type: 'end',
            speaker: 'narrator',
            label: 'Narrator',
            text: 'End of conversation.',
            tts: null
        });
        console.log('  [Post] Injected end slide');
    }

    // Build the deck structure
    const participants = source.participants.filter(Boolean);
    const deck = {
        version: 1,
        source: {
            arenaExportId: sourceData.id || sourceData.source?.arenaExportId || 'unknown',
            exportedAt: sourceData.exportedAt || sourceData.source?.exportedAt || new Date().toISOString(),
            topic: source.topic,
            participants: participants,
            messages: source.messages
        },
        voiceMapping: {
            narrator:     { voice: VOICES.narrator.voice,     speed: VOICES.narrator.speed },
            participantA: { voice: VOICES.participantA.voice, speed: VOICES.participantA.speed, label: participants[0] || '' },
            participantB: { voice: VOICES.participantB.voice, speed: VOICES.participantB.speed, label: participants[1] || '' }
        },
        slides: builder.slides,
        createdAt: Date.now()
    };

    // Write output (skip if outputDir is null — API mode)
    if (outputDir) {
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'slide_deck_llm.json');
        fs.writeFileSync(outputPath, JSON.stringify(deck, null, 2), 'utf-8');
        console.log(`[LLM Clean] Output: ${outputPath}`);
    }

    // Print slide overview
    console.log('\n[LLM Clean] Slide overview:');
    console.log('\n[LLM Clean] Slide overview:');
    for (let i = 0; i < deck.slides.length; i++) {
        const s = deck.slides[i];
        const preview = (s.text || '').substring(0, 80);
        console.log(`  ${i}. [${s.type}] ${s.label}: "${preview}${preview.length >= 80 ? '...' : ''}"`);
    }

    return deck;
}

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/llm-clean.js <arena-export.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(inputPath, 'utf-8');
    const data = JSON.parse(raw);

    await cleanWithLLM(data, outputDir);
}

if (require.main === module) {
    main().catch(err => {
        console.error('\n[LLM Clean] FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { cleanWithLLM };
