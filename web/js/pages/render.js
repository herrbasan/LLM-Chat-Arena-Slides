import { nui } from '/nui/nui.js';

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
const NUMBER_WORDS_0_19 = [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'
];
const NUMBER_WORDS_VOWEL_NEXT = {
    1: 'first', 2: 'second', 3: 'third', 5: 'fifth', 8: 'eighth', 9: 'ninth', 12: 'twelfth'
};
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function spell(n) {
    if (n < 0) return 'negative ' + spell(-n);
    if (n < 20) return NUMBER_WORDS_0_19[n];
    if (n < 100) {
        const t = Math.floor(n / 10);
        const r = n % 10;
        return r ? `${TENS[t]}-${NUMBER_WORDS_0_19[r]}` : TENS[t];
    }
    if (n < 1000) {
        const h = Math.floor(n / 100);
        const r = n % 100;
        const head = h === 1 ? 'one hundred' : `${NUMBER_WORDS_0_19[h]} hundred`;
        return r ? `${head} ${spell(r)}` : head;
    }
    if (n < 10000) {
        const th = Math.floor(n / 1000);
        const rest = n % 1000;
        const head = th < 20 ? NUMBER_WORDS_0_19[th] + ' thousand' : `${spell(th)} thousand`;
        return rest ? `${head} ${spell(rest)}` : head;
    }
    return String(n);
}

function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatHumanDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const day = d.getUTCDate();
    const month = MONTHS[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    const dayWord = day < 20 && NUMBER_WORDS_VOWEL_NEXT[day]
        ? NUMBER_WORDS_VOWEL_NEXT[day]
        : `${spell(day)}th`;
    return `${month} ${dayWord}, ${spell(year)}`;
}

nui.registerPage('render', {
    html: 'render.html',
    async init(element, params, nui) {
        await nui.ready();

        let projectId = params.id || window.SLIDESHOW_APP.currentProject;
        if (!projectId) {
            window.location.hash = '#page=projects';
            return;
        }

        let deck = null;
        let splitIndexCache = null;
        let splitIndexDeckRef = null;

        async function loadProject(id) {
            try {
                const res = await fetch(`/api/projects/${id}`);
                deck = await res.json();
                window.SLIDESHOW_APP.deck = deck;
                window.SLIDESHOW_APP.currentProject = id;
                invalidateSplitIndexCache();
                if (window.SLIDESHOW_APP.updateStepper) window.SLIDESHOW_APP.updateStepper();
            } catch (err) {
                nui.components.banner.show({ content: 'Failed to load project', priority: 'alert', autoClose: 5000 });
                deck = null;
            }
        }

        await loadProject(projectId);
        if (!deck) return;

        // ─── v3 Paragraph Architecture ─────────────────────────────
        // v3 projects store messages with paragraphs instead of slides.
        // We build "virtual slides" at runtime by grouping paragraphs
        // into visual chunks (~600 chars per slide). Audio chains across
        // paragraphs within a virtual slide.
        const isV3 = deck.version === 3 && deck.messages;
        let virtualSlides = null;

        function buildVirtualSlides() {
            if (!isV3) return null;
            const slides = [];
            const MAX_CHARS_PER_SLIDE = 600;

            const messages = deck.messages || [];
            const hasOpeningInMessages = messages.length > 0 && messages[0].type === 'setup';

            if (hasOpeningInMessages) {
                // New v3 format: opening/closing slides are synthetic
                // narrator messages at the start/end of project.messages.
                for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
                    const msg = messages[msgIdx];
                    const type = msg.type || 'conversation';

                    if (type === 'conversation') {
                        const paragraphs = msg.paragraphs || [];
                        const speaker = msg.speaker || 'narrator';
                        const label = msg.label || msg.originalSpeaker || speaker;

                        const groups = [];
                        let currentGroup = [];
                        let currentChars = 0;
                        for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
                            const para = paragraphs[paraIdx];
                            const paraLen = (para.text || '').length;
                            if (currentGroup.length > 0 && currentChars + paraLen > MAX_CHARS_PER_SLIDE) {
                                groups.push(currentGroup);
                                currentGroup = [];
                                currentChars = 0;
                            }
                            currentGroup.push({ paraIdx, para });
                            currentChars += paraLen;
                        }
                        if (currentGroup.length > 0) groups.push(currentGroup);

                        for (let splitIdx = 0; splitIdx < groups.length; splitIdx++) {
                            slides.push(buildConversationSlide(groups[splitIdx], msgIdx, speaker, label, msg, splitIdx, groups.length));
                        }
                    } else {
                        // setup/details/topic/end: one slide per message
                        const paragraphs = (msg.paragraphs || []).map((p, pi) => ({
                            msgIdx,
                            paraIdx: pi,
                            text: p.text,
                            audioUrl: p.audioUrl,
                            words: p.words,
                            durationMs: p.durationMs,
                            renderHash: p.renderHash,
                            alignComplete: p.alignComplete,
                            alignVersion: p.alignVersion
                        }));
                        let text = msg.text || (type === 'setup' ? 'Setup' : type === 'details' ? 'Details' : type === 'end' ? 'End of conversation.' : '');
                        let narration = msg.narration || paragraphs.map(p => p.text).join('\n\n') || text;
                        if (type === 'topic') {
                            text = text.replace(/^\s*Topic:\s*/i, '').trim();
                            narration = narration.replace(/^\s*Topic:\s*/i, '').trim();
                        }
                        const tts = paragraphs.length > 0 ? {
                            audioUrl: paragraphs[0]?.audioUrl,
                            renderHash: paragraphs.map(p => p.renderHash).join('|'),
                            durationMs: paragraphs.reduce((sum, p) => sum + (p.durationMs || 0), 0)
                        } : null;
                        slides.push({
                            type,
                            text,
                            narration,
                            speaker: msg.speaker || 'narrator',
                            label: msg.label || 'Narrator',
                            meta: type === 'details' ? (msg.meta || buildDetailsMetaFromSource()) : null,
                            _virtual: true,
                            _paragraphs: paragraphs,
                            tts
                        });
                    }
                }
            } else {
                // Legacy v3 format: messages are conversation only;
                // reconstruct opening/closing from source.
                const source = deck.source || {};
                const models = (source.participants || []).map((name, i) => ({
                    name,
                    role: i === 0 ? 'participantA' : 'participantB'
                }));
                const turnCount = messages.length;
                const dateText = formatHumanDate(source.exportedAt) || 'an unknown date';
                const participantLine = source.participants?.length >= 2
                    ? `${source.participants[0]} and ${source.participants[1]}`
                    : (source.participants?.[0] || 'two language models');

                slides.push({
                    type: 'setup',
                    text: 'Setup',
                    narration: "You're about to hear a conversation between two language models. They were given a single prompt — a topic — and then left to respond to each other directly, with no further human involvement. What follows is unedited and unsteered. The models chose every word themselves.",
                    speaker: 'narrator',
                    _virtual: true
                });

                slides.push({
                    type: 'details',
                    text: 'Details',
                    narration: `This recording was generated on ${dateText}, featuring the models ${participantLine}. ${turnCount === 1 ? 'One' : capitalize(spell(turnCount))} turn${turnCount === 1 ? '' : 's'}.`,
                    speaker: 'narrator',
                    meta: {
                        recordedAt: source.exportedAt,
                        renderedAt: source.renderedAt,
                        models,
                        turnCount
                    },
                    _virtual: true
                });

                const topicText = (source.seedPromptRaw || '').replace(/^\s*Topic:\s*/i, '').trim()
                    || source.seedPrompt || source.topic || '';
                slides.push({
                    type: 'topic',
                    text: topicText,
                    narration: topicText,
                    speaker: 'narrator',
                    _virtual: true
                });

                for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
                    const msg = messages[msgIdx];
                    const paragraphs = msg.paragraphs || [];
                    const speaker = msg.speaker || 'narrator';
                    const label = msg.label || msg.originalSpeaker || speaker;

                    const groups = [];
                    let currentGroup = [];
                    let currentChars = 0;
                    for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
                        const para = paragraphs[paraIdx];
                        const paraLen = (para.text || '').length;
                        if (currentGroup.length > 0 && currentChars + paraLen > MAX_CHARS_PER_SLIDE) {
                            groups.push(currentGroup);
                            currentGroup = [];
                            currentChars = 0;
                        }
                        currentGroup.push({ paraIdx, para });
                        currentChars += paraLen;
                    }
                    if (currentGroup.length > 0) groups.push(currentGroup);

                    for (let splitIdx = 0; splitIdx < groups.length; splitIdx++) {
                        slides.push(buildConversationSlide(groups[splitIdx], msgIdx, speaker, label, msg, splitIdx, groups.length));
                    }
                }

                slides.push({
                    type: 'end',
                    text: 'End of conversation.',
                    narration: 'End of conversation.',
                    speaker: 'narrator',
                    _virtual: true
                });
            }

            return slides;
        }

        function buildDetailsMetaFromSource() {
            const source = deck.source || {};
            const models = (source.participants || []).map((name, i) => ({
                name,
                role: i === 0 ? 'participantA' : 'participantB'
            }));
            return {
                recordedAt: source.exportedAt,
                renderedAt: source.renderedAt,
                models,
                turnCount: (deck.messages || []).filter(m => m.type === 'conversation' || !m.type).length
            };
        }

        function buildConversationSlide(group, msgIdx, speaker, label, msg, splitIdx, splitCount) {
            const firstPara = group[0];
            const lastPara = group[group.length - 1];
            const text = group.map(g => g.para.text || '').join('\n\n');
            const paragraphs = group.map(g => ({
                msgIdx,
                paraIdx: g.paraIdx,
                text: g.para.text,
                audioUrl: g.para.audioUrl,
                words: g.para.words,
                durationMs: g.para.durationMs,
                renderHash: g.para.renderHash,
                alignComplete: g.para.alignComplete,
                alignVersion: g.para.alignVersion
            }));

            return {
                type: 'conversation',
                text,
                speaker,
                label,
                originalIdx: msg.conversationIdx ?? msgIdx,
                createdAt: msg.createdAt,
                splitIdx,
                splitCount,
                _virtual: true,
                _paragraphs: paragraphs,
                // For staleness check
                tts: {
                    audioUrl: paragraphs[0]?.audioUrl,
                    renderHash: paragraphs.map(p => p.renderHash).join('|'),
                    durationMs: paragraphs.reduce((sum, p) => sum + (p.durationMs || 0), 0)
                }
            };
        }

        if (isV3) {
            virtualSlides = buildVirtualSlides();
            // Replace deck.slides with virtual slides for v2-compatible rendering
            deck.slides = virtualSlides;
        }


        const messageList = element.querySelector('#render-message-list');
        const playerContent = element.querySelector('#player-slide-content');
        const progressBar = element.querySelector('#playback-progress-bar');
        const progressFill = element.querySelector('#playback-progress-fill');
        const timeDisplay = element.querySelector('#time-display');
        const btnPlay = element.querySelector('#btn-play');
        const btnSpeed = element.querySelector('#btn-speed');
        const btnRecord = element.querySelector('#btn-record');
        const btnRecordLabel = element.querySelector('#btn-record-label');
        const renderProgress = element.querySelector('#render-progress');
        const renderProgressWrap = element.querySelector('#render-progress-wrap');
        const renderProgressText = element.querySelector('#render-progress-text');
        const renderStatus = element.querySelector('#render-status');
        const btnRenderWrap = element.querySelector('#btn-render-wrap');
        const btnStopWrap = element.querySelector('#btn-stop-wrap');
        let renderAllActive = false;

        let currentSlideIdx = 0;
        let isPlaying = false;
        let playbackSpeed = 1.0;
        let audio = new Audio();
        let rafId = null;

        // v3 audio chaining state
        // Each paragraph plays independently. No offset math.
        // currentParaIdx tracks which paragraph is playing.
        // Cumulative time is tracked for progress bar and time display.
        let v3Paragraphs = [];      // paragraphs array from the current slide
        let currentParaIdx = -1;    // which paragraph is currently playing (-1 = none)
        let v3CumulativeMs = 0;     // total ms of all finished paragraphs
        let v3TotalDurationMs = 0;  // total duration of all paragraphs combined

        function loadParagraphAudio(paragraphs) {
            v3Paragraphs = paragraphs || [];
            currentParaIdx = -1;
            v3CumulativeMs = 0;
            v3TotalDurationMs = 0;

            for (const para of v3Paragraphs) {
                v3TotalDurationMs += para.durationMs || 0;
            }

            // Find first paragraph with audio
            const first = v3Paragraphs.find(p => p.audioUrl && p.words?.length > 0);
            if (first) {
                currentParaIdx = v3Paragraphs.indexOf(first);
                audio.src = first.audioUrl;
                audio.playbackRate = playbackSpeed;
            } else {
                audio.src = '';
            }
        }



        function getSpokenText(slide) {
            let text;
            // topic and end speak the narration; everything else (setup,
            // details, conversation) speaks the on-screen text. The
            // narration for setup/details is a short spoken intro; the
            // on-screen meta/text is what the viewer reads while the
            // narrator speaks.
            if (slide.type === 'topic' || slide.type === 'end') {
                text = slide.narration || slide.text || '';
            } else {
                text = slide.text || slide.narration || '';
            }
            return stripEmphasisForSpeech(text);
        }

        // Single source of truth for paragraph freshness.
        // Matches the server's renderParagraph freshness check as closely
        // as the browser can: hash from spoken text, audio present, words
        // present. Anything with audio/hash but not fresh is stale.
        function computeParagraphStatus(para, voiceConfig) {
            if (!para.text || para.text.trim() === '' || para.text.trim() === '...') return 'skip';
            const hasAudio = !!(para.audioRef || para.audioUrl);
            const hasHash = !!para.renderHash;
            if (!hasAudio && !hasHash) return 'unrendered';
            const expectedHash = computeRenderHash(stripEmphasisForSpeech(para.text), voiceConfig.voice, voiceConfig.speed);
            const isFresh = para.renderHash === expectedHash && hasAudio && (para.words?.length || 0) > 0;
            return isFresh ? 'fresh' : 'stale';
        }

        function aggregateStatus(statuses) {
            if (statuses.length === 0) return 'unrendered';
            if (statuses.some(s => s === 'stale')) return 'stale';
            if (statuses.some(s => s === 'unrendered')) return 'unrendered';
            return 'fresh';
        }

        function computeStaleness(slide) {
            // v3: aggregate paragraph status
            if (slide._paragraphs) {
                const roleCfg = deck.voiceMapping[slide.speaker] || deck.voiceMapping.narrator || {};
                const statuses = slide._paragraphs
                    .map(p => computeParagraphStatus(p, roleCfg))
                    .filter(s => s !== 'skip');
                return aggregateStatus(statuses);
            }
            // v2: original logic
            if (!slide.tts || slide.tts.error) return 'unrendered';
            const text = getSpokenText(slide);
            const roleCfg = deck.voiceMapping[slide.speaker] || deck.voiceMapping.narrator || {};
            const expectedHash = computeRenderHash(text, roleCfg.voice, roleCfg.speed);
            if (slide.tts.renderHash === expectedHash) return 'fresh';
            return 'stale';
        }

        // Browser-side mirror of pipeline/speak-text.js speakText().
        // Rewrites *content* → (content) for natural parenthetical
        // cadence (action beats like *pauses*, *stays*), then strips
        // any stray asterisks. nSpeech would otherwise speak "asterisk"
        // literally. On-screen slide.text keeps the marks. Keep in sync
        // with the canonical server-side helper.
        function stripEmphasisForSpeech(s) {
            return String(s || '')
                .replace(/\*+([^*]+?)\*+/g, '($1)')
                .replace(/\*+/g, '');
        }

        // ─── Per-slide-type style configuration ─────────────────────
        //
        // The render function reads from this object to decide layout,
        // which UI bits to show (eyebrow, speaker, header), and what
        // class hooks to add. To restyle a slide type, change CSS hooks
        // (see web/css/main.css) — no JS changes needed for visual tweaks.
        // To change layout/data flow, edit SLIDE_STYLES or the render
        // helpers in loadSlide.
        //
        // Each entry has:
        //   showEyebrow    — show the small uppercase type label
        //                    ("SETUP", "TOPIC", "CONVERSATION", etc.)
        //   showSpeaker    — show the speaker/role label in the header
        //   showHeader     — show the entire header row at all
        //   layout         — "framed" | "meta" | "centered" | "flow" | "minimal"
        //                    drives the body DOM structure
        //   textSize       — "sm" | "md" | "lg" | "xl" (rendered as
        //                    text-size--{size} class hook)
        //   textAlign      — "left" | "center"
        //   accentBackground — true to add .slide--accent-bg hook
        //
        // The class hooks (slide--{type}, slide--speaker-{role},
        // slide--split-{start|middle|end}, slide--new-speaker) are
        // always applied. Layout / eyebrow / speaker flags only control
        // whether those specific UI elements are rendered.
        const SLIDE_STYLES = {
            setup: {
                showEyebrow: false,
                showSpeaker: false,
                showHeader: true,
                layout: 'framed',
                textSize: 'md',
                textAlign: 'left',
                accentBackground: false
            },
            details: {
                showEyebrow: false,
                showSpeaker: false,
                showHeader: true,
                layout: 'meta',
                textSize: 'md',
                textAlign: 'left',
                accentBackground: false
            },
            topic: {
                showEyebrow: false,
                showSpeaker: false,
                showHeader: true,
                layout: 'centered',
                textSize: 'xl',
                textAlign: 'center',
                accentBackground: true
            },
            conversation: {
                showEyebrow: false,
                showSpeaker: true,
                showHeader: true,
                layout: 'flow',
                textSize: 'md',
                textAlign: 'left',
                accentBackground: false
            },
            end: {
                showEyebrow: false,
                showSpeaker: false,
                showHeader: false,
                layout: 'minimal',
                textSize: 'sm',
                textAlign: 'center',
                accentBackground: false
            }
        };

        // Compute the set of class hooks for a slide based on its
        // position in the deck and its relationship to neighbours.
        // This is the single source of truth for state-class names.
        function buildSlideClassList(slide, idx) {
            const prev = deck.slides[idx - 1];
            const next = deck.slides[idx + 1];
            const classes = ['slide', `slide--${slide.type}`];

            // Per-role hook for conversation slides.
            if (slide.speaker) {
                classes.push(`slide--speaker-${slide.speaker}`);
            }

            // Per-model chip hook for the details meta block.
            if (slide.type === 'details' && Array.isArray(slide.meta?.models)) {
                slide.meta.models.forEach(m => {
                    if (m && m.role) classes.push(`details-meta__model--${m.role}`);
                });
            }

            // Position-in-deck hooks.
            if (idx === 0) classes.push('slide--first');
            if (idx === deck.slides.length - 1) classes.push('slide--last');

            // Speaker-transition marker. If the previous slide has a
            // different speaker (or no speaker), this is a new-speaker
            // boundary. The setup/details/topic slides all have speaker
            // 'narrator' so we treat that as "no transition" for the
            // conversation → conversation case, but a "new speaker"
            // marker when entering the first conversation slide.
            if (slide.type === 'conversation') {
                if (!prev || prev.speaker !== slide.speaker) {
                    classes.push('slide--new-speaker');
                }
                if (prev && prev.type === 'conversation' && prev.speaker === slide.speaker && prev.originalIdx === slide.originalIdx) {
                    // Same message, same speaker → this is a split-chunk continuation.
                    if (slide.splitIdx === 0) {
                        classes.push('slide--split-start');
                    } else if (slide.splitIdx === slide.splitCount - 1) {
                        classes.push('slide--split-end');
                    } else {
                        classes.push('slide--split-middle');
                    }
                }
            }

            // Layout hook from the per-type style.
            const style = SLIDE_STYLES[slide.type] || {};
            if (style.layout) classes.push(`slide--layout-${style.layout}`);
            if (style.textSize) classes.push(`slide--text-size-${style.textSize}`);
            if (style.textAlign) classes.push(`slide--align-${style.textAlign}`);
            if (style.accentBackground) classes.push('slide--accent-bg');

            return classes;
        }

        // Render the details meta block. Each model gets its own chip
        // so the user can style them independently.
        function renderDetailsMeta(meta) {
            if (!meta) return '';
            const rows = [];

            if (meta.recordedAt) {
                rows.push(`<div class="details-meta__row">
                    <span class="details-meta__label">Recorded</span>
                    <time class="details-meta__value" datetime="${escapeHtml(meta.recordedAt)}">${escapeHtml(formatHumanDate(meta.recordedAt) || meta.recordedAt)}</time>
                </div>`);
            }

            if (meta.renderedAt) {
                rows.push(`<div class="details-meta__row">
                    <span class="details-meta__label">Rendered</span>
                    <time class="details-meta__value" datetime="${escapeHtml(meta.renderedAt)}">${escapeHtml(formatHumanDate(meta.renderedAt) || meta.renderedAt)}</time>
                </div>`);
            }

            if (Array.isArray(meta.models) && meta.models.length) {
                const chips = meta.models.map(m => {
                    return `<span class="model-chip model-chip--${escapeHtml(m.role || 'unknown')}">${escapeHtml(m.name || '')}</span>`;
                }).join('');
                rows.push(`<div class="details-meta__row details-meta__row--models">
                    <span class="details-meta__label">Models</span>
                    <div class="details-meta__models">${chips}</div>
                </div>`);
            }

            if (typeof meta.turnCount === 'number') {
                const turnLabel = meta.turnCount === 1 ? 'turn' : 'turns';
                rows.push(`<div class="details-meta__row">
                    <span class="details-meta__label">Turns</span>
                    <span class="details-meta__value">${meta.turnCount} ${turnLabel}</span>
                </div>`);
            }

            return `<div class="details-meta">${rows.join('')}</div>`;
        }

        // Standalone date formatter used by both the details meta block
        // and the conversation-slide timestamp.
        function formatHumanDate(iso) {
            if (!iso) return null;
            const d = new Date(iso);
            if (isNaN(d.getTime())) return null;
            const months = ['January', 'February', 'March', 'April', 'May', 'June',
                            'July', 'August', 'September', 'October', 'November', 'December'];
            return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
        }


        // Memoized map of slide-idx → split-position-within-message.
        // Walked once per deck-instance; cleared on deck mutation.
        function getSplitIndices() {
            const deckRef = deck;
            if (splitIndexCache && splitIndexDeckRef === deckRef) return splitIndexCache;
            const map = new Map();
            const seen = new Map(); // originalIdx → running count
            (deckRef?.slides || []).forEach((slide, idx) => {
                if (slide.type !== 'conversation' && slide.type !== 'narration') return;
                if (slide.originalIdx == null) return;
                const count = seen.get(slide.originalIdx) || 0;
                map.set(idx, count);
                seen.set(slide.originalIdx, count + 1);
            });
            splitIndexCache = map;
            splitIndexDeckRef = deckRef;
            return map;
        }
        function invalidateSplitIndexCache() {
            splitIndexCache = null;
            splitIndexDeckRef = null;
        }

        function formatTimestamp(iso) {
            if (!iso) return null;
            const d = new Date(iso);
            if (isNaN(d.getTime())) return null;
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const date = `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
            const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            return `${date} · ${time}`;
        }

        // Build the header label for a slide. For setup/details/title/end,
        // return the type label verbatim. For conversation/narration slides,
        // return just the speaker/label. The split-chunk index is shown
        // separately as a row of bubbles below the header line.
        function buildHeaderLabel(slide, idx) {
            if (slide.type !== 'conversation' && slide.type !== 'narration') {
                return slide.type.charAt(0).toUpperCase() + slide.type.slice(1);
            }
            if (slide.originalIdx == null) {
                return slide.label || slide.speaker || `Slide ${idx + 1}`;
            }
            return slide.label || slide.speaker || '';
        }

        // Build the row of split-chunk bubbles for a slide. For
        // conversation/narration slides that were split from a single
        // source message, render one bubble per chunk. The bubble
        // corresponding to the current chunk is filled; the others are
        // outlined. Returns '' for non-conversation slides or single-chunk
        // messages (no visual signal needed).
        function buildSplitBubbles(slide, idx) {
            if (slide.type !== 'conversation' && slide.type !== 'narration') return '';
            if (slide.originalIdx == null) return '';
            const splitCount = slide.splitCount || 1;
            if (splitCount <= 1) return '';
            const splitIdx = getSplitIndices().get(idx) || 0;
            const bubbles = [];
            for (let i = 0; i < splitCount; i++) {
                const isActive = i === splitIdx;
                bubbles.push(`<span class="slide-split-bubbles__bubble${isActive ? ' is-active' : ''}" aria-current="${isActive ? 'true' : 'false'}"></span>`);
            }
            return `<div class="slide-split-bubbles" aria-label="Chunk ${splitIdx + 1} of ${splitCount}">${bubbles.join('')}</div>`;
        }

        function computeRenderHash(text, voice, speed) {
            const state = `${text || ''}|${voice || ''}|${speed || 1.0}`;
            let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (let i = 0; i < state.length; i++) {
                const ch = state.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
        }

        let renderingMessages = new Set();
        let renderingSlides = new Set();
        // Per-paragraph rendering state. Keyed by `${msgIdx}:${paraIdx}`
        // so individual paragraphs light up while a message render is
        // in flight, and dim back to their final state as each completes.
        let renderingParagraphs = new Set();

        function computeMessageStaleness(msg) {
            if (!msg) return 'unrendered';
            const voiceConfig = deck.voiceMapping?.[msg.speaker || 'narrator'] || deck.voiceMapping?.narrator || { voice: 'en-US-Male', speed: 1.0 };
            const statuses = (msg.paragraphs || [])
                .map(p => computeParagraphStatus(p, voiceConfig))
                .filter(s => s !== 'skip');
            return aggregateStatus(statuses);
        }

        function renderMessageList() {
            // v2 path: flat per-slide list (no message grouping).
            if (!isV3) {
                renderSlideList();
                return;
            }

            const messages = deck.messages || [];
            if (messages.length === 0) {
                messageList.innerHTML = '<p class="render-status-hint">No messages to render.</p>';
                renderStatus.innerHTML = '<p class="render-status-hint">No messages.</p>';
                return;
            }

            // Status counts (kept at the message level — the dots in the
            // status card summarize message freshness, not individual
            // virtual slides).
            const counts = { fresh: 0, stale: 0, unrendered: 0, rendering: renderingMessages.size };
            messages.forEach(m => { counts[computeMessageStaleness(m)]++; });

            const statusLabel = {
                fresh: 'ready',
                stale: 'stale',
                unrendered: 'unrendered',
                rendering: 'rendering…'
            };
            const statusDot = (s) => `<span class="render-status-dot ${s}">
                <span class="render-status-dot__mark"></span>
                <span class="render-status-dot__label">${counts[s]} ${statusLabel[s]}</span>
            </span>`;

            renderStatus.innerHTML = `
                <div class="render-status-row">
                    ${counts.fresh ? statusDot('fresh') : ''}
                    ${counts.stale ? statusDot('stale') : ''}
                    ${counts.unrendered ? statusDot('unrendered') : ''}
                    ${counts.rendering ? statusDot('rendering') : ''}
                    ${(counts.fresh + counts.stale + counts.unrendered + counts.rendering) === 0 ? '<span class="render-status-hint">no messages</span>' : ''}
                </div>
            `;

            // ─── Build msgIdx → virtual-slide-indices map ───
            // Conversation slides (split chunks of a single source message)
            // are grouped under their source message. Non-conversation
            // slides (setup, details, topic, end) are top-level entries
            // with no children. Setup/Details/Topic render at the top of
            // the sidebar as the opening; End renders at the bottom as
            // the closing.
            const slidesByMsg = new Map();
            const openingSlides = []; // setup, details, topic (in deck.slides order)
            const closingSlides = []; // end (in deck.slides order)
            (deck.slides || []).forEach((slide, slideIdx) => {
                if (slide.type !== 'conversation' && slide.type !== 'narration') {
                    if (slide.type === 'end') closingSlides.push({ slideIdx, slide });
                    else openingSlides.push({ slideIdx, slide });
                    return;
                }
                const msgIdx = slide._paragraphs?.[0]?.msgIdx;
                if (msgIdx == null) {
                    if (slide.type === 'end') closingSlides.push({ slideIdx, slide });
                    else openingSlides.push({ slideIdx, slide });
                    return;
                }
                if (!slidesByMsg.has(msgIdx)) slidesByMsg.set(msgIdx, []);
                slidesByMsg.get(msgIdx).push(slideIdx);
            });

            // Build the sidebar. Opening slides first (Setup, Details,
            // Topic), then numbered conversation groups, then closing
            // slides (End). Each section gets a small label so the
            // structure is self-evident.
            const out = [];

            const renderTopLevelRow = ({ slideIdx, slide }) => {
                const slideRendering = renderingSlides.has(slideIdx)
                    || (slide._paragraphs || []).some(p => renderingParagraphs.has(`${p.msgIdx}:${p.paraIdx}`));
                const status = slideRendering ? 'rendering' : computeStaleness(slide);
                const isSelected = slideIdx === currentSlideIdx;
                const isDimmed = status !== 'fresh' && !slideRendering;
                const label = slide.type.charAt(0).toUpperCase() + slide.type.slice(1);
                return `
                    <div data-slide-idx="${slideIdx}" class="render-slide-row render-slide-row--top ${isSelected ? 'is-selected' : ''} ${isDimmed ? 'is-dimmed' : ''}" title="${escapeHtml(label)} (${statusLabel[status]})">
                        <span class="render-slide-row__dot ${status}" data-slide-idx="${slideIdx}"></span>
                        <span class="render-slide-row__label" data-slide-idx="${slideIdx}">${escapeHtml(label)}</span>
                        ${!slideRendering ? `<span class="render-slide-row__action"><nui-button variant="icon" data-action="render-slide:${slideIdx}" title="Render this slide"><button type="button" aria-label="Render slide ${slideIdx + 1}"><nui-icon name="redo"></nui-icon></button></nui-button></span>` : ''}
                    </div>
                `;
            };

            if (openingSlides.length > 0) {
                out.push(`<div class="render-slide-section__label">Opening</div>`);
                openingSlides.forEach(s => out.push(renderTopLevelRow(s)));
            }

            let msgCounter = 0;
            messages.forEach((msg, msgIdx) => {
                if (msg.type && msg.type !== 'conversation') return; // already in top-level
                msgCounter++;
                const subSlides = slidesByMsg.get(msgIdx) || [];
                const isRendering = renderingMessages.has(msgIdx)
                    || (msg.paragraphs || []).some((_, pi) => renderingParagraphs.has(`${msgIdx}:${pi}`));
                const status = isRendering ? 'rendering' : computeMessageStaleness(msg);
                const isDimmed = status !== 'fresh' && !isRendering;
                const label = msg.label || msg.originalSpeaker || msg.speaker || `Message ${msgIdx + 1}`;
                const subRows = subSlides.map((sIdx, j) => {
                    const subSlide = deck.slides[sIdx];
                    // If any paragraph in this virtual slide is currently
                    // rendering, show the slide as rendering regardless of
                    // its overall freshness — gives per-paragraph feedback.
                    const slideRendering = renderingSlides.has(sIdx)
                        || (subSlide?._paragraphs || []).some(p => renderingParagraphs.has(`${p.msgIdx}:${p.paraIdx}`));
                    const subStatus = slideRendering ? 'rendering' : computeStaleness(subSlide);
                    const subSelected = sIdx === currentSlideIdx;
                    const subDimmed = subStatus !== 'fresh' && !slideRendering;
                    return `
                        <div data-slide-idx="${sIdx}" class="render-slide-row render-slide-row--sub ${subSelected ? 'is-selected' : ''} ${subDimmed ? 'is-dimmed' : ''}" title="Slide ${j + 1} of ${subSlides.length} (${statusLabel[subStatus]})">
                            <span class="render-slide-row__dot ${subStatus}" data-slide-idx="${sIdx}"></span>
                            <span class="render-slide-row__label" data-slide-idx="${sIdx}">Slide ${j + 1} of ${subSlides.length}</span>
                            ${!slideRendering ? `<span class="render-slide-row__action"><nui-button variant="icon" data-action="render-vslide:${sIdx}" title="Render this virtual slide"><button type="button" aria-label="Render slide ${sIdx + 1}"><nui-icon name="redo"></nui-icon></button></nui-button></span>` : ''}
                        </div>
                    `;
                }).join('');
                out.push(`
                    <div class="render-slide-group">
                        <div data-msg-idx="${msgIdx}" class="render-slide-group__header ${isDimmed ? 'is-dimmed' : ''}" title="${escapeHtml(label)} (${statusLabel[status]})">
                            <span class="render-slide-group__num">${msgCounter}.</span>
                            <span class="render-slide-row__dot ${status}" data-msg-idx="${msgIdx}"></span>
                            <span class="render-slide-group__label">${escapeHtml(label)}</span>
                            <span class="render-slide-group__count">${subSlides.length} slide${subSlides.length === 1 ? '' : 's'}</span>
                            ${!isRendering ? `<span class="render-slide-row__action"><nui-button variant="icon" data-action="render-message:${msgIdx}" title="Render this message"><button type="button" aria-label="Render message ${msgIdx + 1}"><nui-icon name="redo"></nui-icon></button></nui-button></span>` : ''}
                        </div>
                        <div class="render-slide-group__slides">${subRows}</div>
                    </div>
                `);
            });

            if (closingSlides.length > 0) {
                out.push(`<div class="render-slide-section__label">Closing</div>`);
                closingSlides.forEach(s => out.push(renderTopLevelRow(s)));
            }

            messageList.innerHTML = out.join('');

            // Click handlers: sub-rows jump to a specific virtual slide.
            // Group headers jump to the first virtual slide in the group.
            messageList.querySelectorAll('[data-slide-idx]').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.slideIdx);
                    loadSlide(idx);
                });
            });
            messageList.querySelectorAll('[data-msg-idx]').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.msgIdx);
                    const first = (slidesByMsg.get(idx) || [])[0];
                    if (first != null) loadSlide(first);
                });
            });
        }

        function renderSlideList() {
            const slides = deck.slides || [];
            if (slides.length === 0) {
                messageList.innerHTML = '<p class="render-status-hint">No slides to render.</p>';
                return;
            }

            const counts = { fresh: 0, stale: 0, unrendered: 0, rendering: renderingSlides.size };
            slides.forEach(s => { counts[computeStaleness(s)]++; });

            const statusLabel = {
                fresh: 'ready',
                stale: 'stale',
                unrendered: 'unrendered',
                rendering: 'rendering…'
            };
            const statusDot = (s) => `<span class="render-status-dot ${s}">
                <span class="render-status-dot__mark"></span>
                <span class="render-status-dot__label">${counts[s]} ${statusLabel[s]}</span>
            </span>`;

            renderStatus.innerHTML = `
                <div class="render-status-row">
                    ${counts.fresh ? statusDot('fresh') : ''}
                    ${counts.stale ? statusDot('stale') : ''}
                    ${counts.unrendered ? statusDot('unrendered') : ''}
                    ${counts.rendering ? statusDot('rendering') : ''}
                </div>
            `;

            messageList.innerHTML = slides.map((slide, idx) => {
                const isRendering = renderingSlides.has(idx);
                const status = isRendering ? 'rendering' : computeStaleness(slide);
                const isSelected = idx === currentSlideIdx;
                const headerLabel = buildHeaderLabel(slide, idx);
                return `
                    <div data-slide-idx="${idx}" class="render-slide-row ${isSelected ? 'is-selected' : ''} ${status !== 'fresh' && !isRendering ? 'is-dimmed' : ''}" title="${escapeHtml(headerLabel)} (${statusLabel[status]})">
                        <span class="render-slide-row__dot ${status}" data-slide-idx="${idx}"></span>
                        <span class="render-slide-row__label" data-slide-idx="${idx}">${escapeHtml(headerLabel)}</span>
                        ${!isRendering ? `<span class="render-slide-row__action"><nui-button variant="icon" data-action="render-slide:${idx}" title="Render this slide"><button type="button" aria-label="Render slide ${idx + 1}"><nui-icon name="redo"></nui-icon></button></nui-button></span>` : ''}
                    </div>
                `;
            }).join('');

            messageList.querySelectorAll('[data-slide-idx]').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.slideIdx);
                    loadSlide(idx);
                });
            });
        }

        async function renderSingleMessage(idx) {
            if (!isV3) {
                // v2: fall back to slide render
                return renderSingleSlide(idx);
            }
            const msg = deck.messages?.[idx];
            if (!msg) return;
            // Build (paraIdx, para) pairs from the ORIGINAL paragraphs array,
            // filtering out empty/placeholder paragraphs. The paraIdx must
            // be the index into msg.paragraphs[] (the server's array), not
            // the filtered array — the server identifies paragraphs by
            // their positional index.
            const msgIdx = idx;
            const paragraphs = [];
            (msg.paragraphs || []).forEach((p, pi) => {
                if (p.text && p.text.trim() && p.text.trim() !== '...') {
                    paragraphs.push({ paraIdx: pi, para: p });
                }
            });
            if (paragraphs.length === 0) return;

            renderingMessages.add(idx);
            // Mark every paragraph as rendering up front so the dots
            // flip to blue immediately. They clear one-by-one as each
            // per-paragraph endpoint completes below.
            paragraphs.forEach(({ paraIdx }) => renderingParagraphs.add(`${msgIdx}:${paraIdx}`));
            renderMessageList();

            let failed = 0;
            try {
                for (const { paraIdx } of paragraphs) {
                    const key = `${msgIdx}:${paraIdx}`;
                    try {
                        const res = await fetch(`/api/v3/render-paragraph/${projectId}/${msgIdx}/${paraIdx}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        if (!res.ok) throw new Error((await res.json()).error || 'Render failed');
                        const updatedPara = await res.json();
                        const targetMsg = deck.messages[msgIdx];
                        if (targetMsg && targetMsg.paragraphs) {
                            targetMsg.paragraphs[paraIdx] = updatedPara;
                        }
                    } catch {
                        failed++;
                    } finally {
                        // Rebuild virtual slides so _paragraphs picks up
                        // the updated paragraph data (audioRef, words,
                        // etc.). Without this, computeStaleness reads
                        // stale _paragraphs snapshots and shows freshly-
                        // rendered paragraphs as "unrendered" until the
                        // entire message finishes.
                        virtualSlides = buildVirtualSlides();
                        deck.slides = virtualSlides;
                        window.SLIDESHOW_APP.deck = deck;
                        invalidateSplitIndexCache();

                        // Each paragraph clears as it finishes, so the
                        // dots go from blue → final color one at a time.
                        renderingParagraphs.delete(key);
                        renderMessageList();
                    }
                }
                virtualSlides = buildVirtualSlides();
                deck.slides = virtualSlides;
                window.SLIDESHOW_APP.deck = deck;
                invalidateSplitIndexCache();
                if (failed === 0) {
                    nui.components.banner.show({ content: `Message ${idx + 1} rendered`, priority: 'success', autoClose: 2000 });
                } else {
                    nui.components.banner.show({ content: `Message ${idx + 1} render: ${paragraphs.length - failed}/${paragraphs.length} ok`, priority: 'alert', autoClose: 5000 });
                }
            } finally {
                renderingMessages.delete(idx);
                // Safety net — if any paragraphs didn't clear (shouldn't
                // happen, but defend against thrown errors mid-loop),
                // clear them all.
                paragraphs.forEach(({ paraIdx }) => renderingParagraphs.delete(`${msgIdx}:${paraIdx}`));
                renderMessageList();
                loadSlide(currentSlideIdx);
            }
        }

        // Render a single virtual slide (a group of paragraphs in a
        // single source message). Loops over the slide's paragraphs and
        // calls the per-paragraph endpoint. The server is idempotent on
        // already-fresh paragraphs, so this is safe to re-run.
        async function renderVirtualSlide(slideIdx) {
            if (!isV3) {
                return renderSingleSlide(slideIdx);
            }
            const slide = deck.slides?.[slideIdx];
            if (!slide || !slide._paragraphs) return;
            const paragraphs = slide._paragraphs.filter(p => p.text && p.text.trim() && p.text.trim() !== '...');
            if (paragraphs.length === 0) return;

            // Mark both the slide and the source message as rendering so
            // both dots in the sidebar show the in-flight state.
            renderingSlides.add(slideIdx);
            const msgIdx = paragraphs[0].msgIdx;
            if (msgIdx != null) renderingMessages.add(msgIdx);
            renderMessageList();

            let failed = 0;
            try {
                for (const para of paragraphs) {
                    try {
                        const res = await fetch(`/api/v3/render-paragraph/${projectId}/${para.msgIdx}/${para.paraIdx}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' }
                        });
                        if (!res.ok) throw new Error((await res.json()).error || 'Render failed');
                        // The server returns the updated paragraph. Splice
                        // it back into the message's paragraphs[].
                        const updatedPara = await res.json();
                        const targetMsg = deck.messages[para.msgIdx];
                        if (targetMsg && targetMsg.paragraphs) {
                            targetMsg.paragraphs[para.paraIdx] = updatedPara;
                        }
                        // Rebuild after each paragraph so staleness
                        // checks see fresh data immediately.
                        virtualSlides = buildVirtualSlides();
                        deck.slides = virtualSlides;
                        window.SLIDESHOW_APP.deck = deck;
                        invalidateSplitIndexCache();
                        renderMessageList();
                    } catch {
                        failed++;
                    }
                }
                virtualSlides = buildVirtualSlides();
                deck.slides = virtualSlides;
                window.SLIDESHOW_APP.deck = deck;
                invalidateSplitIndexCache();
                if (failed === 0) {
                    nui.components.banner.show({ content: `Slide rendered`, priority: 'success', autoClose: 2000 });
                } else {
                    nui.components.banner.show({ content: `Slide render: ${paragraphs.length - failed}/${paragraphs.length} ok`, priority: 'alert', autoClose: 5000 });
                }
            } finally {
                renderingSlides.delete(slideIdx);
                if (msgIdx != null) renderingMessages.delete(msgIdx);
                renderMessageList();
                loadSlide(currentSlideIdx);
            }
        }

        // Render a single slide.
        //   - v3: delegate to renderVirtualSlide, which works for any
        //     virtual slide with paragraphs (conversation, setup,
        //     details, topic, end). The server's /api/v3/render-paragraph
        //     resolves the right voice from the message's role.
        //   - v2: call the v2 /api/render-slide endpoint.
        async function renderSingleSlide(slideIdx) {
            if (isV3) {
                return renderVirtualSlide(slideIdx);
            }
            renderingSlides.add(slideIdx);
            renderMessageList();
            try {
                const res = await fetch(`/api/render-slide/${projectId}/${slideIdx}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!res.ok) throw new Error((await res.json()).error || 'Render failed');
                const { slide } = await res.json();
                deck.slides[slideIdx] = slide;
                window.SLIDESHOW_APP.deck = deck;
                invalidateSplitIndexCache();
                nui.components.banner.show({ content: `Slide rendered`, priority: 'success', autoClose: 2000 });
            } catch (err) {
                nui.components.banner.show({ content: `Slide render failed: ${err.message}`, priority: 'alert', autoClose: 5000 });
            } finally {
                renderingSlides.delete(slideIdx);
                renderMessageList();
                loadSlide(currentSlideIdx);
            }
        }

        async function renderAllSlides(options = {}) {
            if (isV3) {
                return await renderAllV3(options);
            }
            // v2: original per-slide render
            const slides = deck.slides;
            const toRender = [];
            for (let i = 0; i < slides.length; i++) {
                toRender.push(i);
            }

            toRender.forEach(i => renderingSlides.add(i));
            renderSlideList();

            let failed = 0;
            for (const idx of toRender) {
                try {
                    const res = await fetch(`/api/render-slide/${projectId}/${idx}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    if (!res.ok) throw new Error((await res.json()).error || 'Render failed');
                    const { slide } = await res.json();
                    deck.slides[idx] = slide;
                    window.SLIDESHOW_APP.deck = deck;
                    invalidateSplitIndexCache();
                } catch (err) {
                    failed++;
                }
                renderingSlides.delete(idx);
                renderSlideList();
            }

            loadSlide(currentSlideIdx);
            if (failed === 0) {
                nui.components.banner.show({ content: `Render complete: ${toRender.length} slides`, priority: 'success', autoClose: 3000 });
            } else {
                nui.components.banner.show({ content: `Render done: ${toRender.length - failed} ok, ${failed} failed`, priority: 'alert', autoClose: 5000 });
            }
        }

        function setRenderProgress(visible, pct, message) {
            if (!renderProgress || !renderProgressWrap) return;
            renderProgress.setAttribute('value', String(pct));
            if (renderProgressText) renderProgressText.textContent = message || '';
            renderProgressWrap.hidden = !visible;
        }

        function setRenderControls(isActive) {
            renderAllActive = isActive;
            if (btnRenderWrap) btnRenderWrap.hidden = isActive;
            if (btnStopWrap) btnStopWrap.hidden = !isActive;
        }

        async function renderAllV3(options = {}) {
            const force = options.force === true;
            setRenderControls(true);
            // Mark all messages as rendering
            for (let i = 0; i < deck.messages.length; i++) renderingMessages.add(i);
            renderMessageList();
            setRenderProgress(true, 0, 'Render starting…');

            let pollTimer = null;
            let renderStartMs = Date.now();

            function formatEta(ms) {
                if (!isFinite(ms) || ms < 0) return '';
                const totalSec = Math.round(ms / 1000);
                if (totalSec < 60) return `${totalSec}s`;
                const min = Math.floor(totalSec / 60);
                const sec = totalSec % 60;
                return sec ? `${min}m ${sec}s` : `${min}m`;
            }

            function updateProgress(message, pct) {
                // Estimate TTA from elapsed time and current percentage. Skip
                // the estimate during the first few seconds — at 0% the math
                // divides by zero, and at 1-2% the estimate is wildly wrong.
                let eta = '';
                if (pct > 5) {
                    const elapsedMs = Date.now() - renderStartMs;
                    const remainingMs = (elapsedMs / pct) * (100 - pct);
                    eta = ` · ETA ${formatEta(remainingMs)}`;
                }
                setRenderProgress(true, pct, `${message} (${pct}%)${eta}`);
            }

            async function refreshProjectStatus() {
                try {
                    const res = await fetch(`/api/projects/${projectId}`);
                    if (!res.ok) return;
                    const fresh = await res.json();
                    if (fresh.messages) {
                        deck.messages = fresh.messages;
                        deck.voiceMapping = fresh.voiceMapping || deck.voiceMapping;
                        window.SLIDESHOW_APP.deck = deck;
                        virtualSlides = buildVirtualSlides();
                        deck.slides = virtualSlides;
                        renderMessageList();
                    }
                } catch (err) {
                    console.warn('[renderAllV3] status refresh failed:', err);
                }
            }

            async function pollProgress() {
                try {
                    const res = await fetch(`/api/v3/render-progress/${projectId}`);
                    if (!res.ok) return;
                    const p = await res.json();
                    updateProgress(p.message, p.pct);
                    if (p.stage === 'done' || p.stage === 'stopped') {
                        clearInterval(pollTimer);
                    }
                    // Refresh message status dots every few percent
                    if (Math.floor(p.pct / 5) !== Math.floor((p.pct - (p.pct > 0 ? 1 : 0)) / 5)) {
                        await refreshProjectStatus();
                    }
                } catch (err) {
                    console.warn('[renderAllV3] poll failed:', err);
                }
            }

            try {
                // Poll every second; server writes progress file every few paragraphs
                pollTimer = setInterval(pollProgress, 1000);

                const res = await fetch(`/api/v3/render-deck/${projectId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...deck, force })
                });

                clearInterval(pollTimer);

                if (!res.ok) {
                    const errText = await res.text().catch(() => '');
                    let msg = errText;
                    try { msg = JSON.parse(errText).error || msg; } catch {}
                    throw new Error(msg || 'Render failed');
                }

                const rendered = await res.json();
                deck.messages = rendered.messages;
                deck.voiceMapping = rendered.voiceMapping;
                window.SLIDESHOW_APP.deck = deck;

                virtualSlides = buildVirtualSlides();
                deck.slides = virtualSlides;

                updateProgress('Render complete', 100);
                nui.components.banner.show({ content: `Render complete: ${rendered.messages.length} messages`, priority: 'success', autoClose: 3000 });
            } catch (err) {
                clearInterval(pollTimer);
                if (err.name === 'AbortError' || err.message?.includes('aborted')) {
                    updateProgress('Render stopped', 0);
                    nui.components.banner.show({ content: 'Render stopped', priority: 'warning', autoClose: 3000 });
                    await refreshProjectStatus();
                } else {
                    updateProgress(`Render failed: ${err.message}`, 0);
                    nui.components.banner.show({ content: `Render failed: ${err.message}`, priority: 'alert', autoClose: 5000 });
                }
            } finally {
                setRenderControls(false);
                renderingMessages = new Set();
                renderMessageList();
                loadSlide(currentSlideIdx);
            }
        }

        async function stopRenderAll() {
            try {
                const res = await fetch(`/api/v3/render-stop/${projectId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    console.warn('[stopRenderAll]', data.error || 'stop failed');
                }
            } catch (err) {
                console.warn('[stopRenderAll] request failed:', err);
            }
        }

        function loadSlide(idx) {
            if (!deck.slides || idx < 0 || idx >= deck.slides.length) return;
            currentSlideIdx = idx;
            currentParaIdx = -1;
            v3CumulativeMs = 0;
            const slide = deck.slides[idx];



            // ── Body content ──
            //
            // The render function is now data-driven: it reads SLIDE_STYLES
            // for which UI bits to show, then emits a structured DOM with
            // class hooks. The actual visual styling lives in CSS.
            const style = SLIDE_STYLES[slide.type] || {};
            const classes = buildSlideClassList(slide, idx);

            let html = '';
            html += `<div class="${classes.join(' ')}" data-slide-type="${escapeHtml(slide.type)}" data-slide-render-idx="${idx}">`;

            // Header row. Per-type flags decide what shows.
            if (style.showHeader) {
                const headerLabel = buildHeaderLabel(slide, idx);
                const createdAt = (slide.type === 'conversation' && slide.originalIdx != null)
                    ? deck?.source?.messages?.[slide.originalIdx]?.createdAt
                    : null;
                const timestamp = createdAt ? formatTimestamp(createdAt) : null;

                html += `<div class="slide-header">`;
                if (style.showEyebrow) {
                    html += `<div class="slide-eyebrow">${escapeHtml(slide.type)}</div>`;
                }
                if (style.showSpeaker || headerLabel) {
                    html += `<div class="slide-header__row">`;
                    if (style.showSpeaker) {
                        html += `<div class="slide-header__label">${escapeHtml(headerLabel)}</div>`;
                    }
                    if (timestamp) {
                        html += `<div class="slide-header__timestamp">${escapeHtml(timestamp)}</div>`;
                    }
                    html += `</div>`;
                }
                // Split-chunk bubbles: one per chunk, active bubble filled.
                const bubbles = buildSplitBubbles(slide, idx);
                if (bubbles) html += bubbles;
                html += `</div>`;
            }

            // Body. Per-layout dispatch.
            if (style.layout === 'meta') {
                // Details slide: render the structured meta block. The
                // spoken narration still goes through the words container
                // so word-by-word highlighting works.
                html += renderDetailsMeta(slide.meta);
                if (slide.narration) {
                    html += `<div class="slide-narration words-container">${buildWordSpans(slide.narration, slide.tts, slide._paragraphs)}</div>`;
                }
            } else if (style.layout === 'centered') {
                // Topic slide: large centered text with word highlighting.
                // If aligned words exist, the words container is the
                // primary text so the topic is not duplicated.
                if (slide._paragraphs?.some(p => p.words?.length > 0)) {
                    html += `<div class="slide-body words-container">${buildWordSpans(slide.narration || slide.text || '', slide.tts, slide._paragraphs)}</div>`;
                } else {
                    html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
                }
            } else if (style.layout === 'minimal') {
                // End slide: small centered. Use word spans if aligned.
                if (slide._paragraphs?.some(p => p.words?.length > 0)) {
                    html += `<div class="slide-body words-container">${buildWordSpans(slide.narration || slide.text || '', slide.tts, slide._paragraphs)}</div>`;
                } else {
                    html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
                }
            } else if (style.layout === 'framed') {
                // Setup slide: framed text, with the narration words
                // container below for highlighting.
                html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
                if (slide.narration) {
                    html += `<div class="slide-body words-container">${buildWordSpans(slide.narration, slide.tts, slide._paragraphs)}</div>`;
                }
            } else {
                html += `<div class="slide-body words-container">${buildWordSpans(slide.text || slide.narration || '', slide.tts, slide._paragraphs)}</div>`;
            }

            html += `</div>`;

            // Swap the slide content. Speaker-change visual treatment
            // is handled purely via CSS (the .slide--new-speaker class
            // hook), not JS animations. The previous WAAPI transition
            // was removed — it triggered on wrong events and duplicated
            // slides. A proper transition system needs to be driven by
            // the playback timeline, not by loadSlide() calls.
            playerContent.innerHTML = html;

            // Load audio if rendered
            const tts = slide.tts;
            if (slide._paragraphs && slide._paragraphs.length > 0) {
                // v3: chain paragraph audios
                loadParagraphAudio(slide._paragraphs);
            } else if (tts && !tts.error && tts.audioUrl) {
                audio.src = tts.audioUrl;
                audio.playbackRate = playbackSpeed;
            } else {
                audio.src = '';
            }

            updateControls();
            updateProgress(0);
            updateTimeDisplay(0, tts?.durationMs || 0);
            // Reflect the new current slide in the sidebar selection.
            renderMessageList();
        }

        function buildWordSpans(text, tts, paragraphs) {
            // v3: build word spans per-paragraph, each with local timing (no offsets)
            if (paragraphs && paragraphs.length > 0) {
                const allSpans = [];
                for (let pi = 0; pi < paragraphs.length; pi++) {
                    const para = paragraphs[pi];
                    const wordSpans = [];
                    if (para.words && para.words.length > 0) {
                        for (const w of para.words) {
                            wordSpans.push(
                                `<span class="word future" data-start="${w.startMs}" data-end="${w.endMs}">${escapeHtml(w.word)}</span> `
                            );
                        }
                    } else if (para.text) {
                        // Paragraph exists but hasn't been aligned yet (or
                        // alignment produced no words). Show the text so the
                        // slide isn't blank; it will gain word timing after
                        // render/alignment.
                        wordSpans.push(`<span class="word future">${escapeHtml(para.text)}</span>`);
                    }
                    // Wrap this paragraph's words in a container with para index
                    allSpans.push(`<span class="para-words" data-para-idx="${pi}">${wordSpans.join('')}</span>`);
                    // Visual paragraph break between paragraphs (not after the last one)
                    if (pi < paragraphs.length - 1) {
                        allSpans.push('<span class="para-break"></span>');
                    }
                }
                return allSpans.join('');
            }

            // v2: original logic
            const timedWords = getTimedWords(tts);
            if (timedWords.length > 0) {
                return timedWords.map(w =>
                    `<span class="word future" data-start="${w.startMs}" data-end="${w.endMs}">${escapeHtml(w.word)}</span> `
                ).join('');
            }
            if (!text) return '';
            return `<span class="word future">${escapeHtml(text)}</span>`;
        }

        function getTimedWords(tts) {
            if (!tts) return [];
            if (tts.words && tts.words.length > 0) return tts.words;
            if (tts.segments) {
                const flat = [];
                for (const seg of tts.segments) {
                    if (seg.words) flat.push(...seg.words);
                }
                return flat;
            }
            return [];
        }

        function updateWordHighlight(currentTimeMs) {
            const slide = deck?.slides?.[currentSlideIdx];

            // v3: per-paragraph highlighting using local timing
            if (slide?._paragraphs && currentParaIdx >= 0) {
                const paraContainers = playerContent.querySelectorAll('.para-words');
                paraContainers.forEach(container => {
                    const pi = parseInt(container.dataset.paraIdx, 10);
                    const words = container.querySelectorAll('.word');

                    if (pi < currentParaIdx) {
                        // Past paragraph — all words are past
                        words.forEach(el => { el.className = 'word past'; });
                    } else if (pi === currentParaIdx) {
                        // Current paragraph — use local audio time
                        words.forEach(el => {
                            const startMs = parseFloat(el.dataset.start);
                            const endMs = parseFloat(el.dataset.end);
                            if (isNaN(startMs) || isNaN(endMs)) {
                                el.className = 'word future';
                            } else if (currentTimeMs >= startMs && currentTimeMs < endMs) {
                                el.className = 'word active';
                            } else if (currentTimeMs >= endMs) {
                                el.className = 'word past';
                            } else {
                                el.className = 'word future';
                            }
                        });
                    } else {
                        // Future paragraph — all words are future
                        words.forEach(el => { el.className = 'word future'; });
                    }
                });
                return;
            }

            // v2: original global highlighting
            const wordEls = playerContent.querySelectorAll('.words-container .word');
            if (wordEls.length === 0) return;

            wordEls.forEach(el => {
                const startMs = parseFloat(el.dataset.start);
                const endMs = parseFloat(el.dataset.end);

                if (isNaN(startMs) || isNaN(endMs)) {
                    el.className = 'word future';
                    return;
                }

                if (currentTimeMs >= startMs && currentTimeMs < endMs) {
                    el.className = 'word active';
                } else if (currentTimeMs >= endMs) {
                    el.className = 'word past';
                } else {
                    el.className = 'word future';
                }
            });
        }

        function updateProgress(currentTimeMs) {
            const slide = deck?.slides?.[currentSlideIdx];
            const duration = slide?.tts?.durationMs || (audio.duration * 1000) || 0;
            const pct = duration > 0 ? (currentTimeMs / duration) * 100 : 0;
            progressFill.style.width = Math.min(pct, 100) + '%';
        }

        // ─── Recording / Presentation mode ─────────────────────
        // Hides the app header, sidebar, progress bar, and controls
        // row, then requests browser fullscreen on the page wrapper.
        // Esc (or the browser's fullscreen-exit) tears the mode down
        // and shows the controls again. Useful for screen-recording
        // the slides or for a clean presentation view.
        let isRecording = false;

        async function enterRecordingMode() {
            if (isRecording) return;
            isRecording = true;
            document.body.classList.add('render-recording');
            updateRecordButton();
            try {
                // requestFullscreen on the .page-render wrapper so the
                // background-color of the page extends into the
                // fullscreen area (otherwise it'd be black).
                const pageEl = element.querySelector('.page-render');
                if (pageEl && pageEl.requestFullscreen) {
                    await pageEl.requestFullscreen();
                } else if (document.documentElement.requestFullscreen) {
                    await document.documentElement.requestFullscreen();
                }
            } catch (err) {
                // Fullscreen request can be denied (e.g. not from a
                // user gesture in some browsers). Recording mode
                // still works without it — the layout is clean.
                console.warn('[Record] fullscreen request failed:', err.message);
            }
        }

        async function exitRecordingMode() {
            if (!isRecording) return;
            isRecording = false;
            document.body.classList.remove('render-recording');
            updateRecordButton();
            try {
                if (document.fullscreenElement) {
                    await document.exitFullscreen();
                }
            } catch (err) {
                console.warn('[Record] exitFullscreen failed:', err.message);
            }
        }

        function toggleRecordingMode() {
            if (isRecording) exitRecordingMode();
            else enterRecordingMode();
        }

        function updateRecordButton() {
            if (!btnRecord || !btnRecordLabel) return;
            btnRecordLabel.textContent = isRecording ? 'Exit' : 'Record';
            btnRecord.setAttribute('title', isRecording
                ? 'Exit recording mode (Esc)'
                : 'Enter recording mode (fullscreen, no controls)');
        }

        // Sync state if the user presses Esc (or any other browser-
        // native way of leaving fullscreen).
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement && isRecording) {
                isRecording = false;
                document.body.classList.remove('render-recording');
                updateRecordButton();
            }
        });

        // Also handle Esc as a fallback for browsers that don't fire
        // fullscreenchange reliably on key-exit.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isRecording) {
                exitRecordingMode();
            }
        });

        function updateTimeDisplay(currentMs, durationMs) {
            const fmt = (ms) => {
                const s = Math.floor(ms / 1000);
                const m = Math.floor(s / 60);
                return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
            };
            timeDisplay.textContent = `${fmt(currentMs)} / ${fmt(durationMs)}`;
        }

        function updateControls() {
            const slide = deck?.slides?.[currentSlideIdx];
            // v3: check if any paragraph has audio
            if (slide?._paragraphs) {
                btnPlay.disabled = !slide._paragraphs.some(p => p.audioUrl);
                return;
            }
            const tts = slide?.tts;
            btnPlay.disabled = !tts || !tts.audioUrl;
        }

        function animationLoop() {
            if (!audio.src || audio.paused) {
                rafId = null;
                return;
            }
            const slide = deck?.slides?.[currentSlideIdx];
            const localTimeMs = audio.currentTime * 1000;

            if (slide?._paragraphs) {
                // v3: local time for current paragraph, cumulative for progress
                const totalElapsedMs = v3CumulativeMs + localTimeMs;
                updateWordHighlight(localTimeMs);
                updateProgress(totalElapsedMs);
                updateTimeDisplay(totalElapsedMs, v3TotalDurationMs);
            } else {
                // v2: global time
                const durationMs = slide?.tts?.durationMs || (audio.duration * 1000) || 0;
                updateWordHighlight(localTimeMs);
                updateProgress(localTimeMs);
                updateTimeDisplay(localTimeMs, durationMs);
            }
            rafId = requestAnimationFrame(animationLoop);
        }

        function startLoop() {
            if (!rafId) rafId = requestAnimationFrame(animationLoop);
        }
        function stopLoop() {
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        }

        audio.addEventListener('play', () => {
            isPlaying = true;
            const innerBtn = btnPlay.querySelector('button');
            const icon = btnPlay.querySelector('nui-icon');
            if (icon) icon.setAttribute('name', 'pause');
            if (innerBtn) innerBtn.setAttribute('aria-label', 'Pause');
            startLoop();
        });
        audio.addEventListener('pause', () => {
            isPlaying = false;
            const innerBtn = btnPlay.querySelector('button');
            const icon = btnPlay.querySelector('nui-icon');
            if (icon) icon.setAttribute('name', 'play');
            if (innerBtn) innerBtn.setAttribute('aria-label', 'Play');
            stopLoop();
        });
        audio.addEventListener('ended', () => {
            const slide = deck?.slides?.[currentSlideIdx];

            // v3: chain to next paragraph
            if (slide?._paragraphs && currentParaIdx >= 0) {
                // Accumulate finished paragraph's duration
                v3CumulativeMs += v3Paragraphs[currentParaIdx]?.durationMs || 0;

                // Find next paragraph with audio
                let nextIdx = -1;
                for (let i = currentParaIdx + 1; i < v3Paragraphs.length; i++) {
                    if (v3Paragraphs[i].audioUrl && v3Paragraphs[i].words?.length > 0) {
                        nextIdx = i;
                        break;
                    }
                }

                if (nextIdx >= 0) {
                    currentParaIdx = nextIdx;
                    audio.src = v3Paragraphs[nextIdx].audioUrl;
                    audio.playbackRate = playbackSpeed;
                    audio.play().catch(() => {});
                    return;
                }
                // No more paragraphs — fall through to slide advance
            }

            // All paragraphs done (or v2 slide ended)
            const innerBtn = btnPlay.querySelector('button');
            const icon = btnPlay.querySelector('nui-icon');
            if (icon) icon.setAttribute('name', 'play');
            if (innerBtn) innerBtn.setAttribute('aria-label', 'Play');
            stopLoop();
            if (currentSlideIdx < (deck?.slides?.length || 1) - 1) {
                setTimeout(() => loadSlide(currentSlideIdx + 1), 300);
                if (audio.src) {
                    setTimeout(() => audio.play().catch(() => {}), 400);
                }
            }
        });

        // Click handlers
        element.addEventListener('click', async (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;
            const [action, param] = actionEl.dataset.action.split(':');

            if (action === 'render-all') {
                await renderAllSlides({ force: param === 'force' });
            }

            if (action === 'render-stop') {
                await stopRenderAll();
            }

            if (action === 'render-message') {
                const idx = parseInt(param, 10);
                await renderSingleMessage(idx);
            }

            if (action === 'render-slide') {
                const idx = parseInt(param, 10);
                await renderSingleSlide(idx);
            }

            if (action === 'render-vslide') {
                const idx = parseInt(param, 10);
                await renderVirtualSlide(idx);
            }

            if (action === 'player-play') {
                if (!audio.src) return;
                if (audio.paused) audio.play().catch(() => {});
                else audio.pause();
            }
            if (action === 'player-prev') {
                if (currentSlideIdx > 0) loadSlide(currentSlideIdx - 1);
            }
            if (action === 'player-next') {
                if (currentSlideIdx < (deck.slides?.length || 0) - 1) loadSlide(currentSlideIdx + 1);
            }
            if (action === 'player-speed') {
                const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
                const idx = speeds.indexOf(playbackSpeed);
                playbackSpeed = speeds[(idx + 1) % speeds.length];
                audio.playbackRate = playbackSpeed;
                btnSpeed.querySelector('button').textContent = playbackSpeed.toFixed(playbackSpeed % 1 === 0 ? 0 : 2) + 'x';
            }
            if (action === 'player-record') {
                toggleRecordingMode();
            }
        });

        progressBar.addEventListener('click', (e) => {
            if (!audio.src) return;
            const rect = progressBar.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const slide = deck?.slides?.[currentSlideIdx];

            // v3: find which paragraph the click lands in
            if (slide?._paragraphs && v3Paragraphs.length > 0) {
                const targetMs = pct * v3TotalDurationMs;
                let cumMs = 0;
                for (let i = 0; i < v3Paragraphs.length; i++) {
                    const paraDur = v3Paragraphs[i].durationMs || 0;
                    if (cumMs + paraDur > targetMs || i === v3Paragraphs.length - 1) {
                        // Click is in this paragraph
                        currentParaIdx = i;
                        v3CumulativeMs = cumMs;
                        audio.src = v3Paragraphs[i].audioUrl;
                        audio.playbackRate = playbackSpeed;
                        const withinPara = Math.max(0, targetMs - cumMs);
                        audio.currentTime = withinPara / 1000;
                        break;
                    }
                    cumMs += paraDur;
                }
                return;
            }

            // v2
            const duration = slide?.tts?.durationMs || (audio.duration * 1000) || 0;
            audio.currentTime = (pct * duration) / 1000;
        });

        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            switch (e.key) {
                case ' ': e.preventDefault(); audio.paused ? audio.play() : audio.pause(); break;
                case 'ArrowLeft': if (currentSlideIdx > 0) loadSlide(currentSlideIdx - 1); break;
                case 'ArrowRight': if (currentSlideIdx < (deck.slides?.length || 0) - 1) loadSlide(currentSlideIdx + 1); break;
            }
        });

        if (isV3) {
            renderMessageList();
        } else {
            renderSlideList();
        }
        loadSlide(0);

        // Router lifecycle: the page is cached (init() runs once).
        // The router calls element.show(params) on every navigation,
        // so we hook it to reload the project when the URL changes.
        element.show = (newParams) => {
            if (newParams && newParams.id && newParams.id !== projectId) {
                projectId = newParams.id;
                audio.pause();
                audio.src = '';
                currentSlideIdx = 0;
                currentParaIdx = -1;
                v3CumulativeMs = 0;
                isPlaying = false;
                renderingSlides = new Set();
                renderingMessages = new Set();
                loadProject(projectId).then(() => {
                    if (deck) {
                        if (isV3) {
                            virtualSlides = buildVirtualSlides();
                            deck.slides = virtualSlides;
                            renderMessageList();
                        } else {
                            renderSlideList();
                        }
                        loadSlide(0);
                    }
                });
            }
        };
    }
});

function escapeHtml(s) {
    if (!s) return '';
    return s.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
