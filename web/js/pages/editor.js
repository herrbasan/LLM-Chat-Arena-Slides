import { nui } from '/nui/nui.js';
import { GatewayClient } from '../gateway-client.js';

// Backward-compat helper: older v3 projects stored only paragraph-split
// messages in deck.messages and did not keep the original message-level
// source.messages. To regenerate, we need the message-level array the
// importer expects, so join paragraphs back into a single content string.
function reconstructSourceMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(m => ({
        speaker: m.originalSpeaker || m.label || m.speaker || 'Unknown',
        role: m.role || 'assistant',
        content: (m.paragraphs || []).map(p => p.text || '').join('\n\n'),
        createdAt: m.createdAt || null,
        model: m.model || m.originalSpeaker || m.speaker || null
    }));
}

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

        // ─── Voice panel (always visible in the editor's right column) ─
        // Renders the narrator / participantA / participantB rows with a
        // voice select and speed slider. Changes are saved to the deck
        // immediately. The "Conversation Source" tab from the old
        // options dialog was retired — the moderator message is the seed
        // prompt, not data the editor needs to see.
        const voicePanelBody = element.querySelector('#voice-panel-body');
        const voicePanel = element.querySelector('#voice-panel');

        function buildVoicePanelHtml() {
            // Read the latest voices list each time the panel is built.
            // The fetch result is cached in localStorage (see app.js) so
            // most page loads see a populated list synchronously.
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

        function renderVoicePanel() {
            if (!voicePanelBody) return;
            voicePanelBody.innerHTML = buildVoicePanelHtml();
        }

        function bindVoicePanelListeners() {
            if (!voicePanel) return;
            ['narrator', 'participantA', 'participantB'].forEach(key => {
                const select = voicePanel.querySelector(`#voice-${key}`);
                const slider = voicePanel.querySelector(`#speed-${key}`);
                const label = voicePanel.querySelector(`#speed-label-${key}`);

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

        // Initial render of the voice panel + listeners. Await the
        // voices fetch so the <select> options are present on the
        // first paint (no flash of an empty dropdown). On fetch
        // failure, render with whatever's available.
        try {
            await window.SLIDESHOW_APP.voicesReady;
        } catch {
            // voicesReady never rejects (it swallows errors), but be
            // defensive in case that changes.
        }
        renderVoicePanel();
        requestAnimationFrame(() => bindVoicePanelListeners());

        // ─── Slide rendering ───────────────────────────────
        const slideDeck = element.querySelector('#slide-deck');
        const isV3 = deck.version === 3 && deck.messages;

        function renderSlides() {
            if (isV3) {
                renderV3Messages();
                return;
            }

            // v2: original slide rendering
            const slides = deck.slides || [];
            if (slides.length === 0) {
                slideDeck.innerHTML = `
                    <nui-card>
                        <div class="empty-state">
                            <p>No slides yet.</p>
                            <p>Click "Clean text with AI" to create slides from the conversation.</p>
                        </div>
                    </nui-card>
                `;
                return;
            }

            slideDeck.innerHTML = slides.map((slide, idx) => {
                const isStale = isSlideStale(slide, idx);
                // Status dot mirrors the render & play page:
                // --color-highlight for fresh, #d4a017 for stale. The
                // nui-badge was noisy on a 58-slide deck.
                const statusDot = isStale
                    ? '<span style="width: 8px; height: 8px; border-radius: 50%; background: #d4a017; display: inline-block; flex-shrink: 0; box-shadow: 0 0 0 1px var(--border-shade2);" title="stale: text changed since last render"></span>'
                    : (slide.tts?.renderHash
                        ? '<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--color-highlight); display: inline-block; flex-shrink: 0; box-shadow: 0 0 0 1px var(--border-shade2);" title="fresh: matches cached render"></span>'
                        : '<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--text-color-dim); display: inline-block; flex-shrink: 0; box-shadow: 0 0 0 1px var(--border-shade2);" title="unrendered"></span>');
                return `
                    <nui-card data-slide-index="${idx}" class="${isStale ? 'slide-card-stale' : ''}">
                        <div class="slide-card-header">
                            <div class="slide-card-meta">
                                ${statusDot}
                                <nui-badge variant="${slide.type === 'topic' ? 'primary' : (slide.type === 'end' ? 'danger' : 'info')}">${slide.type}</nui-badge>
                                <strong>${escapeHtml(slide.label || slide.speaker || '')}</strong>
                                <span class="slide-card-index">#${idx + 1}</span>
                            </div>
                            <div class="slide-card-actions">
                                <nui-button variant="icon" data-action="play-slide:${idx}" title="Preview TTS">
                                    <button type="button" aria-label="Preview TTS"><nui-icon name="volume"></nui-icon></button>
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
                        if (slide.type === 'topic' || slide.type === 'end') {
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

        function renderV3Messages() {
            const messages = deck.messages || [];
            if (messages.length === 0) {
                slideDeck.innerHTML = `
                    <nui-card>
                        <div class="empty-state">
                            <p>No messages yet.</p>
                            <p>Click "Clean text with AI" to process the conversation.</p>
                        </div>
                    </nui-card>
                `;
                return;
            }

            const totalParagraphs = messages.reduce((s, m) => s + (m.paragraphs?.length || 0), 0);
            slideDeck.innerHTML = `
                <nui-card>
                    <div class="editor-summary-row">
                        <div>
                            <strong>${messages.length} messages</strong> · ${totalParagraphs} paragraphs
                        </div>
                        <div class="editor-summary-badge">
                            v3 paragraph architecture
                        </div>
                    </div>
                </nui-card>
                ${messages.map((msg, msgIdx) => {
                    const paras = msg.paragraphs || [];
                    const speaker = msg.label || msg.originalSpeaker || msg.speaker || 'unknown';
                    const role = msg.speaker || 'narrator';
                    const voiceConfig = deck.voiceMapping?.[role] || deck.voiceMapping?.narrator || {};
                    return `
                        <nui-card>
                            <div class="slide-card-header">
                                <div class="slide-card-meta">
                                    <nui-badge variant="${role === 'participantA' ? 'info' : (role === 'participantB' ? 'warning' : 'primary')}">${escapeHtml(speaker)}</nui-badge>
                                    <strong>Message ${msgIdx + 1}</strong>
                                    <span class="slide-card-index">${paras.length} paragraphs</span>
                                </div>
                                <div class="slide-card-actions">
                                    <nui-button variant="outline" data-action="edit-message:${msgIdx}" title="Edit paragraphs (join / split)">
                                        <button type="button">Edit</button>
                                    </nui-button>
                                </div>
                            </div>
                            <div class="editor-paragraphs">
                                ${paras.map((para, paraIdx) => {
                                    const hasAudio = !!para.audioUrl;
                                    const hasWords = para.words?.length > 0;
                                    const statusClass = hasWords ? 'status-aligned' : (hasAudio ? 'status-audio' : 'status-unrendered');
                                    return `
                                        <div class="editor-paragraph ${paraIdx > 0 ? 'editor-paragraph-sep' : ''}">
                                            <div class="editor-paragraph-status ${statusClass}" title="${hasWords ? 'aligned' : (hasAudio ? 'audio only' : 'unrendered')}"></div>
                                            <nui-button variant="icon" data-action="play-paragraph:${msgIdx}:${paraIdx}" title="Preview TTS">
                                                <button type="button" aria-label="Preview TTS"><nui-icon name="volume"></nui-icon></button>
                                            </nui-button>
                                            <span class="editor-paragraph-text">${escapeHtml(para.text || '').substring(0, 200)}${(para.text || '').length > 200 ? '…' : ''}</span>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </nui-card>
                    `;
                }).join('')}
            `;
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

        // ─── Busy Overlay ────────────────────────────────────
        // Blocks all interaction with the app while a long operation
        // (generation) runs. No progress data — just a busy spinner.
        // Uses <nui-loading mode="overlay">, toggled via `active`.
        // Returns { el, updateText, remove }.
        function showBusyOverlay(text) {
            const el = document.createElement('nui-loading');
            el.setAttribute('mode', 'overlay');
            el.setAttribute('active', '');
            document.body.appendChild(el);
            return {
                el,
                updateText(t) {
                    const label = el.querySelector('.loading-text');
                    if (label) label.textContent = t || 'Loading...';
                },
                remove() { el.remove(); }
            };
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

        // ─── Edit Message Dialog ───────────────────────────
        // Opens a nui-dialog (page mode) with one <textarea> per
        // paragraph. Operations:
        //   - Join with previous: merges paragraph N's text into N-1
        //     by concatenating with the same '\n\n' separator the
        //     splitter uses, then removes N.
        //   - Split here: inserts an empty paragraph after N so the
        //     user can split a long paragraph manually.
        // Save commits the new paragraphs array, persists via saveDeck,
        // and re-renders. Cancel discards.
        async function openEditMessageDialog(msgIdx) {
            const msg = deck.messages[msgIdx];
            if (!msg) return;
            const speaker = msg.label || msg.originalSpeaker || msg.speaker || 'unknown';
            const initialParas = (msg.paragraphs || []).map(p => ({ text: p.text || '' }));

            function buildDialogHtml(paras) {
                return paras.map((p, i) => `
                    <div class="edit-msg-paragraph" data-edit-para="${i}">
                        <div class="edit-msg-paragraph-header">
                            <strong>Paragraph ${i + 1}</strong>
                            <div class="edit-msg-paragraph-actions">
                                ${i > 0 ? `<nui-button variant="ghost" data-action="edit-join-prev:${i}"><button type="button">Join with previous</button></nui-button>` : ''}
                                <nui-button variant="ghost" data-action="edit-split-at-cursor:${i}"><button type="button" title="Place cursor where you want to split, then click">Split at cursor</button></nui-button>
                            </div>
                        </div>
                        <nui-textarea auto-resize>
                            <textarea data-edit-text="${i}" rows="4" style="white-space: pre-wrap;">${escapeHtml(p.text)}</textarea>
                        </nui-textarea>
                    </div>
                `).join('');
            }

            // Working copy. We re-render the dialog body whenever the
            // paragraphs array mutates (join/split) so the indices stay
            // consistent.
            let working = initialParas.map(p => ({ ...p }));

            const { dialog, main, result } = await nui.components.dialog.page(
                `Edit message ${msgIdx + 1} — ${speaker}`,
                `<div class="edit-msg-list">${buildDialogHtml(working)}</div>
                 <p class="edit-msg-hint">Edits invalidate the cached audio; you'll need to re-render this message after saving.</p>`,
                {
                    buttons: [
                        { label: 'Cancel', value: 'cancel', type: 'outline' },
                        { label: 'Save', value: 'save', type: 'primary' }
                    ],
                    placement: 'top'
                }
            );

            // Wire up the per-paragraph controls. Bound on every
            // re-render so join/split clicks always act on fresh DOM.
            // We scope queries to `main` — that's the content root
            // returned by dialog.page(), not the <nui-dialog> wrapper.
            function bindControls() {
                main.querySelectorAll('[data-action^="edit-join-prev:"]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const i = parseInt(btn.dataset.action.split(':')[1], 10);
                        if (i < 1 || i >= working.length) return;
                        // Join: concat working[i].text onto working[i-1]
                        // with the same \n\n separator the splitter
                        // expects, then remove working[i].
                        working[i - 1].text = working[i - 1].text + '\n\n' + working[i].text;
                        working.splice(i, 1);
                        rerenderDialog();
                    });
                });
                main.querySelectorAll('[data-action^="edit-split-at-cursor:"]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const i = parseInt(btn.dataset.action.split(':')[1], 10);
                        // Split the paragraph at the textarea's current
                        // cursor position. If nothing is selected, fall
                        // back to the middle of the text. The user can
                        // click into the textarea first to choose where
                        // to split.
                        const ta = main.querySelector(`textarea[data-edit-text="${i}"]`);
                        const original = working[i].text || '';
                        let splitAt;
                        if (ta && typeof ta.selectionStart === 'number' && ta.selectionStart > 0 && ta.selectionStart < original.length) {
                            splitAt = ta.selectionStart;
                        } else if (original.length > 1) {
                            splitAt = Math.floor(original.length / 2);
                        } else {
                            return; // nothing to split
                        }
                        const before = original.slice(0, splitAt).trimEnd();
                        const after = original.slice(splitAt).trimStart();
                        if (!after) return; // cursor was at the end
                        working.splice(i, 1, { text: before }, { text: after });
                        rerenderDialog();
                    });
                });
            }

            function rerenderDialog() {
                main.innerHTML = buildDialogHtml(working)
                    + `<p class="edit-msg-hint">Edits invalidate the cached audio; you'll need to re-render this message after saving.</p>`;
                bindControls();
            }

            bindControls();

            // Pull the latest textarea values into `working` before
            // reading the dialog result, so unsaved edits aren't lost.
            function snapshotTextareas() {
                main.querySelectorAll('[data-edit-text]').forEach(ta => {
                    const i = parseInt(ta.dataset.editText, 10);
                    if (working[i]) working[i].text = ta.value;
                });
            }

            const choice = await result;
            if (choice !== 'save') return;
            snapshotTextareas();

            // Strip out any paragraphs the user emptied — easier than
            // asking them to hit a delete button. An empty paragraph
            // produces 0-byte audio and breaks alignment anyway.
            const cleaned = working.map(p => p.text).filter(t => t && t.trim().length > 0);
            if (cleaned.length === 0) {
                nui.components.banner.show({
                    content: 'All paragraphs are empty — discarding message.',
                    priority: 'warning',
                    autoClose: 3000
                });
                deck.messages.splice(msgIdx, 1);
            } else {
                // Reset paragraphs to the new array. Clear the cached
                // TTS / alignment data — the user will have to
                // re-render the affected paragraphs, but we don't
                // silently leave stale audio playing.
                msg.paragraphs = cleaned.map(text => ({ text }));
                msg.text = cleaned.join('\n\n');
            }

            await saveDeck();
            renderSlides();
            nui.components.banner.show({
                content: 'Message updated.',
                priority: 'success',
                autoClose: 2000
            });
        }

        // ─── Chat / LLM Integration ──────────────────────────
        chatHistory = element.querySelector('#chat-history');
        chatInput = element.querySelector('#chat-input');
        // The GatewayClient proxies via the slideshow server's /api/chat
        // endpoint (same-origin). The browser never touches the LLM
        // gateway directly because of CSP default-src 'self'. See
        // server.js `app.post('/api/chat', ...)` for the proxy.
        gateway = new GatewayClient();

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
                                type: { type: 'string', enum: ['topic', 'narration', 'conversation', 'end'] },
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
            const [action, ...paramParts] = actionPart.split(':');
            const param = paramParts.join(':');

            if (action === 'generate-deck') {
                if (isV3) {
                    // v3: regenerate messages from source
                    if ((deck.messages || []).length > 0) {
                        const ok = await nui.components.dialog.confirm(
                            'Regenerate messages?',
                            `This will replace the current ${deck.messages.length} messages. Continue?`,
                            { placement: 'top' }
                        );
                        if (!ok) return;
                    }
                    actionEl.setLoading?.(true);
                    // Simple blocking overlay — no real progress data,
                    // just keep the user from touching the app while
                    // generation runs so results can't overwrite
                    // in-flight edits.
                    const overlay = showBusyOverlay('Generating messages…');
                    try {
                        // Re-import from source to regenerate. The source
                        // payload must include the original message-level
                        // messages array; older projects may not have
                        // source.messages, so reconstruct it from the
                        // paragraph-split deck.messages.
                        const sourcePayload = {
                            ...deck.source,
                            messages: deck.source?.messages?.length
                                ? deck.source.messages
                                : reconstructSourceMessages(deck.messages)
                        };
                        const res = await fetch('/api/v3/generate-deck', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(sourcePayload)
                        });
                        if (!res.ok) {
                            const errText = await res.text().catch(() => '');
                            throw new Error('Server returned ' + res.status + ': ' + errText.substring(0, 200));
                        }
                        const generated = await res.json();
                        deck.messages = generated.messages || [];
                        deck.voiceMapping = { ...deck.voiceMapping, ...generated.voiceMapping };
                        await saveDeck();
                        renderSlides();
                        nui.components.banner.show({ content: `Generated ${deck.messages.length} messages`, priority: 'success', autoClose: 3000 });
                    } catch (err) {
                        nui.components.banner.show({ content: 'Generation failed: ' + err.message, priority: 'alert', autoClose: 5000 });
                    } finally {
                        overlay.remove();
                        actionEl.setLoading?.(false);
                    }
                } else {
                // v2: original generate-deck
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

                // Simple blocking overlay — prevents editing during
                // generation so results can't overwrite in-flight edits.
                const overlay = showBusyOverlay('Generating slides…');

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
                                overlay.updateText(`${data.message || data.stage} (${pct}%)`);
                                // Yield to the browser so the overlay repaints.
                                await new Promise(r => setTimeout(r, 0));
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

                    if (lastErr) throw lastErr;
                    if (!generated) throw new Error('Generation finished without a result');

                    deck.slides = generated.slides || [];
                    deck.voiceMapping = { ...deck.voiceMapping, ...generated.voiceMapping };
                    await saveDeck();
                    renderSlides();
                    nui.components.banner.show({ content: `Generated ${deck.slides.length} slides`, priority: 'success', autoClose: 3000 });
                } catch (err) {
                    nui.components.banner.show({ content: 'Generation failed: ' + err.message, priority: 'alert', autoClose: 5000 });
                } finally {
                    overlay.remove();
                    actionEl.setLoading?.(false);
                }
                } // end v2 generate-deck else block
            }

            if (action === 'chat-send') sendChat();
            if (action === 'goto-render') {
                // Guard: warn if any voice role is unset. An empty
                // `voice` string means the user picked the placeholder
                // "Select voice..." option. Falling through to render
                // & play with an empty voice would silently default to
                // whatever the TTS service picks, which is almost
                // never what the user wants.
                const vm = deck.voiceMapping || {};
                const missing = [];
                for (const [role, cfg] of Object.entries(vm)) {
                    if (!cfg || !cfg.voice) missing.push(role);
                }
                if (missing.length > 0) {
                    const labels = {
                        narrator: 'Narrator',
                        participantA: deck.source?.participants?.[0] || 'Participant A',
                        participantB: deck.source?.participants?.[1] || 'Participant B'
                    };
                    const names = missing.map(r => labels[r] || r).join(', ');
                    nui.components.dialog.confirm(
                        'Unset voices',
                        `The following voice${missing.length === 1 ? ' is' : 's are'} not set: ${names}. Render & Play will fall back to defaults, which may not match the rest of the deck. Continue anyway?`,
                        { placement: 'top' }
                    ).then(ok => {
                        if (ok) window.location.hash = `#page=render&id=${projectId}`;
                    });
                    return;
                }
                window.location.hash = `#page=render&id=${projectId}`;
            }
            if (action === 'back-to-projects') window.location.hash = '#page=projects';

            if (action === 'play-slide') {
                const idx = parseInt(param);
                const slide = deck.slides[idx];
                if (!slide) return;
                const text = slide.text || slide.narration || '';
                const roleCfg = deck.voiceMapping[slide.speaker] || deck.voiceMapping.narrator || {};
                previewTts(text, roleCfg.voice, roleCfg.speed, actionEl);
            }

            if (action === 'play-paragraph') {
                const [msgIdx, paraIdx] = param.split(':').map(n => parseInt(n, 10));
                const msg = deck.messages?.[msgIdx];
                const para = msg?.paragraphs?.[paraIdx];
                if (!para) return;
                const role = msg.speaker || 'narrator';
                const roleCfg = deck.voiceMapping?.[role] || deck.voiceMapping?.narrator || {};
                previewTts(para.text || '', roleCfg.voice, roleCfg.speed, actionEl);
            }

            if (action === 'delete-slide') {
                const idx = parseInt(param);
                if (deck.slides[idx]) {
                    deck.slides.splice(idx, 1);
                    saveDeck();
                    renderSlides();
                }
            }

            if (action === 'edit-message') {
                const idx = parseInt(param, 10);
                if (isV3 && deck.messages && deck.messages[idx]) {
                    openEditMessageDialog(idx);
                }
            }
        });

        chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendChat();
        });

        // ─── TTS Preview ──────────────────────────────────────
        // Talks directly to nSpeech from the browser — no server proxy.
        // Same pattern as LLM Gateway Chat: new Audio(url) and play.
        // Clicking the same button again stops playback and restores
        // the volume icon.
        let previewAudio = null;
        let previewButton = null;
        let cachedNspeechUrl = null;

        async function getNspeechUrl() {
            if (cachedNspeechUrl) return cachedNspeechUrl;
            try {
                const res = await fetch('/api/settings');
                const settings = res.ok ? await res.json() : {};
                cachedNspeechUrl = settings.nspeechUrl || 'http://localhost:2233';
            } catch {
                cachedNspeechUrl = 'http://localhost:2233';
            }
            return cachedNspeechUrl;
        }

        // Browser-side mirror of pipeline/speak-text.js speakText().
        function speakText(s) {
            return String(s || '')
                .replace(/\*+([^*]+?)\*+/g, '($1)')
                .replace(/\*+/g, '');
        }

        function resetPreviewButton() {
            if (previewButton) {
                const icon = previewButton.querySelector('nui-icon');
                if (icon) icon.setAttribute('name', 'volume');
                previewButton = null;
            }
        }

        function stopTts() {
            if (previewAudio) { previewAudio.pause(); previewAudio.src = ''; previewAudio = null; }
            resetPreviewButton();
        }

        async function previewTts(text, voice, speed, btnEl) {
            // If clicking the button that's already playing, stop.
            if (previewButton === btnEl) { stopTts(); return; }
            // Stop any previous playback + reset its button.
            stopTts();

            try {
                const endpoint = await getNspeechUrl();
                const spoken = speakText(text);
                const url = `${endpoint}/tts?` + new URLSearchParams({
                    text: spoken,
                    voice_name: voice || '',
                    speed: (speed || 1.0).toString(),
                    output_format: 'mp3'
                }).toString();

                previewAudio = new Audio(url);
                previewAudio.preload = 'auto';
                previewAudio.onended = () => stopTts();
                previewAudio.onerror = () => stopTts();

                // Swap icon to close so the user can stop playback.
                previewButton = btnEl;
                const icon = btnEl.querySelector('nui-icon');
                if (icon) icon.setAttribute('name', 'close');

                previewAudio.play().catch(() => stopTts());
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
