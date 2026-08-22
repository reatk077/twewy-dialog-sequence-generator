// Quick parser unit test (Node): node tools/test_parser.js
const { parse, indexLabels } = require('../js/parser.js');

const SCRIPT = `
// 黄昏便利店前
@title 相遇
@bg Event_BG_sh001_01.jpg
@shownames on

!actor alice = 爱丽丝 | left | front | sprites/{id}{expr}.png
!actor bravo = 布拉沃 | right | front | sprites/{id}{expr}.png
!actor chloe = 克洛伊 | right | back | sprites/{id}{expr}.png

alice: 嘿，你也是来找那家店的？
bravo{box=thought}: 什么店？我只是路过。
alice+chloe: 我们一起吧！
bravo{expr=2}: 喂喂，那边的人别跟来啊。
* 天空开始下雨了。
bravo(3){box=loud,flip=1}: 啧，烦死了！
++ alice{box=thought}: 要撑伞吗？ || bravo{box=default}: 不用。
? 答应他 -> yes
? 拒绝他 -> no
-> yes
@label yes
alice: 那好吧，一起走。
@label no
bravo: 哼，随便你。
-> end
@end
`;

const r = parse(SCRIPT);
console.log('settings:', JSON.stringify(r.settings, null, 0));
console.log('errors:', r.errors.length);
r.errors.forEach(e => console.log('  ERR line', e.line, e.msg, '|', e.raw));
console.log('ops:');
r.ops.forEach((op, i) => console.log(' ', i, JSON.stringify(op)));
const labels = indexLabels(r.ops);
console.log('labels:', JSON.stringify(labels));

// assertions
const assert = require('assert');
assert.strictEqual(r.errors.length, 0, 'no parse errors');
assert.strictEqual(r.ops.filter(o => o.op === 'speech').length, 9, '9 speech ops');
assert.strictEqual(r.ops.filter(o => o.op === 'choice').length, 1, '1 choice op');
assert.strictEqual(r.ops.find(o => o.op === 'choice').choices.length, 2, 'choice has 2 options');
assert.strictEqual(labels.yes, r.ops.findIndex(o => o.op === 'label' && o.name === 'yes'), 'label index');
const dual = r.ops.find(o => o.op === 'speech' && o.bubbles.length === 2);
assert.ok(dual, 'dual bubble line parsed');
assert.strictEqual(dual.bubbles[0].box, 'thought');
assert.strictEqual(dual.bubbles[1].box, 'default');
const multi = r.ops.find(o => o.op === 'speech' && o.bubbles[0].speakers.length === 2);
assert.ok(multi, 'multi-speaker bubble parsed');
const loud = r.ops.find(o => o.op === 'speech' && o.bubbles[0].box === 'loud');
assert.strictEqual(loud.bubbles[0].flip, true, 'flip=1 attr');
console.log('ALL PARSER TESTS PASSED');

// ---- document model round-trip ----
const { parseDocument, serializeEntries } = require('../js/parser.js');

// comments & blanks preserved
{
  const doc = parseDocument('// head\n\n@bg x.jpg\n!actor a = A | left | front | s.png\nalice: hi\n\n// tail\n-> end');
  assert.strictEqual(doc.entries[0].kind, 'comment', 'comment preserved');
  assert.strictEqual(doc.entries[1].kind, 'blank', 'blank preserved');
  assert.strictEqual(doc.entries[2].kind, 'directive', 'directive parsed');
  assert.strictEqual(doc.entries[2].key, 'bg');
  assert.strictEqual(doc.entries[5].kind, 'blank', 'trailing blank preserved');
  assert.strictEqual(doc.entries[6].kind, 'comment', 'tail comment preserved');
  console.log('doc1 OK: comments/blanks preserved');
}

// serialize -> parse round-trip is stable (ops identical)
{
  const script2 = [
    '// demo',
    '@title 相遇',
    '@bg Event_BG_sh001_01.jpg',
    '!actor alice = 爱丽丝 | left | front | sprites/{id}{expr}.png',
    '!actor bravo = 布拉沃 | right | front | sprites/{id}{expr}.png',
    '!actor chloe = 克洛伊 | right | back | sprites/{id}{expr}.png',
    '',
    'alice: 嘿，你好。',
    'bravo{box=thought,flip=1}: 你是谁？',
    'alice(2)+chloe{box=loud}: 我们一起！',
    '* 旁白文字。',
    '++ alice{box=thought}: 前句 || bravo: 后句',
    '? 选一 -> yes',
    '? 选二 -> no',
    '-> end',
    '@label yes',
    'alice: 好。',
    '-> end',
    '@end',
  ].join('\n');
  const p1 = parse(script2);
  assert.strictEqual(p1.errors.length, 0, 'no errors: ' + JSON.stringify(p1.errors));
  const text2 = serializeEntries(p1.entries);
  const p2 = parse(text2);
  assert.strictEqual(p2.errors.length, 0, 'reparse no errors: ' + JSON.stringify(p2.errors));
  assert.deepStrictEqual(p2.ops, p1.ops, 'ops identical after round-trip');
  assert.deepStrictEqual(p2.settings, p1.settings, 'settings identical after round-trip');
  console.log('doc2 OK: serialize->parse round-trip stable');
}

// entry -> op index mapping
{
  const parsed2 = parse('// c\n@bg x.jpg\na: one\n? o -> l\n@label l\nb: two\n@end');
  const speechIdx = parsed2.entries.findIndex(e => e.kind === 'speech');
  const commentIdx = parsed2.entries.findIndex(e => e.kind === 'comment');
  assert.strictEqual(parsed2.entries[speechIdx]._opIdx, 1, 'speech op index = 1');
  assert.strictEqual(parsed2.entries[commentIdx]._opIdx, null, 'comment has no op');
  console.log('doc3 OK: entry->_opIdx mapping');
}

// serialize an edited entry (WYSIWYG scenario)
{
  const parsed3 = parse('!actor a = A | left | front | s.png\na{box=default}: hi');
  const speech = parsed3.entries.find(e => e.kind === 'speech');
  speech.bubbles[0].box = 'wiggly';
  speech.bubbles[0].flip = false;
  speech.bubbles[0].speakers[0].expr = 3;
  speech.bubbles[0].text = 'edited';
  const out = serializeEntries(parsed3.entries);
  const reparsed = parse(out);
  assert.strictEqual(reparsed.errors.length, 0);
  const b = reparsed.ops.find(o => o.op === 'speech').bubbles[0];
  assert.strictEqual(b.box, 'wiggly');
  assert.strictEqual(b.flip, false);
  assert.strictEqual(b.speakers[0].expr, 3);
  assert.strictEqual(b.text, 'edited');
  console.log('doc4 OK: WYSIWYG-style edit round-trips, text =', JSON.stringify(out.split('\n')[1]));
}
// ---- actor flip mode ----
{
  const p = parse('!actor a = A | left | front | s.png | flip\n!actor b = B | right | front | s.png | noflip\n!actor c = C | left | front | s.png');
  const aOp = p.ops.find(o => o.op === 'actor' && o.id === 'a');
  const bOp = p.ops.find(o => o.op === 'actor' && o.id === 'b');
  const cOp = p.ops.find(o => o.op === 'actor' && o.id === 'c');
  assert.strictEqual(aOp.flipMode, true, 'flip token -> flipMode true');
  assert.strictEqual(bOp.flipMode, false, 'noflip token -> flipMode false');
  assert.strictEqual(cOp.flipMode, null, 'no token -> flipMode null');
  // round-trip keeps the tokens
  const text = serializeEntries(p.entries);
  assert.ok(text.includes('| flip'), 'flip token serialized');
  assert.ok(text.includes('| noflip'), 'noflip token serialized');
  assert.ok(!text.split('\n')[2].includes('| flip') && !text.split('\n')[2].includes('| noflip'), 'null flip not serialized');
  const p2 = parse(text);
  assert.strictEqual(p2.errors.length, 0);
  assert.strictEqual(p2.ops.find(o => o.op === 'actor' && o.id === 'a').flipMode, true, 'flip survives round-trip');
  assert.strictEqual(p2.ops.find(o => o.op === 'actor' && o.id === 'b').flipMode, false, 'noflip survives round-trip');
  console.log('doc5 OK: actor flip mode parses + serializes + round-trips');
}

// ---- actor default expression (expr=N) ----
{
  const p = parse('!actor a = A | left | front | sprites/{id}{expr}.png | expr=3\n!actor b = B | left | front | s.png');
  const aOp = p.ops.find(o => o.op === 'actor' && o.id === 'a');
  const bOp = p.ops.find(o => o.op === 'actor' && o.id === 'b');
  assert.strictEqual(aOp.expr, 3, 'expr=3 token parsed');
  assert.strictEqual(bOp.expr, null, 'no expr token -> null');
  const text = serializeEntries(p.entries);
  assert.ok(text.includes('| expr=3'), 'expr serialized');
  const p2 = parse(text);
  assert.strictEqual(p2.errors.length, 0);
  assert.strictEqual(p2.ops.find(o => o.op === 'actor' && o.id === 'a').expr, 3, 'expr survives round-trip');
  console.log('doc6 OK: actor default expr parses + serializes + round-trips');
}

// ---- audio directives & voice attr ----
{
  const p = parse('@bgm bgm://bgm1\n@sfx sfx://boom\na{voice=2}: 语音测试\n@bgm off');
  assert.strictEqual(p.errors.length, 0, JSON.stringify(p.errors));
  const bgmOn = p.ops.find(o => o.op === 'bgm' && o.path === 'bgm://bgm1');
  const bgmOff = p.ops.find(o => o.op === 'bgm' && o.path === null);
  const sfx = p.ops.find(o => o.op === 'sfx');
  const sp = p.ops.find(o => o.op === 'speech');
  assert.ok(bgmOn && bgmOff, 'bgm on/off ops');
  assert.ok(sfx && sfx.path === 'sfx://boom', 'sfx op');
  assert.strictEqual(sp.bubbles[0].voice, 2, 'voice attr parsed');
  const text = serializeEntries(p.entries);
  const p2 = parse(text);
  assert.strictEqual(p2.errors.length, 0);
  assert.strictEqual(p2.ops.find(o => o.op === 'speech').bubbles[0].voice, 2, 'voice survives round-trip');
  assert.ok(text.includes('@bgm bgm://bgm1') && text.includes('@bgm off'), 'bgm lines round-trip');
  assert.ok(text.includes('@sfx sfx://boom'), 'sfx line round-trips');
  console.log('doc7 OK: @bgm/@sfx + voice attr parse + serialize + round-trip');
}

// ---- empty @sfx / @label are no-ops (editor placeholder state) ----
{
  const p = parse('@sfx\n@label\na: hi\n@end');
  assert.strictEqual(p.errors.length, 0, 'empty @sfx/@label must not error: ' + JSON.stringify(p.errors));
  const sfxOp = p.ops.find(o => o.op === 'sfx');
  assert.ok(sfxOp && sfxOp.path === null, 'empty @sfx -> no-op op');
  assert.strictEqual(p.ops.filter(o => o.op === 'label').length, 0, 'empty @label emits no op');
  // round-trip: '@sfx' serializes and reparses cleanly
  const text = serializeEntries(p.entries);
  const p2 = parse(text);
  assert.strictEqual(p2.errors.length, 0, 'round-trip clean');
  console.log('doc8 OK: empty @sfx/@label tolerated as placeholders');
}

console.log('ALL DOCUMENT TESTS PASSED');
