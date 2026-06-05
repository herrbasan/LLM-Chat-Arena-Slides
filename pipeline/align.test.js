const assert = require('assert');
const { alignWordsToSource } = require('./align.js');

function assertWord(result, index, word, startMs, endMs) {
    assert.strictEqual(result[index].word, word);
    assert.strictEqual(result[index].startMs, startMs);
    assert.strictEqual(result[index].endMs, endMs);
}

{
    const result = alignWordsToSource('these inter-LLM exchanges', [
        { word: 'these', start: 0.0, end: 0.2 },
        { word: 'inter', start: 0.2, end: 0.4 },
        { word: '-LLM', start: 0.4, end: 0.6 },
        { word: 'exchanges', start: 0.7, end: 1.0 }
    ], 1000);
    assert.strictEqual(result.length, 3);
    assertWord(result, 0, 'these', 0, 200);
    assertWord(result, 1, 'inter-LLM', 200, 600);
    assertWord(result, 2, 'exchanges', 700, 1000);
}

{
    const result = alignWordsToSource('Kimi K2.5 Chat', [
        { word: 'Kimi', start: 0.0, end: 0.3 },
        { word: 'K2.5Chat', start: 0.3, end: 1.0 }
    ], 1000);
    assert.strictEqual(result.length, 3);
    assertWord(result, 0, 'Kimi', 0, 300);
    assertWord(result, 1, 'K2.5', 300, 600);
    assertWord(result, 2, 'Chat', 600, 1000);
}

{
    const result = alignWordsToSource('Hello. Yes, we are.', [
        { word: 'hello', start: 0.0, end: 0.4 },
        { word: 'yes', start: 0.6, end: 0.9 },
        { word: 'we', start: 1.0, end: 1.1 },
        { word: 'are', start: 1.1, end: 1.4 }
    ], 1400);
    assert.deepStrictEqual(result.map(word => word.word), ['Hello.', 'Yes,', 'we', 'are.']);
    assert.deepStrictEqual(result.map(word => [word.startMs, word.endMs]), [[0, 400], [600, 900], [1000, 1100], [1100, 1400]]);
}

{
    const result = alignWordsToSource('alpha beta gamma delta', [
        { word: 'alpha', start: 0.0, end: 0.3 },
        { word: 'gamma', start: 0.5, end: 0.7 },
        { word: 'delta', start: 0.8, end: 1.0 }
    ], 1000);
    assert.strictEqual(result.length, 4);
    assertWord(result, 0, 'alpha', 0, 300);
    assertWord(result, 2, 'gamma', 500, 700);
    assertWord(result, 3, 'delta', 800, 1000);
    assert.strictEqual(result[1].word, 'beta');
    assert.strictEqual(result[1].interpolated, true);
    assert(result[1].startMs >= result[0].endMs);
    assert(result[1].endMs <= result[2].startMs);
}

{
    const source = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
    const spokenWords = source.split(/\s+/).filter(word => word !== 'seven');
    const sttWords = spokenWords.map((word, index) => ({ word, start: index * 0.25, end: index * 0.25 + 0.2 }));
    const result = alignWordsToSource(source, sttWords, 4000);
    assert.strictEqual(result.length, 16);
    assertWord(result, 0, 'one', 0, 200);
    assertWord(result, 1, 'two', 250, 450);
    assert.strictEqual(result[6].word, 'seven');
    assert.strictEqual(result[6].interpolated, true);
    assertWord(result, 7, 'eight', 1500, 1700);
    assertWord(result, 15, 'sixteen', 3500, 3700);
}

console.log('align.test.js passed');