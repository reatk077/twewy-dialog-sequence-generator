/* editor.js — WYSIWYG line editor (draft-based).
 * Works on the document entries produced by DGParser.parseDocument (see app.js).
 *
 * Editing model: form fields mutate a DRAFT clone of the selected entry. Nothing
 * is applied until the user clicks 「确定」 — only then entries are written back,
 * serialized to the script text, reparsed and the preview seeks to the line.
 * 「取消」 discards the draft. Structural ops (add/delete/move/select) flush the
 * pending draft first, then apply immediately.
 *
 * app interface (provided by app.js):
 *   entries, selectedIdx, bubbleImgs, builtinBgs, resources
 *   commit(), selectEntry(i), actorOptions(), toast(msg)
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DGEditor = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /* ---------- tiny DOM helpers ---------- */

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

  // accepts options as {value,label} objects (or legacy [value,label] arrays)
  function makeSelect(options, value, onChange) {
    const sel = el('select', { class: 'ed-input' }, options.map(o => {
      const v = Array.isArray(o) ? o[0] : o.value;
      const l = Array.isArray(o) ? o[1] : o.label;
      return el('option', { value: v, selected: String(v) === String(value) ? '' : null }, [l]);
    }));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function fieldRow(label, control) {
    return el('div', { class: 'ed-row' }, [
      el('label', { class: 'ed-label' }, [label]),
      control,
    ]);
  }

  // open a dropdown menu anchored to `anchor`; closes on any outside click.
  // The outside-click listener is registered on the NEXT tick so the opening
  // click (which bubbles to document) cannot immediately close the menu.
  function openMenu(anchor, menu) {
    const host = anchor.parentNode;
    host.querySelectorAll('.ed-menu').forEach(m => m.remove());
    host.appendChild(menu);
    function dismiss(ev) {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', dismiss);
      }
    }
    setTimeout(() => document.addEventListener('click', dismiss), 0);
    return dismiss;
  }

  /* ---------- editor factory ---------- */

  function create(app) {
    const editor = {};

    const listEl = document.getElementById('edList');
    const formEl = document.getElementById('edForm');
    const kindSel = document.getElementById('edNewKind');

    /* ---------- draft model ---------- */

    let draft = null;   // { idx, entry } — working copy of the selected entry
    let dirty = false;  // draft differs from the committed entry
    let applyBtn = null, cancelBtn = null, applyHint = null;

    function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

    function currentEntry() { return app.entries[app.selectedIdx]; }

    // re-snapshot the draft from the committed entry (fresh, clean)
    function snapshotDraft() {
      draft = app.selectedIdx >= 0 ? { idx: app.selectedIdx, entry: deepClone(currentEntry()) } : null;
      dirty = false;
      updateApplyBar();
    }

    function getDraft() { return draft ? draft.entry : currentEntry(); }

    function markDirty() {
      dirty = true;
      updateApplyBar();
    }

    function updateApplyBar() {
      if (!applyBtn) return;
      applyBtn.textContent = dirty ? '✔ 应用修改' : '✔ 确定';
      applyBtn.classList.toggle('btn-glow', dirty);
      if (cancelBtn) cancelBtn.disabled = !dirty;
      if (applyHint) applyHint.textContent = dirty ? '有未应用的修改，点击「确定」生效' : '修改需点击「确定」后生效';
    }

    // write the pending draft back into entries (no recompile)
    function flushDraft() {
      if (draft && dirty && draft.idx >= 0 && draft.idx < app.entries.length) {
        app.entries[draft.idx] = draft.entry;
      }
      draft = null;
      dirty = false;
    }

    // apply: ensure actor declarations for resource speakers, write back, commit
    function applyDraft() {
      if (!draft || draft.idx < 0) { snapshotDraft(); return; }
      if (!dirty) { snapshotDraft(); return; }
      const entry = draft.entry;
      // auto-insert !actor declarations for resource characters used as speakers
      let shift = 0;
      const needIds = [];
      (entry.bubbles || []).forEach(b => (b.speakers || []).forEach(s => needIds.push(s.id)));
      const declared = new Set(app.entries.filter(e => e.kind === 'actor').map(e => e.id));
      needIds.forEach(id => {
        if (declared.has(id)) return;
        const c = app.resources.getCharacter(id);
        if (!c) return;
        app.entries.splice(draft.idx + shift, 0, {
          kind: 'actor', id, name: c.name, side: c.defaultSide, slot: 0,
          pattern: 'chara://' + id + '/{expr}', lineNo: 0,
        });
        shift++;
        declared.add(id);
      });
      app.entries[draft.idx + shift] = entry;
      draft = null;
      dirty = false;
      app.commit();
    }

    function cancelDraft() {
      draft = null;
      dirty = false;
      renderForm();
    }

    // flush pending draft before structural operations
    function flushBeforeStructural() {
      if (draft && dirty) flushDraft();
    }

    /* ---------------- list ---------------- */

    function entryLabel(e) {
      switch (e.kind) {
        case 'blank': return '';
        case 'comment': return '注释：' + e.raw;
        case 'error': return '⚠ ' + e.raw;
        case 'jump': return '跳转 → ' + e.label;
        case 'actorCmd': return (e.cmd === 'on' ? '登场：' : '退场：') + e.id;
        case 'sprite': return '换立绘：' + e.id + ' → ' + e.expr;
        case 'directive':
          if (e.key === 'end') return '结束 @end';
          if (e.key === 'bg') return '背景：' + e.value;
          if (e.key === 'title') return '标题：' + e.value;
          if (e.key === 'label') return '标签：@' + e.value;
          return '@' + e.key + ' = ' + e.value;
        case 'actor': return '角色：' + e.name + '（' + e.id + ' · ' + e.side + '/' + (e.slot <= 1 ? (e.slot === 0 ? '前' : '后') : '槽' + e.slot) + '）';
        case 'choice': return '？' + e.choices.map(c => c.text).join(' ／ ');
        case 'speech': {
          const b = e.bubbles[0];
          const who = b.narration ? '旁白' : (b.speakers || []).map(s => s.id + (s.expr ? '(' + s.expr + ')' : '')).join('+') || '无主';
          return who + '：' + (b.text || '').replace(/\n/g, '⏎').slice(0, 20) + (e.bubbles.length === 2 ? ' [双层]' : '');
        }
        default: return e.kind;
      }
    }

    function renderList() {
      // warn about duplicate actor ids (later declarations override earlier ones)
      const warnEl = document.getElementById('edWarn');
      if (warnEl) {
        const seen = new Map();
        app.entries.forEach(e => { if (e.kind === 'actor') seen.set(e.id, (seen.get(e.id) || 0) + 1); });
        const dups = [...seen].filter(([, c]) => c > 1);
        if (dups.length) {
          warnEl.style.display = 'block';
          warnEl.innerHTML = '⚠ 角色 id 重复：' + dups.map(([id, c]) => id + '（' + c + ' 次）').join('、') +
            ' —— 后面的声明会覆盖前面的，同屏多人请使用不同 id';
        } else {
          warnEl.style.display = 'none';
          warnEl.innerHTML = '';
        }
      }
      listEl.innerHTML = '';
      app.entries.forEach((e, i) => {
        const li = el('li', {
          class: 'll-item' + (i === app.selectedIdx ? ' ll-current' : '') +
            (e.kind === 'speech' || e.kind === 'choice' ? ' ll-edit' : '') +
            (e.kind === 'blank' || e.kind === 'comment' ? ' ll-meta' : ''),
          'data-idx': String(i),
        }, [
          el('span', { class: 'll-no' }, [e.lineNo ? String(e.lineNo) : '']),
          el('span', { class: 'll-txt' }, [entryLabel(e)]),
        ]);
        li.addEventListener('click', () => app.selectEntry(i));
        listEl.appendChild(li);
      });
    }

    /* ---------------- list toolbar (structural = immediate) ---------------- */

    function insertEntry(kind) {
      const entry = newEntry(kind);
      if (!entry) return;
      flushBeforeStructural();
      const at = app.selectedIdx >= 0 ? app.selectedIdx + 1 : app.entries.length;
      app.entries.splice(at, 0, entry);
      app.selectedIdx = at;
      app.commit();
    }

    function deleteSelected() {
      if (app.selectedIdx < 0) return;
      flushBeforeStructural();
      app.entries.splice(app.selectedIdx, 1);
      app.selectedIdx = Math.min(app.selectedIdx, app.entries.length - 1);
      app.commit();
    }

    function moveSelected(delta) {
      const i = app.selectedIdx;
      const j = i + delta;
      if (i < 0 || j < 0 || j >= app.entries.length) return;
      flushBeforeStructural();
      const t = app.entries[i];
      app.entries[i] = app.entries[j];
      app.entries[j] = t;
      app.selectedIdx = j;
      app.commit();
    }

    function newEntry(kind) {
      switch (kind) {
        case 'speech':
          return { kind: 'speech', bubbles: [{ speakers: [], text: '', box: 'default', flip: 'auto', side: null, expr: null, name: null, speed: null, narration: false }], lineNo: 0 };
        case 'narration':
          return { kind: 'speech', bubbles: [{ speakers: [], text: '', box: 'default', flip: 'auto', side: null, expr: null, name: null, speed: null, narration: true }], lineNo: 0 };
        case 'choice':
          return { kind: 'choice', choices: [{ text: '', target: '' }], lineNo: 0 };
        case 'jump':
          return { kind: 'jump', label: '', lineNo: 0 };
        case 'label':
          return { kind: 'directive', key: 'label', value: '', lineNo: 0 };
        case 'bg':
          return { kind: 'directive', key: 'bg', value: app.builtinBgs[0] || 'Event_BG_sh001_01.jpg', lineNo: 0 };
        case 'bgm':
          return { kind: 'directive', key: 'bgm', value: '', lineNo: 0 };
        case 'sfx':
          return { kind: 'directive', key: 'sfx', value: '', lineNo: 0 };
        case 'actor': {
          // auto-unique id so two "角色声明" entries never silently collide
          const used = new Set(app.entries.filter(e => e.kind === 'actor').map(e => e.id));
          let id = 'char', n = 2;
          while (used.has(id)) id = 'char' + (n++);
          return { kind: 'actor', id, name: '新角色', side: 'left', slot: 0, pattern: 'sprites/{id}{expr}.png', lineNo: 0 };
        }
        default:
          return null;
      }
    }

    document.getElementById('edAdd').addEventListener('click', () => insertEntry(kindSel.value));
    document.getElementById('edDel').addEventListener('click', deleteSelected);
    document.getElementById('edUp').addEventListener('click', () => moveSelected(-1));
    document.getElementById('edDown').addEventListener('click', () => moveSelected(1));

    /* ---------------- forms (draft-only, no commits) ---------------- */

    function renderForm() {
      formEl.innerHTML = '';
      snapshotDraft();
      const e = getDraft();
      if (!e) {
        formEl.appendChild(el('div', { class: 'ed-empty' }, ['在上方列表选择一行进行编辑，或点击"添加"新建。']));
        return;
      }

      // apply bar
      const bar = el('div', { class: 'ed-apply-bar' }, [
        el('button', { class: 'btn btn-small btn-red', id: 'edApply' }, ['✔ 确定']),
        el('button', { class: 'btn btn-small', id: 'edCancel' }, ['取消']),
        el('span', { class: 'ed-apply-hint', id: 'edApplyHint' }, ['']),
      ]);
      applyBtn = bar.querySelector('#edApply');
      cancelBtn = bar.querySelector('#edCancel');
      applyHint = bar.querySelector('#edApplyHint');
      applyBtn.addEventListener('click', applyDraft);
      cancelBtn.addEventListener('click', cancelDraft);
      formEl.appendChild(bar);

      formEl.appendChild(el('h3', { class: 'ed-title' }, [kindTitle(e)]));
      const body = el('div', {});
      buildForm(body, e);
      formEl.appendChild(body);
      updateApplyBar();
    }

    function kindTitle(e) {
      switch (e.kind) {
        case 'speech': return e.bubbles.length === 2 ? '双层对话（后层 || 前层）' : (e.bubbles[0].narration ? '旁白' : '对话');
        case 'choice': return '选择分支';
        case 'jump': return '跳转';
        case 'actor': return '角色声明';
        case 'directive': return e.key === 'bg' ? '背景' : e.key === 'label' ? '标签' : e.key === 'end' ? '结束' : e.key === 'title' ? '标题' : e.key === 'bgm' ? '背景音乐' : e.key === 'sfx' ? '音效' : '@' + e.key;
        case 'comment': return '注释';
        case 'blank': return '空行';
        case 'error': return '⚠ 语法错误';
        case 'actorCmd': return e.cmd === 'on' ? '角色登场' : '角色退场';
        case 'sprite': return '切换立绘';
        default: return e.kind;
      }
    }

    // Ctrl/Cmd+Enter anywhere in the form applies the draft
    function applyOnEnter(ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        applyDraft();
      }
    }

    /* ---- speech form ---- */

    function buildSpeechForm(body, entry) {
      entry.bubbles.forEach((b, bi) => {
        if (entry.bubbles.length === 2) {
          body.appendChild(el('div', { class: 'ed-subhead' }, [bi === 0 ? '后层气泡（先显示，z3）' : '前层气泡（z6）']));
        }

        // box type (bubble icons)
        const boxRow = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['对话框形式'])]);
        const boxBtns = el('div', { class: 'ed-btns' });
        DGParser.BOX_TYPES.forEach(box => {
          const img = app.bubbleImgs[box];
          const btn = el('button', {
            class: 'bub-icon' + (b.box === box ? ' active' : ''),
            title: box,
          }, [img ? el('img', { src: img.src, alt: box }) : el('span', {}, [box])]);
          btn.addEventListener('click', () => { b.box = box; markDirty(); });
          boxBtns.appendChild(btn);
        });
        boxRow.appendChild(boxBtns);
        body.appendChild(boxRow);

        // speakers (skip for narration)
        if (!b.narration) {
          if (!b.speakers || !b.speakers.length) {
            body.appendChild(el('div', { class: 'ed-hint ed-warn-hint' }, [
              '本行没有说话人：不会关联立绘/语音，名字标签也不显示（可用 name= 覆盖）。点「＋说话人」添加。',
            ]));
          }
          const chipRow = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['说话人（方向）'])]);
          const chips = el('div', { class: 'ed-chips' });
          (b.speakers || []).forEach((sp, si) => {
            const a = app.actorOptions().find(x => x.id === sp.id);
            const chip = el('span', { class: 'chip' + (a && a.side ? ' chip-' + a.side : '') }, [
              a ? a.name : sp.id,
              sp.expr ? ' (' + sp.expr + ')' : '',
              el('span', { class: 'chip-x', title: '移除' }, ['×']),
            ]);
            chip.querySelector('.chip-x').addEventListener('click', () => {
              b.speakers.splice(si, 1);
              markDirty();
            });
            chip.addEventListener('click', (ev) => {
              if (ev.target.classList.contains('chip-x')) return;
              const exprs = exprOptions(a);
              if (exprs.length === 1 && exprs[0] === null) { app.toast('该角色没有可用的表情资源，可到"资源"页面上传'); return; }
              buildExprPicker(chip, sp, a, markDirty);
            });
            chips.appendChild(chip);
          });
          const addBtn = el('button', { class: 'btn btn-small' }, ['＋说话人']);
          addBtn.addEventListener('click', () => buildSpeakerPicker(addBtn, b, markDirty));
          chips.appendChild(addBtn);
          chipRow.appendChild(chips);
          body.appendChild(chipRow);
        }

        // flip
        const flipRow = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['翻转/方向'])]);
        const flipBtns = el('div', { class: 'ed-btns' });
        [['auto', '自动'], ['left', '朝左'], ['right', '朝右'], ['0', '不翻'], ['1', '必翻']].forEach(([v, label]) => {
          const cur = b.flip === true ? '1' : b.flip === false ? '0' : 'auto';
          const btn = el('button', { class: 'btn btn-small' + (cur === v ? ' active' : '') }, [label]);
          btn.addEventListener('click', () => {
            b.flip = v === 'auto' ? 'auto' : v === 'left' || v === '1' ? true : false;
            if (v === 'left' || v === 'right') b.side = v;
            markDirty();
          });
          flipBtns.appendChild(btn);
        });
        flipRow.appendChild(flipBtns);
        body.appendChild(flipRow);

        // name override
        const nameInp = el('input', {
          class: 'ed-input', type: 'text', value: b.name || '',
          placeholder: '默认取角色名',
        });
        nameInp.addEventListener('input', () => { b.name = nameInp.value || null; markDirty(); });
        nameInp.addEventListener('keydown', applyOnEnter);
        body.appendChild(fieldRow('名字标签（覆盖）', nameInp));

        // voice (speaker's voice clip, voice=<n>)
        const voiceRow = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['语音'])]);
        const voiceInp = el('input', {
          class: 'ed-input ed-voice-num', type: 'number', min: '1', value: b.voice || '',
          placeholder: '语音编号（留空无语音）',
        });
        voiceInp.addEventListener('input', () => {
          const v = parseInt(voiceInp.value, 10);
          b.voice = (voiceInp.value !== '' && !Number.isNaN(v)) ? v : null;
          markDirty();
        });
        voiceInp.addEventListener('keydown', applyOnEnter);
        voiceRow.appendChild(voiceInp);
        // 试听: play the FIRST speaker's voice n
        const sp0 = b.speakers && b.speakers[0] && b.speakers[0].id;
        const listenBtn = el('button', { class: 'btn btn-small' }, ['▶ 试听']);
        listenBtn.addEventListener('click', () => {
          const v = parseInt(voiceInp.value, 10);
          if (!sp0) { app.toast('该行没有说话人，无法关联语音'); return; }
          if (!v || Number.isNaN(v)) { app.toast('先填写语音编号'); return; }
          app.previewVoice(sp0, v);
        });
        voiceRow.appendChild(listenBtn);
        // quick-pick buttons when the first speaker is a resource character with voices
        const rc = sp0 ? app.resources.getCharacter(sp0) : null;
        if (rc && Object.keys(rc.voices).length) {
          const btns = el('div', { class: 'ed-btns' }, []);
          Object.keys(rc.voices).sort((a, z) => a - z).forEach(n => {
            const btn = el('button', { class: 'btn btn-small' + (b.voice === Number(n) ? ' active' : '') }, ['语音' + n]);
            btn.addEventListener('click', () => {
              b.voice = Number(n);
              markDirty();
              app.previewVoice(sp0, Number(n));
            });
            btns.appendChild(btn);
          });
          voiceRow.appendChild(btns);
        }
        // linkage hint: voices only exist on RESOURCE characters with matching id
        const rch = sp0 ? app.resources.getCharacter(sp0) : null;
        if (!rch) {
          voiceRow.appendChild(el('div', { class: 'ed-hint' }, [
            '说话人 ' + (sp0 || '（无）') + ' 没有对应资源角色——语音需在「资源」页给同名角色上传，并确保脚本角色 id 一致。',
          ]));
        } else if (!Object.keys(rch.voices).length) {
          voiceRow.appendChild(el('div', { class: 'ed-hint' }, [
            '已关联角色 ' + rch.name + '，但还没有上传语音（去「资源」页添加）。',
          ]));
        }
        body.appendChild(voiceRow);

        // text
        const ta = el('textarea', { class: 'ed-text', rows: '3' }, [b.text || '']);
        ta.addEventListener('input', () => { b.text = ta.value; markDirty(); });
        ta.addEventListener('keydown', applyOnEnter);
        body.appendChild(fieldRow('对话内容', ta));
      });
    }

    // options for a speaker's expression: null (no resource) or {value,label,img}[]
    function exprOptions(actorInfo) {
      if (!actorInfo || !actorInfo.fromResource) return [null];
      const c = app.resources.getCharacter(actorInfo.id);
      if (!c) return [null];
      const opts = Object.keys(c.sprites).sort((x, y) => x - y).map(k => ({ value: Number(k), label: '表情 ' + k, img: c.sprites[k] }));
      return opts.length ? opts : [null];
    }

    function buildExprPicker(anchor, sp, actorInfo, onDone) {
      const opts = exprOptions(actorInfo);
      if (opts.length === 1 && opts[0] === null) return;
      const menu = el('div', { class: 'ed-menu' }, []);
      opts.forEach(o => {
        const item = el('button', { class: 'ed-menu-item' + (sp.expr === o.value ? ' active' : '') }, [
          o.img ? el('img', { src: o.img, class: 'menu-thumb' }) : null,
          el('span', {}, [o.label]),
        ]);
        item.addEventListener('click', () => { sp.expr = o.value; menu.remove(); onDone(); });
        menu.appendChild(item);
      });
      openMenu(anchor, menu);
    }

    function buildSpeakerPicker(anchor, bubble, onDone) {
      const opts = app.actorOptions();
      if (!opts.length) { app.toast('还没有任何角色：先在"添加"里新建角色声明，或到"资源"页创建角色'); return; }
      const menu = el('div', { class: 'ed-menu ed-menu-wide' }, []);
      opts.forEach(o => {
        const item = el('button', { class: 'ed-menu-item' }, [
          el('span', {}, [o.name + '（' + o.id + ' · ' + (o.side === 'right' ? '右' : '左') + (o.fromResource ? ' · 资源' : '') + '）']),
        ]);
        item.addEventListener('click', () => {
          if (!bubble.speakers.some(s => s.id === o.id)) {
            bubble.speakers.push({ id: o.id, expr: null });
            if (o.fromResource) {
              // actor declaration will be auto-inserted on apply (draft model)
              app.toast('已添加资源角色，点「确定」时自动补上角色声明');
            }
          }
          menu.remove();
          onDone();
        });
        menu.appendChild(item);
      });
      openMenu(anchor, menu);
    }

    /* ---- sprite picker (choose the default sprite from the character's sprites) ---- */

    function buildSpritePicker(body, entry) {
      const section = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['立绘选择'])]);
      const grid = el('div', { class: 'ed-sprite-grid' }, []);
      section.appendChild(grid);
      body.appendChild(section);

      const pattern = entry.pattern || '';
      const resMatch = /^chara:\/\/([^/]+)\/\{expr\}$/.exec(pattern);
      const hasTemplate = pattern.indexOf('{expr}') !== -1;

      function render(items) {
        grid.innerHTML = '';
        if (!items.length) {
          grid.appendChild(el('div', { class: 'ed-hint' }, [
            '未找到立绘。' + (hasTemplate
              ? '检查模板路径是否正确，或到"资源"页上传角色立绘。'
              : '模板需包含 {expr} 占位符才能选择表情立绘。'),
          ]));
          return;
        }
        const cur = entry.expr || 1;
        items.forEach(it => {
          const thumb = el('div', { class: 'ed-sprite-item' + (it.n === cur ? ' active' : '') }, [
            el('img', { src: it.src, class: 'ed-sprite-thumb' }),
            el('span', { class: 'ed-sprite-label' }, ['表情 ' + it.n]),
          ]);
          thumb.addEventListener('click', () => {
            entry.expr = it.n;
            markDirty();
            grid.querySelectorAll('.ed-sprite-item').forEach(x => x.classList.toggle('active', x === thumb));
          });
          grid.appendChild(thumb);
        });
        if (hasTemplate) {
          grid.appendChild(el('div', { class: 'ed-hint' }, ['点击选择默认立绘（写为 expr=N）；每句对话仍可用 alice(2) 临时换表情。']));
        }
      }

      if (resMatch) {
        // resource character: enumerate uploaded sprites
        const c = app.resources.getCharacter(resMatch[1]);
        const items = c ? Object.keys(c.sprites).map(Number).sort((a, b) => a - b)
          .map(n => ({ n, src: c.sprites[String(n)] })) : [];
        render(items);
      } else if (hasTemplate) {
        // file template: probe a few expressions, stop after 2 consecutive misses
        const items = [];
        let pending = 0, misses = 0, done = false;
        const base = pattern.replace(/\{id\}/g, entry.id);
        const finish = () => { if (!done) { done = true; render(items); } };
        for (let k = 1; k <= 8 && !done; k++) {
          pending++;
          app.loadSprite(base.replace(/\{expr\}/g, String(k)), (img) => {
            pending--;
            if (done) return;
            if (img) { items.push({ n: k, src: img.src }); misses = 0; }
            else { misses++; if (misses >= 2) { finish(); return; } }
            if (pending === 0) finish();
          });
        }
      } else {
        // fixed pattern: show the single sprite as a preview
        app.loadSprite(pattern.replace(/\{id\}/g, entry.id), (img) => {
          grid.innerHTML = '';
          if (img) {
            grid.appendChild(el('div', { class: 'ed-sprite-item active' }, [
              el('img', { src: img.src, class: 'ed-sprite-thumb' }),
              el('span', { class: 'ed-sprite-label' }, ['当前立绘']),
            ]));
          } else {
            grid.appendChild(el('div', { class: 'ed-hint' }, ['立绘未找到；模板需包含 {expr} 才能选择表情。']));
          }
        });
      }
    }

    /* ---- choice / jump / actor / directive forms ---- */

    function buildChoiceForm(body, entry) {
      entry.choices.forEach((c, i) => {
        const row = el('div', { class: 'ed-row' }, []);
        const t = el('input', { class: 'ed-input ed-grow', type: 'text', value: c.text, placeholder: '选项文案' });
        t.addEventListener('input', () => { c.text = t.value; markDirty(); });
        t.addEventListener('keydown', applyOnEnter);
        row.appendChild(el('span', { class: 'ed-arrow' }, ['→']));
        const l = el('input', { class: 'ed-input ed-label-input', type: 'text', value: c.target, placeholder: '目标标签' });
        l.addEventListener('input', () => { c.target = l.value; markDirty(); });
        l.addEventListener('keydown', applyOnEnter);
        row.appendChild(l);
        const rm = el('button', { class: 'btn btn-small btn-danger' }, ['×']);
        rm.addEventListener('click', () => { entry.choices.splice(i, 1); if (!entry.choices.length) entry.choices.push({ text: '', target: '' }); markDirty(); });
        row.appendChild(rm);
        row.insertBefore(t, row.firstChild);
        body.appendChild(row);
      });
      const add = el('button', { class: 'btn btn-small' }, ['＋ 选项']);
      add.addEventListener('click', () => { entry.choices.push({ text: '', target: '' }); markDirty(); });
      body.appendChild(add);
      body.appendChild(el('div', { class: 'ed-hint' }, ['连续多个选项组成一个选择菜单；点选后跳转到对应标签。']));
    }

    function buildJumpForm(body, entry) {
      const inp = el('input', { class: 'ed-input', type: 'text', value: entry.label, placeholder: '目标标签（end = 直接结束）' });
      inp.addEventListener('input', () => { entry.label = inp.value; markDirty(); });
      inp.addEventListener('keydown', applyOnEnter);
      body.appendChild(fieldRow('跳转到', inp));
    }

    function buildActorForm(body, entry) {
      const nameInp = el('input', { class: 'ed-input', type: 'text', value: entry.name });
      nameInp.addEventListener('input', () => { entry.name = nameInp.value; markDirty(); });
      nameInp.addEventListener('keydown', applyOnEnter);
      body.appendChild(fieldRow('显示名', nameInp));

      const sideSel = makeSelect(
        [['left', '左侧'], ['right', '右侧']].map(([v, l]) => ({ value: v, label: l })),
        entry.side,
        (v) => { entry.side = v; markDirty(); }
      );
      body.appendChild(fieldRow('方向', sideSel));

      const slotSel = makeSelect(
        [['0', '前 (front)'], ['1', '后 (back)'], ['2', '槽位2'], ['3', '槽位3']].map(([v, l]) => ({ value: v, label: l })),
        String(entry.slot),
        (v) => { entry.slot = parseInt(v, 10); markDirty(); }
      );
      body.appendChild(fieldRow('槽位（同侧多人）', slotSel));

      // horizontal flip: auto (follow @mirrorleft) / always / never
      const flipSel = makeSelect(
        [['', '自动（跟随 @mirrorleft）'], ['1', '水平翻转'], ['0', '不翻转']].map(([v, l]) => ({ value: v, label: l })),
        entry.flipMode === true ? '1' : entry.flipMode === false ? '0' : '',
        (v) => { entry.flipMode = v === '' ? null : v === '1'; markDirty(); }
      );
      body.appendChild(fieldRow('水平翻转', flipSel));

      const patInp = el('input', { class: 'ed-input', type: 'text', value: entry.pattern });
      patInp.addEventListener('input', () => { entry.pattern = patInp.value; markDirty(); });
      patInp.addEventListener('keydown', applyOnEnter);
      body.appendChild(fieldRow('立绘模板', patInp));
      body.appendChild(el('div', { class: 'ed-hint' }, ['模板占位符：{id} = 角色id，{expr} = 表情编号。资源角色用 chara://角色id/{expr}']));

      // sprite picker: choose the default sprite (sets expr=N) from the character's sprites
      buildSpritePicker(body, entry);

      const chars = app.resources.allCharacters();
      if (chars.length) {
        const pick = makeSelect(
          [{ value: '', label: '—— 从资源角色套用 ——' }].concat(chars.map(c => ({ value: c.id, label: c.name + '（' + c.id + '）' }))),
          '',
          (v) => {
            if (!v) return;
            const c = app.resources.getCharacter(v);
            if (c) {
              entry.name = c.name;
              entry.side = c.defaultSide;
              entry.pattern = 'chara://' + c.id + '/{expr}';
              markDirty();
            }
          }
        );
        body.appendChild(fieldRow('从资源选择', pick));
      }
    }

    function buildBgForm(body, entry) {
      const locSel = makeSelect(
        [{ value: '__builtin__', label: '内置背景 (assets/bg)' }].concat(app.resources.allLocations().map(l => ({ value: l.id, label: l.name + '（' + l.id + '）' }))),
        '__builtin__',
        () => {} // real handler below
      );
      const variantSel = el('select', { class: 'ed-input ed-grow' });
      const customInp = el('input', { class: 'ed-input', type: 'text', value: '', placeholder: '或直接输入路径（如 assets/bg/xxx.jpg）' });

      function updateVariant(initial) {
        variantSel.innerHTML = '';
        if (locSel.value === '__builtin__') {
          app.builtinBgs.forEach(b => variantSel.appendChild(el('option', { value: b }, [b])));
        } else {
          const l = app.resources.getLocation(locSel.value);
          if (!l) {
            // location was deleted while the form was open — fall back to builtin
            locSel.value = '__builtin__';
            app.builtinBgs.forEach(b => variantSel.appendChild(el('option', { value: b }, [b])));
          } else {
            (Object.keys(l.images)).forEach(k => variantSel.appendChild(el('option', { value: 'loc://' + l.id + '/' + k }, [(l.images[k].name || k)])));
          }
        }
        const opts = Array.from(variantSel.options).map(o => o.value);
        if (opts.includes(entry.value)) variantSel.value = entry.value;
        else variantSel.value = opts[0] || '';
        if (!initial) onPick();
      }

      function onPick() {
        entry.value = variantSel.value || customInp.value;
        markDirty();
      }

      variantSel.addEventListener('change', onPick);
      customInp.addEventListener('input', () => {
        if (customInp.value) { entry.value = customInp.value; markDirty(); }
      });
      customInp.addEventListener('keydown', applyOnEnter);

      locSel.addEventListener('change', () => updateVariant(false));
      const locRow = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['地点']), locSel]);
      body.appendChild(locRow);
      const varRow = el('div', { class: 'ed-row' }, [el('label', { class: 'ed-label' }, ['画面/变体']), variantSel]);
      body.appendChild(varRow);
      body.appendChild(fieldRow('自定义路径', customInp));
      updateVariant(true);
    }

    function buildLabelForm(body, entry) {
      const inp = el('input', { class: 'ed-input', type: 'text', value: entry.value, placeholder: '标签名' });
      inp.addEventListener('input', () => { entry.value = inp.value; markDirty(); });
      inp.addEventListener('keydown', applyOnEnter);
      body.appendChild(fieldRow('标签名', inp));
    }

    // bgm / sfx directive form: pick from resource store or type a path
    function buildAudioForm(body, entry) {
      const isBgm = entry.key === 'bgm';
      const items = isBgm ? app.resources.allBgms() : app.resources.allSfx();
      const scheme = isBgm ? 'bgm://' : 'sfx://';

      const sel = makeSelect(
        [{ value: '', label: '—— 从资源选择 ——' }].concat(items.map(x => ({ value: x.id, label: x.name + '（' + x.id + '）' }))),
        '',
        (v) => {
          if (!v) return;
          entry.value = scheme + v;
          markDirty();
          if (isBgm) app.previewBgm(v); else app.previewSfx(v);
        }
      );
      body.appendChild(fieldRow(isBgm ? '音乐' : '音效', sel));

      const pathInp = el('input', {
        class: 'ed-input', type: 'text', value: entry.value,
        placeholder: isBgm ? 'bgm://id 或文件路径（如 assets/audio/x.mp3）；off = 停止' : 'sfx://id 或文件路径',
      });
      pathInp.addEventListener('input', () => { entry.value = pathInp.value; markDirty(); });
      pathInp.addEventListener('keydown', applyOnEnter);
      body.appendChild(fieldRow('路径', pathInp));

      if (isBgm) {
        const offBtn = el('button', { class: 'btn btn-small' }, ['停止背景音乐 (off)']);
        offBtn.addEventListener('click', () => { entry.value = 'off'; markDirty(); });
        body.appendChild(offBtn);
      }
      body.appendChild(el('div', { class: 'ed-hint' }, [isBgm
        ? '到达本行时开始循环播放；音乐可在"资源"页上传管理并打包分享。'
        : '到达本行时播放一次；音效可在"资源"页上传管理并打包分享。']));
    }

    function buildRawForm(body, entry) {
      const inp = el('input', { class: 'ed-input', type: 'text', value: entry.raw || '' });
      inp.addEventListener('input', () => { entry.raw = inp.value; markDirty(); });
      inp.addEventListener('keydown', applyOnEnter);
      body.appendChild(fieldRow('原始文本', inp));
      if (entry.kind === 'error') body.appendChild(el('div', { class: 'ed-hint ed-error-text' }, ['错误：' + (entry.msg || '')]));
      if (entry.kind === 'blank') body.appendChild(el('div', { class: 'ed-hint' }, ['空行（保留排版用）']));
      if (entry.kind === 'comment') body.appendChild(el('div', { class: 'ed-hint' }, ['注释行']));
    }

    function buildForm(body, entry) {
      switch (entry.kind) {
        case 'speech': return buildSpeechForm(body, entry);
        case 'choice': return buildChoiceForm(body, entry);
        case 'jump': return buildJumpForm(body, entry);
        case 'actor': return buildActorForm(body, entry);
        case 'directive':
          if (entry.key === 'bg') return buildBgForm(body, entry);
          if (entry.key === 'label') return buildLabelForm(body, entry);
          if (entry.key === 'bgm' || entry.key === 'sfx') return buildAudioForm(body, entry);
          return buildRawForm(body, entry);
        default:
          return buildRawForm(body, entry);
      }
    }

    /* ---------------- public ---------------- */

    editor.refresh = function () {
      renderList();
      renderForm();
    };

    editor.select = function (i) {
      if (i >= 0 && i < app.entries.length) app.selectedIdx = i;
      editor.refresh();
    };

    // used by app.selectEntry: apply pending draft before switching lines
    editor.hasPending = function () { return !!draft && dirty; };
    editor.applyPending = function () { if (editor.hasPending()) applyDraft(); };

    return editor;
  }

  return { create };
});
