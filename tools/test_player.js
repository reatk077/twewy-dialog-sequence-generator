// Player state-machine test (Node): node tools/test_player.js
const fs = require('fs');
const path = require('path');
const { parse } = require('../js/parser.js');
const { create } = require('../js/player.js');

const script = fs.readFileSync(path.join(__dirname, '..', 'samples', 'demo.txt'), 'utf8');
const parsed = parse(script);
if (parsed.errors.length) {
  console.error('PARSE ERRORS:', parsed.errors);
  process.exit(1);
}

const seen = [];
const player = create({
  onRender: (state, display) => { /* no-op */ },
  onChange: (info) => { /* no-op */ },
  onError: (msg) => { console.error('PLAYER ERROR:', msg); process.exit(1); },
});
player.load(parsed);
player.restart();

let guard = 0;
while (!player.finished && guard++ < 5000) {
  if (player.display) {
    if (player.display.op === 'choice') {
      seen.push('CHOICE:' + player.display.choices.map(c => c.text).join('/'));
      player.choose(player.display.choices[0].target);
      continue;
    }
    if (player.display.op === 'speech') {
      const b = player.display.bubbles[0];
      seen.push((b.speakers.map(s => s.id).join('+') || '*') + ': ' + b.text.slice(0, 12));
    }
  }
  player.next();
}

console.log('finished:', player.finished, '| steps seen:', seen.length);
seen.forEach((s, i) => console.log(' ', i, s));

const assert = require('assert');
assert.ok(player.finished, 'reaches @end');
assert.ok(seen.length >= 8, 'multiple speech lines played');
assert.ok(seen.some(s => s.startsWith('CHOICE:')), 'choice menu encountered');
assert.ok(seen.some(s => s.includes('递出雨伞')), 'choice branch (yes) followed');
console.log('ALL PLAYER TESTS PASSED');

// ---- transition animation behavior ----
const stubBubbles = { default: { width: 608, height: 427 }, thought: { width: 608, height: 424 }, wiggly: { width: 610, height: 424 }, loud: { width: 606, height: 424 } };
const stubImg = { width: 240, height: 360 };
const p3 = create({ onRender() {}, onError(m) { throw new Error(m); } });
p3.setLoaders((p, cb) => cb(stubImg), (p, cb) => cb(stubImg));
p3.load(parse('!actor a = A | left | front | s.png\n!actor b = B | right | front | s.png\na: one\nb: two'));
p3.state.bubbles = stubBubbles;
p3.restart(); // first line: restart => no transition
assert.strictEqual(p3.transition, null, 'restart does not animate');
p3.next(); // complete typing
p3.next(); // advance -> speech->speech transition created
assert.ok(p3.transition, 'speech->speech creates a transition');
assert.strictEqual(p3.transition.from.bubbles[0].text, 'one', 'from = previous line');
assert.strictEqual(p3.transition.to.bubbles[0].text, 'two', 'to = new line');
assert.strictEqual(p3.transition.dist, 110, 'default transition distance');
p3.next(); // fast-forward the transition
assert.strictEqual(p3.transition, null, 'next() fast-forwards the transition');
p3.next(); // advance to end
assert.ok(p3.finished, 'sequence finished');
console.log('TRANSITION BEHAVIOR TESTS PASSED');

// ---- audio hooks: bgm/sfx ops + voice on present, suppressed during export ----
{
  const calls = [];
  const p5 = create({
    onRender() {},
    onError(m) { throw new Error(m); },
  });
  p5.setLoaders((path, cb) => cb(stubImg), (path, cb) => cb(stubImg));
  p5.setAudioHooks({
    playBgm: (path) => calls.push(['bgm', path]),
    stopBgm: () => calls.push(['bgmStop']),
    playSfx: (path) => calls.push(['sfx', path]),
    playVoice: (id, n) => calls.push(['voice', id, n]),
  });
  p5.load(parse('@bgm bgm://m1\n@sfx sfx://boom\na{voice=2}: 说话'));
  p5.state.bubbles = stubBubbles;
  p5.restart();
  assert.ok(calls.some(c => c[0] === 'bgm' && c[1] === 'bgm://m1'), 'bgm op triggers playBgm');
  assert.ok(calls.some(c => c[0] === 'sfx' && c[1] === 'sfx://boom'), 'sfx op triggers playSfx');
  assert.ok(calls.some(c => c[0] === 'voice' && c[1] === 'a' && c[2] === 2), 'voice attr plays speaker voice');
  // exportAll needs document.createElement('canvas') — minimal stub
  const realDoc = global.document;
  global.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ({
          clearRect() {}, save() {}, restore() {}, scale() {}, drawImage() {},
          fillRect() {}, measureText(t) { return { width: String(t).length * 10 }; },
          fillText() {}, strokeText() {}, setTransform() {}, translate() {},
        }) };
      }
      return { style: {}, appendChild() {}, remove() {}, click() {}, addEventListener() {} };
    },
  };
  calls.length = 0; // clear playback-phase calls; export must not add any
  p5.exportAll(2, () => {});
  global.document = realDoc;
  assert.strictEqual(calls.length, 0, 'no audio during batch export');
  // @bgm off stops music
  const p6 = create({ onRender() {}, onError() {} });
  p6.setLoaders((path, cb) => cb(stubImg), (path, cb) => cb(stubImg));
  const stops = [];
  p6.setAudioHooks({ playBgm() {}, stopBgm: () => stops.push(1), playSfx() {}, playVoice() {} });
  p6.load(parse('@bgm x\n@bgm off'));
  p6.state.bubbles = stubBubbles;
  p6.restart();
  assert.ok(stops.length >= 2, 'reset stops stale bgm + @bgm off stops music (got ' + stops.length + ')');
  // script without any bgm op: restart still clears stale music
  const p9 = create({ onRender() {}, onError() {} });
  p9.setLoaders((path, cb) => cb(stubImg), (path, cb) => cb(stubImg));
  const stops9 = [];
  p9.setAudioHooks({ playBgm() {}, stopBgm: () => stops9.push(1), playSfx() {}, playVoice() {} });
  p9.load(parse('a: hi\nb: bye'));
  p9.state.bubbles = stubBubbles;
  p9.restart();
  assert.ok(stops9.length >= 1, 'restart stops stale bgm even without @bgm');
  console.log('AUDIO HOOKS TEST PASSED');
}

// ---- per-sprite xform flows from loader to actor state ----
{
  const p7 = create({ onRender() {}, onError(m) { throw new Error(m); } });
  p7.setLoaders(
    (path, cb) => cb(stubImg),
    (path, cb) => {
      if (path === 'chara://alice/1') cb(stubImg, { scale: 1.4, ox: 5, oy: -3 });
      else cb(stubImg, undefined);
    }
  );
  p7.load(parse('!actor alice = Alice | left | front | chara://alice/{expr}\nalice: hi'));
  p7.state.bubbles = stubBubbles;
  p7.restart();
  const act = p7.state.actors.get('alice');
  assert.ok(act.xform && act.xform.scale === 1.4 && act.xform.ox === 5 && act.xform.oy === -3,
    'resource sprite xform attached to actor state');
  console.log('SPRITE XFORM FLOW TEST PASSED');
}
{
  const paths = [];
  const p4 = create({ onRender() {}, onError(m) { throw new Error(m); } });
  p4.setLoaders(
    (path, cb) => cb(stubImg),
    (path, cb) => { paths.push(path); cb(stubImg); }
  );
  p4.load(parse('!actor a = A | left | front | sprites/{id}{expr}.png | expr=3\na: hi'));
  p4.state.bubbles = stubBubbles;
  p4.restart();
  const actor = p4.state.actors.get('a');
  assert.strictEqual(actor.expr, 3, 'actor default expr = 3');
  assert.ok(paths.includes('sprites/a3.png'), 'sprite loader requested expr-3 file, got: ' + JSON.stringify(paths));
  console.log('ACTOR DEFAULT EXPR TEST PASSED');
}
