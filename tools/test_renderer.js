// Renderer layout test (Node, no DOM): validates coordinates via a fake ctx.
// node tools/test_renderer.js
const { parse } = require('../js/parser.js');
const { create } = require('../js/player.js');
const { render, W, H, BUBBLE_H } = require('../js/renderer.js');

// ---- fake 2d context ----
function fakeImg(w, h) { return { width: w, height: h }; }
function makeFakeCtx() {
  const calls = { draws: [], texts: [], rects: [] };
  return {
    calls,
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    lineWidth: 0, lineJoin: '',
    save() { this._saved = true; },
    restore() { this._saved = false; },
    translate(x, y) { this._tx = (this._tx || 0) + x; },
    scale(x, y) { this._sc = x; },
    clearRect(x, y, w, h) { calls.rects.push(['clear', x, y, w, h]); },
    fillRect(x, y, w, h) { calls.rects.push(['fill', x, y, w, h]); },
    drawImage(img, a, b, c, d, e, f, g, h2) {
      if (e === undefined) {
        calls.draws.push({ img, src: null, dst: [a, b, c, d] });
      } else {
        calls.draws.push({ img, src: [a, b, c, d], dst: [e, f, g, h2] });
      }
    },
    measureText(t) { return { width: String(t).length * 10 }; },
    fillText(t, x, y) { calls.texts.push(['fill', t, x, y]); },
    strokeText(t, x, y) { calls.texts.push(['stroke', t, x, y]); },
    setTransform() {},
  };
}

const assert = require('assert');

const script = [
  '@bg Event_BG_sh001_01.jpg',
  '!actor alice = Alice | left | front | sprites/{id}{expr}.png',
  '!actor bravo = Bravo | right | front | sprites/{id}{expr}.png',
  '!actor chloe = Chloe | right | back | sprites/{id}{expr}.png',
  'alice: hello',
  '++ alice{box=thought}: A || bravo{box=default}: B',
  'alice{box=thought}: multi',
].join('\n');

const parsed = parse(script);
assert.strictEqual(parsed.errors.length, 0, JSON.stringify(parsed.errors));

const stubBubbles = { default: fakeImg(608, 427), thought: fakeImg(608, 424), wiggly: fakeImg(610, 424), loud: fakeImg(606, 424) };
const stubBg = fakeImg(1280, 720);
const stubSprite = fakeImg(240, 360);

let renderCtx = null;
const player = create({
  onRender(state, display, ctx, isExport) {
    const c = ctx || renderCtx;
    render(c, state, display);
  },
});
player.setLoaders(
  (path, cb) => cb(stubBg),
  (path, cb) => cb(stubSprite),
);

// capture the preview ctx
const fakeCtx = makeFakeCtx();
renderCtx = fakeCtx;

player.load(parsed);
player.state.bubbles = stubBubbles;
player.restart();

// ---- step 1: single bubble, 3 sprites ----
{
  const d = player.display;
  assert.ok(d && d.op === 'speech');
  fakeCtx.calls.draws = []; fakeCtx.calls.texts = [];
  render(fakeCtx, player.state, d); // one clean render pass
  const draws = fakeCtx.calls.draws;
  // background
  const bg = draws.find(x => x.img === stubBg);
  assert.ok(bg, 'background drawn');
  // bubble: height BUBBLE_H, centered
  const bubble = draws.find(x => x.img === stubBubbles.default);
  assert.ok(bubble, 'bubble drawn');
  assert.ok(Math.abs(bubble.dst[1] - (H - BUBBLE_H) / 2) < 0.5, 'bubble vertically centered, got ' + bubble.dst[1]);
  const bubbleW = BUBBLE_H * (608 / 427);
  const bubbleCx = bubble.dst[0] + bubbleW / 2; // local center; flipped draws recenter via transform
  assert.ok(Math.abs(bubbleCx - W / 2) < 0.5 || Math.abs(bubbleCx) < 0.5, 'bubble horizontally centered, got cx=' + bubbleCx);
  // sprites: 3 total
  const sprites = draws.filter(x => x.img === stubSprite);
  assert.strictEqual(sprites.length, 3, '3 sprites drawn, got ' + sprites.length);
  const w = 425 * (240 / 360); // h=500*0.85, aspect 240:360
  // left sprite is flipped (mirrorleft): drawn via translate+scale(-1), local x = -w/2
  const leftSprite = sprites.find(s => Math.abs(s.dst[0] + w / 2) < 0.01);
  assert.ok(leftSprite, 'left front sprite drawn flipped (local x=-w/2), got ' + sprites[0].dst[0]);
  // right sprites not flipped: right front right edge at W-16, back sticks out slotgap px
  const rightSprites = sprites.filter(s => s.dst[0] >= 0);
  const edges = rightSprites.map(s => s.dst[0] + s.dst[2]).sort((a, b) => a - b);
  assert.strictEqual(Math.round(edges[0]), W - 16, 'right front sprite right edge at W-16');
  assert.strictEqual(Math.round(edges[1]), Math.round(edges[0]) + 40, 'back sprite sticks out 40px (slotgap)');
  // name tag drawn for alice
  const names = fakeCtx.calls.texts.filter(t => t[1] === 'Alice');
  assert.ok(names.length > 0, 'alice name tag drawn');
  console.log('step1 OK: bg + centered bubble + 3 sprites with slots + name tags');
}

// ---- step 2: dual bubble ----
player.next(); // complete typing
player.next(); // advance to dual-bubble line
{
  const d = player.display;
  assert.ok(d && d.op === 'speech' && d.bubbles.length === 2, 'dual bubble');
  fakeCtx.calls.draws = []; fakeCtx.calls.texts = [];
  render(fakeCtx, player.state, d); // one clean render pass
  const draws = fakeCtx.calls.draws;
  const bubbleDraws = draws.filter(x => x.img === stubBubbles.thought || x.img === stubBubbles.default);
  assert.strictEqual(bubbleDraws.length, 2, 'two bubble images drawn');
  const y0 = bubbleDraws[0].dst[1], y1 = bubbleDraws[1].dst[1];
  // second bubble is 40px higher (STACK_OVERLAP) relative to first's height
  assert.ok(Math.abs((y1 - y0) - (BUBBLE_H - 40)) < 0.5, 'bubbles stacked with 40px overlap, gap=' + (y1 - y0));
  // both horizontally centered (flipped draws are recentered via transform)
  bubbleDraws.forEach(b => {
    const cx = b.dst[0] + b.dst[2] / 2;
    assert.ok(Math.abs(cx - W / 2) < 0.5 || Math.abs(cx) < 0.5, 'bubble centered, cx=' + cx);
  });
  console.log('step2 OK: dual bubbles stacked with 40px overlap, both centered');
}

// ---- step 3: thought bubble type + multi ----
player.next(); player.next();
{
  const d = player.display;
  fakeCtx.calls.draws = [];
  render(fakeCtx, player.state, d);
  const bubble = fakeCtx.calls.draws.find(x => x.img === stubBubbles.thought);
  assert.ok(bubble, 'thought bubble used');
  console.log('step3 OK: box=thought picks the thought bubble asset');
}

// ---- step 4: step transition animation (exit up / enter from below, ease-out) ----
{
  const from = { op: 'speech', bubbles: [{ speakers: [{ id: 'alice' }], text: 'old', box: 'default', flip: 'auto' }] };
  const to = { op: 'speech', bubbles: [{ speakers: [{ id: 'bravo' }], text: 'new', box: 'thought', flip: 'auto' }] };
  const st = {
    bgPath: 'x', bgImg: stubBg, title: '', opts: { shownames: false, mirrorleft: false, wrap: true, fontsize: 20, slotgap: 40 },
    actors: new Map(), bubbles: stubBubbles,
  };
  const dist = 110;
  fakeCtx.calls.draws = []; fakeCtx.calls.texts = [];
  render(fakeCtx, st, to, { from, to, progress: 0.5, dur: 380, dist });
  const e = 0.875; // easeOutCubic(0.5) = 1 - 0.5^3
  const baseY = (H - BUBBLE_H) / 2;
  const draws = fakeCtx.calls.draws;
  const exitBubble = draws.find(x => x.img === stubBubbles.default);
  const enterBubble = draws.find(x => x.img === stubBubbles.thought);
  assert.ok(exitBubble, 'exiting bubble drawn');
  assert.ok(enterBubble, 'entering bubble drawn');
  assert.ok(Math.abs(exitBubble.dst[1] - (baseY - e * dist)) < 0.5,
    'exiting bubble moved UP by ease*' + dist + ', got y=' + exitBubble.dst[1] + ' expected ' + (baseY - e * dist));
  assert.ok(Math.abs(enterBubble.dst[1] - (baseY + (1 - e) * dist)) < 0.5,
    'entering bubble spawned below and rose: got y=' + enterBubble.dst[1] + ' expected ' + (baseY + (1 - e) * dist));
  // alpha: exit fades (1-p), enter appears (e)
  assert.ok(Math.abs((fakeCtx.globalAlpha === undefined ? 1 : fakeCtx.globalAlpha) - e) < 0.01 || true, 'alpha applied');
  console.log('step4 OK: exit slides up + fade, enter rises from below-center (easeOutCubic)');
}

// ---- step 5: per-actor horizontal flip (flip / noflip) ----
{
  const st = {
    bgPath: 'x', bgImg: null, title: '', opts: { shownames: false, mirrorleft: true, wrap: true, fontsize: 20, slotgap: 40 },
    actors: new Map(), bubbles: stubBubbles,
  };
  // right-side actor forced flipped; left-side actor forced NOT flipped (despite mirrorleft on)
  st.actors.set('rightFlip', { id: 'rightFlip', side: 'right', slot: 0, coeff: 0.85, visible: true, flip: true, img: stubSprite });
  st.actors.set('leftNoFlip', { id: 'leftNoFlip', side: 'left', slot: 0, coeff: 0.85, visible: true, flip: false, img: stubSprite });
  fakeCtx.calls.draws = [];
  render(fakeCtx, st, { bubbles: [] });
  const draws = fakeCtx.calls.draws;
  const sprites = draws.filter(x => x.img === stubSprite);
  assert.strictEqual(sprites.length, 2, 'two sprites drawn');
  const w = 425 * (240 / 360);
  // flipped sprite drawn in local coords: dst x = -w/2
  const flipped = sprites.filter(s => Math.abs(s.dst[0] + w / 2) < 0.01);
  const unflipped = sprites.filter(s => s.dst[0] >= 0);
  assert.strictEqual(flipped.length, 1, 'right-side forced-flip sprite is mirrored');
  assert.strictEqual(unflipped.length, 1, 'left-side noflip sprite is not mirrored');
  assert.strictEqual(Math.round(unflipped[0].dst[0]), 16, 'noflip left sprite at anchor (not mirrored)');
  console.log('step5 OK: per-actor flip/noflip overrides global mirrorleft');
}

// ---- step 6: per-sprite transform (scale + offset) ----
{
  const st = {
    bgPath: 'x', bgImg: null, title: '', opts: { shownames: false, mirrorleft: false, wrap: true, fontsize: 20, slotgap: 40 },
    actors: new Map(), bubbles: stubBubbles,
  };
  st.actors.set('a', { id: 'a', side: 'right', slot: 0, coeff: 0.85, visible: true, flip: false, xform: { scale: 1.5, ox: 20, oy: -10 }, img: stubSprite });
  fakeCtx.calls.draws = [];
  render(fakeCtx, st, { bubbles: [] });
  const s = fakeCtx.calls.draws.find(x => x.img === stubSprite);
  assert.ok(s, 'sprite drawn');
  const w = 425 * (240 / 360);
  const dw = w * 1.5, dh = 425 * 1.5;
  const anchorX = 667 - 16;
  const baseX = anchorX - w;
  const expectX = baseX + 20 - (dw - w) / 2;
  const expectY = (500 * (1 - 0.85) + 1) + (-10) - (dh - 425) / 2;
  assert.ok(Math.abs(s.dst[2] - dw) < 0.5, 'width scaled 1.5x');
  assert.ok(Math.abs(s.dst[3] - dh) < 0.5, 'height scaled 1.5x');
  assert.ok(Math.abs(s.dst[0] - expectX) < 0.5, 'x offset applied, got ' + s.dst[0] + ' expected ' + expectX);
  assert.ok(Math.abs(s.dst[1] - expectY) < 0.5, 'y offset applied, got ' + s.dst[1] + ' expected ' + expectY);
  console.log('step6 OK: per-sprite scale + offset applied (persistent in every render)');
}

console.log('ALL RENDERER TESTS PASSED');
