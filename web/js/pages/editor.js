import { nui } from '/nui/nui.js';
import { GatewayClient } from '../gateway-client.js';

nui.registerPage('editor', {
    html: 'editor.html',
    async init(element, params, nui) {
        await nui.ready();

        // The router caches this page (init() runs once). The actual
        // project data depends on params.id, which can change between
        // visits. The router calls element.show(params) on every
        // navigation, so we hook it to reload the project.
        // init() does the first load; show() handles all subsequent
        // visits.
        let projectId = params.id;
        let deck = null;
        let chatMessages = null;
        let gateway = null;
        let chatInput = null;
        let chatHistory = null;

        async function loadProject(id) {
            if (!id) {
                window.location.hash = '#page=projects';
                return false;
            }
            projectId = id;
            try {
                const res = await fetch(`/api/projects/${id}`);
                deck = await res.json();
                window.SLIDESHOW_APP.currentProject = id;
                window.SLIDESHOW_APP.deck = deck;
                if (window.SLIDESHOW_APP.updateStepper) window.SLIDESHOW_APP.updateStepper();
            } catch (err) {
                nui.components.banner.show({ content: 'Failed to load project', priority: 'alert', autoClose: 5000 });
                return false;
            }
            // Set the project title in the toolbar
            const titleEl = element.querySelector('#editor-project-title');
            if (titleEl) titleEl.textContent = deck.source?.topic || 'Untitled';
            return true;
        }

        // First load
        const firstLoadOk = await loadProject(projectId);
        if (!firstLoadOk) return; // load failed, bail

        // ─── Source rendering (used by options dialog) ──────
        function buildSourceHtml() {
            const msgs = deck.source?.messages || [];
            if (msgs.length === 0) {
                return '<p style="color: var(--text-color-dim);">No source messages.</p>';
            }
            return msgs.map((m, i) => {
                const isModerator = (m.speaker || '').toLowerCase() === 'moderator';
                const speakerLabel = escapeHtml(m.speaker || 'Unknown');
                return `
                    <div class="options-source-msg ${isModerator ? 'options-source-msg-moderator' : ''}">
                        <div class="options-source-speaker">
                            <strong>${speakerLabel}</strong>
                            ${isModerator ? '<nui-badge variant="primary">setup</nui-badge>' : ''}
                            <span class="options-source-turn">· Turn ${i + 1}</span>
                        </div>
                        <div class="options-source-content">${escapeHtml(m.content || m.text || '')}</div>
                    </div>
                `;
            }).join('');
        }

        // ─── Voice mapping rendering (used by options dialog) ─
        function buildVoiceMappingHtml() {
            // Read the latest voices list each time the dialog is built.
            // The /api/voices fetch in app.js completes asynchronously
            // and may not be done when the editor first initializes.
            const voiceOptions = (window.SLIDESHOW_APP.voices || [])
                .map(v => ({ value: v.name || v, label: v.name || v }));

            const vm = deck.voiceMapping || {};
            const roles = [
                { key: 'narrator', label: 'Narrator', defaultVoice: window.SLIDESHOW_CONFIG.DEFAULT_NARRATOR_VOICE, defaultSpeed: 0.95 },
                { key: 'participantA', label: deck.source?.participants?.[0] || 'Participant A', defaultVoice: 'en-US-Female', defaultSpeed: 1.0 },
                { key: 'participantB', label: deck.source?.participants?.[1] || 'Participant B', defaultVoice: 'en-GB-Male', defaultSpeed: 1.0 }
            ];

            return roles.map(r => {
                const cfg = vm[r.key] || { voice: r.defaultVoice, speed: r.defaultSpeed };
                return `
                    <div class="options-voice-row">
                        <strong>${escapeHtml(r.label)}</strong>
                        <nui-select searchable id="voice-${r.key}">
                            <select>
                                <option value="">Select voice...</option>
                                ${voiceOptions.map(o => `<option value="${escapeHtml(o.value)}" ${o.value === cfg.voice ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
                            </select>
                        </nui-select>
                        <div class="options-voice-speed">
                            <span>Speed</span>
                            <nui-slider>
                                <input type="range" id="speed-${r.key}" min="0.5" max="2.0" step="0.05" value="${cfg.speed}">
                            </nui-slider>
                            <span id="speed-label-${r.key}">${cfg.speed}x</span>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function bindVoiceMappingListeners() {
            ['narrator', 'participantA', 'participantB'].forEach(key => {
                const select = document.querySelector(`#voice-${key}`);
                const slider = document.querySelector(`#speed-${key}`);
                const label = document.querySelector(`#speed-label-${key}`);

                if (select) {
                    select.addEventListener('nui-change', (e) => {
                        if (!deck.voiceMapping[key]) deck.voiceMapping[key] = {};
                        const values = e.detail?.values;
                        deck.voiceMapping[key].voice = (values && values[0]) || '';
                        saveDeck();
                        renderSlides();
                    });
                }
                if (slider) {
                    slider.addEventListener('input', (e) => {
                        if (label) label.textContent = e.target.value + 'x';
                    });
                    slider.addEventListener('change', (e) => {
                        if (!deck.voiceMapping[key]) deck.voiceMapping[key] = {};
                        deck.voiceMapping[key].speed = parseFloat(e.target.value);
                        saveDeck();
                        renderSlides();
                    });
                }
            });
        }

        // ─── Open options dialog ────────────────────────────
        function openOptionsDialog() {
            const tabsHtml = `
                <nui-tabs no-animation>
                    <nav>
                        <button data-tab="voice" aria-controls="opt-voice">Voice Mapping</button>
                        <button data-tab="source" aria-controls="opt-source">Conversation Source</button>
                    </nav>
                    <section id="opt-voice" class="options-pane">
                        <div class="options-voice-list">${buildVoiceMappingHtml()}</div>
                    </section>
                    <section id="opt-source" class="options-pane" hidden>
                        <div class="options-source">${buildSourceHtml()}</div>
                    </section>
                </nui-tabs>
            `;
            const { dialog, result } = nui.components.dialog.page(
                'Options',
                tabsHtml,
                {
                    placement: 'top',
                    buttons: [
                        { label: 'Close', value: 'close', type: 'primary' }
                    ]
                }
            );
            // Wire up voice listeners after the dialog is in the DOM
            // (page() inserts into body, so querySelector works immediately)
            requestAnimationFrame(() => bindVoiceMappingListeners());
            return result;
        }

        // ─── Slide rendering ───────────────────────────────
        const slideDeck = element.querySelector('#slide-deck');
        function renderSlides() {
            const slides = deck.slides || [];
            if (slides.length === 0) {
                slideDeck.innerHTML = `
                    <nui-card>
                        <div class="empty-state">
                            <p>No slides yet.</p>
                            <p>Click "Generate with AI" to create slides from the conversation.</p>
                        </div>
                    </nui-card>
                `;
                return;
            }

            slideDeck.innerHTML = slides.map((slide, idx) => {
                const isStale = isSlideStale(slide, idx);
                return `
                    <nui-card data-slide-index="${idx}" class="${isStale ? 'slide-card-stale' : ''}">
                        <div class="slide-card-header">
                            <div class="slide-card-meta">
                                <nui-badge variant="${slide.type === 'title' ? 'primary' : (slide.type === 'end' ? 'danger' : 'info')}">${slide.type}</nui-badge>
                                <strong>${escapeHtml(slide.label || slide.speaker || '')}</strong>
                                <span class="slide-card-index">#${idx + 1}</span>
                                ${isStale ? '<nui-badge variant="warning">stale</nui-badge>' : ''}
                            </div>
                            <div class="slide-card-actions">
                                <nui-button variant="icon" data-action="play-slide:${idx}" title="Preview TTS">
                                    <button type="button" aria-label="Preview TTS"><nui-icon name="play"></nui-icon></button>
                                </nui-button>
                                <nui-button variant="icon" data-action="delete-slide:${idx}" title="Delete">
                                    <button type="button" aria-label="Delete slide"><nui-icon name="delete"></nui-icon></button>
                                </nui-button>
                            </div>
                        </div>
                        <nui-textarea auto-resize>
                            <textarea data-slide-text="${idx}" rows="3" style="white-space: pre-wrap;">${escapeHtml(slide.text || slide.narration || '')}</textarea>
                        </nui-textarea>
                    </nui-card>
                `;
            }).join('');

            // Bind text editing
            requestAnimationFrame(() => {
                slideDeck.querySelectorAll('textarea[data-slide-text]').forEach(ta => {
                    ta.addEventListener('change', (e) => {
                        const idx = parseInt(e.target.dataset.slideText);
                        const slide = deck.slides[idx];
                        if (slide.type === 'title' || slide.type === 'end') {
                            slide.narration = e.target.value;
                        } else {
                            slide.text = e.target.value;
                        }
                        if (slide.tts) slide.tts = null;
                        saveDeck();
                        renderSlides();
                    });
                });
            });
        }

        function isSlideStale(slide, idx) {
            if (!slide.tts || !slide.tts.renderHash) return false;
            const text = slide.text || slide.narration || '';
            const roleCfg = deck.voiceMapping[slide.speaker] || deck.voiceMapping.narrator || {};
            const expectedHash = computeRenderHash(text, roleCfg.voice, roleCfg.speed);
            return slide.tts.renderHash !== expectedHash && !slide.tts.cached;
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

        // ─── Save Deck ───────────────────────────────────────
        async function saveDeck() {
            try {
                await fetch(`/api/projects/${projectId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(deck)
                });
            } catch (e) {
                console.error('Save failed:', e);
            }
        }

        // ─── Chat / LLM Integration ──────────────────────────
        chatHistory = element.querySelector('#chat-history');
        chatInput = element.querySelector('#chat-input');
        gateway = new GatewayClient({ baseUrl: window.SLIDESHOW_CONFIG.GATEWAY_URL });

        chatMessages = [
            {
                role: 'system',
                content: `You are the Slideshow Director. You help edit slide decks for TTS narration.
You have tools: slideshow_get_source, slideshow_get_deck, slideshow_insert_slide, slideshow_update_slide.
When asked to make changes, USE THE TOOLS. Clean text for TTS: strip markdown, expand contractions, no asterisks.`
            }
        ];

        function addChatMessage(role, text, opts = {}) {
            const div = document.createElement('div');
            div.dataset.chatRole = role;
            div.className = `chat-msg chat-msg-${role}`;
            if (role === 'assistant' && !opts.noMarkdown) {
                const safeText = (text || '').replace(/<\/script/gi, '<\\/script');
                div.innerHTML = `<nui-markdown><script type="text/markdown">\n${safeText}\n</script></nui-markdown>`;
            } else {
                div.textContent = text;
            }
            chatHistory.appendChild(div);
            chatHistory.scrollTop = chatHistory.scrollHeight;
            return div;
        }

        async function sendChat() {
            const text = chatInput.value.trim();
            if (!text) return;
            chatInput.value = '';

            addChatMessage('user', text);
            chatMessages.push({ role: 'user', content: text });

            await runAssistantTurn(chatMessages);
        }

        async function runAssistantTurn(messages) {
            const assistantEl = addChatMessage('assistant', '');
            const md = assistantEl.querySelector('nui-markdown');
            if (md && md.beginStream) md.beginStream();

            let contentBuffer = '';
            let finished = false;

            try {
                const requestBody = {
                    model: 'badkid-llama-chat',
                    messages,
                    tools: getToolDefinitions(),
                    tool_choice: 'auto',
                    temperature: 0.3
                };

                for await (const event of gateway.streamChatIterable(requestBody)) {
                    if (event.type === 'delta') {
                        contentBuffer += event.content;
                        if (md && md.appendChunk) md.appendChunk(event.content);
                    } else if (event.type === 'done') {
                        finished = true;
                        if (md && md.endStream) md.endStream();

                        const assistantMsg = { role: 'assistant', content: contentBuffer };
                        if (event.tool_calls && event.tool_calls.length > 0) {
                            assistantMsg.tool_calls = event.tool_calls.map(tc => ({
                                id: tc.id,
                                type: tc.type,
                                function: { name: tc.function.name, arguments: tc.function.arguments }
                            }));
                        }
                        messages.push(assistantMsg);

                        if (event.tool_calls && event.tool_calls.length > 0) {
                            const toolResults = [];
                            for (const tc of event.tool_calls) {
                                const result = await executeToolCall(tc);
                                toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
                            }
                            addChatMessage('assistant', `Executed ${event.tool_calls.length} tool(s). Updating slides…`, { noMarkdown: true });
                            messages.push(...toolResults);
                            await runAssistantTurn(messages);
                        }
                    } else if (event.type === 'error') {
                        if (md && md.endStream) md.endStream();
                        assistantEl.textContent = 'Error: ' + event.error;
                    }
                }

                if (!finished) {
                    if (md && md.endStream) md.endStream();
                    messages.push({ role: 'assistant', content: contentBuffer });
                }
            } catch (err) {
                if (md && md.endStream) md.endStream();
                assistantEl.textContent = 'Error: ' + err.message;
            }
        }

        function getToolDefinitions() {
            return [
                {
                    type: 'function',
                    function: {
                        name: 'slideshow_get_source',
                        description: 'Get the raw Arena conversation source.',
                        parameters: { type: 'object', properties: {} }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'slideshow_get_deck',
                        description: 'Get the current slide deck with all slides.',
                        parameters: { type: 'object', properties: {} }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'slideshow_insert_slide',
                        description: 'Insert a slide at a specific position.',
                        parameters: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['title', 'narration', 'conversation', 'end'] },
                                speaker: { type: 'string' },
                                label: { type: 'string' },
                                text: { type: 'string' },
                                position: { type: 'number' }
                            },
                            required: ['type', 'speaker', 'text', 'position']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'slideshow_update_slide',
                        description: 'Update a slide by index.',
                        parameters: {
                            type: 'object',
                            properties: {
                                index: { type: 'number' },
                                text: { type: 'string' }
                            },
                            required: ['index', 'text']
                        }
                    }
                }
            ];
        }

        async function executeToolCall(tc) {
            const name = tc.function?.name;
            let args = {};
            try {
                args = JSON.parse(tc.function?.arguments || '{}');
            } catch (e) {
                return JSON.stringify({ error: 'Invalid arguments JSON: ' + e.message });
            }

            try {
                if (name === 'slideshow_get_source') return JSON.stringify(deck.source);
                if (name === 'slideshow_get_deck') return JSON.stringify({ slides: deck.slides, voiceMapping: deck.voiceMapping });
                if (name === 'slideshow_insert_slide') {
                    deck.slides.splice(args.position, 0, {
                        type: args.type,
                        speaker: args.speaker,
                        label: args.label || args.speaker,
                        text: args.text,
                        tts: null
                    });
                    await saveDeck();
                    renderSlides();
                    return JSON.stringify({ status: 'inserted', count: deck.slides.length });
                }
                if (name === 'slideshow_update_slide') {
                    if (deck.slides[args.index]) {
                        deck.slides[args.index].text = args.text;
                        deck.slides[args.index].tts = null;
                        await saveDeck();
                        renderSlides();
                    }
                    return JSON.stringify({ status: 'updated', index: args.index });
                }
                return JSON.stringify({ error: `Unknown tool: ${name}` });
            } catch (err) {
                return JSON.stringify({ error: err.message });
            }
        }

        // ─── Action Delegates ─────────────────────────────────
        element.addEventListener('click', async (e) => {
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;
            const actionSpec = actionEl.dataset.action;
            const [actionPart] = actionSpec.split('@');
            const [action, param] = actionPart.split(':');

            if (action === 'generate-deck') {
                // If the deck already has slides, ask first — this
                // action silently overwrites them. Voice mapping
                // and source are preserved; only the generated
                // slide list is replaced.
                if ((deck.slides || []).length > 0) {
                    const ok = await nui.components.dialog.confirm(
                        'Regenerate slides?',
                        `This will replace the current ${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'} with a freshly generated deck. Your source, voice mapping, and manual edits to slide text will be lost. Continue?`,
                        { placement: 'top' }
                    );
                    if (!ok) return;
                }
                actionEl.setLoading?.(true);

                // Show a progress banner that we'll update as SSE events arrive.
                let progressBanner = nui.components.banner.show({
                    content: 'Generating… 0%',
                    priority: 'info'
                });

                try {
                    const res = await fetch('/api/generate-deck', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        body: JSON.stringify(deck.source)
                    });

                    if (!res.ok) {
                        const errText = await res.text();
                        throw new Error('Server returned ' + res.status + ': ' + errText.substring(0, 200));
                    }
                    if (!res.body) throw new Error('No response body (no streaming support)');

                    // Parse SSE stream.
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let buf = '';
                    let generated = null;
                    let lastErr = null;

                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream: true });

                        // SSE events are separated by blank lines; process complete
                        // events as they appear.
                        let idx;
                        while ((idx = buf.indexOf('\n\n')) !== -1) {
                            const raw = buf.slice(0, idx);
                            buf = buf.slice(idx + 2);
                            const lines = raw.split('\n');
                            let eventName = 'message';
                            let dataLines = [];
                            for (const line of lines) {
                                if (line.startsWith('event:')) eventName = line.slice(6).trim();
                                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
                                // lines starting with ':' are SSE comments (heartbeat) — ignore
                            }
                            if (dataLines.length === 0) continue;
                            const dataStr = dataLines.join('\n');
                            let data;
                            try { data = JSON.parse(dataStr); } catch { data = dataStr; }

                            if (eventName === 'progress') {
                                const pct = Math.round(data.pct || 0);
                                progressBanner.update(`${data.message || data.stage} (${pct}%)`);
                            } else if (eventName === 'done') {
                                // Server has finished; the 'result' event will follow
                                // (or it already did in the same packet). No action.
                            } else if (eventName === 'result') {
                                generated = data;
                            } else if (eventName === 'error') {
                                lastErr = new Error(data.message || 'Server reported error');
                            }
                        }
                    }

                    progressBanner.close();

                    if (lastErr) throw lastErr;
                    if (!generated) throw new Error('Generation finished without a result');

                    deck.slides = generated.slides || [];
                    deck.voiceMapping = { ...deck.voiceMapping, ...generated.voiceMapping };
                    await saveDeck();
                    renderSlides();
                    nui.components.banner.show({ content: `Generated ${deck.slides.length} slides`, priority: 'success', autoClose: 3000 });
                } catch (err) {
                    try { progressBanner.close(); } catch {}
                    nui.components.banner.show({ content: 'Generation failed: ' + err.message, priority: 'alert', autoClose: 5000 });
                } finally {
                    actionEl.setLoading?.(false);
                }
            }

            if (action === 'chat-send') sendChat();
            if (action === 'goto-render') window.location.hash = `#page=render&id=${projectId}`;
            if (action === 'back-to-projects') window.location.hash = '#page=projects';
            if (action === 'open-options') openOptionsDialog();

            if (action === 'play-slide') {
                const idx = parseInt(param);
                const slide = deck.slides[idx];
                if (!slide) return;
                const text = slide.text || slide.narration || '';
                const roleCfg = deck.voiceMapping[slide.speaker] || deck.voiceMapping.narrator || {};
                previewTts(text, roleCfg.voice, roleCfg.speed);
            }

            if (action === 'delete-slide') {
                const idx = parseInt(param);
                if (deck.slides[idx]) {
                    deck.slides.splice(idx, 1);
                    saveDeck();
                    renderSlides();
                }
            }
        });

        chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendChat();
        });

        // ─── TTS Preview ──────────────────────────────────────
        let previewAudio = null;
        let previewMediaSource = null;

        async function previewTts(text, voice, speed) {
            if (previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; }
            if (previewMediaSource) { try { previewMediaSource.endOfStream(); } catch {} previewMediaSource = null; }

            try {
                const res = await fetch('/api/tts-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, voice, speed })
                });
                if (!res.ok) throw new Error('TTS preview failed');

                const mime = 'audio/mpeg';
                const canStream = window.MediaSource && MediaSource.isTypeSupported(mime);

                if (canStream) {
                    const mediaSource = new MediaSource();
                    previewMediaSource = mediaSource;
                    const url = URL.createObjectURL(mediaSource);
                    previewAudio = new Audio(url);
                    previewAudio.play().catch(() => {});

                    mediaSource.addEventListener('sourceopen', async () => {
                        const sourceBuffer = mediaSource.addSourceBuffer(mime);
                        const reader = res.body.getReader();
                        let pumping = true;

                        async function pump() {
                            if (!pumping) return;
                            try {
                                const { done, value } = await reader.read();
                                if (done || !mediaSource || mediaSource.readyState === 'closed') {
                                    if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream();
                                    return;
                                }
                                if (sourceBuffer.updating) {
                                    sourceBuffer.addEventListener('updateend', () => pump(), { once: true });
                                } else {
                                    sourceBuffer.appendBuffer(value);
                                    sourceBuffer.addEventListener('updateend', () => pump(), { once: true });
                                }
                            } catch (e) {
                                console.error('[TTS Preview] Stream error:', e);
                                if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream('decode');
                            }
                        }
                        pump();
                    }, { once: true });

                    previewAudio.addEventListener('ended', () => { pumping = false; });
                } else {
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    previewAudio = new Audio(url);
                    previewAudio.play();
                }
            } catch (err) {
                nui.components.banner.show({ content: 'TTS preview failed: ' + err.message, priority: 'alert', autoClose: 3000 });
            }
        }

        // ─── Initial Render ───────────────────────────────────
        renderSlides();

        // Router lifecycle: the page is cached (init() runs once).
        // The router calls element.show(params) on every navigation,
        // so we hook it to reload the project when the URL changes.
        element.show = (newParams) => {
            if (newParams && newParams.id && newParams.id !== projectId) {
                // Clear chat history on project switch
                if (chatHistory) chatHistory.innerHTML = '';
                // Reset chat messages for the new project
                chatMessages = [
                    {
                        role: 'system',
                        content: `You are the Slideshow Director. You help edit slide decks for TTS narration.
You have tools: slideshow_get_source, slideshow_get_deck, slideshow_insert_slide, slideshow_update_slide.
When asked to make changes, USE THE TOOLS. Clean text for TTS: strip markdown, expand contractions, no asterisks.`
                    }
                ];
                loadProject(newParams.id).then(ok => { if (ok) renderSlides(); });
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
