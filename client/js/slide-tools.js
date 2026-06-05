// client/js/slide-tools.js

export class SlideTools {
    constructor(appContext) {
        this.app = appContext; // Reference to SlideshowApp state and methods
    }

    /**
     * Definition of tools exposed to the LLM Gateway
     */
    getToolDefinitions() {
        return [
            {
                type: "function",
                function: {
                    name: "slideshow_get_source",
                    description: "Return the parsed Arena export data (all messages, metadata) for the current project.",
                    parameters: {
                        type: "object",
                        properties: {},
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "slideshow_get_deck",
                    description: "Return the current slide deck JSON. Use this to review the exact slide structure before making edits.",
                    parameters: {
                        type: "object",
                        properties: {},
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "slideshow_set_narration",
                    description: "Insert or update narration slides (intro, interstitial, outro).",
                    parameters: {
                        type: "object",
                        properties: {
                            text: { type: "string", description: "The narration text." },
                            position: { type: "number", description: "Slide index to insert at, or overwrite." },
                            label: { type: "string", description: "Optional label (e.g. 'Intro')." }
                        },
                        required: ["text", "position"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "slideshow_insert_slide",
                    description: "Insert a new slide at a given position.",
                    parameters: {
                        type: "object",
                        properties: {
                            type: { type: "string", enum: ["title", "narration", "conversation", "end"] },
                            speaker: { type: "string", description: "Role: 'narrator', 'participantA', 'participantB'" },
                            label: { type: "string", description: "Visible speaker/slide label" },
                            text: { type: "string", description: "The text to speak/show." },
                            position: { type: "number", description: "Index to insert at." }
                        },
                        required: ["type", "speaker", "text", "position"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "slideshow_update_slide",
                    description: "Modify a specific slide by index.",
                    parameters: {
                        type: "object",
                        properties: {
                            index: { type: "number" },
                            text: { type: "string" }
                        },
                        required: ["index", "text"]
                    }
                }
            }
        ];
    }

    /**
     * Dispatcher for handling tool calls from the LLM
     */
    async executeToolCall(call) {
        const name = call.function.name;
        const args = JSON.parse(call.function.arguments || "{}");
        const deck = this.app.state.deck;

        console.log(`[Tool Executing] ${name}`, args);

        switch (name) {
            case "slideshow_get_source":
                return JSON.stringify(deck.source);

            case "slideshow_get_deck":
                return JSON.stringify(deck.slides || []);

            case "slideshow_set_narration":
            case "slideshow_insert_slide":
                const insertPos = args.position;
                if (!deck.slides) deck.slides = [];
                const newSlide = {
                    type: args.type || 'narration',
                    speaker: args.speaker || 'narrator',
                    label: args.label || 'Narrator',
                    text: args.text,
                    tts: null
                };
                deck.slides.splice(insertPos, 0, newSlide);
                this.app.renderSlideDeck(deck.slides);
                await this.app.saveCurrentDeck();
                return JSON.stringify({ status: "success", newLength: deck.slides.length });

            case "slideshow_update_slide":
                if (!deck.slides || !deck.slides[args.index]) {
                    return JSON.stringify({ error: "Slide index out of bounds." });
                }
                deck.slides[args.index].text = args.text;
                // Invalidate TTS hash implicitly by just nulling it for now
                deck.slides[args.index].tts = null; 
                this.app.renderSlideDeck(deck.slides);
                await this.app.saveCurrentDeck();
                return JSON.stringify({ status: "success" });

            default:
                return JSON.stringify({ error: `Tool ${name} not implemented.` });
        }
    }
}
