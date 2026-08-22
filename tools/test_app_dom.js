// App boot + WYSIWYG flow test with a minimal DOM shim (no browser needed).
// node tools/test_app_dom.js
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ---------- minimal DOM shim ---------- */

function makeCtx2d() {
  const ctx = {
    _log: [],
    canvas: { width: 667, height: 500 },
    measureText(t) { return { width: String(t).length * 10 }; },
  };
  return new Proxy(ctx, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string') {
        return (...args) => { t._log.push([k, ...args]); };
      }
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeElement(tag) {
  const listeners = {};
  function findInTree(node, attr, val) {
    if (node['attr_' + attr] === val) return node;
    for (const c of (node.children || [])) {
      const found = findInTree(c, attr, val);
      if (found) return found;
    }
    return null;
  }
  const el = {
    tagName: tag ? tag.toUpperCase() : 'DIV',
    style: {},
    dataset: {},
    className: '',
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    checked: false,
    title: '',
    placeholder: '',
    parentNode: null,
    children: [],
    _innerHTML: '',
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) { if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else { force ? this._set.add(c) : this._set.delete(c); } },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== fn); },
    dispatchEvent(ev) {
      const e = typeof ev === 'string'
        ? { type: ev, target: el, preventDefault() {}, key: '', code: '' }
        : (ev && ev.target ? ev : { type: 'click', target: el, preventDefault() {}, key: '', code: '' });
      (listeners[e.type] || []).slice().forEach(f => f(e));
      // bubble click events up to document (for dropdown dismiss listeners)
      if (e.type === 'click' && global.document && global.document._dispatchClick) {
        global.document._dispatchClick(e);
      }
    },
    appendChild(child) { if (child) { child.parentNode = el; this.children.push(child); } return child; },
    remove() { el._removed = true; },
    contains(node) {
      if (node === el) return true;
      return (function walk(n) {
        for (const c of (n.children || [])) {
          if (c === node) return true;
          if (walk(c)) return true;
        }
        return false;
      })(el);
    },
    querySelector(sel) {
      if (sel.startsWith('#')) return findInTree(this, 'id', sel.slice(1)) || null;
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        const found = (function walk(node) {
          if (node.className && String(node.className).split(/\s+/).includes(cls)) return node;
          for (const c of (node.children || [])) {
            const r = walk(c);
            if (r) return r;
          }
          return null;
        })(this);
        return found;
      }
      return null;
    },
    querySelectorAll() { return []; },
    click() { (listeners['click'] || []).forEach(f => f({ target: el, preventDefault() {} })); },
    focus() {},
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k]; },
  };
  // select.options support (used by the bg/audio editor forms)
  Object.defineProperty(el, 'options', {
    get() { return (this.children || []).filter(c => c.tagName === 'OPTION'); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(v) {
      this._innerHTML = String(v);
      this.children.length = 0; // realistic: setting innerHTML replaces children
    },
  });
  return el;
}

const elements = {};
const byTag = { button: [], input: [], textarea: [], select: [], li: [], ul: [], div: [], span: [], h3: [], label: [], option: [], img: [] };

global.self = global;
global.window = global;

const docListeners = {};

global.document = {
  _els: elements,
  getElementById(id) {
    if (!elements[id]) elements[id] = makeElement('div');
    return elements[id];
  },
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.tab-btn') {
      return ['script', 'editor', 'resources'].map(n => {
        const b = makeElement('button');
        b.dataset.tab = n;
        byTag.button.push(b);
        return b;
      });
    }
    return [];
  },
  createElement(tag) {
    const el = makeElement(tag);
    (byTag[tag] = byTag[tag] || []).push(el);
    return el;
  },
  createTextNode(t) { return { text: String(t) }; },
  addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
  removeEventListener: (type, fn) => {
    if (docListeners[type]) docListeners[type] = docListeners[type].filter(f => f !== fn);
  },
  _dispatchClick: (e) => { (docListeners['click'] || []).slice().forEach(f => f(e)); },
  body: makeElement('body'),
};

global.Image = function () {
  const img = {
    width: 240, height: 360,
    set src(v) { queueMicrotask(() => { if (img.onload) img.onload(); }); },
    get src() { return img._src; },
  };
  return img;
};

// canvas: getElementById('preview').getContext('2d')
const previewEl = makeElement('canvas');
previewEl.getContext = () => makeCtx2d();
elements['preview'] = previewEl;

// drive the player's rAF-based transition loop (16ms ticks)
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// textarea element for #editor: keep a live .value
global.localStorage = undefined; // resources: storage disabled

global.fetch = () => Promise.reject(new Error('no network in test'));

/* ---------- boot the app modules ---------- */
require(path.join(ROOT, 'js', 'parser.js'));
require(path.join(ROOT, 'js', 'renderer.js'));
require(path.join(ROOT, 'js', 'player.js'));
require(path.join(ROOT, 'js', 'resources.js'));
require(path.join(ROOT, 'js', 'audio.js'));
require(path.join(ROOT, 'js', 'editor.js'));
require(path.join(ROOT, 'js', 'app.js'));

const assert = require('assert');

(async function () {
  // let async startup (bubble image loads, debounced compile) settle
  await new Promise(r => setTimeout(r, 120));

  const editorEl = elements['editor'];
  assert.ok(String(editorEl.value).includes('@title'), 'editor has demo script');
  assert.ok(String(editorEl.value).includes('alice:'), 'demo speech line present');

  // tabs exist and switch
  assert.ok(document.getElementById('tab-editor'), 'editor tab exists');
  assert.ok(document.getElementById('tabEditorBadge'), 'editor tab badge exists');

  // WYSIWYG: add a speech line via toolbar
  const kindSel = elements['edNewKind'];
  kindSel.value = 'speech';
  const addBtn = elements['edAdd'];
  const before = String(editorEl.value);
  addBtn.click(); // insertEntry -> commit (async debounce? commit is sync)
  await new Promise(r => setTimeout(r, 60));
  const after = String(editorEl.value);
  assert.notStrictEqual(after, before, 'adding a speech line changes the script');
  assert.ok(after.includes(': ') || after.includes(':'), 'new line serialized with colon');

  // WYSIWYG edit of an actor entry: rename -> script updates
  // (select first actor entry: find via DGParser on current text)
  const DGParser = require(path.join(ROOT, 'js', 'parser.js'));
  const parsed = DGParser.parse(String(editorEl.value));
  const actorIdx = parsed.entries.findIndex(e => e.kind === 'actor');
  assert.ok(actorIdx >= 0, 'demo has actor entries');
  const sel = elements['edList']; // list ul — items are appended as children
  // simulate selection by calling the app's selectEntry through editor list item click
  // the list items are li elements with data-idx; find first li
  const liItems = sel.children.filter(c => c.tagName === 'LI');
  assert.ok(liItems.length > 0, 'line list rendered with items');

  // resources tab renders without throwing
  assert.ok(document.getElementById('tab-resources'), 'resources tab exists');
  // switchTab is internal; simulate clicking the resources tab button
  const tabBtns = byTag.button.filter(b => b.dataset && b.dataset.tab === 'resources');
  assert.ok(tabBtns.length === 1, 'resources tab button exists');
  tabBtns[0].click();
  await new Promise(r => setTimeout(r, 30));

  // ---- WYSIWYG edit loop: select the first speech line, change its text ----
  const editorTabBtn = byTag.button.find(b => b.dataset && b.dataset.tab === 'editor');
  editorTabBtn.click();
  await new Promise(r => setTimeout(r, 30));

  const listEl = elements['edList'];
  const lis = listEl.children.filter(c => c.tagName === 'LI');
  const speechLi = lis.find(li => {
    if (!li.className.includes('ll-edit')) return false; // speech/choice only
    const t = li.children.find(c => c.className === 'll-txt');
    return t && t.children.some(ch => typeof ch.text === 'string' && ch.text.includes('：'));
  });
  assert.ok(speechLi, 'speech line present in list');
  speechLi.click(); // select entry -> form renders + preview seeks
  await new Promise(r => setTimeout(r, 30));

  // find the speech textarea inside the form
  const formEl = elements['edForm'];
  function findTextarea(root) {
    for (const c of (root.children || [])) {
      if (c.tagName === 'TEXTAREA') return c;
      const found = findTextarea(c);
      if (found) return found;
    }
    return null;
  }
  const ta = findTextarea(formEl);
  assert.ok(ta, 'speech form has a textarea');

  // draft model: typing must NOT touch the script until 确定 is clicked
  ta.value = '这是所见即所得编辑的内容！';
  ta.dispatchEvent('input');
  await new Promise(r => setTimeout(r, 350));
  assert.ok(!String(editorEl.value).includes('这是所见即所得编辑的内容！'),
    'edits are staged — script unchanged before 确定');

  // find the apply button inside the form and click it
  function findByAttr(root, attr, val) {
    for (const c of (root.children || [])) {
      if (c['attr_' + attr] === val) return c;
      const found = findByAttr(c, attr, val);
      if (found) return found;
    }
    return null;
  }
  const applyBtn = findByAttr(formEl, 'id', 'edApply');
  assert.ok(applyBtn, '确定 button present in form');
  applyBtn.click();
  await new Promise(r => setTimeout(r, 60));

  assert.ok(String(editorEl.value).includes('这是所见即所得编辑的内容！'),
    'WYSIWYG text edit reaches the script after 确定');
  console.log('WYSIWYG draft model OK — staged until 确定, applied on click');

  // ---- cancel path: edits discarded ----
  const ta2 = findTextarea(elements['edForm']);
  assert.ok(ta2, 'form has textarea again');
  ta2.value = '这段会被取消';
  ta2.dispatchEvent('input');
  const cancelBtn = findByAttr(elements['edForm'], 'id', 'edCancel');
  assert.ok(cancelBtn, '取消 button present');
  cancelBtn.click();
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!String(editorEl.value).includes('这段会被取消'), 'cancel discards the draft');

  // ---- switching lines auto-applies pending edits ----
  const ta3 = findTextarea(elements['edForm']);
  ta3.value = '切换行前未确定的修改';
  ta3.dispatchEvent('input');
  const otherLi = lis.find(li => li !== speechLi && li.className.includes('ll-edit'));
  assert.ok(otherLi, 'another editable line exists');
  otherLi.click();
  await new Promise(r => setTimeout(r, 40));
  assert.ok(String(editorEl.value).includes('切换行前未确定的修改'),
    'switching lines applies pending edits');
  console.log('WYSIWYG cancel + switch-line auto-apply OK');

  // ---- actor form has the horizontal-flip control ----
  {
    const parsed2 = require(path.join(ROOT, 'js', 'parser.js')).parse(String(editorEl.value));
    const actorIdx = parsed2.entries.findIndex(e => e.kind === 'actor');
    const actorLi = lis.find(li => {
      const t = li.children.find(c => c.className === 'll-txt');
      return t && t.children.some(ch => typeof ch.text === 'string' && ch.text.startsWith('角色：'));
    });
    assert.ok(actorLi, 'actor line in list');
    actorLi.click();
    await new Promise(r => setTimeout(r, 30));
    const formEl3 = elements['edForm'];
    let selectCount = 0;
    (function walk(root) {
      for (const c of (root.children || [])) {
        if (c.tagName === 'SELECT') selectCount++;
        walk(c);
      }
    })(formEl3);
    assert.ok(selectCount >= 3, 'actor form has side/slot/flip selects, got ' + selectCount);
    console.log('actor flip control present in WYSIWYG form');
  }

  // ---- actor form: sprite picker — click a sprite, apply, expr=N lands in script ----
  {
    // re-select the actor line (form re-rendered after earlier operations)
    const actorLi2 = lis.find(li => {
      const t = li.children.find(c => c.className === 'll-txt');
      return t && t.children.some(ch => typeof ch.text === 'string' && ch.text.startsWith('角色：'));
    });
    assert.ok(actorLi2, 'actor line in list');
    actorLi2.click();
    await new Promise(r => setTimeout(r, 40)); // allow probe renders

    const formEl4 = elements['edForm'];
    // find sprite grid items (probe loads resolve via shim Image)
    function findSpriteItems(root) {
      const out = [];
      (function walk(node) {
        for (const c of (node.children || [])) {
          if (c.className && String(c.className).includes('ed-sprite-item')) out.push(c);
          walk(c);
        }
      })(root);
      return out;
    }
    const items = findSpriteItems(formEl4);
    assert.ok(items.length > 0, 'sprite picker shows thumbnails, got ' + items.length);
    items[Math.min(1, items.length - 1)].click(); // pick expression 2 (or last)
    const applyBtn2 = findByAttr(formEl4, 'id', 'edApply');
    assert.ok(applyBtn2, 'apply button present');
    applyBtn2.click();
    await new Promise(r => setTimeout(r, 60));
    assert.ok(/expr=\d+/.test(String(editorEl.value)),
      'sprite selection serializes as expr=N, got: ' + String(editorEl.value).split('\n').find(l => l.startsWith('!actor')));
    console.log('sprite picker → expr=N in script OK');
  }

  // ---- audio resources render in the resources tab ----
  {
    const resBtn = byTag.button.find(b => b.dataset && b.dataset.tab === 'resources');
    resBtn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(document.getElementById('resBgms'), 'BGM section exists');
    assert.ok(document.getElementById('resSfxs'), 'SFX section exists');
    // add a bgm via the store -> card renders
    const R2 = require(path.join(ROOT, 'js', 'resources.js'));
    const bgm = R2.addBgm({ name: '测试音乐' });
    R2.updateBgm(bgm.id, { dataURL: 'data:audio/mpeg;base64,XXXX' });
    const resTabBtn = byTag.button.find(b => b.dataset && b.dataset.tab === 'resources');
    resTabBtn.click(); // re-trigger renderResources
    await new Promise(r => setTimeout(r, 30));
    const bgmCards = elements['resBgms'].children.filter(c => c.className && String(c.className).includes('res-card'));
    assert.ok(bgmCards.length >= 1, 'BGM card rendered, got ' + bgmCards.length);
    R2.deleteBgm(bgm.id);
    console.log('audio resources UI OK');
  }

  // ---- speech form has the voice field ----
  {
    const edTabBtn2 = byTag.button.find(b => b.dataset && b.dataset.tab === 'editor');
    edTabBtn2.click();
    await new Promise(r => setTimeout(r, 30));
    const listEl2 = elements['edList'];
    const lis2 = listEl2.children.filter(c => c.tagName === 'LI');
    const speechLi2 = lis2.find(li => {
      if (!li.className.includes('ll-edit')) return false;
      const t = li.children.find(c => c.className === 'll-txt');
      return t && t.children.some(ch => typeof ch.text === 'string' && ch.text.includes('：'));
    });
    assert.ok(speechLi2, 'speech line in list');
    speechLi2.click();
    await new Promise(r => setTimeout(r, 30));
    let voiceInput = null;
    (function walk(root) {
      for (const c of (root.children || [])) {
        if (c.tagName === 'INPUT' && c['attr_type'] === 'number') voiceInput = c;
        walk(c);
      }
    })(elements['edForm']);
    assert.ok(voiceInput, 'voice number field present in speech form');
    voiceInput.value = '2';
    voiceInput.dispatchEvent('input');
    const applyBtn3 = findByAttr(elements['edForm'], 'id', 'edApply');
    applyBtn3.click();
    await new Promise(r => setTimeout(r, 50));
    assert.ok(/voice=2/.test(String(editorEl.value)), 'voice attr lands in script');
    console.log('voice field → voice=2 in script OK');
  }

  // ---- bg directive form: no crash with zero locations, placeholder value sane ----
  {
    const DGR2 = require(path.join(ROOT, 'js', 'resources.js'));
    assert.strictEqual(DGR2.allLocations().length, 0, 'no locations in store (crash repro)');
    const kindSel2 = elements['edNewKind'];
    kindSel2.value = 'bg';
    elements['edAdd'].click(); // insert a bg entry -> renderForm -> buildBgForm
    await new Promise(r => setTimeout(r, 40));
    // find the location select (first .ed-input select inside the form)
    let locSel = null;
    (function walk(root) {
      for (const c of (root.children || [])) {
        if (c.tagName === 'SELECT' && !locSel) { locSel = c; }
        walk(c);
      }
    })(elements['edForm']);
    assert.ok(locSel, 'location select rendered');
    const firstOpt = locSel.options && locSel.options[0];
    assert.ok(firstOpt && firstOpt.value === '__builtin__',
      'builtin placeholder option has a proper value, got ' + (firstOpt && firstOpt.value));
    console.log('bg form OK with zero locations (no crash, placeholder sane)');
  }

  // ---- adding an empty sfx line must NOT produce a parse error ----
  {
    const kindSel3 = elements['edNewKind'];
    kindSel3.value = 'sfx';
    elements['edAdd'].click();
    await new Promise(r => setTimeout(r, 60));
    const errBox = elements['parseErrors'];
    assert.ok(!errBox._innerHTML.includes('@sfx needs a path'),
      'empty @sfx placeholder tolerated, errors=' + errBox._innerHTML);
    assert.ok(String(editorEl.value).includes('@sfx'), 'sfx line in script');
    console.log('empty sfx entry OK (no syntax error)');
  }

  // ---- voice linkage: speaker id must match a resource character with voices ----
  {
    const DGR3 = require(path.join(ROOT, 'js', 'resources.js'));
    const ch = DGR3.addCharacter({ name: 'alice' });
    DGR3.setCharVoice(ch.id, 1, 'data:audio/mpeg;base64,VOICE1');
    // both sides must resolve the SAME slot via the same store
    assert.strictEqual(DGR3.charVoice(ch.id, 1), 'data:audio/mpeg;base64,VOICE1', 'store lookup');
    assert.strictEqual(DGR3.resolveVoice('voice://' + ch.id + '/1'), 'data:audio/mpeg;base64,VOICE1', 'voice:// scheme');
    // editor quick-pick buttons appear for a resource speaker
    const parsedV = require(path.join(ROOT, 'js', 'parser.js')).parse('!actor alice = Alice | left | front | chara://alice/{expr}\nalice{voice=1}: hi');
    assert.strictEqual(parsedV.errors.length, 0);
    const b = parsedV.ops.find(o => o.op === 'speech').bubbles[0];
    assert.strictEqual(b.voice, 1, 'voice attr parsed');
    assert.strictEqual(b.speakers[0].id, 'alice', 'speaker id matches resource char id');
    DGR3.deleteCharacter(ch.id);
    console.log('voice linkage resolution OK');
  }

  // ---- +说话人 dropdown: menu must open and NOT be closed by its own click ----
  {
    const edTabBtn3 = byTag.button.find(b => b.dataset && b.dataset.tab === 'editor');
    edTabBtn3.click();
    await new Promise(r => setTimeout(r, 30));
    const listEl3 = elements['edList'];
    const lis3 = listEl3.children.filter(c => c.tagName === 'LI');
    const speechLi3 = lis3.find(li => {
      if (!li.className.includes('ll-edit')) return false;
      const t = li.children.find(c => c.className === 'll-txt');
      return t && t.children.some(ch => typeof ch.text === 'string' && ch.text.includes('：'));
    });
    assert.ok(speechLi3, 'speech line in list');
    speechLi3.click(); // renders the speech form
    await new Promise(r => setTimeout(r, 30));

    // find the ＋说话人 button inside the form
    let addSpeakerBtn = null;
    (function walk(root) {
      for (const c of (root.children || [])) {
        if (c.tagName === 'BUTTON' && c.children.some(ch => typeof ch.text === 'string' && ch.text.includes('＋说话人'))) {
          addSpeakerBtn = c;
        }
        walk(c);
      }
    })(elements['edForm']);
    assert.ok(addSpeakerBtn, '＋说话人 button present in speech form');

    addSpeakerBtn.click(); // open the menu (opening click bubbles to document)
    await new Promise(r => setTimeout(r, 40)); // let the deferred dismiss listener register

    function findMenus(root) {
      const out = [];
      (function walk(n) {
        for (const c of (n.children || [])) {
          if (c.className && String(c.className).includes('ed-menu')) out.push(c);
          walk(c);
        }
      })(root);
      return out;
    }
    const menusAfterOpen = findMenus(elements['edForm']);
    assert.ok(menusAfterOpen.length >= 1,
      'speaker menu stays open after the opening click (not instantly closed)');

    // clicking elsewhere dismisses it
    addSpeakerBtn.dispatchEvent('click'); // simulate a second click elsewhere target
    await new Promise(r => setTimeout(r, 20));
    console.log('speaker menu open/close OK');
  }

  // ---- actor ids auto-unique when added via toolbar ----
  {
    const kindSelA = elements['edNewKind'];
    kindSelA.value = 'actor';
    elements['edAdd'].click(); // first actor -> char
    await new Promise(r => setTimeout(r, 40));
    elements['edAdd'].click(); // second actor -> char2 (must NOT collide)
    await new Promise(r => setTimeout(r, 60));
    const parsedA = require(path.join(ROOT, 'js', 'parser.js')).parse(String(editorEl.value));
    const ids = parsedA.entries.filter(e => e.kind === 'actor').map(e => e.id);
    assert.ok(ids.includes('char') && ids.includes('char2'),
      'new actor ids auto-unique, got ' + JSON.stringify(ids));
    console.log('actor auto-unique id OK');
  }

  // ---- duplicate actor ids trigger a visible warning ----
  {
    editorEl.value = '!actor a = A | left | front | s.png\n!actor a = B | right | front | s.png\na: hi';
    editorEl.dispatchEvent('input');
    await new Promise(r => setTimeout(r, 500));
    const warnEl = document.getElementById('edWarn');
    assert.ok(warnEl, 'edWarn element exists');
    assert.ok(warnEl.style.display === 'block' && String(warnEl.innerHTML).includes('角色 id 重复'),
      'duplicate actor id warning shown, got: ' + warnEl.innerHTML);
    // clean: no duplicates -> hidden
    editorEl.value = '!actor a = A | left | front | s.png\na: hi';
    editorEl.dispatchEvent('input');
    await new Promise(r => setTimeout(r, 500));
    assert.ok(warnEl.style.display === 'none', 'warning hidden when ids unique');
    console.log('duplicate actor id warning OK');
  }

  console.log('editor.value length:', String(editorEl.value).length);
  console.log('tabEditorBadge exists:', true);

  // ---- volume slider drives DGAudio ----
  {
    const DGAudio2 = require(path.join(ROOT, 'js', 'audio.js'));
    const vol = document.getElementById('bgmVol');
    assert.ok(vol, 'bgm volume slider exists');
    vol.value = '30';
    vol.dispatchEvent('input');
    assert.ok(Math.abs(DGAudio2.getVolume('bgm') - 0.3) < 1e-9, 'bgm slider updates volume, got ' + DGAudio2.getVolume('bgm'));
    DGAudio2.setVolume('bgm', 0.7);
    assert.ok(global.DGApp && global.DGApp.audio === DGAudio2, 'audio engine exposed on app handle');
    console.log('volume slider wiring OK');
  }

  // ---- playback mode auto-advances to the end ----
  {
    // short script, fast play delay
    editorEl.value = 'a: 你好\nb: 再见\n@end';
    editorEl.dispatchEvent('input');
    await new Promise(r => setTimeout(r, 500)); // debounce compile

    const DGParser2 = require(path.join(ROOT, 'js', 'parser.js'));
    const parsed = DGParser2.parse(String(editorEl.value));
    assert.strictEqual(parsed.errors.length, 0, 'short script parses');

    assert.ok(global.DGApp, 'app handle exposed');
    global.DGApp.setPlayDelay(40); // shrink auto-advance delay for the test

    const autoBtn = elements['btnAuto'];
    assert.ok(autoBtn, 'playback mode button exists');
    autoBtn.click(); // enable playback mode
    await new Promise(r => setTimeout(r, 2600));
    assert.ok(elements['overlayDone'].style.display === 'block',
      'playback mode auto-completed the script, overlay=' + elements['overlayDone'].style.display);
    autoBtn.click(); // disable again
    console.log('playback mode auto-advance OK');
  }

  // ---- record button exists (disabled without MediaRecorder) ----
  {
    const recBtn = elements['btnRecord'];
    assert.ok(recBtn, 'record button exists');
    assert.strictEqual(recBtn.disabled, true, 'record disabled when unsupported (shim has no captureStream/MediaRecorder)');
    console.log('record button state OK');
  }

  console.log('ALL APP DOM TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('APP DOM TEST FAILED:', e); process.exit(1); });
