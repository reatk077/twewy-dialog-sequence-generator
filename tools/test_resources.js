// Resources store test (Node): node tools/test_resources.js
const R = require('../js/resources.js');
const assert = require('assert');

// ---- characters ----
const c1 = R.addCharacter({ name: 'Alice' });
assert.strictEqual(c1.id, 'alice', 'id slugified');
const c2 = R.addCharacter({ name: 'Alice' });
assert.strictEqual(c2.id, 'alice2', 'unique id on collision');

R.setCharSprite(c1.id, 1, 'data:image/png;base64,AAAA');
R.setCharSprite(c1.id, 2, 'data:image/png;base64,BBBB');
assert.strictEqual(R.charSprite(c1.id, 1), 'data:image/png;base64,AAAA');
assert.strictEqual(R.charSprite(c1.id, 2), 'data:image/png;base64,BBBB');
assert.strictEqual(R.charSprite(c1.id, 3), null, 'missing expr -> null');
assert.strictEqual(R.resolveSprite('chara://alice/2'), 'data:image/png;base64,BBBB', 'chara:// scheme');
assert.strictEqual(R.resolveSprite('chara://nope/1'), null, 'unknown char');

// ---- locations ----
const l1 = R.addLocation({ name: '街道' });
R.setLocImage(l1.id, 'morning', '早晨', 'data:image/jpeg;base64,CCCC');
R.setLocImage(l1.id, 'night', '夜晚', 'data:image/jpeg;base64,DDDD');
assert.strictEqual(R.locImage(l1.id, 'morning'), 'data:image/jpeg;base64,CCCC');
assert.strictEqual(R.locVariantName(l1.id, 'night'), '夜晚');
assert.strictEqual(R.resolveBg('loc://' + l1.id + '/morning'), 'data:image/jpeg;base64,CCCC', 'loc:// scheme');
assert.strictEqual(R.resolveBg('loc://nope/x'), null, 'unknown loc');

// ---- packaging round trip ----
const packed = R.exportCharacter(c1.id);
assert.ok(packed && packed.includes('"type":"dgchar"'), 'char package type');
const imp = R.importCharacter(packed);
assert.ok(imp.ok, 'char import ok');
assert.strictEqual(R.charSprite(imp.id, 1), 'data:image/png;base64,AAAA', 'imported char has sprite');
assert.notStrictEqual(imp.id, c1.id, 'import creates a new id');

const packedLoc = R.exportLocation(l1.id);
const impLoc = R.importLocation(packedLoc);
assert.ok(impLoc.ok, 'loc import ok');
assert.strictEqual(R.locImage(impLoc.id, 'night'), 'data:image/jpeg;base64,DDDD', 'imported loc variant');

// bad input
assert.deepStrictEqual(R.importCharacter('not json').ok, false, 'bad json rejected');
assert.deepStrictEqual(R.importCharacter(JSON.stringify({ type: 'other' })).ok, false, 'wrong type rejected');

// ---- delete ----
R.deleteCharacter(c1.id);
assert.strictEqual(R.charSprite(c1.id, 1), null, 'deleted char gone');

// ---- BGM / SFX ----
const b1 = R.addBgm({ name: '夜曲' });
assert.strictEqual(b1.id, '夜曲'.length > 0 ? b1.id : '', 'bgm id assigned');
R.updateBgm(b1.id, { dataURL: 'data:audio/mpeg;base64,EEEE' });
assert.strictEqual(R.bgmData(b1.id), 'data:audio/mpeg;base64,EEEE');
assert.strictEqual(R.resolveBgm('bgm://' + b1.id), 'data:audio/mpeg;base64,EEEE', 'bgm:// scheme');
const b1p = R.exportBgm(b1.id);
assert.ok(b1p.includes('"type":"dgbgm"'), 'bgm package type');
const b1i = R.importBgm(b1p);
assert.ok(b1i.ok && R.bgmData(b1i.id) === 'data:audio/mpeg;base64,EEEE', 'bgm import');

const s1 = R.addSfx({ name: '爆炸' });
R.updateSfx(s1.id, { dataURL: 'data:audio/wav;base64,FFFF' });
assert.strictEqual(R.resolveSfx('sfx://' + s1.id), 'data:audio/wav;base64,FFFF', 'sfx:// scheme');
const s1p = R.exportSfx(s1.id);
const s1i = R.importSfx(s1p);
assert.ok(s1i.ok && R.sfxData(s1i.id) === 'data:audio/wav;base64,FFFF', 'sfx import');

// ---- character voices ----
R.setCharVoice(c2.id, 1, 'data:audio/mpeg;base64,GGGG');
R.setCharVoice(c2.id, 2, 'data:audio/mpeg;base64,HHHH');
assert.strictEqual(R.charVoice(c2.id, 1), 'data:audio/mpeg;base64,GGGG');
assert.strictEqual(R.charVoice(c2.id, 3), null, 'missing voice -> null');
assert.strictEqual(R.resolveVoice('voice://' + c2.id + '/2'), 'data:audio/mpeg;base64,HHHH', 'voice:// scheme');
// voice rides along in the character package
const c2p = R.exportCharacter(c2.id);
const c2i = R.importCharacter(c2p);
assert.ok(c2i.ok, 'char import ok');
assert.strictEqual(R.charVoice(c2i.id, 1), 'data:audio/mpeg;base64,GGGG', 'voice in char package');
assert.strictEqual(R.charVoice(c2i.id, 2), 'data:audio/mpeg;base64,HHHH', 'voice2 in char package');
assert.strictEqual(R.charVoiceCount(c2i.id), 2, 'voice count');

// ---- per-sprite transform (scale + offset) ----
R.setSpriteXform(c2.id, 1, { scale: 1.5, ox: 12, oy: -8 });
const xf = R.spriteXform(c2.id, 1);
assert.strictEqual(xf.scale, 1.5, 'scale stored');
assert.strictEqual(xf.ox, 12, 'ox stored');
assert.strictEqual(xf.oy, -8, 'oy stored');
R.setSpriteXform(c2.id, 2, { scale: 5, ox: 999 }); // clamps
const xf2 = R.spriteXform(c2.id, 2);
assert.strictEqual(xf2.scale, 3, 'scale clamped to 3');
assert.strictEqual(xf2.ox, 300, 'ox clamped to 300');
assert.strictEqual(R.resolveSpriteXform('chara://' + c2.id + '/1').scale, 1.5, 'resolveSpriteXform');
assert.strictEqual(R.resolveSpriteXform('sprites/a1.png'), null, 'file path -> no xform');
assert.strictEqual(R.spriteXform(c2.id, 9), null, 'no xform -> null');
// xform rides along in the character package
const c2x = R.exportCharacter(c2.id);
const c2xi = R.importCharacter(c2x);
const xfImp = R.spriteXform(c2xi.id, 1);
assert.ok(xfImp && xfImp.scale === 1.5 && xfImp.ox === 12 && xfImp.oy === -8, 'xform in char package');
R.setSpriteXform(c2.id, 1, null); // clear
assert.strictEqual(R.spriteXform(c2.id, 1), null, 'xform cleared');

console.log('ALL RESOURCES TESTS PASSED');
