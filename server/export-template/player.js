// Arena Slides export player — vendored NUI chrome
// (button/icon/slider/select/loading + theme + icon sprite).
// Ports the v3 playback core from web/js/pages/render.js: virtual slide
// chunking, per-paragraph audio chaining, rAF word highlighting, seek.
// Consumes project.json (written by POST /api/v3/export/:id).

import { nui } from './nui/nui.js';

const audio = new Audio();
const state = {
    project: null,
    slides: [],
    currentSlideIdx: 0,
    isPlaying: false,
    playbackSpeed: 1.0,
    paragraphs: [],      // paragraphs of the current slide
    currentParaIdx: -1,  // which paragraph is playing (-1 = none)
    cumulativeMs: 0,     // total ms of finished paragraphs in this slide
    totalDurationMs: 0,  // total duration of all paragraphs in this slide
    rafId: null,
    seeking: false       // user is dragging the playhead
};

const el = {};
['player-title', 'player-counter', 'player-slide-content',
 'time-display', 'btn-play', 'btn-prev', 'btn-next',
 'play-icon', 'buffering-indicator']
    .forEach(id => { el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id); });
const seekSlider = document.getElementById('seek-slider');
const seekInput = seekSlider.querySelector('input');

function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatHumanDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function formatTimestamp(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const date = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${date} · ${time}`;
}

// ─── Slide building (virtual slides from messages) ───────────

const SLIDE_STYLES = {
    setup:        { showSpeaker: false, showHeader: true,  layout: 'framed',   textSize: 'md', textAlign: 'left',   accentBackground: false },
    details:      { showSpeaker: false, showHeader: true,  layout: 'meta',     textSize: 'md', textAlign: 'left',   accentBackground: false },
    topic:        { showSpeaker: false, showHeader: true,  layout: 'centered', textSize: 'xl', textAlign: 'center', accentBackground: true },
    conversation: { showSpeaker: true,  showHeader: true,  layout: 'flow',     textSize: 'md', textAlign: 'left',   accentBackground: false },
    end:          { showSpeaker: false, showHeader: false, layout: 'minimal',  textSize: 'sm', textAlign: 'center', accentBackground: false }
};

function buildSlides(project) {
    const slides = [];
    const MAX_CHARS_PER_SLIDE = 600;
    const messages = project.messages || [];

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
                currentGroup.push(para);
                currentChars += paraLen;
            }
            if (currentGroup.length > 0) groups.push(currentGroup);

            for (let splitIdx = 0; splitIdx < groups.length; splitIdx++) {
                const group = groups[splitIdx];
                slides.push({
                    type: 'conversation',
                    text: group.map(p => p.text || '').join('\n\n'),
                    speaker,
                    label,
                    originalIdx: msg.conversationIdx ?? msgIdx,
                    createdAt: msg.createdAt || null,
                    splitIdx,
                    splitCount: groups.length,
                    _paragraphs: group
                });
            }
        } else {
            // setup/details/topic/end: one slide per message
            const paragraphs = msg.paragraphs || [];
            let text = msg.text || (type === 'end' ? 'End of conversation.' : '');
            let narration = msg.narration || paragraphs.map(p => p.text).join('\n\n') || text;
            if (type === 'topic') {
                text = text.replace(/^\s*Topic:\s*/i, '').trim();
                narration = narration.replace(/^\s*Topic:\s*/i, '').trim();
            }
            slides.push({
                type,
                text,
                narration,
                speaker: msg.speaker || 'narrator',
                label: msg.label || 'Narrator',
                meta: msg.meta || null,
                _paragraphs: paragraphs
            });
        }
    }
    return slides;
}

function buildSlideClassList(slide, idx) {
    const prev = state.slides[idx - 1];
    const classes = ['slide', `slide--${slide.type}`];
    if (slide.speaker) classes.push(`slide--speaker-${slide.speaker}`);
    if (idx === 0) classes.push('slide--first');
    if (idx === state.slides.length - 1) classes.push('slide--last');
    if (slide.type === 'conversation') {
        if (!prev || prev.speaker !== slide.speaker) classes.push('slide--new-speaker');
        if (prev && prev.type === 'conversation' && prev.speaker === slide.speaker && prev.originalIdx === slide.originalIdx) {
            if (slide.splitIdx === 0) classes.push('slide--split-start');
            else if (slide.splitIdx === slide.splitCount - 1) classes.push('slide--split-end');
            else classes.push('slide--split-middle');
        }
    }
    const style = SLIDE_STYLES[slide.type] || {};
    if (style.layout) classes.push(`slide--layout-${style.layout}`);
    if (style.textSize) classes.push(`slide--text-size-${style.textSize}`);
    if (style.textAlign) classes.push(`slide--align-${style.textAlign}`);
    if (style.accentBackground) classes.push('slide--accent-bg');
    return classes;
}

function buildHeaderLabel(slide, idx) {
    if (slide.type !== 'conversation') {
        return slide.type.charAt(0).toUpperCase() + slide.type.slice(1);
    }
    return slide.label || slide.speaker || `Slide ${idx + 1}`;
}

function buildSplitBubbles(slide) {
    if (slide.type !== 'conversation') return '';
    if ((slide.splitCount || 1) <= 1) return '';
    const bubbles = [];
    for (let i = 0; i < slide.splitCount; i++) {
        const isActive = i === slide.splitIdx;
        bubbles.push(`<span class="slide-split-bubbles__bubble${isActive ? ' is-active' : ''}"></span>`);
    }
    return `<div class="slide-split-bubbles">${bubbles.join('')}</div>`;
}

function renderDetailsMeta(meta) {
    if (!meta) return '';
    const rows = [];
    if (meta.recordedAt) {
        rows.push(`<div class="details-meta__row">
            <span class="details-meta__label">Recorded</span>
            <time class="details-meta__value" datetime="${escapeHtml(meta.recordedAt)}">${escapeHtml(formatHumanDate(meta.recordedAt) || meta.recordedAt)}</time>
        </div>`);
    }
    if (Array.isArray(meta.models) && meta.models.length) {
        const chips = meta.models.map(m =>
            `<span class="model-chip model-chip--${escapeHtml(m.role || 'unknown')}">${escapeHtml(m.name || '')}</span>`
        ).join('');
        rows.push(`<div class="details-meta__row details-meta__row--models">
            <span class="details-meta__label">Models</span>
            <div class="details-meta__models">${chips}</div>
        </div>`);
    }
    if (typeof meta.turnCount === 'number') {
        rows.push(`<div class="details-meta__row">
            <span class="details-meta__label">Turns</span>
            <span class="details-meta__value">${meta.turnCount} ${meta.turnCount === 1 ? 'turn' : 'turns'}</span>
        </div>`);
    }
    return `<div class="details-meta">${rows.join('')}</div>`;
}

function buildWordSpans(paragraphs) {
    const allSpans = [];
    for (let pi = 0; pi < paragraphs.length; pi++) {
        const para = paragraphs[pi];
        const wordSpans = [];
        if (para.words && para.words.length > 0) {
            for (const w of para.words) {
                wordSpans.push(`<span class="word future" data-start="${w.startMs}" data-end="${w.endMs}">${escapeHtml(w.word)}</span> `);
            }
        } else if (para.text) {
            wordSpans.push(`<span class="word future">${escapeHtml(para.text)}</span>`);
        }
        allSpans.push(`<span class="para-words" data-para-idx="${pi}">${wordSpans.join('')}</span>`);
        if (pi < paragraphs.length - 1) allSpans.push('<span class="para-break"></span>');
    }
    return allSpans.join('');
}

// ─── Slide rendering ───

function loadSlide(idx) {
    if (idx < 0 || idx >= state.slides.length) return;
    state.currentSlideIdx = idx;
    const slide = state.slides[idx];
    const style = SLIDE_STYLES[slide.type] || {};
    const classes = buildSlideClassList(slide, idx);

    let html = `<div class="${classes.join(' ')}">`;

    if (style.showHeader) {
        const timestamp = slide.type === 'conversation' && slide.createdAt
            ? formatTimestamp(slide.createdAt)
            : null;
        html += `<div class="slide-header"><div class="slide-header__row">`;
        if (style.showSpeaker) {
            html += `<div class="slide-header__label">${escapeHtml(buildHeaderLabel(slide, idx))}</div>`;
        }
        if (timestamp) html += `<div class="slide-header__timestamp">${escapeHtml(timestamp)}</div>`;
        html += `</div>${buildSplitBubbles(slide)}</div>`;
    }

    const words = buildWordSpans(slide._paragraphs || []);
    if (style.layout === 'meta') {
        html += renderDetailsMeta(slide.meta);
        html += `<div class="slide-narration words-container">${words}</div>`;
    } else if (style.layout === 'centered' || style.layout === 'minimal') {
        html += `<div class="slide-body words-container">${words}</div>`;
    } else if (style.layout === 'framed') {
        html += `<div class="slide-body slide-body--text">${escapeHtml(slide.text || '')}</div>`;
        html += `<div class="slide-body words-container">${words}</div>`;
    } else {
        html += `<div class="slide-body words-container">${words}</div>`;
    }

    html += `</div>`;
    el.playerSlideContent.innerHTML = html;

    loadParagraphAudio(slide._paragraphs || []);
    el.playerCounter.textContent = `${idx + 1} / ${state.slides.length}`;
    updateControls();
    updateTimeDisplay(0, state.totalDurationMs);
}

// ─── Playback ───

function loadParagraphAudio(paragraphs) {
    state.paragraphs = paragraphs;
    state.currentParaIdx = -1;
    state.cumulativeMs = 0;
    state.totalDurationMs = paragraphs.reduce((sum, p) => sum + (p.durationMs || 0), 0);
    seekInput.max = String(state.totalDurationMs);
    seekSlider.setValue(0);
    const first = paragraphs.findIndex(p => p.audioUrl && p.words?.length > 0);
    if (first >= 0) {
        state.currentParaIdx = first;
        audio.src = audioSrc(paragraphs[first].audioUrl);
        audio.playbackRate = state.playbackSpeed;
    } else {
        audio.src = '';
    }
}

function updateWordHighlight(currentTimeMs) {
    if (state.currentParaIdx < 0) return;
    el.playerSlideContent.querySelectorAll('.para-words').forEach(container => {
        const pi = parseInt(container.dataset.paraIdx, 10);
        const words = container.querySelectorAll('.word');
        if (pi < state.currentParaIdx) {
            words.forEach(w => { w.className = 'word past'; });
        } else if (pi === state.currentParaIdx) {
            words.forEach(w => {
                const startMs = parseFloat(w.dataset.start);
                const endMs = parseFloat(w.dataset.end);
                if (isNaN(startMs) || isNaN(endMs)) w.className = 'word future';
                else if (currentTimeMs >= startMs && currentTimeMs < endMs) w.className = 'word active';
                else if (currentTimeMs >= endMs) w.className = 'word past';
                else w.className = 'word future';
            });
        } else {
            words.forEach(w => { w.className = 'word future'; });
        }
    });
}

function updateTimeDisplay(currentMs, durationMs) {
    const fmt = ms => {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    el.timeDisplay.textContent = `${fmt(currentMs)} / ${fmt(durationMs)}`;
}

function updateControls() {
    el.btnPlay.disabled = !state.paragraphs.some(p => p.audioUrl);
    el.btnPrev.disabled = state.currentSlideIdx === 0;
    el.btnNext.disabled = state.currentSlideIdx >= state.slides.length - 1;
}

function animationLoop() {
    if (!audio.src || audio.paused) { state.rafId = null; return; }
    const localTimeMs = audio.currentTime * 1000;
    const totalElapsedMs = state.cumulativeMs + localTimeMs;
    updateWordHighlight(localTimeMs);
    // nui-slider only repaints its fill via its setValue API (or native
    // 'input' events) — assigning input.value leaves the visual stale.
    if (!state.seeking) seekSlider.setValue(Math.round(totalElapsedMs));
    updateTimeDisplay(totalElapsedMs, state.totalDurationMs);
    state.rafId = requestAnimationFrame(animationLoop);
}

function startLoop() { if (!state.rafId) state.rafId = requestAnimationFrame(animationLoop); }
function stopLoop() { if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; } }

audio.addEventListener('play', () => {
    state.isPlaying = true;
    el.playIcon.setAttribute('name', 'pause');
    startLoop();
});
audio.addEventListener('pause', () => {
    state.isPlaying = false;
    el.playIcon.setAttribute('name', 'play');
    stopLoop();
});

// Buffering indicator: matters when the export is hosted — MP3s stream
// over the network and the next paragraph/slide may not be ready yet.
audio.addEventListener('waiting', () => { el.bufferingIndicator.hidden = false; });
audio.addEventListener('playing', () => { el.bufferingIndicator.hidden = true; });
audio.addEventListener('canplaythrough', () => { el.bufferingIndicator.hidden = true; });
audio.addEventListener('ended', () => {
    // Stop the loop immediately: between `ended` and the next
    // paragraph's `play`, audio.currentTime is stale and would flash
    // the next paragraph's words early.
    stopLoop();
    state.cumulativeMs += state.paragraphs[state.currentParaIdx]?.durationMs || 0;

    // Next paragraph with audio in this slide
    for (let i = state.currentParaIdx + 1; i < state.paragraphs.length; i++) {
        if (state.paragraphs[i].audioUrl && state.paragraphs[i].words?.length > 0) {
            state.currentParaIdx = i;
            audio.src = audioSrc(state.paragraphs[i].audioUrl);
            audio.playbackRate = state.playbackSpeed;
            audio.play().catch(() => {});
            return;
        }
    }

    // Slide finished — mark everything past, advance to the next slide
    el.playerSlideContent.querySelectorAll('.word').forEach(w => { w.className = 'word past'; });
    seekSlider.setValue(state.totalDurationMs);
    if (state.currentSlideIdx < state.slides.length - 1) {
        loadSlide(state.currentSlideIdx + 1);
        audio.play().catch(() => {});
    }
});

function togglePlay() {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
}

function goToSlide(idx) {
    const wasPlaying = state.isPlaying;
    audio.pause();
    loadSlide(idx);
    if (wasPlaying) audio.play().catch(() => {});
}

// ─── Seek ───
// The slider spans the slide's total duration across all paragraphs.
// 'input' previews the target time while dragging; 'change' performs
// the seek: map the cumulative target to (paragraph, local offset).

seekInput.addEventListener('input', () => {
    state.seeking = true;
    updateTimeDisplay(parseFloat(seekInput.value) || 0, state.totalDurationMs);
});

seekInput.addEventListener('change', () => {
    const targetMs = parseFloat(seekInput.value) || 0;
    state.seeking = false;

    // Find the paragraph containing the target time.
    let acc = 0;
    let targetIdx = -1;
    let localMs = 0;
    for (let i = 0; i < state.paragraphs.length; i++) {
        const p = state.paragraphs[i];
        if (!p.audioUrl || !(p.words?.length > 0)) continue;
        const dur = p.durationMs || 0;
        if (targetMs < acc + dur || i === state.paragraphs.length - 1) {
            targetIdx = i;
            localMs = Math.max(0, Math.min(targetMs - acc, dur));
            break;
        }
        acc += dur;
    }
    if (targetIdx < 0) return;

    state.cumulativeMs = acc;
    state.currentParaIdx = targetIdx;
    const targetSrc = audioSrc(state.paragraphs[targetIdx].audioUrl);
    const wasPlaying = state.isPlaying;

    const applyOffset = () => {
        audio.currentTime = localMs / 1000;
        updateWordHighlight(localMs);
        updateTimeDisplay(acc + localMs, state.totalDurationMs);
        if (wasPlaying) audio.play().catch(() => {});
    };

    if (audio.src !== targetSrc) {
        audio.src = targetSrc;
        audio.playbackRate = state.playbackSpeed;
        audio.addEventListener('loadedmetadata', applyOffset, { once: true });
    } else {
        applyOffset();
    }
});

el.btnPlay.addEventListener('click', togglePlay);
el.btnPrev.addEventListener('click', () => goToSlide(state.currentSlideIdx - 1));
el.btnNext.addEventListener('click', () => goToSlide(state.currentSlideIdx + 1));
document.addEventListener('keydown', e => {
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') goToSlide(state.currentSlideIdx - 1);
    else if (e.key === 'ArrowRight') goToSlide(state.currentSlideIdx + 1);
});

// ─── Boot ───
// The player is standalone: ?src= points at any project.json (relative
// or absolute URL). Audio URLs inside the project are resolved
// relative to that file's location. Default: ./project.json (legacy
// single-folder exports).

await nui.ready();

const srcParam = new URLSearchParams(location.search).get('src') || 'project.json';
const srcUrl = new URL(srcParam, location.href);
const audioSrc = (rel) => new URL(rel, srcUrl).href;

fetch(srcUrl)
    .then(res => {
        if (!res.ok) throw new Error(`project.json HTTP ${res.status}`);
        return res.json();
    })
    .then(project => {
        state.project = project;
        state.slides = buildSlides(project);
        const title = project.source?.topic || 'Arena Conversation';
        document.title = `${title} — Arena Conversation`;
        el.playerTitle.textContent = title;
        loadSlide(0);
    })
    .catch(err => {
        el.playerSlideContent.innerHTML = `<div class="slide"><div class="slide-body">Failed to load project.json: ${escapeHtml(err.message)}</div></div>`;
    });
