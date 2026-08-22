/* app.js — Application glue for the Dialogue Generator.
 * Tabs: 脚本 (script textarea) / 编辑器 (WYSIWYG line editor) / 资源 (characters & locations).
 * Provides the `app` interface consumed by js/editor.js, wires player + renderer,
 * resolves resource schemes (chara://, loc://) in image loaders, and renders
 * the resources tab (upload / edit / package / import).
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const DPR = (window.devicePixelRatio || 1);

  /* ---------------- constants ---------------- */

  const SHIPPED_BGS = [
    'Event_BG_ce001_00.jpg', 'Event_BG_ce001_01_a05.jpg', 'Event_BG_ce003_01.jpg',
    'Event_BG_ce004_01.jpg', 'Event_BG_ea001_01.jpg', 'Event_BG_ev001_01.jpg',
    'Event_BG_ev005_01.jpg', 'Event_BG_ex001_01.jpg', 'Event_BG_ex106_01.jpg',
    'Event_BG_ex415.jpg', 'Event_BG_mk001_01.jpg', 'Event_BG_no001_01.jpg',
    'Event_BG_no006_01.jpg', 'Event_BG_sh001_01.jpg', 'Event_BG_sh005_01.jpg',
    'Event_BG_sh010_01.jpg', 'Event_BG_sh015_01.jpg', 'Event_BG_so001_01.jpg',
    'Event_BG_we001_01.jpg', 'Event_BG_we004_01.jpg',
  ];

  const DEMO_SCRIPT = [
    '// 对话生成器演示脚本',
    '// 语法见 README.md。把 assets/sprites/ 下的占位图换成你自己的立绘即可。',
    '',
    '@title 雨夜的便利店',
    '@bg Event_BG_sh001_01.jpg',
    '@shownames on',
    '@speed 30',
    '',
    '!actor alice = 爱丽丝 | left | front | sprites/{id}{expr}.png',
    '!actor bravo = 布拉沃 | right | front | sprites/{id}{expr}.png',
    '!actor chloe = 克洛伊 | right | back | sprites/{id}{expr}.png',
    '',
    'alice: 嘿，你也是来找那家便利店的？',
    'bravo{box=thought}: 什么店？我只是路过躲雨。',
    'alice{expr=2}: 哦——那正好，两个人一起跑过去吧。',
    'chloe: 等等，还有我呢！',
    'alice+chloe{box=default}: 我们俩一起陪你。',
    'bravo{expr=3,box=loud}: 喂！三个人的话雨伞可不够啊！',
    '* 雨越下越大了……',
    'alice{box=thought}: 那，分你一半伞？',
    'bravo: ……哼，谢了。',
    '++ alice{box=thought}: 走啦走啦。 || bravo{box=default}: 别催别催。',
    '? 递出雨伞 -> yes',
    '? 自己先跑 -> no',
    '-> end',
    '',
    '@label yes',
    'alice{expr=1}: 喏，拿着。',
    'bravo{expr=2}: 没想到你还挺仗义的。',
    'alice: 那当然！',
    '-> end',
    '',
    '@label no',
    'alice{expr=3}: 我先走一步啦！',
    'bravo: 喂——！真是的……',
    '-> end',
    '',
    '@end',
  ].join('\n');

  /* ---------------- resources store ---------------- */

  DGResources.load();
  DGResources.setQuotaWarning((e) => toast('⚠ 资源保存失败（存储空间不足）：' + e));

  /* ---------------- image loading ---------------- */

  const imgCache = new Map();

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      if (imgCache.has(src)) return resolve(imgCache.get(src));
      const img = new Image();
      img.onload = () => { imgCache.set(src, img); resolve(img); };
      img.onerror = () => reject(new Error('load failed: ' + src));
      img.src = src;
    });
  }

  function loadImageCascade(candidates) {
    if (!candidates.length) return Promise.reject(new Error('no candidates'));
    return loadImage(candidates[0]).catch(() => loadImageCascade(candidates.slice(1)));
  }

  function resolveBgPath(p) {
    if (/^(https?:|data:|blob:)/.test(p)) return [p];
    if (p.indexOf('/') !== -1) return [p, 'assets/' + p];
    return ['assets/bg/' + p, p];
  }

  function resolveSpritePath(p) {
    if (/^(https?:|data:|blob:)/.test(p)) return [p];
    if (p.startsWith('assets/')) return [p];
    // prefer the assets/ location first (kills the sprites/x.png -> assets/sprites/x.png
    // double-request 404 noise); the raw path is kept as a fallback
    return ['assets/' + p, p];
  }

  function warmupFont() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('20px "FOT-NewCezanne-Pro"'),
      document.fonts.load('16px "FOT-NewCezanne-Pro"'),
    ]).catch(() => {});
  }

  /* ---------------- player ---------------- */

  const canvas = $('#preview');
  canvas.width = Math.round(DGRenderer.W * DPR);
  canvas.height = Math.round(DGRenderer.H * DPR);
  const pctx = canvas.getContext('2d');

  const player = DGPlayer.create({
    onRender(state, display, ctx, isExport, transition) {
      if (isExport) {
        DGRenderer.render(ctx, state, display);
        return;
      }
      pctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      DGRenderer.render(pctx, state, display, transition);
      // mirror every frame into the recording canvas (2x) when recording
      if (recCtx) {
        recCtx.setTransform(REC_SCALE, 0, 0, REC_SCALE, 0, 0);
        DGRenderer.render(recCtx, state, display, transition);
      }
    },
    onChange(info) { updateUI(info); },
    onError(msg) { toast(msg); },
  });

  function bgLoader(path, cb) {
    const res = DGResources.resolveBg(path);
    if (res) { loadImage(res).then(cb).catch(() => cb(null)); return; }
    loadImageCascade(resolveBgPath(path)).then(cb).catch(() => cb(null));
  }

  function spriteLoader(path, cb) {
    const xform = DGResources.resolveSpriteXform(path);
    const res = DGResources.resolveSprite(path);
    if (res) { loadImage(res).then(img => cb(img, xform)).catch(() => cb(null, xform)); return; }
    loadImageCascade(resolveSpritePath(path)).then(img => cb(img, undefined)).catch(() => cb(null, undefined));
  }

  player.setLoaders(bgLoader, spriteLoader);

  /* ---------------- audio ---------------- */

  // throttled toast so repeated replays (seek/restart) don't spam
  let lastAudioWarn = 0;
  function audioWarn(msg) {
    console.warn('[audio]', msg);
    const now = Date.now();
    if (now - lastAudioWarn > 8000) {
      lastAudioWarn = now;
      toast(msg);
    }
  }

  // scheme pattern: bgm://  sfx://  loc://  chara://  voice:// …
  const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

  function resolveAudio(url, kind, schemeResolver) {
    const res = schemeResolver(url);
    if (res) return res;
    if (SCHEME_RE.test(url)) {
      audioWarn('音频资源未找到：' + url + '（请到"资源"页确认已上传音频）');
      return null;
    }
    return url; // plain file path — let the engine fetch it
  }

  player.setAudioHooks({
    playBgm(path) {
      const url = resolveAudio(path, 'bgm', DGResources.resolveBgm);
      if (url) DGAudio.playBgm(url);
    },
    stopBgm() { DGAudio.stopBgm(); },
    playSfx(path) {
      const url = resolveAudio(path, 'sfx', DGResources.resolveSfx);
      if (url) DGAudio.playSfx(url);
    },
    playVoice(actorId, n) {
      const url = DGResources.charVoice(actorId, n);
      if (url) DGAudio.playVoice(url);
      else audioWarn('角色 ' + actorId + ' 没有第 ' + n + ' 号语音');
    },
  });

  // volume sliders
  [['bgm', 'bgmVol'], ['sfx', 'sfxVol'], ['voice', 'voiceVol']].forEach(([kind, id]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = Math.round(DGAudio.getVolume(kind) * 100);
    el.addEventListener('input', () => DGAudio.setVolume(kind, Number(el.value) / 100));
  });

  let bubbleImgs = null;
  Promise.all(
    ['default', 'thought', 'wiggly', 'loud'].map(n =>
      loadImage('assets/bubbles/' + n + '.png'))
  ).then((imgs) => {
    bubbleImgs = { default: imgs[0], thought: imgs[1], wiggly: imgs[2], loud: imgs[3] };
    if (player.state) player.state.bubbles = bubbleImgs;
  }).catch((e) => toast('bubble assets failed to load: ' + e.message));

  /* ---------------- app interface (consumed by editor.js) ---------------- */

  const app = {
    entries: [],
    selectedIdx: -1,
    parsed: null,
    resources: DGResources,
    bubbleImgs: null,
    builtinBgs: SHIPPED_BGS,
    player: null,
    editor: null,
    toast,
    commit,
    selectEntry,
    actorOptions,
    ensureActorEntry,
    allChars: DGResources.allCharacters,
    allLocs: DGResources.allLocations,
    loadSprite: (path, cb) => spriteLoader(path, cb), // used by the editor's sprite picker
  };
  app.player = player;

  // preview helpers used by the editor forms
  app.previewVoice = (charId, n) => {
    const url = DGResources.charVoice(charId, n);
    if (url) DGAudio.playVoice(url);
    else toast('该角色没有第 ' + n + ' 号语音');
  };
  app.previewBgm = (id) => {
    const url = DGResources.bgmData(id);
    if (url) DGAudio.playBgm(url);
    else toast('该音乐还没有上传音频文件');
  };
  app.previewSfx = (id) => {
    const url = DGResources.sfxData(id);
    if (url) DGAudio.playSfx(url);
    else toast('该音效还没有上传音频文件');
  };

  function actorOptions() {
    const out = [];
    app.entries.forEach(e => {
      if (e.kind === 'actor') out.push({ id: e.id, name: e.name, side: e.side, slot: e.slot, pattern: e.pattern, fromResource: false });
    });
    DGResources.allCharacters().forEach(c => {
      if (!out.some(x => x.id === c.id)) {
        out.push({ id: c.id, name: c.name, side: c.defaultSide, slot: 0, pattern: 'chara://' + c.id + '/{expr}', fromResource: true });
      }
    });
    return out;
  }

  function ensureActorEntry(id) {
    // legacy helper (kept for interface compat); the editor auto-inserts
    // actor declarations on apply instead. Returns existing or a new entry.
    const existing = app.entries.find(e => e.kind === 'actor' && e.id === id);
    if (existing) return existing;
    const c = DGResources.getCharacter(id);
    return {
      kind: 'actor',
      id,
      name: c ? c.name : id,
      side: c ? c.defaultSide : 'left',
      slot: 0,
      pattern: c ? 'chara://' + id + '/{expr}' : 'sprites/{id}{expr}.png',
      lineNo: 0,
    };
  }

  /* ---------------- compile / commit / selection ---------------- */

  let parseTimer = null;

  function compileScript(keepSelection) {
    const text = $('#editor').value;
    const parsed = DGParser.parse(text);
    app.parsed = parsed;
    app.entries = parsed.entries;
    if (!keepSelection) app.selectedIdx = -1;
    else if (app.selectedIdx >= app.entries.length) app.selectedIdx = app.entries.length - 1;
    showParseErrors(parsed.errors);
    if (!parsed.errors.length) {
      player.load(parsed);
      if (bubbleImgs) player.state.bubbles = bubbleImgs;
      player.restart();
    }
    app.bubbleImgs = bubbleImgs;
    if (app.editor) app.editor.refresh();
    updateTabBadge();
  }

  // WYSIWYG edit: entries -> script text -> recompile -> preview the edited line
  function commit() {
    const text = DGParser.serializeEntries(app.entries);
    $('#editor').value = text;
    compileScript(true);
    seekPreview();
  }

  function seekPreview() {
    const e = app.entries[app.selectedIdx];
    if (!e || e._opIdx == null) return;
    player.seekTo(e._opIdx);
    if (player.typing) player.next(); // complete text instantly
  }

  function selectEntry(i) {
    if (i >= 0 && i < app.entries.length) {
      // commit any pending WYSIWYG edits before leaving the line
      if (app.editor && app.editor.hasPending()) app.editor.applyPending();
      app.selectedIdx = i;
      if (app.editor) app.editor.refresh();
      seekPreview();
    }
  }

  function toast(msg) {
    const box = $('#toast');
    box.textContent = msg;
    box.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { box.style.display = 'none'; }, 2600);
  }

  $('#editor').addEventListener('input', () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => compileScript(false), 300);
  });

  $('#btnLoadSample').addEventListener('click', () => {
    $('#editor').value = state.script;
    compileScript(false);
  });

  /* ---------------- tabs ---------------- */

  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    ['script', 'editor', 'resources'].forEach(n => {
      const p = document.getElementById('tab-' + n);
      if (p) p.style.display = n === name ? 'block' : 'none';
    });
    if (name === 'editor' && app.editor) { app.editor.refresh(); seekPreview(); }
    if (name === 'resources') renderResources();
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function updateTabBadge() {
    const n = app.parsed ? app.parsed.errors.length : 0;
    const badge = $('#tabEditorBadge');
    if (badge) { badge.textContent = n ? '⚠' : ''; badge.style.display = n ? 'inline' : 'none'; }
  }

  /* ---------------- editor init ---------------- */

  const editor = DGEditor.create(app);
  app.editor = editor;

  /* ---------------- resources tab ---------------- */

  const resCharsEl = $('#resChars');
  const resLocsEl = $('#resLocs');

  function renderResources() {
    renderChars();
    renderLocs();
    renderBgms();
    renderSfxs();
  }

  // read an audio file into a dataURL (no compression — audio kept as-is)
  function readAudioAsDataURL(file, cb) {
    const r = new FileReader();
    r.onload = () => cb(String(r.result));
    r.onerror = () => { cb(null); toast('音频读取失败'); };
    r.readAsDataURL(file);
  }

  // read a file into an Image, then convert to dataURL (scaled, compressed)
  function readImageAsDataURL(file, type, quality, maxW, cb) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      const m = maxW || 1200;
      if (w > m) { h = Math.round(h * m / w); w = m; }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(c.toDataURL(type || 'image/png', quality === undefined ? 0.85 : quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); cb(null); toast('图片读取失败'); };
    img.src = url;
  }

  function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  function fileInput(onFile) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (f) onFile(f);
      inp.value = '';
      inp.remove();
    });
    document.body.appendChild(inp);
    return inp;
  }

  function makeThumb(dataURL, alt) {
    const img = document.createElement('img');
    img.src = dataURL;
    img.alt = alt || '';
    img.className = 'res-thumb';
    return img;
  }

  /* ---- characters ---- */

  function renderChars() {
    resCharsEl.innerHTML = '';
    const chars = DGResources.allCharacters();
    if (!chars.length) {
      resCharsEl.appendChild(el('div', { class: 'res-empty' }, ['还没有角色。点击"新建角色"，上传不同表情的立绘，然后打包分享给别人。']));
    }
    chars.forEach(c => {
      const card = el('div', { class: 'res-card' }, [
        el('div', { class: 'res-card-head' }, [
          el('span', { class: 'res-card-title' }, [c.name || c.id]),
          el('span', { class: 'res-card-id' }, [c.id]),
        ]),
        el('div', { class: 'res-card-body' }, [
          field('显示名', c.name, (v) => { c.name = v; DGResources.updateCharacter(c.id, { name: v }); renderResources(); }),
          field('默认方向', c.defaultSide, (v) => { DGResources.updateCharacter(c.id, { defaultSide: v }); renderResources(); }, [['left', '左侧'], ['right', '右侧']]),
          el('div', { class: 'res-sprites' }, [
            spriteSlots(c),
          ]),
          el('div', { class: 'res-subhead' }, ['语音（打包时随角色一起导出）']),
          el('div', { class: 'res-slots' }, [voiceSlots(c)]),
        ]),
        el('div', { class: 'res-card-foot' }, [
          btn('打包分享', () => { const json = DGResources.exportCharacter(c.id); if (json) downloadText(json, c.id + '.dgchar.json'); }),
          btn('删除', () => { if (confirm('删除角色 ' + c.name + '？')) { DGResources.deleteCharacter(c.id); renderResources(); } }, 'btn-danger'),
        ]),
      ]);
      resCharsEl.appendChild(card);
    });
    resCharsEl.appendChild(el('div', { class: 'res-actions' }, [
      btn('＋ 新建角色', () => { const c = DGResources.addCharacter({ name: '新角色' + (DGResources.allCharacters().length + 1) }); renderResources(); }),
      btn('导入角色包', () => {
        const inp = fileInput((f) => {
          const r = new FileReader();
          r.onload = () => {
            const res = DGResources.importCharacter(String(r.result));
            toast(res.ok ? '已导入角色' : res.error);
            renderResources();
          };
          r.readAsText(f);
        });
        inp.accept = '.json,.dgchar';
        inp.click();
      }),
    ]));
  }

  // expression slots grid for one character
  function spriteSlots(c) {
    const wrap = el('div', { class: 'res-slots' }, []);
    const keys = Object.keys(c.sprites).map(Number).sort((a, b) => a - b);
    keys.forEach(k => {
      const xform = DGResources.spriteXform(c.id, k);
      const slot = el('div', { class: 'res-slot' }, [
        makeThumb(c.sprites[String(k)], '表情' + k),
        el('div', { class: 'res-slot-meta' }, [
          el('span', {}, ['表情 ' + k]),
          btn('调', () => openSpriteXform(c, k, wrap), 'btn-mini'),
          btn('×', () => { DGResources.setCharSprite(c.id, k, null); renderResources(); }, 'btn-mini'),
        ]),
      ]);
      if (xform && (xform.scale !== 1 || xform.ox || xform.oy)) {
        slot.appendChild(el('div', { class: 'res-slot-xform-badge' }, ['已调整']));
      }
      wrap.appendChild(slot);
    });
    const add = el('div', { class: 'res-slot res-slot-add' }, [
      el('div', {}, ['＋ 立绘']),
      el('div', { class: 'res-slot-hint' }, ['新表情']),
    ]);
    const inp = fileInput((f) => {
      readImageAsDataURL(f, 'image/png', null, 600, (url) => {
        if (!url) return;
        let next = 1;
        while (c.sprites[String(next)]) next++;
        DGResources.setCharSprite(c.id, next, url);
        renderResources();
      });
    });
    add.addEventListener('click', () => inp.click());
    wrap.appendChild(add);
    return wrap;
  }

  // inline per-sprite adjustment: scale + x/y offset with live preview
  function openSpriteXform(c, expr, anchorWrap) {
    const dataURL = c.sprites[String(expr)];
    if (!dataURL) return;
    const xform = DGResources.spriteXform(c.id, expr) || { scale: 1, ox: 0, oy: 0 };
    const img = new Image();
    img.onload = () => {
      const panel = el('div', { class: 'xform-panel' }, []);
      const preview = el('canvas', { class: 'xform-preview', width: '96', height: '132' });
      const pctx = preview.getContext('2d');
      const scaleInp = range(50, 200, Math.round(xform.scale * 100), '%'),
        oxInp = range(-150, 150, xform.ox, 'px'),
        oyInp = range(-150, 150, xform.oy, 'px');
      const scaleVal = el('span', { class: 'xform-val' }, [scaleInp.value + '%']);
      const oxVal = el('span', { class: 'xform-val' }, [oxInp.value + 'px']);
      const oyVal = el('span', { class: 'xform-val' }, [oyInp.value + 'px']);

      function draw() {
        const s = Number(scaleInp.value) / 100;
        const ow = 96, oh = 132;
        pctx.clearRect(0, 0, ow, oh);
        const bw = oh * (img.naturalWidth / img.naturalHeight);
        const bx = (ow - bw) / 2 + Number(oxInp.value) * 0.4;
        const by = 0 + Number(oyInp.value) * 0.4;
        const dw = bw * s, dh = oh * s;
        pctx.save();
        pctx.beginPath();
        pctx.rect(0, 0, ow, oh);
        pctx.clip();
        pctx.drawImage(img, bx - (dw - bw) / 2, by - (dh - oh) / 2, dw, dh);
        pctx.restore();
      }

      function commit() {
        DGResources.setSpriteXform(c.id, expr, {
          scale: Number(scaleInp.value) / 100,
          ox: Number(oxInp.value),
          oy: Number(oyInp.value),
        });
      }

      scaleInp.addEventListener('input', () => { scaleVal.textContent = scaleInp.value + '%'; draw(); commit(); });
      oxInp.addEventListener('input', () => { oxVal.textContent = oxInp.value + 'px'; draw(); commit(); });
      oyInp.addEventListener('input', () => { oyVal.textContent = oyInp.value + 'px'; draw(); commit(); });

      panel.appendChild(el('div', { class: 'xform-title' }, ['表情 ' + expr + ' 调整']));
      panel.appendChild(preview);
      panel.appendChild(sliderRow('缩放', scaleInp, scaleVal));
      panel.appendChild(sliderRow('左右', oxInp, oxVal));
      panel.appendChild(sliderRow('上下', oyInp, oyVal));
      panel.appendChild(el('div', { class: 'xform-actions' }, [
        btn('重置', () => { scaleInp.value = 100; oxInp.value = 0; oyInp.value = 0; scaleVal.textContent = '100%'; oxVal.textContent = '0px'; oyVal.textContent = '0px'; draw(); commit(); }),
        btn('完成', () => { panel.remove(); renderResources(); }, 'btn-red'),
      ]));
      panel.appendChild(el('div', { class: 'xform-hint' }, ['调整在每次播放 sequence 时保持一致，并随角色包导出。']));

      anchorWrap.appendChild(panel);
      draw();
    };
    img.src = dataURL;
  }

  function range(min, max, value, unit) {
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min);
    inp.max = String(max);
    inp.value = String(value);
    inp.className = 'xform-range';
    inp.dataset.unit = unit || '';
    return inp;
  }

  function sliderRow(label, inp, valEl) {
    return el('div', { class: 'xform-row' }, [el('label', {}, [label]), inp, valEl]);
  }

  // voice slot grid for one character (语音1..N, play preview / upload / remove)
  function voiceSlots(c) {
    const wrap = el('div', { class: 'res-slots' }, []);
    const keys = Object.keys(c.voices).map(Number).sort((a, b) => a - b);
    keys.forEach(k => {
      const slot = el('div', { class: 'res-slot res-slot-audio' }, [
        el('div', { class: 'res-audio-ctrl' }, [
          btn('▶', () => { const u = DGResources.charVoice(c.id, k); if (u) DGAudio.playVoice(u); }, 'btn-mini'),
          el('span', {}, ['语音 ' + k]),
          btn('×', () => { DGResources.setCharVoice(c.id, k, null); renderResources(); }, 'btn-mini'),
        ]),
      ]);
      wrap.appendChild(slot);
    });
    const add = el('div', { class: 'res-slot res-slot-add' }, [el('div', {}, ['＋ 语音']), el('div', { class: 'res-slot-hint' }, ['一句台词'])]);
    const inp = fileInput((f) => {
      readAudioAsDataURL(f, (url) => {
        if (!url) return;
        let next = 1;
        while (c.voices[String(next)]) next++;
        DGResources.setCharVoice(c.id, next, url);
        renderResources();
      });
    });
    add.addEventListener('click', () => inp.click());
    wrap.appendChild(add);
    return wrap;
  }

  /* ---- locations ---- */

  function renderLocs() {
    resLocsEl.innerHTML = '';
    const locs = DGResources.allLocations();
    if (!locs.length) {
      resLocsEl.appendChild(el('div', { class: 'res-empty' }, ['还没有地点。新建地点后可上传多张画面（如 早晨 / 中午 / 夜晚 的同一地点）。']));
    }
    locs.forEach(l => {
      const card = el('div', { class: 'res-card' }, [
        el('div', { class: 'res-card-head' }, [
          el('span', { class: 'res-card-title' }, [l.name || l.id]),
          el('span', { class: 'res-card-id' }, [l.id]),
        ]),
        el('div', { class: 'res-card-body' }, [
          field('地点名', l.name, (v) => { l.name = v; DGResources.updateLocation(l.id, { name: v }); renderResources(); }),
          el('div', { class: 'res-slots' }, [variantSlots(l)]),
        ]),
        el('div', { class: 'res-card-foot' }, [
          btn('打包分享', () => { const json = DGResources.exportLocation(l.id); if (json) downloadText(json, l.id + '.dgloc.json'); }),
          btn('删除', () => { if (confirm('删除地点 ' + l.name + '？')) { DGResources.deleteLocation(l.id); renderResources(); } }, 'btn-danger'),
        ]),
      ]);
      resLocsEl.appendChild(card);
    });
    resLocsEl.appendChild(el('div', { class: 'res-actions' }, [
      btn('＋ 新建地点', () => { DGResources.addLocation({ name: '新地点' + (DGResources.allLocations().length + 1) }); renderResources(); }),
      btn('导入地点包', () => {
        const inp = fileInput((f) => {
          const r = new FileReader();
          r.onload = () => {
            const res = DGResources.importLocation(String(r.result));
            toast(res.ok ? '已导入地点' : res.error);
            renderResources();
          };
          r.readAsText(f);
        });
        inp.accept = '.json,.dgloc';
        inp.click();
      }),
    ]));
  }

  // image variants grid (morning / noon / night …)
  function variantSlots(l) {
    const wrap = el('div', { class: 'res-slots' }, []);
    const keys = Object.keys(l.images);
    keys.forEach(k => {
      const v = l.images[k];
      const nameInp = el('input', { class: 'ed-input ed-variant-name', type: 'text', value: v.name || '' });
      nameInp.addEventListener('change', () => { DGResources.setLocImage(l.id, k, nameInp.value || k, v.dataURL); });
      wrap.appendChild(el('div', { class: 'res-slot' }, [
        makeThumb(v.dataURL, v.name),
        el('div', { class: 'res-slot-meta' }, [
          nameInp,
          btn('×', () => { DGResources.setLocImage(l.id, k, null, null); renderResources(); }, 'btn-mini'),
        ]),
      ]));
    });
    const add = el('div', { class: 'res-slot res-slot-add' }, [el('div', {}, ['＋ 画面']), el('div', { class: 'res-slot-hint' }, ['早晨/中午/夜晚…'])]);
    const inp = fileInput((f) => {
      readImageAsDataURL(f, 'image/jpeg', 0.82, 1600, (url) => {
        if (!url) return;
        let next = 'v' + (Object.keys(l.images).length + 1);
        let n = 1;
        while (l.images[next]) next = 'v' + (++n);
        DGResources.setLocImage(l.id, next, '画面' + (Object.keys(l.images).length + 1), url);
        renderResources();
      });
    });
    add.addEventListener('click', () => inp.click());
    wrap.appendChild(add);
    return wrap;
  }

  /* ---- BGM / SFX ---- */

  const resBgmsEl = $('#resBgms');
  const resSfxsEl = $('#resSfxs');

  function renderBgms() {
    resBgmsEl.innerHTML = '';
    const items = DGResources.allBgms();
    if (!items.length) {
      resBgmsEl.appendChild(el('div', { class: 'res-empty' }, ['还没有背景音乐。上传音频后在脚本里用 @bgm bgm://音乐id（编辑器可添加「背景音乐」行）。']));
    }
    items.forEach(b => {
      resBgmsEl.appendChild(el('div', { class: 'res-card' }, [
        el('div', { class: 'res-card-head' }, [
          el('span', { class: 'res-card-title' }, [b.name || b.id]),
          el('span', { class: 'res-card-id' }, [b.id]),
        ]),
        el('div', { class: 'res-card-body' }, [
          field('名称', b.name, (v) => { b.name = v; DGResources.updateBgm(b.id, { name: v }); renderResources(); }),
          el('div', { class: 'res-audio-row' }, [
            btn('试听 ▶', () => { if (b.dataURL) DGAudio.playBgm(b.dataURL); else toast('尚未上传音频'); }),
            btn('停止', () => DGAudio.stopBgm(), 'btn-danger'),
            btn(b.dataURL ? '更换音频' : '上传音频', () => audioInput((url) => { DGResources.updateBgm(b.id, { dataURL: url }); renderResources(); })),
          ]),
        ]),
        el('div', { class: 'res-card-foot' }, [
          btn('打包分享', () => { const json = DGResources.exportBgm(b.id); if (json) downloadText(json, b.id + '.dgbgm.json'); }),
          btn('删除', () => { if (confirm('删除音乐 ' + b.name + '？')) { DGResources.deleteBgm(b.id); renderResources(); } }, 'btn-danger'),
        ]),
      ]));
    });
    resBgmsEl.appendChild(el('div', { class: 'res-actions' }, [
      btn('＋ 新建音乐', () => { DGResources.addBgm({ name: '音乐' + (DGResources.allBgms().length + 1) }); renderResources(); }),
      btn('导入音乐包', () => {
        const inp = jsonInput((json) => {
          const res = DGResources.importBgm(json);
          toast(res.ok ? '已导入音乐' : res.error);
          renderResources();
        });
        inp.accept = '.json,.dgbgm';
        inp.click();
      }),
    ]));
  }

  function renderSfxs() {
    resSfxsEl.innerHTML = '';
    const items = DGResources.allSfx();
    if (!items.length) {
      resSfxsEl.appendChild(el('div', { class: 'res-empty' }, ['还没有音效。上传音频后在脚本里用 @sfx sfx://音效id（编辑器可添加「音效」行）。']));
    }
    items.forEach(s => {
      resSfxsEl.appendChild(el('div', { class: 'res-card' }, [
        el('div', { class: 'res-card-head' }, [
          el('span', { class: 'res-card-title' }, [s.name || s.id]),
          el('span', { class: 'res-card-id' }, [s.id]),
        ]),
        el('div', { class: 'res-card-body' }, [
          field('名称', s.name, (v) => { s.name = v; DGResources.updateSfx(s.id, { name: v }); renderResources(); }),
          el('div', { class: 'res-audio-row' }, [
            btn('试听 ▶', () => { if (s.dataURL) DGAudio.playSfx(s.dataURL); else toast('尚未上传音频'); }),
            btn(s.dataURL ? '更换音频' : '上传音频', () => audioInput((url) => { DGResources.updateSfx(s.id, { dataURL: url }); renderResources(); })),
          ]),
        ]),
        el('div', { class: 'res-card-foot' }, [
          btn('打包分享', () => { const json = DGResources.exportSfx(s.id); if (json) downloadText(json, s.id + '.dgsfx.json'); }),
          btn('删除', () => { if (confirm('删除音效 ' + s.name + '？')) { DGResources.deleteSfx(s.id); renderResources(); } }, 'btn-danger'),
        ]),
      ]));
    });
    resSfxsEl.appendChild(el('div', { class: 'res-actions' }, [
      btn('＋ 新建音效', () => { DGResources.addSfx({ name: '音效' + (DGResources.allSfx().length + 1) }); renderResources(); }),
      btn('导入音效包', () => {
        const inp = jsonInput((json) => {
          const res = DGResources.importSfx(json);
          toast(res.ok ? '已导入音效' : res.error);
          renderResources();
        });
        inp.accept = '.json,.dgsfx';
        inp.click();
      }),
    ]));
  }

  // audio file input
  function audioInput(onDataURL) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'audio/*,.mp3,.ogg,.wav,.m4a,.flac';
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (f) readAudioAsDataURL(f, onDataURL);
      inp.value = '';
      inp.remove();
    });
    document.body.appendChild(inp);
    inp.click();
  }

  // JSON package input (shared by bgm/sfx imports)
  function jsonInput(onJson) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.style.display = 'none';
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      if (!f) { inp.remove(); return; }
      const r = new FileReader();
      r.onload = () => { onJson(String(r.result)); inp.value = ''; inp.remove(); };
      r.readAsText(f);
    });
    document.body.appendChild(inp);
    return inp;
  }

  // small UI helpers for the resources tab
  function el(tag, props, children) {
    const n = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === 'class') n.className = props[k];
        else if (k === 'html') n.innerHTML = props[k];
        else if (k.startsWith('on') && typeof props[k] === 'function') n.addEventListener(k.slice(2), props[k]);
        else if (k === 'value') n.value = props[k];
        else if (props[k] !== undefined && props[k] !== null) n.setAttribute(k, props[k]);
      }
    }
    (children || []).forEach(c => {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function btn(label, onClick, extraClass) {
    const b = el('button', { class: 'btn btn-small' + (extraClass ? ' ' + extraClass : '') }, [label]);
    b.addEventListener('click', onClick);
    return b;
  }

  function field(label, value, onChange, options) {
    const row = el('div', { class: 'res-field' }, [el('label', {}, [label])]);
    if (options) {
      const sel = el('select', { class: 'ed-input' }, options.map(([v, l]) => el('option', { value: v, selected: v === value ? '' : null }, [l])));
      sel.addEventListener('change', () => onChange(sel.value));
      row.appendChild(sel);
    } else {
      const inp = el('input', { class: 'ed-input', type: 'text', value: value || '' });
      inp.addEventListener('change', () => onChange(inp.value.trim()));
      row.appendChild(inp);
    }
    return row;
  }

  /* ---------------- play controls / UI ---------------- */

  $('#btnRestart').addEventListener('click', () => player.restart());
  $('#btnPrev').addEventListener('click', () => player.prev());
  $('#btnNext').addEventListener('click', () => player.next());

  /* ---- playback mode (auto-play the whole script) ---- */

  let PLAY_DELAY = 1400;      // ms between lines in playback mode
  let autoMode = false;
  let loopMode = false;
  let autoTimer = null;

  app.setPlayDelay = (ms) => { PLAY_DELAY = ms; };

  function scheduleAutoStep(info) {
    clearTimeout(autoTimer);
    if (!autoMode) return;
    if (info && info.typing) return; // wait for typing to finish
    const step = () => {
      if (!autoMode) return;
      if (player.transition) { autoTimer = setTimeout(step, 100); return; } // wait for transition
      if (player.finished) {
        if (loopMode) player.restart();
        return;
      }
      if (player.display && player.display.op === 'choice' && player.display.choices && player.display.choices.length) {
        player.choose(player.display.choices[0].target); // auto-pick first option
      } else {
        player.next();
      }
    };
    autoTimer = setTimeout(step, PLAY_DELAY);
  }

  const btnAuto = $('#btnAuto');
  const chkLoop = $('#chkLoop');
  btnAuto.addEventListener('click', () => {
    autoMode = !autoMode;
    btnAuto.textContent = autoMode ? '⏸ 停止自动播放' : '▶ 播放模式';
    btnAuto.classList.toggle('btn-glow', autoMode);
    if (autoMode) {
      if (player.finished) player.restart();
      scheduleAutoStep(null);
    } else {
      clearTimeout(autoTimer);
    }
  });
  chkLoop.addEventListener('change', () => { loopMode = chkLoop.checked; });

  /* ---- video recording (canvas captureStream + MediaRecorder) ---- */

  const btnRecord = $('#btnRecord');
  let recorder = null;
  let videoChunks = [];
  let recCanvas = null;   // dedicated 2x canvas for recording (1334x1000)
  let recCtx = null;
  let recStream = null;
  const REC_SCALE = 2;

  const canRecord = typeof MediaRecorder !== 'undefined';
  if (!canRecord) {
    btnRecord.disabled = true;
    btnRecord.title = '当前浏览器不支持录制';
  }

  function startRecording() {
    if (recorder) return;
    recCanvas = document.createElement('canvas');
    recCanvas.width = Math.round(DGRenderer.W * REC_SCALE);
    recCanvas.height = Math.round(DGRenderer.H * REC_SCALE);
    recCtx = recCanvas.getContext('2d');
    if (typeof recCanvas.captureStream !== 'function') {
      toast('当前浏览器不支持 canvas 录制');
      recCanvas = recCtx = null;
      return;
    }
    const stream = recCanvas.captureStream(30);
    const audioTrack = DGAudio.startAudioTrack();
    if (audioTrack) stream.addTrack(audioTrack);
    recStream = stream;
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12000000 } : undefined);
    videoChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) videoChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(videoChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dialogue_recording.webm';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1200);
      DGAudio.stopAudioTrack();
      recorder = null;
      recCanvas = recCtx = null;
      recStream = null;
      btnRecord.textContent = '● 录制视频';
      btnRecord.classList.remove('rec-on');
    };
    recorder.start(250);
    btnRecord.textContent = '■ 停止录制';
    btnRecord.classList.add('rec-on');
    toast('录制中（1334×1000）：请播放序列（建议开启播放模式），完成后点「停止录制」');
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else { DGAudio.stopAudioTrack(); btnRecord.classList.remove('rec-on'); }
  }

  btnRecord.addEventListener('click', () => {
    if (recorder) stopRecording();
    else startRecording();
  });

  canvas.addEventListener('click', () => {
    if (player.finished) player.restart();
    else player.next();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); player.next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') player.prev();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') player.next();
    else if (e.key === 'r' || e.key === 'R') player.restart();
  });

  function updateChoices(choices) {
    const box = $('#choices');
    box.innerHTML = '';
    if (!choices) { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    choices.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'choice-btn';
      b.textContent = c.text;
      b.addEventListener('click', () => player.choose(c.target));
      box.appendChild(b);
    });
  }

  function updateUI(info) {
    $('#statusTitle').textContent = info.title || '（无标题）';
    $('#statusPos').textContent = info.finished ? '完' : (info.typing ? '打字中…' : '等待输入');
    $('#btnPrev').disabled = !info.canPrev;
    updateChoices(info.choices);
    if (info.finished) {
      $('#statusPos').textContent = '结束';
      $('#overlayDone').style.display = 'block';
    } else {
      $('#overlayDone').style.display = 'none';
    }
    scheduleAutoStep(info);
  }

  function showParseErrors(errors) {
    const box = $('#parseErrors');
    if (!errors.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    box.innerHTML = '<b>脚本错误（' + errors.length + '）</b><ul>' +
      errors.map(e => '<li>第 ' + e.line + ' 行：' + esc(e.msg) + ' — <code>' + esc(e.raw) + '</code></li>').join('') +
      '</ul>';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- export (unchanged) ---------------- */

  $('#btnExportFrame').addEventListener('click', () => exportFrame());
  $('#btnExportAll').addEventListener('click', () => exportAll());

  function exportScale() {
    const d = $('#exportScale');
    const v = parseFloat(d && d.value);
    return (v && v > 0 && v <= 8) ? v : 2;
  }

  function downloadCanvas(canvas, name) {
    canvas.toBlob((blob) => {
      if (!blob) { toast('导出失败（canvas 被污染？）'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    }, 'image/png');
  }

  function exportFrame() {
    if (!player.display) return;
    warmupFont().then(() => {
      const c = player.exportCurrentFrame(exportScale());
      downloadCanvas(c, 'dialogue_' + String(player.cursor).padStart(3, '0') + '.png');
    });
  }

  let exporting = false;
  function exportAll() {
    if (exporting) return;
    const scale = exportScale();
    const status = $('#exportStatus');
    const btn = $('#btnExportAll');
    exporting = true;
    btn.disabled = true;
    warmupFont()
      .then(() => {
        const results = player.exportAll(scale, (n) => { status.textContent = '渲染中… ' + n; });
        status.textContent = '渲染完成 ' + results.length + ' 帧，开始下载…';
        let i = 0;
        const step = () => {
          if (i >= results.length) {
            status.textContent = '导出完成：' + results.length + ' 张 PNG（@' + scale + 'x）';
            exporting = false;
            btn.disabled = false;
            return;
          }
          downloadCanvas(results[i].canvas, 'dialogue_' + String(i + 1).padStart(3, '0') + '.png');
          i++;
          setTimeout(step, 400);
        };
        setTimeout(step, 300);
      })
      .catch((e) => {
        status.textContent = '导出失败：' + e.message;
        exporting = false;
        btn.disabled = false;
      });
  }

  /* ---------------- startup ---------------- */

  const state = { script: DEMO_SCRIPT };

  $('#editor').value = state.script;
  compileScript(false);
  updateTabBadge();

  // best-effort: load the real sample file over HTTP
  fetch('samples/demo.txt')
    .then(r => (r.ok ? r.text() : null))
    .then(t => {
      if (t) { state.script = t; $('#editor').value = t; compileScript(false); }
    })
    .catch(() => { /* file:// — keep embedded demo */ });

  // bg hint (metadata) — also show the current BGM so audio state is visible
  const bgHint = $('#bgHint');
  setInterval(() => {
    const s = player.state;
    const p = s && s.bgPath;
    const b = s && s.bgmPath;
    let text = p ? '背景：' + p : '';
    if (b) {
      const m = /^bgm:\/\/(.+)$/.exec(b);
      const name = m ? (DGResources.allBgms().find(x => x.id === m[1]) || {}).name || m[1] : b;
      text += (text ? ' · ' : '') + '♪ ' + name;
    }
    bgHint.textContent = text;
  }, 800);

  // debug/test handle
  if (typeof window !== 'undefined') {
    window.DGApp = app;
    window.DGApp.audio = DGAudio;
  }

})();
