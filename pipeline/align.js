// pipeline/align.js
// TTS Audio + Text → Word Timings via nVoice
//
// Supports two input formats:
//   v2 (deck with slides): aligns each slide's audio
//   v3 (project with messages/paragraphs): aligns each paragraph's audio
//
// Paragraph-level alignment is simpler and more reliable because each
// paragraph is short (1-3 sentences), reducing STT drift.

const fs = require('fs');
const path = require('path');
const https = require('https');

// Allow self-signed certs for nVoice (internal service).
const tlsAgent = new https.Agent({ rejectUnauthorized: false });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ─── Config ───────────────────────────────────────────────────

const NVOICE_URL = process.env.NVOICE_URL || 'https://192.168.0.100:2244';
const ALIGNMENT_VERSION = 6;

// ─── Helpers ──────────────────────────────────────────────────

function getSlideText(slide) {
    let text;
    if (slide.type === 'title' || slide.type === 'end') {
        text = slide.narration || slide.text || '';
    } else {
        text = slide.text || slide.narration || '';
    }
    // Strip markdown *emphasis* markers from spoken text. nVoice alignment
    // uses this as endpoint context and would otherwise see literal
    // "asterisk" tokens. Mirrors the server-side fix in server/server.js.
    return text ? text.toString().replace(/\*+/g, '') : text;
}

function getSpokenText(text) {
    if (!text) return '';
    return text.toString().replace(/\*+/g, '');
}

function normalizeWord(w) {
    // Strip punctuation for matching but preserve original for display
    return String(w).replace(/[^\w]/g, '').toLowerCase();
}

function getSourceWords(sourceText) {
    return sourceText.split(/\s+/).filter(w => w.length > 0);
}

function buildSourceTokens(sourceWords) {
    let cursor = 0;
    return sourceWords.map(word => {
        const norm = normalizeWord(word);
        const token = { word, norm, normStart: cursor, normEnd: cursor + norm.length };
        cursor = token.normEnd;
        return token;
    });
}

function buildTimedTokens(sttWords) {
    let cursor = 0;
    const timedTokens = [];
    for (const sttWord of sttWords) {
        const word = String(sttWord.word).trim();
        const norm = normalizeWord(word);
        if (norm.length === 0) continue;
        if (typeof sttWord.start !== 'number' || typeof sttWord.end !== 'number') {
            throw new Error(`nVoice word timing is missing numeric start/end for "${word}"`);
        }
        const startMs = Math.round(sttWord.start * 1000);
        const endMs = Math.round(sttWord.end * 1000);
        if (endMs < startMs) {
            throw new Error(`nVoice word timing is reversed for "${word}"`);
        }
        timedTokens.push({
            word,
            norm,
            startMs,
            endMs,
            normStart: cursor,
            normEnd: cursor + norm.length,
            probability: sttWord.probability || 1.0
        });
        cursor += norm.length;
    }
    return timedTokens;
}

function timedText(timedTokens) {
    return timedTokens.map(token => token.norm).join('');
}

function timeAtRawChar(timedTokens, charIndex, boundary) {
    if (timedTokens.length === 0) throw new Error('Cannot project timing with no nVoice words');
    const last = timedTokens[timedTokens.length - 1];
    if (charIndex <= 0) return timedTokens[0].startMs;
    if (charIndex >= last.normEnd) return last.endMs;

    if (boundary === 'start') {
        for (const token of timedTokens) {
            if (charIndex >= token.normStart && charIndex < token.normEnd) {
                const ratio = (charIndex - token.normStart) / token.norm.length;
                return Math.round(token.startMs + (token.endMs - token.startMs) * ratio);
            }
        }
    } else {
        for (const token of timedTokens) {
            if (charIndex > token.normStart && charIndex <= token.normEnd) {
                const ratio = (charIndex - token.normStart) / token.norm.length;
                return Math.round(token.startMs + (token.endMs - token.startMs) * ratio);
            }
        }
    }

    throw new Error(`Unable to project ${boundary} boundary at normalized character ${charIndex}`);
}

function probabilityForRange(timedTokens, normStart, normEnd) {
    const overlapping = timedTokens.filter(token => token.normEnd > normStart && token.normStart < normEnd);
    if (overlapping.length === 0) return 0.5;
    const sum = overlapping.reduce((total, token) => total + token.probability, 0);
    return sum / overlapping.length;
}

function projectExactNormalizedTiming(sourceTokens, timedTokens) {
    return sourceTokens.map(token => {
        if (token.norm.length === 0) {
            return { word: token.word, startMs: null, endMs: null, probability: 0.5, punctuationOnly: true };
        }
        return {
            word: token.word,
            startMs: timeAtRawChar(timedTokens, token.normStart, 'start'),
            endMs: timeAtRawChar(timedTokens, token.normEnd, 'end'),
            probability: probabilityForRange(timedTokens, token.normStart, token.normEnd)
        };
    });
}

function projectProportionalTiming(sourceTokens, audioDurationMs) {
    const totalChars = sourceTokens.reduce((total, token) => total + Math.max(token.norm.length, 1), 0);
    const durationMs = audioDurationMs || 0;
    let cursor = 0;
    return sourceTokens.map(token => {
        const startRatio = totalChars > 0 ? cursor / totalChars : 0;
        cursor += Math.max(token.norm.length, 1);
        const endRatio = totalChars > 0 ? cursor / totalChars : 1;
        return {
            word: token.word,
            startMs: Math.round(durationMs * startRatio),
            endMs: Math.round(durationMs * endRatio),
            probability: 0.3,
            interpolated: true
        };
    });
}

function buildSequentialWordMap(sourceTokens, sttNorm) {
    const map = new Array(sourceTokens.length === 0 ? 0 : sourceTokens[sourceTokens.length - 1].normEnd).fill(-1);
    let sttCursor = 0;

    for (const token of sourceTokens) {
        if (token.norm.length === 0) continue;
        const foundIndex = sttNorm.indexOf(token.norm, sttCursor);
        if (foundIndex === -1) continue;

        for (let offset = 0; offset < token.norm.length; offset++) {
            map[token.normStart + offset] = foundIndex + offset;
        }
        sttCursor = foundIndex + token.norm.length;
    }
    return map;
}

function projectMappedNormalizedTiming(sourceTokens, timedTokens, sourceToSttMap) {
    return sourceTokens.map(token => {
        if (token.norm.length === 0) {
            return { word: token.word, startMs: null, endMs: null, probability: 0.5, punctuationOnly: true };
        }

        const mappedChars = [];
        for (let index = token.normStart; index < token.normEnd; index++) {
            if (sourceToSttMap[index] !== -1) mappedChars.push(sourceToSttMap[index]);
        }

        if (mappedChars.length === 0) {
            return { word: token.word, startMs: null, endMs: null, probability: 0.3, interpolated: true };
        }

        const normStart = mappedChars[0];
        const normEnd = mappedChars[mappedChars.length - 1] + 1;
        return {
            word: token.word,
            startMs: timeAtRawChar(timedTokens, normStart, 'start'),
            endMs: timeAtRawChar(timedTokens, normEnd, 'end'),
            probability: probabilityForRange(timedTokens, normStart, normEnd),
            projected: true,
            partial: mappedChars.length !== token.norm.length
        };
    });
}

function fillUntimedTimings(words, audioDurationMs) {
    let index = 0;
    while (index < words.length) {
        if (words[index].startMs !== null && words[index].endMs !== null) {
            index++;
            continue;
        }

        const startIndex = index;
        while (index < words.length && (words[index].startMs === null || words[index].endMs === null)) index++;
        const endIndex = index;
        const previousEnd = startIndex > 0 ? words[startIndex - 1].endMs : 0;
        const nextStart = endIndex < words.length ? words[endIndex].startMs : (audioDurationMs || previousEnd + ((endIndex - startIndex) * 120));
        const step = Math.max(20, (nextStart - previousEnd) / (endIndex - startIndex));

        for (let fillIndex = startIndex; fillIndex < endIndex; fillIndex++) {
            const startMs = previousEnd + ((fillIndex - startIndex) * step);
            words[fillIndex].startMs = Math.round(startMs);
            words[fillIndex].endMs = Math.round(startMs + step);
            words[fillIndex].interpolated = true;
        }
    }
    return words;
}

function enforceMonotonicTimings(words) {
    let cursor = 0;
    for (const word of words) {
        if (word.startMs < cursor) word.startMs = cursor;
        if (word.endMs < word.startMs) word.endMs = word.startMs;
        cursor = word.endMs;
    }
    return words;
}

// ─── Word Timing Projection ──────────────────────────────────
// nVoice can split or merge tokens differently than the source text.
// Projecting normalized character ranges keeps timing monotonic and prevents
// one tokenization mismatch from shifting every following word.

function alignWordsToSource(sourceText, sttWords, audioDurationMs) {
    const sourceWords = getSourceWords(sourceText);
    const sourceTokens = buildSourceTokens(sourceWords);
    const timedTokens = buildTimedTokens(sttWords);
    const sourceNorm = sourceTokens.map(token => token.norm).join('');
    const sttNorm = timedText(timedTokens);

    if (sourceNorm.length === 0) return [];
    if (timedTokens.length === 0) {
        throw new Error('nVoice returned no alignable word timings');
    }

    const sourceToSttMap = sourceNorm === sttNorm
        ? null
        : buildSequentialWordMap(sourceTokens, sttNorm);
    const projected = sourceToSttMap
        ? projectMappedNormalizedTiming(sourceTokens, timedTokens, sourceToSttMap)
        : projectExactNormalizedTiming(sourceTokens, timedTokens);
    const mappedCount = sourceToSttMap ? sourceToSttMap.filter(index => index !== -1).length : sourceNorm.length;
    const mappedRatio = mappedCount / sourceNorm.length;
    if (mappedRatio < 0.65) {
        return enforceMonotonicTimings(projectProportionalTiming(sourceTokens, audioDurationMs || timedTokens[timedTokens.length - 1].endMs));
    }

    return enforceMonotonicTimings(fillUntimedTimings(projected, audioDurationMs));
}

// ─── v3: Paragraph-level Alignment ────────────────────────────

async function alignParagraph(paragraph, msgIdx, paraIdx) {
    const text = getSpokenText(paragraph.text);
    if (!text || text.trim().length === 0) return null;

    if (!paragraph.audioPath) return null;

    if (!fs.existsSync(paragraph.audioPath)) {
        console.error(`  [Msg ${msgIdx} Para ${paraIdx}] Audio file not found: ${paragraph.audioPath}`);
        return null;
    }

    const audioBuffer = fs.readFileSync(paragraph.audioPath);
    const url = `${NVOICE_URL}/transcribe?text=${encodeURIComponent(text)}`;

    console.log(`  [Msg ${msgIdx} Para ${paraIdx}] "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`    Audio: ${paragraph.audioFile} (${(audioBuffer.length / 1024).toFixed(1)} KB)`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: audioBuffer,
        agent: tlsAgent
    });

    if (!response.ok) {
        throw new Error(`nVoice alignment failed: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.segments || data.segments.length === 0) {
        console.log(`    Warning: No segments returned from nVoice`);
        return null;
    }

    // Collect all words across segments
    const allWords = [];
    for (const seg of data.segments) {
        if (seg.words) {
            for (const w of seg.words) {
                allWords.push({
                    word: w.word,
                    start: w.start,
                    end: w.end,
                    probability: w.probability
                });
            }
        }
    }

    if (allWords.length === 0) {
        console.log(`    Warning: No word timings in nVoice response`);
        return null;
    }

    const lastSegEnd = data.segments[data.segments.length - 1].end || 0;
    const audioDurationMs = Math.round(lastSegEnd * 1000);

    // For paragraphs, we use the STT words directly — they're short enough
    // that drift is minimal. The source text and STT output should be very
    // close for a single paragraph.
    const alignedWords = alignWordsToSource(text, allWords, audioDurationMs);

    const interpolated = alignedWords.filter(w => w.interpolated).length;
    const matched = alignedWords.length - interpolated;

    const durationMs = alignedWords.length > 0
        ? alignedWords[alignedWords.length - 1].endMs
        : 0;

    console.log(`    Words: ${alignedWords.length} (${matched} matched${interpolated > 0 ? `, ${interpolated} interp` : ''})`);
    console.log(`    Duration: ${(durationMs / 1000).toFixed(1)}s`);

    return {
        words: alignedWords,
        durationMs: durationMs,
        alignVersion: ALIGNMENT_VERSION
    };
}

async function processProject(project, outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });

    const totalParagraphs = project.messages.reduce((sum, m) => sum + m.paragraphs.length, 0);
    console.log(`\n[Align v3] Processing ${project.messages.length} messages (${totalParagraphs} paragraphs)...\n`);

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let mi = 0; mi < project.messages.length; mi++) {
        const message = project.messages[mi];

        for (let pi = 0; pi < message.paragraphs.length; pi++) {
            const para = message.paragraphs[pi];

            if (!para.audioPath || para.ttsError) {
                skipCount++;
                continue;
            }

            try {
                const timingData = await alignParagraph(para, mi, pi);
                if (timingData) {
                    para.words = timingData.words;
                    para.durationMs = timingData.durationMs;
                    para.alignVersion = timingData.alignVersion;
                    successCount++;
                } else {
                    skipCount++;
                }
            } catch (err) {
                console.error(`  [Msg ${mi} Para ${pi}] ERROR: ${err.message}`);
                para.alignError = err.message;
                failCount++;
            }
        }
    }

    const outputPath = path.join(outputDir, 'project_v3_aligned.json');
    fs.writeFileSync(outputPath, JSON.stringify(project, null, 2), 'utf-8');

    console.log(`\n[Align v3] Complete: ${successCount} aligned, ${skipCount} skipped, ${failCount} failed`);
    console.log(`[Align v3] Output: ${outputPath}\n`);

    return project;
}

// ─── v2: Slide-level Alignment (legacy) ───────────────────────

async function alignSlide(slide, slideIndex) {
    const text = getSlideText(slide);
    if (!text || text.trim().length === 0) return null;

    const tts = slide.tts;
    if (!tts || !tts.audioPath) return null;

    if (!fs.existsSync(tts.audioPath)) {
        console.error(`  [Slide ${slideIndex}] Audio file not found: ${tts.audioPath}`);
        return null;
    }

    const audioBuffer = fs.readFileSync(tts.audioPath);
    const url = `${NVOICE_URL}/transcribe?text=${encodeURIComponent(text)}`;

    console.log(`  [Slide ${slideIndex}] "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`    Audio: ${tts.audioFile} (${(audioBuffer.length / 1024).toFixed(1)} KB)`);

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: audioBuffer,
        agent: tlsAgent
    });

    if (!response.ok) {
        throw new Error(`nVoice alignment failed: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    if (!data.segments || data.segments.length === 0) {
        console.log(`    Warning: No segments returned from nVoice`);
        return null;
    }

    // Collect all words across segments
    const allWords = [];
    for (const seg of data.segments) {
        if (seg.words) {
            for (const w of seg.words) {
                allWords.push({
                    word: w.word,
                    start: w.start,
                    end: w.end,
                    probability: w.probability
                });
            }
        }
    }

    if (allWords.length === 0) {
        console.log(`    Warning: No word timings in nVoice response`);
        return null;
    }

    // Get the actual audio duration from nVoice's last segment
    const lastSegEnd = data.segments[data.segments.length - 1].end || 0;
    const audioDurationMs = Math.round(lastSegEnd * 1000);

    // Align STT words to source text, using real audio duration for gaps
    const alignedWords = alignWordsToSource(text, allWords, audioDurationMs);

    const interpolated = alignedWords.filter(w => w.interpolated).length;
    const extrapolated = alignedWords.filter(w => w.extrapolated).length;
    const mismatched = alignedWords.filter(w => w.mismatched).length;
    const matched = alignedWords.length - interpolated - extrapolated - mismatched;

    const durationMs = alignedWords.length > 0
        ? alignedWords[alignedWords.length - 1].endMs
        : 0;

    console.log(`    Words: ${alignedWords.length} (${matched} matched${interpolated > 0 ? `, ${interpolated} interp` : ''}${extrapolated > 0 ? `, ${extrapolated} extrap` : ''}${mismatched > 0 ? `, ${mismatched} mismatch` : ''})`);
    console.log(`    Duration: ${(durationMs / 1000).toFixed(1)}s`);

    return {
        words: alignedWords,
        durationMs: durationMs,
        matchStats: {
            total: alignedWords.length,
            matched: matched,
            interpolated: interpolated,
            extrapolated: extrapolated,
            mismatched: mismatched
        }
    };
}

// ─── Process Deck ─────────────────────────────────────────────

async function processDeck(deckPath, outputDir) {
    const deck = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`\n[Align] Processing ${deck.slides.length} slides...\n`);

    let successCount = 0;
    let skipCount = 0;

    for (let i = 0; i < deck.slides.length; i++) {
        const slide = deck.slides[i];
        if (!slide.tts || slide.tts.error) {
            skipCount++;
            continue;
        }

        try {
            const timingData = await alignSlide(slide, i);
            if (timingData) {
                // Merge timing into TTS data
                slide.tts.words = timingData.words;
                slide.tts.durationMs = timingData.durationMs;
                slide.tts.matchStats = timingData.matchStats;
                slide.tts.alignVersion = ALIGNMENT_VERSION;
                successCount++;
            } else {
                skipCount++;
            }
        } catch (err) {
            console.error(`  [Slide ${i}] ERROR: ${err.message}`);
            slide.tts.alignError = err.message;
        }
    }

    const deckOutputPath = path.join(outputDir, 'slide_deck_aligned.json');
    fs.writeFileSync(deckOutputPath, JSON.stringify(deck, null, 2), 'utf-8');

    console.log(`\n[Align] Complete: ${successCount} aligned, ${skipCount} skipped, ${deck.slides.length - successCount - skipCount} failed`);
    console.log(`[Align] Output: ${deckOutputPath}\n`);

    return deck;
}

// ─── Auto-detect entry point ──────────────────────────────────

async function processInput(inputPath, outputDir) {
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

    if (data.version === 3 && data.messages && data.messages[0]?.paragraphs) {
        console.log('[Align] Detected v3 project (messages + paragraphs)');
        return processProject(data, outputDir);
    }

    if (data.slides) {
        console.log('[Align] Detected v2 deck (slides)');
        return processDeck(inputPath, outputDir);
    }

    throw new Error('Unrecognized input format: expected v2 deck with slides or v3 project with messages.paragraphs');
}

// ─── CLI ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node pipeline/align.js <project_v3_tts.json | slide_deck_tts.json> [output-dir]');
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputDir = path.resolve(args[1] || 'pipeline/output');

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    await processInput(inputPath, outputDir);
}

if (require.main === module) {
    main().catch(err => {
        console.error('FATAL:', err.message);
        process.exit(1);
    });
}

module.exports = { processDeck, processProject, processInput, alignWordsToSource, ALIGNMENT_VERSION };
