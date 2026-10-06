// One-off: verify the Fatten deployment (handover-2026-10-03 checklist, step 5).
// Checks: project count, per-deck audio/alignment coverage, ghost-deck slide flow,
// one audio binary served end-to-end, effective settings. Prints verdicts only.
const BASE = 'http://localhost:3600';
const GHOST_ID = 'slideshow_XOAjsiXuLwjEJgUU';

const res = await fetch(`${BASE}/api/projects`);
if (!res.ok) throw new Error(`/api/projects -> HTTP ${res.status}`);
const projects = (await res.json()).projects.filter(p => p._type !== 'app_settings');
console.log(`projects: ${projects.length}`);

for (const p of projects) {
  const paras = p.messages.flatMap(m => m.paragraphs ?? []);
  const speakable = paras.filter(x => new RegExp('[\\p{L}\\p{N}]', 'u').test(x.text ?? ''));
  const withAudio = speakable.filter(x => x.audioRef && x.audioUrl);
  const aligned = speakable.filter(x => Array.isArray(x.words) && x.words.length > 0);
  const t = p.messages.map(m => m.type);
  const types = `${t.slice(0, 3).join('→')}→[${t.filter(x => x === 'conversation').length}×conversation]→${t[t.length - 1]}`;
  console.log(`${p._id} | ${p.source?.topic ?? '(untitled)'} | v${p.version} | ${p.messages.length} msgs | audio ${withAudio.length}/${speakable.length} | aligned ${aligned.length}/${speakable.length} | ${types}`);
}

// Ghost deck: setup -> details -> topic -> conversation... -> end
const ghost = projects.find(p => p._id === GHOST_ID);
if (!ghost) {
  console.log(`ghost deck ${GHOST_ID}: MISSING — FAIL`);
} else {
  const t = ghost.messages.map(m => m.type);
  const head = t.slice(0, 3).join(',') ;
  const ok = head === 'setup,details,topic' && t[t.length - 1] === 'end' && t.slice(3, -1).every(x => x === 'conversation');
  console.log(`ghost deck flow: ${ok ? 'setup→details→topic→[conv…]→end — PASS' : t.join(',') + ' — FAIL'}`);
  console.log(`ghost deck title: ${ghost.source?.topic ?? '(none)'} | topic: ${ghost.messages.find(m => m.type === 'topic')?.paragraphs?.[0]?.text?.slice(0, 80) ?? '(no topic text)'}`);
}

// One audio binary, end to end
const anyPara = projects.flatMap(p => p.messages.flatMap(m => m.paragraphs ?? [])).find(x => x.audioUrl);
if (!anyPara) throw new Error('no paragraph with audioUrl found — nothing to spot-check');
const ares = await fetch(`${BASE}${anyPara.audioUrl}`);
const buf = Buffer.from(await ares.arrayBuffer());
const head = buf.subarray(0, 2).toString('hex');
const isMp3 = buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
console.log(`audio spot-check: HTTP ${ares.status} ${buf.length} bytes head=${head} ${isMp3 ? '(mp3 sync)' : '(NOT mp3!)'} — ${ares.ok && isMp3 ? 'PASS' : 'FAIL'}`);

// Effective settings
const sres = await fetch(`${BASE}/api/settings`);
if (sres.ok) {
  const s = await sres.json();
  console.log(`settings: ${JSON.stringify(s)}`);
} else {
  console.log(`settings: HTTP ${sres.status}`);
}
