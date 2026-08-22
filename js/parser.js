/* parser.js — Script DSL parser for the Dialogue Generator.
 * Pure JS, no DOM dependency: runs in browser (window.DGParser) and Node (module.exports).
 *
 * Two layers:
 *   1. parseDocument(text) -> { entries, errors, settings }
 *        comment/blank-preserving line model (the WYSIWYG editor works on this).
 *      serializeEntries(entries) -> text   (round-trips the DSL)
 *   2. parse(text) -> { settings, ops, errors, entries, opIndexes }
 *        flat op timeline for the player; entries carry _opIdx (their op index).
 *
 * DSL overview (see README.md for the full reference):
 *
 *   // comments
 *   @bg    <image path>            scene background (assets/bg/... or custom path)
 *   @title <text>                  scene title (metadata)
 *   @label <name>                  jump target
 *   @end                           stop playback
 *   @shownames on|off              name tags on bubbles
 *   @mirrorleft on|off             mirror left-side sprites to face inward
 *   @wrap on|off                   auto-wrap long text
 *   @fontsize <px>                 bubble text size
 *   @speed <ms>                    typing speed (ms per char, 0 = instant)
 *   @autodelay <ms>                auto-advance delay after text completes (0 = wait)
 *   @slotgap <px>                  overlap between stacked actors on one side
 *   @exportscale <n>               PNG export scale (1 = 667x500, 2 = 1334x1000)
 *   @trans on|off                  step transition animation (default on)
 *   @transdur <ms>                 transition duration (default 380)
 *   @transdist <px>                transition travel distance (default 110)
 *   @bgm <path|off>                background music (bgm://id or file path; loops)
 *   @sfx <path>                    sound effect, played once
 *
 *   !actor <id> = <name> | <left|right> | <front|back|slot0..3> | <pattern>
 *       pattern placeholders: {id} and {expr}, e.g. sprites/{id}{expr}.png
 *   !actor on|off <id>             show/hide an actor
 *   !sprite <id> <expr>            change actor's current sprite/expression
 *
 *   speaker{attrs}: text           dialogue line (attrs comma-separated k=v)
 *   a+b{attrs}: text               multiple speakers share one bubble
 *   *{attrs} text                  narration (no name tag, centered, no flip)
 *   ++ a: text || b{box=thought}: text    two bubbles at once (back || front)
 *   ? 文案 -> <label>              choice option (consecutive ? lines = menu)
 *   -> <label>                     unconditional jump
 *
 *   attrs: box=default|thought|wiggly|loud, expr=<n>, flip=auto|0|1,
 *          speed=<ms>, name=<override>, side=left|right, voice=<n> (speaker's voice)
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DGParser = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const BOX_TYPES = ['default', 'thought', 'wiggly', 'loud'];
  const SIDES = ['left', 'right'];

  const DEFAULT_SETTINGS = {
    shownames: true,
    mirrorleft: true,
    wrap: true,
    fontsize: 20,
    speed: 28,          // ms per character
    autodelay: 0,       // 0 = wait for player input
    slotgap: 40,        // px overlap between stacked actors on one side
    exportscale: 2,
    trans: true,        // bubble transition animation between steps
    transdur: 380,      // transition duration (ms)
    transdist: 110,     // vertical travel distance (px) of the transition
  };

  const SETOPT_KEYS = {
    shownames: 'bool', mirrorleft: 'bool', wrap: 'bool',
    fontsize: 'num', speed: 'num', autodelay: 'num', slotgap: 'num', exportscale: 'num',
    trans: 'bool', transdur: 'num', transdist: 'num',
  };

  /* ============================================================
   * Layer 1 — document model (comment/blank preserving)
   * ============================================================ */

  function parseDocument(text) {
    const settings = Object.assign({}, DEFAULT_SETTINGS);
    const entries = [];
    const errors = [];
    const rawLines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);

    let i = 0;
    while (i < rawLines.length) {
      const lineNo = i + 1;
      const line = rawLines[i].trim();
      i++;

      if (!line) { entries.push({ kind: 'blank', raw: '' }); continue; }
      if (line.startsWith('//') || line.startsWith('#')) { entries.push({ kind: 'comment', raw: line }); continue; }

      try {
        if (line.startsWith('@')) {
          entries.push(parseDirectiveEntry(line.slice(1).trim(), lineNo, settings));
        } else if (line.startsWith('!')) {
          entries.push(parseActorEntry(line.slice(1).trim(), lineNo));
        } else if (line.startsWith('->')) {
          const label = line.slice(2).trim();
          if (!label) throw new Error('jump needs a target label');
          entries.push({ kind: 'jump', label, lineNo });
        } else if (line.startsWith('?')) {
          const choices = [];
          while (true) {
            const cur = rawLines[i - 1].trim();
            if (!cur.startsWith('?')) break;
            const m = /^\?\s*(.*?)\s*->\s*(\S+)\s*$/.exec(cur);
            if (!m) throw new Error('choice format: ? 文案 -> label');
            choices.push({ text: m[1], target: m[2] });
            if (i < rawLines.length && rawLines[i].trim().startsWith('?')) { i++; continue; }
            break;
          }
          entries.push({ kind: 'choice', choices, lineNo });
        } else if (line.startsWith('++')) {
          entries.push(parseDualSpeechEntry(line.slice(2).trim(), lineNo));
        } else if (line.startsWith('*')) {
          entries.push(parseSpeechEntry(line.slice(1).trim(), lineNo, true));
        } else {
          entries.push(parseSpeechEntry(line, lineNo, false));
        }
      } catch (e) {
        errors.push({ line: lineNo, raw: line, msg: e.message });
        entries.push({ kind: 'error', raw: line, msg: e.message, lineNo });
      }
    }
    return { entries, errors, settings };
  }

  /* ---------- entry parsers ---------- */

  function parseDirectiveEntry(rest, lineNo, settings) {
    const sp = rest.search(/\s/);
    const key = sp === -1 ? rest : rest.slice(0, sp);
    const value = sp === -1 ? '' : rest.slice(sp + 1).trim();

    switch (key) {
      case 'bg':
        if (!value) throw new Error('@bg needs an image path');
        return { kind: 'directive', key, value, lineNo };
      case 'title':
        return { kind: 'directive', key, value, lineNo };
      case 'label':
        // empty allowed (editor placeholder state) — becomes a no-op op
        return { kind: 'directive', key, value, lineNo };
      case 'bgm':
        return { kind: 'directive', key, value: value || 'off', lineNo };
      case 'sfx':
        // empty value allowed (editor placeholder state) — becomes a no-op op
        return { kind: 'directive', key, value, lineNo };
      case 'end':
        return { kind: 'directive', key: 'end', value: '', lineNo };
      default:
        if (key in SETOPT_KEYS) {
          let v;
          if (SETOPT_KEYS[key] === 'bool') {
            if (!/^(on|off|true|false|1|0)$/i.test(value)) throw new Error('@' + key + ' expects on|off');
            v = /^(on|true|1)$/i.test(value);
          } else {
            v = Number(value);
            if (Number.isNaN(v)) throw new Error('@' + key + ' expects a number');
          }
          settings[key] = v;
          return { kind: 'directive', key, value, lineNo, rawValue: value };
        }
        throw new Error('unknown directive @' + key);
    }
  }

  function parseActorEntry(rest, lineNo) {
    const toks = rest.split(/\s+/);
    const cmd = toks[0];
    if (cmd === 'sprite') {
      const id = toks[1], expr = parseInt(toks[2], 10);
      if (!id || Number.isNaN(expr)) throw new Error('!sprite needs: !sprite <id> <expr>');
      return { kind: 'sprite', id, expr, lineNo };
    }
    if (cmd === 'actor') {
      const sub = toks[1];
      if (sub === 'on' || sub === 'off') {
        const id = toks[2];
        if (!id) throw new Error('!actor ' + sub + ' needs an actor id');
        return { kind: 'actorCmd', cmd: sub, id, lineNo };
      }
      const id = sub;
      if (!id) throw new Error('!actor needs an id');
      let restFields = rest.slice('actor'.length).trim();
      if (restFields.startsWith('=')) restFields = restFields.slice(1).trim();
      restFields = restFields.slice(id.length).trim();
      if (restFields.startsWith('=')) restFields = restFields.slice(1).trim();
      const fields = restFields.includes('|')
        ? restFields.split('|').map(s => s.trim()).filter(Boolean)
        : restFields.split(/\s+/).filter(Boolean);
      if (fields.length === 0) throw new Error('!actor needs: !actor <id> = <name> | <side> | <slot> | <pattern>');

      let name = fields[0];
      let side = null, slot = null, pattern = null, flipMode, expr;
      for (const f of fields.slice(1)) {
        if (SIDES.includes(f)) side = f;
        else if (/^(front|back)$/i.test(f)) slot = f === 'front' ? 0 : 1;
        else if (/^slot\d+$/i.test(f)) slot = parseInt(f.slice(4), 10);
        else if (/\.(png|jpe?g|gif|webp)$/i.test(f) || f.indexOf('://') !== -1) pattern = f;
        else if (f === 'flip') flipMode = true;
        else if (f === 'noflip') flipMode = false;
        else if (/^expr=(\d+)$/i.test(f)) expr = parseInt(/^expr=(\d+)$/i.exec(f)[1], 10);
        else throw new Error('!actor unknown field: "' + f + '" (side/slot/pattern/flip/expr expected)');
      }
      return { kind: 'actor', id, name: name, side: side || 'left', slot: slot === null ? 0 : slot, pattern: pattern || 'sprites/{id}{expr}.png', flipMode: flipMode === undefined ? null : flipMode, expr: expr === undefined ? null : expr, lineNo };
    }
    throw new Error('unknown command !' + cmd);
  }

  // "speakers{attrs}: text" | "{attrs}: text" | ": text" | narration "text"
  function parseSpeechEntry(rest, lineNo, isNarration) {
    let s = rest.trim();
    let attrsStr = null;

    const attrMatch = /^\{([^}]*)\}\s*/.exec(s);
    if (attrMatch) {
      attrsStr = attrMatch[1];
      s = s.slice(attrMatch[0].length);
    }

    let speakersStr = '';
    let text;
    const colonIdx = findColon(s);
    if (colonIdx === -1) {
      if (isNarration) {
        text = s;
      } else {
        throw new Error('missing ":" after speaker — format: id{attrs}: text');
      }
    } else {
      speakersStr = s.slice(0, colonIdx).trim();
      text = s.slice(colonIdx + 1).trim();
    }

    const braceStart = speakersStr.indexOf('{');
    if (braceStart !== -1) {
      if (!speakersStr.endsWith('}')) throw new Error('unbalanced { } in speaker attrs');
      const trailing = speakersStr.slice(braceStart + 1, -1);
      attrsStr = [attrsStr, trailing].filter(Boolean).join(',');
      speakersStr = speakersStr.slice(0, braceStart).trim();
    }

    const attrs = parseAttrs(attrsStr);

    const speakers = [];
    if (!isNarration && speakersStr) {
      for (const part of speakersStr.split('+')) {
        const p = part.trim();
        if (!p) throw new Error('empty speaker in list');
        const m = /^([A-Za-z0-9_\-\u4e00-\u9fff]+)(?:\((\d+)\))?$/.exec(p);
        if (!m) throw new Error('bad speaker token: "' + p + '"');
        speakers.push({ id: m[1], expr: m[2] !== undefined ? parseInt(m[2], 10) : null });
      }
    }

    const box = attrs.box || 'default';
    if (!BOX_TYPES.includes(box)) throw new Error('unknown box type: "' + box + '" (default|thought|wiggly|loud)');

    const flip = attrs.flip !== undefined
      ? (attrs.flip === 'auto' ? 'auto' : attrs.flip === '1' ? true : false)
      : 'auto';

    const bubble = {
      speakers,
      text,
      box,
      flip,
      side: attrs.side || null,
      expr: attrs.expr !== undefined ? parseInt(attrs.expr, 10) : null,
      name: attrs.name !== undefined ? attrs.name : null,
      speed: attrs.speed !== undefined ? Number(attrs.speed) : null,
      voice: attrs.voice !== undefined ? parseInt(attrs.voice, 10) : null,
      narration: !!isNarration,
    };
    if (bubble.expr !== null && Number.isNaN(bubble.expr)) throw new Error('expr must be a number');
    if (bubble.speed !== null && Number.isNaN(bubble.speed)) throw new Error('speed must be a number');
    if (bubble.voice !== null && Number.isNaN(bubble.voice)) throw new Error('voice must be a number');

    return { kind: 'speech', bubbles: [bubble], lineNo };
  }

  // "++ a: t1 || b: t2" — two bubbles at once (back || front)
  function parseDualSpeechEntry(s, lineNo) {
    const parts = s.split('||');
    if (parts.length !== 2) throw new Error('dual-bubble format: ++ a: text || b: text');
    const first = parseSpeechEntry(parts[0].trim(), lineNo, false);
    const second = parseSpeechEntry(parts[1].trim(), lineNo, false);
    return { kind: 'speech', bubbles: [first.bubbles[0], second.bubbles[0]], lineNo };
  }

  // first ':' outside {braces}
  function findColon(s) {
    let depth = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ':' && depth === 0) return k;
    }
    return -1;
  }

  function parseAttrs(str) {
    const out = {};
    if (!str) return out;
    for (const pair of str.split(',')) {
      const kv = pair.split('=');
      if (kv.length !== 2 || !kv[0].trim()) throw new Error('bad attribute: "' + pair + '" (k=v)');
      out[kv[0].trim()] = kv[1].trim();
    }
    return out;
  }

  /* ---------- serialization (entries -> DSL text) ---------- */

  function serializeEntries(entries) {
    return entries.map(serializeEntry).join('\n');
  }

  function serializeEntry(e) {
    switch (e.kind) {
      case 'blank': return '';
      case 'comment': return e.raw;
      case 'error': return e.raw;
      case 'jump': return '-> ' + e.label;
      case 'directive':
        if (e.key === 'end') return '@end';
        return '@' + e.key + (e.value ? ' ' + e.value : '');
      case 'actorCmd':
        return '!actor ' + e.cmd + ' ' + e.id;
      case 'sprite':
        return '!sprite ' + e.id + ' ' + e.expr;
      case 'actor':
        return '!actor ' + e.id + ' = ' + e.name + ' | ' + e.side + ' | ' + (e.slot <= 1 ? (e.slot === 0 ? 'front' : 'back') : 'slot' + e.slot) + ' | ' + e.pattern +
          (e.flipMode === true ? ' | flip' : e.flipMode === false ? ' | noflip' : '') +
          (e.expr ? ' | expr=' + e.expr : '');
      case 'speech':
        if (e.bubbles.length === 2) return '++ ' + serBubble(e.bubbles[0]) + ' || ' + serBubble(e.bubbles[1]);
        return serBubble(e.bubbles[0]);
      case 'choice':
        return e.choices.map(c => '? ' + c.text + ' -> ' + c.target).join('\n');
      default:
        return '';
    }
  }

  function serBubble(b) {
    const speakers = (b.speakers || []).map(sp => sp.expr ? sp.id + '(' + sp.expr + ')' : sp.id).join('+');
    const attrs = [];
    if (b.box && b.box !== 'default') attrs.push('box=' + b.box);
    if (b.flip === true) attrs.push('flip=1');
    else if (b.flip === false) attrs.push('flip=0');
    if (b.side) attrs.push('side=' + b.side);
    if (b.name) attrs.push('name=' + b.name);
    if (b.speed !== null && b.speed !== undefined) attrs.push('speed=' + b.speed);
    if (b.voice !== null && b.voice !== undefined) attrs.push('voice=' + b.voice);
    const a = attrs.length ? '{' + attrs.join(',') + '}' : '';
    if (b.narration) return (a ? a + ' ' : '') + '* ' + b.text;
    return (speakers ? speakers + a + ': ' : a + ': ') + b.text;
  }

  /* ============================================================
   * Layer 2 — op timeline (player input)
   * ============================================================ */

  function buildOps(entries) {
    const ops = [];
    const errors = [];
    const opIndexes = [];
    entries.forEach((entry) => {
      const lineNo = entry.lineNo;
      switch (entry.kind) {
        case 'blank': case 'comment': case 'error':
          opIndexes.push(null);
          break;
        case 'directive':
          if (entry.key === 'label') {
            if (entry.value) {
              ops.push({ op: 'label', name: entry.value, lineNo });
              opIndexes.push(ops.length - 1);
            } else {
              opIndexes.push(null); // empty label = no-op (editor placeholder)
            }
            break;
          }
          if (entry.key === 'end') ops.push({ op: 'end', lineNo });
          else if (entry.key === 'bg') ops.push({ op: 'bg', path: entry.value, lineNo });
          else if (entry.key === 'title') ops.push({ op: 'title', text: entry.value, lineNo });
          else if (entry.key === 'bgm') ops.push({ op: 'bgm', path: entry.value === 'off' ? null : entry.value, lineNo });
          else if (entry.key === 'sfx') ops.push({ op: 'sfx', path: entry.value || null, lineNo });
          else if (entry.key in SETOPT_KEYS) ops.push({ op: 'setopt', key: entry.key, value: entry.rawValue !== undefined ? (SETOPT_KEYS[entry.key] === 'bool' ? /^(on|true|1)$/i.test(entry.rawValue) : Number(entry.rawValue)) : entry.value, lineNo });
          else { errors.push({ line: lineNo, msg: 'unknown directive @' + entry.key }); opIndexes.push(null); break; }
          opIndexes.push(ops.length - 1);
          break;
        case 'actor':
          ops.push({ op: 'actor', id: entry.id, name: entry.name, side: entry.side, slot: entry.slot, pattern: entry.pattern, flipMode: entry.flipMode, expr: entry.expr, lineNo });
          opIndexes.push(ops.length - 1);
          break;
        case 'actorCmd':
          ops.push({ op: entry.cmd === 'on' ? 'actorOn' : 'actorOff', id: entry.id, lineNo });
          opIndexes.push(ops.length - 1);
          break;
        case 'sprite':
          ops.push({ op: 'sprite', id: entry.id, expr: entry.expr, lineNo });
          opIndexes.push(ops.length - 1);
          break;
        case 'speech':
          ops.push({ op: 'speech', bubbles: entry.bubbles, lineNo });
          opIndexes.push(ops.length - 1);
          break;
        case 'choice':
          ops.push({ op: 'choice', choices: entry.choices, lineNo });
          opIndexes.push(ops.length - 1);
          break;
        case 'jump':
          ops.push({ op: 'jump', label: entry.label, lineNo });
          opIndexes.push(ops.length - 1);
          break;
        default:
          opIndexes.push(null);
      }
    });
    return { ops, errors, opIndexes };
  }

  /* ---------- public API ---------- */

  function parse(text) {
    const doc = parseDocument(text);
    const built = buildOps(doc.entries);
    // stamp entries with their op index (null when they emit no op)
    doc.entries.forEach((e, i) => { e._opIdx = built.opIndexes[i]; });
    return {
      settings: doc.settings,
      ops: built.ops,
      errors: doc.errors.concat(built.errors),
      entries: doc.entries,
      opIndexes: built.opIndexes,
    };
  }

  function indexLabels(ops) {
    const labels = {};
    ops.forEach((op, idx) => {
      if (op.op === 'label') labels[op.name] = idx;
    });
    return labels;
  }

  return {
    parse, parseDocument, serializeEntries, serializeEntry, indexLabels,
    BOX_TYPES, SIDES, DEFAULT_SETTINGS, SETOPT_KEYS,
  };
});
