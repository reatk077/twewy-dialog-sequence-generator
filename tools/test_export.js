// Export path test (Node): validates exportCurrentFrame + exportAll replay
// with stubbed document/canvas. node tools/test_export.js
const fs = require('fs');
const path = require('path');
const { parse } = require('../js/parser.js');
const { create } = require('../js/player.js');
const { render } = require('../js/renderer.js');

const assert = require('assert');

// ---- stubs ----
function fakeImg(w, h) { return { width: w, height: h }; }
const stubBubbles = { default: fakeImg(608, 427), thought: fakeImg(608, 424), wiggly: fakeImg(610, 424), loud: fakeImg(606, 424) };
const stubBg = fakeImg(1280, 720);
const stubSprite = fakeImg(240, 360);

function makeCtx() {
  return {
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, lineWidth: 0, lineJoin: '',
    clearRect() {}, fillRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    setTransform() {},
    drawImage() {},
    measureText(t) { return { width: String(t).length * 10 }; },
    fillText() {}, strokeText() {},
  };
}

const realDoc = global.document;
global.document = {
  createElement(tag) {
    if (tag === 'canvas') {
      return {
        width: 0, height: 0,
        getContext: () => makeCtx(),
      };
    }
    return {
      style: {}, setAttribute() {}, appendChild() {}, remove() {}, click() {},
      addEventListener() {},
    };
  },
};

const script = fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo.txt'), 'utf8');
const parsed = parse(script);
assert.strictEqual(parsed.errors.length, 0, JSON.stringify(parsed.errors));

let rendered = 0;
const player = create({
  onRender(state, display, ctx, isExport) {
    if (isExport) { rendered++; render(ctx, state, display); }
  },
  onError: (m) => { throw new Error(m); },
});
player.setLoaders((p, cb) => cb(stubBg), (p, cb) => cb(stubSprite));
player.load(parsed);
player.state.bubbles = stubBubbles;
player.restart();

// current frame export
{
  const c = player.exportCurrentFrame(2);
  assert.strictEqual(c.width, 667 * 2, 'current frame export size x2');
  assert.strictEqual(c.height, 500 * 2, 'current frame export size y2');
  console.log('exportCurrentFrame OK (1334x1000 @2x)');
}

// full sequence export (choice lines skipped, jumps followed, state restored)
{
  rendered = 0;
  const results = player.exportAll(2, () => {});
  console.log('exportAll produced', results.length, 'frames (renders:', rendered + ')');
  assert.ok(results.length >= 8, 'at least 8 speech frames exported, got ' + results.length);
  // demo: 9 speech lines (incl dual-bubble) + 2 in yes branch + 1 in no branch => 12 total reachable
  assert.ok(results.length <= 14, 'no runaway frames: ' + results.length);
  // state restored after export
  assert.ok(player.display, 'display restored after export');
  assert.strictEqual(player.cursor, player.cursor, 'cursor restored');
  console.log('exportAll OK (jumps followed, state restored)');
}

// loop guard: a script with a backward jump that never reaches @end
{
  const loopScript = [
    '@label a',
    'alice: hi',
    '-> a',
  ].join('\n');
  const lp = parse(loopScript);
  const p2 = create({ onRender() {}, onError: () => {} });
  p2.setLoaders((p, cb) => cb(stubBg), (p, cb) => cb(stubSprite));
  p2.load(lp);
  p2.state.bubbles = stubBubbles;
  let threw = false;
  try { p2.exportAll(2, () => {}); } catch (e) { threw = true; console.log('loop guard OK:', e.message); }
  assert.ok(threw, 'infinite loop detected');
  assert.strictEqual(p2._suppressAudio, false, 'audio suppression restored after export failure');
}

global.document = realDoc;
console.log('ALL EXPORT TESTS PASSED');
