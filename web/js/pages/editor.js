import { nui } from '/nui/nui.js';
import { GatewayClient } from '../gateway-client.js';

nui.registerPage('editor', {
    html: 'editor.html',
    async init(element, params, nui) {
        await nui.ready();

        const projectId = params.id;
        if (!projectId) {
            window.location.hash = '#page=projects';
            return;
        }

        // Load project
        let deck;
        try {
            const res = await fetch(`/api/projects/${projectId}`);
            deck = await res.json();
            window.SLIDESHOW_APP.currentProject = projectId;
            window.SLIDESHOW_APP.deck = deck;
            if (window.SLIDESHOW_APP.refreshSidebar) window.SLIDESHOW_APP.refreshSidebar();
        } catch (err) {
            nui.components.banner.show({ content: 'Failed to load project', priority: 'alert', autoClose: 5000 });
            return;
        }

        const voices = window.SLIDESHOW_APP.voices || [];
        const voiceOptions = voices.map(v => ({ value: v.name || v, label: v.name || v }));

        // ─── Voice Mapping Panel ──────────────────────────────
        const voicePanel = element.querySelector('#voice-mapping-panel');
        function renderVoiceMapping() {
            const vm = deck.voiceMapping || {};
            const roles = [
                { key: 'narrator', label: 'Narrator', defaultVoice: window.SLIDESHOW_CONFIG.DEFAULT_NARRATOR_VOICE, defaultSpeed: 0.95 },
                { key: 'participantA', label: deck.source?.participants?.[0] || 'Participant A', defaultVoice: 'en-US-Female', defaultSpeed: 1.0 },
                { key: 'participantB', label: deck.source?.participants?.[1] || 'Participant B', defaultVoice: 'en-GB-Male', defaultSpeed: 1.0 }
            ];

            voicePanel.innerHTML = roles.map(r => {
                const cfg = vm[r.key] || { voice: r.defaultVoice, speed: r.defaultSpeed };
                return `
                    <div style="display: flex; flex-direction: column; gap: var(--nui-space-half);">
                        <strong>${r.label}</strong>
                        <nui-select searchable id="voice-${r.key}">
                            <select>
                                <option value="">Select voice...</option>
                                ${voiceOptions.map(o => `<option value="${o.value}" ${o.value === cfg.voice ? 'selected' : ''}>${o.label}</option>`).join('')}
                            </select>
                        </nui-select>
                        <div style="display: flex; align-items: center; gap: var(--nui-space-half);">
                            <span style="font-size: var(--font-size-xsmall); color: var(--text-color-dim);">Speed</span>
                            <nui-slider style="flex: 1;">
                                <input type="range" id="speed-${r.key}" min="0.5" max="2.0" step="0.05" value="${cfg.speed}">
                            </nui-slider>
                            <span id="speed-label-${r.key}" style="font-size: var(--font-size-xsmall); min-width: 2.5rem; text-align: right;">${cfg.speed}x</span>
                        </div>
                    </div>
                `;
            }).join('');

            // Bind listeners
            requestAnimationFrame(() => {
                roles.forEach(r => {
                    const select = element.querySelector(`#voice-${r.key}`);
                    const slider = element.querySelector(`#speed-${r.key}`);
                    const label = element.querySelector(`#speed-label-${r.key}`);

                    if (select) {
                        select.addEventListener('nui-change', (e) => {
                            if (!deck.voiceMapping[r.key]) deck.voiceMapping[r.key] = {};
                            deck.voiceMapping[r.key].voice = e.detail.values[0] || '';
                            saveDeck();
                            renderSlides();
                        });
                    }
                    if (slider) {
                        slider.addEventListener('input', (e) => {
                            label.textContent = e.target.value + 'x';
                        });
                        slider.addEventListener('change', (e) => {
                            if (!deck.voiceMapping[r.key]) deck.voiceMapping[r.key] = {};
                            deck.voiceMapping[r.key].speed = parseFloat(e.target.value);
                            saveDeck();
                            renderSlides();
                        });
                    }
                });
            });
        }

        // ─── Conversation Source ──────────────────────────────
        const sourcePanel = element.querySelector('#conversation-source');
        function renderSource() {
            const msgs = deck.source?.messages || [];
            if (msgs.length === 0) {
                sourcePanel.innerHTML = '<p style="color: var(--text-color-dim);">No source messages.</p>';
                return;
            }
            sourcePanel.innerHTML = msgs.map((m, i) => `
                <div style="margin-bottom: var(--nui-space); padding: var(--nui-space-half); background: var(--color-shade1); border-radius: var(--border-radius1);">
                    <div style="font-weight: bold; color: var(--color-highlight); font-size: var(--font-size-xsmall);">${m.speaker || 'Unknown'} (Turn ${i + 1})</div>
                    <div style="margin-top: 2px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(m.content || m.text || '')}</div>
                </div>
            `).join('');
        }

        // ─── Slide Deck ───────────────────────────────────────
        const slideDeck = element.querySelector('#slide-deck');
        function renderSlides() {
            const slides = deck.slides || [];
            if (slides.length === 0) {
                slideDeck.innerHTML = `
                    <nui-card>
                        <div style="text-align: center; padding: var(--nui-space-double);">
                            <p>No slides yet.</p>
                            <p>Click "Generate with AI" to create slides from the conversation.</p>
                        </div>
                    </nui-card>
                `;
                return;
            }

            slideDeck.innerHTML = slides.map((slide, idx) => {
                const roleCfg = deck.voiceMapping[slide.speaker] || {};
                const voiceName = roleCfg.voice || 'default';
                const isStale = isSlideStale(slide, idx);
                return `
                    <nui-card data-slide-index="${idx}" style="${isStale ? 'border-left: 3px solid var(--color-highlight);' : ''}">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--nui-space-half);">
                            <div>
                                <nui-badge variant="${slide.type === 'title' ? 'primary' : (slide.type === 'end' ? 'danger' : 'info')}">${slide.type}</nui-badge>
                                <strong style="margin-left: var(--nui-space-half);">${slide.label || slide.speaker}</strong>
                            </div>
                            <div style="display: flex; gap: var(--nui-space-half); align-items: center;">
                                ${isStale ? '<nui-badge variant="warning">stale</nui-badge>' : ''}
                                <span style="font-size: var(--font-size-xsmall); color: var(--text-color-dim);">#${idx + 1}</span>
                                <nui-button variant="icon" data-action="play-slide:${idx}" title="Preview TTS">
                                    <button type="button" aria-label="Preview TTS"><nui-icon name="play"></nui-icon></button>
                                </nui-button>
                                <nui-button variant="icon" data-action="delete-slide:${idx}" title="Delete">
                                    <button type="button" aria-label="Delete slide"><nui-icon name="delete"></nui-icon></button>
                                </nui-button>
                            </div>
                        </div>
                        <nui-textarea auto-resize>
                            <textarea data-slide-text="${idx}" rows="3">${escapeHtml(slide.text || slide.narration || '')}</textarea>
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
                        // Invalidate TTS
                        if (slide.tts) slide.tts = null;
                        saveDeck();
                        renderSlides();
                    });
                });
            });
        }

        function isSlideStale(slide, idx) {
            if (!slide.tts || !slide.tts.renderHash) return false; // Unrendered, not stale
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

        // ─── Save Deck ────────────────────────────────────────
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

        // ─── Chat / LLM Integration ───────────────────────────
        const chatHistory = element.querySelector('#chat-history');
        const chatInput = element.querySelector('#chat-input');
        const gateway = new GatewayClient({ baseUrl: window.SLIDESHOW_CONFIG.GATEWAY_URL });

        // Persist chat history across turns (cleared when leaving page)
        const chatMessages = [
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
            div.style.cssText = `padding: var(--nui-space-half); border-radius: var(--border-radius2); font-size: var(--font-size-small); max-width: 90%; ${role === 'user' ? 'background: var(--color-shade2); align-self: flex-end; margin-left: auto;' : 'background: var(--color-shade1);'}`;

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
                        if (md && md.appendChunk) {
                            md.appendChunk(event.content);
                        }
                    } else if (event.type === 'done') {
                        finished = true;
                        if (md && md.endStream) md.endStream();

                        // Append assistant message to history
                        const assistantMsg = { role: 'assistant', content: contentBuffer };
                        if (event.tool_calls && event.tool_calls.length > 0) {
                            assistantMsg.tool_calls = event.tool_calls.map(tc => ({
                                id: tc.id,
                                type: tc.type,
                                function: {
                                    name: tc.function.name,
                                    arguments: tc.function.arguments
                                }
                            }));
                        }
                        messages.push(assistantMsg);

                        // Execute tools if requested
                        if (event.tool_calls && event.tool_calls.length > 0) {
                            const toolResults = [];
                            for (const tc of event.tool_calls) {
                                const result = await executeToolCall(tc);
                                toolResults.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: result
                                });
                            }
                            // Show tool call indicator
                            addChatMessage('assistant', `Executed ${event.tool_calls.length} tool(s). Updating slides...`, { noMarkdown: true });
                            // Push tool results to history and recurse for model's follow-up
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
                        description: 'Insert a slide at a specific position. Use 0 for beginning, deck.slides.length for end.',
                        parameters: {
                            type: 'object',
                            properties: {
                                type: { type: 'string', enum: ['title', 'narration', 'conversation', 'end'] },
                                speaker: { type: 'string' },
                                label: { type: 'string' },
                                text: { type: 'string' },
                                position: { type: 'number', description: '0-based index. Use deck.slides.length to append.' }
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
                if (name === 'slideshow_get_source') {
                    return JSON.stringify(deck.source);
                }
                if (name === 'slideshow_get_deck') {
                    return JSON.stringify({ slides: deck.slides, voiceMapping: deck.voiceMapping });
                }
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
                // Quick auto-generate via server
                actionEl.setLoading?.(true);
                try {
                    const res = await fetch('/api/generate-deck', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(deck.source)
                    });
                    const generated = await res.json();
                    deck.slides = generated.slides || [];
                    deck.voiceMapping = { ...deck.voiceMapping, ...generated.voiceMapping };
                    await saveDeck();
                    renderVoiceMapping();
                    renderSlides();
                    nui.components.banner.show({ content: `Generated ${deck.slides.length} slides`, priority: 'success', autoClose: 3000 });
                } catch (err) {
                    nui.components.banner.show({ content: 'Generation failed: ' + err.message, priority: 'alert', autoClose: 5000 });
                } finally {
                    actionEl.setLoading?.(false);
                }
            }

            if (action === 'chat-send') {
                sendChat();
            }
            if (action === 'goto-render') {
                window.location.hash = `#page=render&id=${projectId}`;
            }

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

        // ─── Realtime TTS Preview (streaming) ─────────────────
        let previewAudio = null;
        let previewMediaSource = null;

        async function previewTts(text, voice, speed) {
            // Clean up previous preview
            if (previewAudio) {
                previewAudio.pause();
                previewAudio.src = '';
                previewAudio = null;
            }
            if (previewMediaSource) {
                try { previewMediaSource.endOfStream(); } catch {}
                previewMediaSource = null;
            }

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
                    // MediaSource streaming — playback starts as soon as first chunk arrives
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
                                    if (mediaSource && mediaSource.readyState === 'open') {
                                        mediaSource.endOfStream();
                                    }
                                    return;
                                }
                                if (sourceBuffer.updating) {
                                    sourceBuffer.addEventListener('updateend', () => pump(), { once: true });
                                } else {
                                    sourceBuffer.appendBuffer(value);
                                    // Wait for append to finish before next read
                                    sourceBuffer.addEventListener('updateend', () => pump(), { once: true });
                                }
                            } catch (e) {
                                console.error('[TTS Preview] Stream error:', e);
                                if (mediaSource && mediaSource.readyState === 'open') {
                                    mediaSource.endOfStream('decode');
                                }
                            }
                        }
                        pump();
                    }, { once: true });

                    previewAudio.addEventListener('ended', () => {
                        pumping = false;
                    });
                } else {
                    // Fallback: wait for full blob (older browsers)
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
        renderVoiceMapping();
        renderSource();
        renderSlides();
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
