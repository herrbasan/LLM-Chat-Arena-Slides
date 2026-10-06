// Verify the landmark overlay E2E at the pipeline level (no server, no DB):
// real raw export + landmark block → buildProject → title/date must win,
// legacy file without the block → unchanged behavior. Also proves the
// fail-fast validation fires on a malformed block.
import fs from 'node:fs';
import { buildProject } from '../pipeline/build-messages.js';

const RAW = 'X:/arena-publication/sessions/raw/arena-1774392377554-6ebtoqrlo.json';

// 1. With overlay
const withOverlay = JSON.parse(fs.readFileSync(RAW, 'utf8'));
withOverlay.landmark = { title: 'Overlay Probe Title', recordedAt: '2026-05-22' };
const p1 = await buildProject(withOverlay, null);
console.log(`overlay:    title="${p1.source.topic}" recordedAt="${p1.source.recordedAt}" exportedAt="${p1.source.exportedAt}"`);
if (p1.source.topic !== 'Overlay Probe Title') throw new Error('FAIL: landmark.title did not win');
if (!String(p1.source.recordedAt).startsWith('2026-05-22')) throw new Error('FAIL: landmark.recordedAt did not land');

// 2. Without overlay (legacy behavior unchanged)
const plain = JSON.parse(fs.readFileSync(RAW, 'utf8'));
delete plain.landmark;
const p2 = await buildProject(plain, null);
console.log(`no overlay: title="${p2.source.topic}" recordedAt="${p2.source.recordedAt}"`);
if (p2.source.topic === 'Overlay Probe Title') throw new Error('FAIL: title leaked without overlay');
if (p2.source.recordedAt != null) throw new Error('FAIL: recordedAt should be null without overlay');

// 3. Malformed overlay → must throw
const bad = JSON.parse(fs.readFileSync(RAW, 'utf8'));
bad.landmark = { recordedAt: '2026-05-22' }; // no title
try {
    await buildProject(bad, null);
    throw new Error('FAIL: malformed overlay (missing title) did not throw');
} catch (err) {
    if (!/landmark/.test(err.message)) throw err;
    console.log(`malformed:  threw as expected — ${err.message}`);
}

// 4. Topic slide text must be untouched by the title (seed verbatim)
const topicMsg = p1.messages.find(m => m.type === 'topic');
const seedShown = topicMsg?.paragraphs?.[0]?.text ?? '(none)';
console.log(`topic slide speaks: ${String(seedShown).slice(0, 90)}…`);
console.log('ALL OVERLAY CHECKS PASSED');
