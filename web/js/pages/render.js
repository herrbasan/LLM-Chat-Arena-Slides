import { nui } from '/nui/nui.js';

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

        const slideList = element.querySelector('#render-slide-list');
        const playerContent = element.querySelector('#player-slide-content');
        const progressBar = element.querySelector('#playback-progress-bar');
        const progressFill = element.querySelector('#playback-progress-fill');
        const timeDisplay = element.querySelector('#time-display');
        const btnPlay = element.querySelector('#btn-play');
        const btnSpeed = element.querySelector('#btn-speed');
        const renderProgress = element.querySelector('#render-progress');
        const renderStatus = element.querySelector('#render-status');

        let currentSlideIdx = 0;
        let isPlaying = false;
        let playbackSpeed = 1.0;
        let audio = new Audio();
        let rafId = null;

        function computeStaleness(slide) {
            if (!slide.tts || slide.tts.error) return 'unrendered';
            const text = getSpokenText(slide);
            const roleCfg = deck.voiceMapping[slide.speaker] || deck.voiceMapping.narrator || {};
            const expectedHash = computeRenderHash(text, roleCfg.voice, roleCfg.speed);
            if (slide.tts.renderHash === expectedHash) return 'fresh';
            return 'stale';
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

        // Markdown-style *emphasis* markers (single or multiple asterisks)
        // are spoken by nSpeech as literal "asterisk" tokens. Strip them
        // from the SPOKEN text only; on-screen slide.text keeps the marks.
        function stripEmphasisForSpeech(s) {
            if (!s) return s;
            return s.toString().replace(/\*+/g, '');
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
                showHeader: false,
                layout: 'centered',
                textSize: 'xl',
                textAlign: 'center',
                accentBackground: true
            },
            conversation: {
                showEyebrow: true,
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
        // return the type label verbatim. For conversation/narration slides
        // (which may be split from a single source message), return
        // "<originalIdx+1>.<splitIdx> <speaker>" so the list and player
        // header share a stable numeric identity.
        function buildHeaderLabel(slide, idx) {
            if (slide.type !== 'conversation' && slide.type !== 'narration') {
                return slide.type.charAt(0).toUpperCase() + slide.type.slice(1);
            }
            if (slide.originalIdx == null) {
                return slide.label || slide.speaker || `Slide ${idx + 1}`;
            }
            const major = slide.originalIdx + 1;
            const splitIdx = getSplitIndices().get(idx) || 0;
            const who = slide.label || slide.speaker || '';
            return `${major}.${splitIdx} ${who}`.trim();
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

        let renderingSlides = new Set();

        function renderSlideList() {
            const slides = deck.slides || [];
            if (slides.length === 0) {
                slideList.innerHTML = '<p style="color: var(--text-color-dim);">No slides to render.</p>';
                return;
            }

            const counts = { fresh: 0, stale: 0, unrendered: 0, rendering: renderingSlides.size };
            slides.forEach(s => { counts[computeStaleness(s)]++; });

            // Compact status indicator: a small colored dot + label. Used in
            // the Render card and per-row on the Slides card. Inline span with
            // a CSS variable for the dot color so we don't need a NUI badge.
            const dotColor = {
                fresh: 'var(--color-highlight)',
                stale: '#d4a017',
                unrendered: 'var(--text-color-dim)',
                rendering: 'var(--text-color-dim)'
            };
            const statusLabel = {
                fresh: 'ready',
                stale: 'stale',
                unrendered: 'unrendered',
                rendering: 'rendering…'
            };
            const statusDot = (s) => `<span style="display: inline-flex; align-items: center; gap: 4px; font-size: var(--font-size-xsmall); color: var(--text-color-dim);">
                <span style="width: 6px; height: 6px; border-radius: 50%; background: ${dotColor[s]}; display: inline-block; flex-shrink: 0; ${s === 'rendering' ? 'opacity: 0.5;' : ''}"></span>
                <span>${counts[s]} ${statusLabel[s]}</span>
            </span>`;

            renderStatus.innerHTML = `
                <div style="display: flex; gap: var(--nui-space); flex-wrap: wrap;">
                    ${counts.fresh ? statusDot('fresh') : ''}
                    ${counts.stale ? statusDot('stale') : ''}
                    ${counts.unrendered ? statusDot('unrendered') : ''}
                    ${counts.rendering ? statusDot('rendering') : ''}
                    ${(counts.fresh + counts.stale + counts.unrendered + counts.rendering) === 0 ? '<span style="color: var(--text-color-dim); font-size: var(--font-size-xsmall);">no slides</span>' : ''}
                </div>
            `;

            slideList.innerHTML = slides.map((slide, idx) => {
                const isRendering = renderingSlides.has(idx);
                const status = isRendering ? 'rendering' : computeStaleness(slide);
                const isSelected = idx === currentSlideIdx;
                const headerLabel = buildHeaderLabel(slide, idx);
                return `
                    <div data-slide-idx="${idx}" style="display: flex; align-items: center; gap: var(--nui-space-half); padding: 4px var(--nui-space-half) 4px calc(var(--nui-space-half) + 4px); border-radius: var(--border-radius1); border-left: 3px solid ${isSelected ? 'var(--color-highlight)' : 'transparent'}; background: ${isSelected ? 'var(--color-shade2)' : 'transparent'}; ${status !== 'fresh' && !isRendering ? 'opacity: 0.5;' : ''} cursor: pointer;">
                        <span style="width: 8px; height: 8px; border-radius: 50%; background: ${dotColor[status]}; display: inline-block; flex-shrink: 0; ${status === 'rendering' ? 'opacity: 0.5;' : ''} box-shadow: 0 0 0 1px var(--border-shade2);" title="${statusLabel[status]}" data-slide-idx="${idx}"></span>
                        <span style="font-size: var(--font-size-small); font-weight: ${isSelected ? '600' : '500'}; color: ${isSelected ? 'var(--text-color)' : 'var(--text-color-dim)'}; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" data-slide-idx="${idx}" title="${escapeHtml(headerLabel)} (${statusLabel[status]})">${escapeHtml(headerLabel)}</span>
                        ${!isRendering ? `<nui-button variant="icon" data-action="render-slide:${idx}" style="flex-shrink: 0; width: 1.75rem; height: 1.75rem;" title="Render this slide"><button type="button" aria-label="Render slide ${idx + 1}"><nui-icon name="redo"></nui-icon></button></nui-button>` : ''}
                    </div>
                `;
            }).join('');

            // Click to jump to slide
            slideList.querySelectorAll('[data-slide-idx]').forEach(el => {
                el.addEventListener('click', () => {
                    const idx = parseInt(el.dataset.slideIdx);
                    loadSlide(idx);
                });
            });
        }

        async function renderSingleSlide(idx) {
            renderingSlides.add(idx);
            renderSlideList();

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
                nui.components.banner.show({ content: `Slide ${idx + 1} render failed: ${err.message}`, priority: 'alert', autoClose: 5000 });
            } finally {
                renderingSlides.delete(idx);
                renderSlideList();
                if (idx === currentSlideIdx) loadSlide(idx);
            }
        }

        async function renderAllSlides() {
            const slides = deck.slides;
            const toRender = [];
            for (let i = 0; i < slides.length; i++) {
                // Always include all slides — fresh ones will hit the server cache
                // and return instantly. The visual reset shows progress either way.
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

        function loadSlide(idx) {
            if (!deck.slides || idx < 0 || idx >= deck.slides.length) return;
            currentSlideIdx = idx;
            const slide = deck.slides[idx];

            // Update list highlighting. The selected row gets an accent
            // left border, a tint background, and full-color bold text.
            // The inline-styled border-left, bg, and label styles here must
            // stay in sync with the initial render in renderSlideList().
            slideList.querySelectorAll('[data-slide-idx]').forEach(el => {
                const isSelected = parseInt(el.dataset.slideIdx) === idx;
                el.style.borderLeftColor = isSelected ? 'var(--color-highlight)' : 'transparent';
                el.style.background = isSelected ? 'var(--color-shade2)' : 'transparent';
                // Update the label's font-weight + color too. The label is
                // the second [data-slide-idx] on the row (the first is the
                // dot, which we don't change).
                const labelEls = el.querySelectorAll('span[data-slide-idx]');
                const labelEl = labelEls[labelEls.length - 1];
                if (labelEl) {
                    labelEl.style.fontWeight = isSelected ? '600' : '500';
                    labelEl.style.color = isSelected ? 'var(--text-color)' : 'var(--text-color-dim)';
                }
            });
            // Scroll the selected row into view if it's off-screen.
            const selectedEl = slideList.querySelector(`[data-slide-idx="${idx}"]`);
            if (selectedEl && selectedEl.scrollIntoView) {
                selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }

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
                html += `</div>`;
            }

            // Body. Per-layout dispatch.
            if (style.layout === 'meta') {
                // Details slide: render the structured meta block. The
                // spoken narration still goes through the words container
                // so word-by-word highlighting works.
                html += renderDetailsMeta(slide.meta);
                if (slide.narration) {
                    html += `<div class="slide-narration words-container">${buildWordSpans(slide.narration, slide.tts)}</div>`;
                }
            } else if (style.layout === 'centered') {
                // Topic slide: large centered text, no header. Words
                // container overlays the same text for highlighting.
                html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
                if (slide.narration) {
                    html += `<div class="slide-body words-container">${buildWordSpans(slide.narration, slide.tts)}</div>`;
                }
            } else if (style.layout === 'minimal') {
                // End slide: small centered.
                html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
            } else if (style.layout === 'framed') {
                // Setup slide: framed text, with the narration words
                // container below for highlighting.
                html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
                if (slide.narration) {
                    html += `<div class="slide-body words-container">${buildWordSpans(slide.narration, slide.tts)}</div>`;
                }
            } else {
                html += `<div class="slide-body words-container">${buildWordSpans(slide.text || slide.narration || '', slide.tts)}</div>`;
            }

            html += `</div>`;

            playerContent.innerHTML = html;

            // Load audio if rendered
            const tts = slide.tts;
            if (tts && !tts.error && tts.audioUrl) {
                audio.src = tts.audioUrl;
                audio.playbackRate = playbackSpeed;
            } else {
                audio.src = '';
            }

            updateControls();
            updateProgress(0);
            updateTimeDisplay(0, tts?.durationMs || 0);
        }

        function buildWordSpans(text, tts) {
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
            const wordEls = playerContent.querySelectorAll('.words-container .word');
            if (wordEls.length === 0) return;

            wordEls.forEach(el => {
                const startMs = parseFloat(el.dataset.start);
                const endMs = parseFloat(el.dataset.end);

                if (isNaN(startMs) || isNaN(endMs)) {
                    // No timing data — don't highlight
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
            const tts = deck?.slides[currentSlideIdx]?.tts;
            const duration = tts?.durationMs || (audio.duration * 1000) || 0;
            const pct = duration > 0 ? (currentTimeMs / duration) * 100 : 0;
            progressFill.style.width = Math.min(pct, 100) + '%';
        }

        function updateTimeDisplay(currentMs, durationMs) {
            const fmt = (ms) => {
                const s = Math.floor(ms / 1000);
                const m = Math.floor(s / 60);
                return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
            };
            timeDisplay.textContent = `${fmt(currentMs)} / ${fmt(durationMs)}`;
        }

        function updateControls() {
            const tts = deck?.slides?.[currentSlideIdx]?.tts;
            btnPlay.disabled = !tts || !tts.audioUrl;
        }

        function animationLoop() {
            if (!audio.src || audio.paused) {
                rafId = null;
                return;
            }
            const currentTimeMs = audio.currentTime * 1000;
            const tts = deck?.slides[currentSlideIdx]?.tts;
            const durationMs = tts?.durationMs || (audio.duration * 1000) || 0;
            updateWordHighlight(currentTimeMs);
            updateProgress(currentTimeMs);
            updateTimeDisplay(currentTimeMs, durationMs);
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
            isPlaying = false;
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
                await renderAllSlides();
            }

            if (action === 'render-slide') {
                const idx = parseInt(param, 10);
                await renderSingleSlide(idx);
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
        });

        progressBar.addEventListener('click', (e) => {
            if (!audio.src) return;
            const rect = progressBar.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const tts = deck?.slides[currentSlideIdx]?.tts;
            const duration = tts?.durationMs || (audio.duration * 1000) || 0;
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

        renderSlideList();
        loadSlide(0);

        // Router lifecycle: the page is cached (init() runs once).
        // The router calls element.show(params) on every navigation,
        // so we hook it to reload the project when the URL changes.
        element.show = (newParams) => {
            if (newParams && newParams.id && newParams.id !== projectId) {
                projectId = newParams.id;
                // Reset playback state for the new project
                audio.pause();
                audio.src = '';
                currentSlideIdx = 0;
                isPlaying = false;
                renderingSlides = new Set();
                loadProject(projectId).then(() => {
                    if (deck) {
                        renderSlideList();
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
