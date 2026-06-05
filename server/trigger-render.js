const fs = require('fs');
const path = require('path');

const projectId = 'slideshow_R0QnIVeH5mMNRM2C';
const deckPath = path.join(__dirname, 'data', 'render_cache', projectId, 'deck.json');

const deck = JSON.parse(fs.readFileSync(deckPath, 'utf-8'));

console.log(`Loaded deck: ${deck.slides.length} slides`);
console.log(`Slide 0 tts.cached: ${deck.slides[0].tts?.cached}`);
console.log(`Slide 0 has words: ${!!(deck.slides[0].tts?.words?.length)}`);

fetch(`http://localhost:3600/api/render-deck/${projectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deck)
})
.then(async res => {
    if (!res.ok) {
        const err = await res.json();
        console.error('Render failed:', err.error || err);
        process.exit(1);
    }
    const result = await res.json();
    console.log(`Render complete! ${result.slides.length} slides`);
    const aligned = result.slides.filter(s => s.tts?.words?.length > 0).length;
    console.log(`Aligned slides: ${aligned}`);
    for (let i = 0; i < Math.min(3, result.slides.length); i++) {
        const s = result.slides[i];
        console.log(`  Slide ${i}: words=${s.tts?.words?.length || 0}, alignError=${s.tts?.alignError || 'none'}`);
    }
})
.catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
