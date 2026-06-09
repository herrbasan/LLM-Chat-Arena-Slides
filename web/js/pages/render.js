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
            if (slide.type === 'title' || slide.type === 'end') {
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

            // Render slide content
            const headerLabel = buildHeaderLabel(slide, idx);
            const createdAt = (slide.type === 'conversation' && slide.originalIdx != null)
                ? deck?.source?.messages?.[slide.originalIdx]?.createdAt
                : null;
            const timestamp = formatTimestamp(createdAt);
            let html = '';
            html += `<div style="font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: var(--text-color-dim); margin-bottom: 8px;">${slide.type}</div>`;
            html += `<div style="display: flex; align-items: baseline; gap: var(--nui-space); margin-bottom: 4px;">`;
            html += `<div style="font-size: 14px; font-weight: bold; color: var(--color-highlight);">${escapeHtml(headerLabel)}</div>`;
            if (timestamp) {
                html += `<div style="font-size: var(--font-size-xsmall); color: var(--text-color-dim);">${escapeHtml(timestamp)}</div>`;
            }
            html += `</div>`;

            if (slide.type === 'title' || slide.type === 'end') {
                html += `<div style="font-size: 36px; font-weight: bold; margin-bottom: 8px; line-height: 1.2;">${escapeHtml(slide.text || '')}</div>`;
                if (slide.narration) {
                    html += `<div class="words-container">${buildWordSpans(slide.narration, slide.tts)}</div>`;
                }
            } else {
                html += `<div class="words-container">${buildWordSpans(slide.text || slide.narration || '', slide.tts)}</div>`;
            }

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
            const timedSegments = getTimedSegments(tts);
            if (timedSegments.length > 0) {
                return timedSegments.map(segment => {
                    const words = segment.words.map(w => {
                        return `<span class="word future" data-start="${w.startMs}" data-end="${w.endMs}">${escapeHtml(w.word)}</span> `;
                    }).join('');
                    return `<span class="segment future" data-start="${segment.startMs}" data-end="${segment.endMs}">${words}</span> `;
                }).join('');
            }

            if (!text) return '';
            const textWords = stripEmphasisForSpeech(text).split(/\s+/).filter(w => w.length > 0);
            return textWords.map((w, i) => {
                return `<span class="word future">${escapeHtml(w)}</span> `;
            }).join('');
        }

        function getTimedSegments(tts) {
            if (!tts) return [];
            if (tts.segments && tts.segments.length > 0) {
                return tts.segments.filter(segment => segment.words && segment.words.length > 0);
            }
            if (tts.words && tts.words.length > 0) {
                return [{ startMs: tts.words[0].startMs, endMs: tts.words[tts.words.length - 1].endMs, words: tts.words }];
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
