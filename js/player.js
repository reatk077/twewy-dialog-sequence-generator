/* player.js — Interactive sequence player (state machine over parsed ops).
 * Handles: scene state (bg / actors / options), typewriter text,
 * choices + label jumps, prev/seek/restart, and frame export (single + batch).
 *
 * UI integration: set player.onRender = (state, display) => {}   (draw canvas)
 *                set player.onChange = (info) => {}              (update UI)
 * info: { index, lineNo, total, title, finished, choices, typing, canPrev, canNext }
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DGPlayer = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const MAX_STEPS = 20000; // jump loop guard

  const DEFAULT_ACTOR_COEFF = 0.85;

  function create(playerOptions) {
    playerOptions = playerOptions || {};

    const player = {
      ops: [],
      labels: {},
      settings: null,
      state: null,        // scene state (see resetState)
      cursor: 0,          // index of next op to execute
      display: null,      // { bubbles, choices }
      snapshots: [],      // [{opIndex, state}]
      finished: false,
      typing: false,
      shownText: null,
      transition: null,   // { from, to, start, progress, dur, dist } — step transition anim
      _prevDisplay: null, // last presented display (for transition 'from')
      _rafId: null,
      _allowTransition: true,
      _audio: null,       // { playBgm(path), stopBgm(), playSfx(path), playVoice(actorId, n) }
      _suppressAudio: false,
      _typingTimer: null,
      _autoTimer: null,

      onRender: playerOptions.onRender || null,
      onChange: playerOptions.onChange || null,
      onError: playerOptions.onError || null,

      /* -------- loading -------- */

      load(parsed) {
        this.ops = parsed.ops || [];
        this.settings = Object.assign({}, parsed.settings || {});
        this.labels = {};
        this.ops.forEach((op, i) => { if (op.op === 'label') this.labels[op.name] = i; });
        this.resetState();
        this.cursor = 0;
        this.snapshots = [];
        this.finished = false;
        this._emitChange();
      },

      resetState() {
        // stop any lingering BGM (scene state is being reset; the @bgm op will
        // re-apply it if the replayed position reaches that line)
        if (this._audio && this._audio.stopBgm && !this._suppressAudio) this._audio.stopBgm();
        // static assets (bubble images) survive scene resets
        const prev = this.state ? this.state.bubbles : null;
        this._prevDisplay = null;
        this.state = {
          bgPath: null,
          bgImg: null,
          bgmPath: null,
          title: '',
          opts: Object.assign({}, this.settings || {}),
          actors: new Map(),
          bubbles: prev,   // {default: img, thought: img, wiggly: img, loud: img}
        };
      },

      /* -------- core ops -------- */

      // apply one op's state changes; returns a display object if it needs presentation
      applyOpState(op) {
        const s = this.state;
        switch (op.op) {
          case 'bg':
            s.bgPath = op.path;
            s.bgImg = null;
            if (this._bgLoader) this._bgLoader(op.path, (img) => { if (s.bgPath === op.path) { s.bgImg = img; this._render(); } });
            return null;
          case 'bgm':
            s.bgmPath = op.path || null;
            if (!this._suppressAudio && this._audio) {
              if (op.path) { if (this._audio.playBgm) this._audio.playBgm(op.path); }
              else if (this._audio.stopBgm) this._audio.stopBgm();
            }
            return null;
          case 'sfx':
            if (!this._suppressAudio && op.path && this._audio && this._audio.playSfx) this._audio.playSfx(op.path);
            return null;
          case 'title':
            s.title = op.text;
            return null;
          case 'setopt':
            s.opts[op.key] = op.value;
            return null;
          case 'actor': {
            const a = s.actors.get(op.id) || {
              id: op.id, name: op.id, side: 'left', slot: 0,
              pattern: 'sprites/{id}{expr}.png', expr: 1,
              coeff: DEFAULT_ACTOR_COEFF, visible: true, img: null, flip: null, xform: null,
            };
            if (op.name !== null && op.name !== undefined) a.name = op.name;
            if (op.side !== null && op.side !== undefined) a.side = op.side;
            if (op.slot !== null && op.slot !== undefined) a.slot = op.slot;
            if (op.pattern) a.pattern = op.pattern;
            a.flip = op.flipMode === true || op.flipMode === false ? op.flipMode : null;
            if (op.expr) a.expr = op.expr; // default expression from !actor expr=N
            a.visible = true;
            s.actors.set(op.id, a);
            this._loadActorSprite(a);
            return null;
          }
          case 'actorOn':
            if (s.actors.has(op.id)) { s.actors.get(op.id).visible = true; this._render(); }
            return null;
          case 'actorOff':
            if (s.actors.has(op.id)) { s.actors.get(op.id).visible = false; this._render(); }
            return null;
          case 'sprite':
            if (s.actors.has(op.id)) {
              const a = s.actors.get(op.id);
              a.expr = op.expr;
              this._loadActorSprite(a);
              this._render();
            } else if (this.onError) {
              this.onError('!sprite: unknown actor "' + op.id + '"');
            }
            return null;
          case 'label':
            return null;
          case 'jump':
            return null; // handled by advance loop
          case 'end':
            return null;
          case 'speech': {
            // apply per-bubble speaker expr changes atomically
            (op.bubbles || []).forEach(b => {
              (b.speakers || []).forEach(sp => {
                const expr = sp.expr !== null ? sp.expr : (b.expr !== null ? b.expr : null);
                if (expr !== null && this.state.actors.has(sp.id)) {
                  const a = this.state.actors.get(sp.id);
                  if (a.expr !== expr) { a.expr = expr; this._loadActorSprite(a); }
                }
              });
            });
            this._render();
            return op; // needs presentation (typewriter)
          }
          case 'choice':
            this._render();
            return op;
          default:
            return null;
        }
      },

      // advance through ops until something needs presentation or we stop
      _advanceRaw(steps) {
        let stepsLeft = steps;
        while (this.cursor < this.ops.length) {
          if (steps !== Infinity) {
            if (stepsLeft-- <= 0) break;
          }
          const op = this.ops[this.cursor];
          this.cursor++;
          if (op.op === 'jump') {
            if (op.label === 'end') { // convention: jump to "end" finishes the sequence
              this.finished = true;
              this._emitChange();
              return null;
            }
            const target = this.labels[op.label];
            if (target === undefined) {
              if (this.onError) this.onError('jump to unknown label "' + op.label + '"');
              break;
            }
            this.cursor = target;
            continue;
          }
          if (op.op === 'end') {
            this.finished = true;
            this._emitChange();
            return null;
          }
          const d = this.applyOpState(op);
          if (d) return d;
        }
        if (this.cursor >= this.ops.length && !this.finished) {
          this.finished = true;
          this._emitChange();
        }
        return null;
      },

      /* -------- presentation -------- */

      present(display) {
        const animate = this._allowTransition;
        this._allowTransition = true;
        const prev = this._prevDisplay || null;
        this._prevDisplay = display;
        this.display = display;
        this._clearTimers();

        // step transition: previous bubble(s) slide up & fade (fast-start ease-out),
        // new bubble(s) rise from below-center into the dialogue position.
        const opts = this.state.opts;
        const canAnim = animate && opts.trans &&
          display.op === 'speech' &&
          prev && (prev.op === 'speech' || prev.op === 'choice');
        if (canAnim) {
          this.transition = {
            from: prev,
            to: display,
            start: 0,
            progress: 0,
            dur: opts.transdur || 380,
            dist: opts.transdist || 110,
          };
        } else {
          this.transition = null;
        }

        if (display.op === 'choice') {
          this.typing = false;
          this.shownText = null;
          this._emitChange();
          this._render();
          this._startAnim();
          return;
        }
        // speech
        const bubbles = display.bubbles || [];
        this.typing = true;
        this.shownText = bubbles.map(b => '');
        // play the speaker's voice when the line shows (voice=<n> attr)
        if (this._audio && this._audio.playVoice) {
          for (const b of bubbles) {
            if (b.voice !== null && b.voice !== undefined && b.speakers && b.speakers.length) {
              this._audio.playVoice(b.speakers[0].id, b.voice);
              break;
            }
          }
        }
        this._emitChange();
        this._render();
        this._startAnim();
        this._type(bubbles);
      },

      /* transition animation driver (rAF) */
      _startAnim() {
        const tr = this.transition;
        if (!tr || tr.progress >= 1) return;
        if (typeof requestAnimationFrame !== 'function') return; // headless (tests)
        if (!tr.start) tr.start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const loop = (ts) => {
          this._rafId = null;
          if (!this.transition) return;
          const t = Math.min(1, (ts - this.transition.start) / this.transition.dur);
          this.transition.progress = t;
          this._render();
          if (t >= 1) {
            this.transition = null;
            this._render();
            this._emitChange(); // playback mode reacts once the transition completes
            return;
          }
          this._rafId = requestAnimationFrame(loop);
        };
        this._rafId = requestAnimationFrame(loop);
      },

      _finishTransition() {
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        if (this.transition) {
          this.transition = null;
          this._render();
          this._emitChange(); // playback mode (and UI) can react to transition end
        }
      },

      _type(bubbles) {
        const s = this.state;
        let step = 0;
        const maxLen = Math.max(...bubbles.map(b => (b.text || '').length));
        const speed = bubbles[0] && bubbles[0].speed !== null ? bubbles[0].speed : s.opts.speed;
        const tick = () => {
          if (!this.typing) return;
          step++;
          let anyLeft = false;
          bubbles.forEach((b, i) => {
            const t = b.text || '';
            if (this.shownText[i].length < t.length) {
              this.shownText[i] = t.slice(0, step); // per-char progress
              anyLeft = true;
            }
          });
          this._render();
          if (!anyLeft || step >= maxLen) {
            this.typing = false;
            bubbles.forEach((b, i) => { this.shownText[i] = b.text || ''; });
            this._render();
            this._emitChange();
            if (s.opts.autodelay > 0) {
              this._autoTimer = setTimeout(() => { if (!this.finished) this.next(); }, s.opts.autodelay);
            }
            return;
          }
          this._typingTimer = setTimeout(tick, speed > 0 ? speed : 0);
        };
        if (speed === 0) {
          bubbles.forEach((b, i) => { this.shownText[i] = b.text || ''; });
          this.typing = false;
          this._render();
          this._emitChange();
          if (s.opts.autodelay > 0) {
            this._autoTimer = setTimeout(() => { if (!this.finished) this.next(); }, s.opts.autodelay);
          }
          return;
        }
        this._typingTimer = setTimeout(tick, speed);
      },

      /* -------- player controls -------- */

      next() {
        if (this.finished) return;
        this._clearTimers();
        if (this.transition) {
          // fast-forward the step transition (and complete any typing)
          this._finishTransition();
          if (this.typing && this.display) {
            const bubbles = this.display.bubbles || [];
            bubbles.forEach((b, i) => { this.shownText[i] = b.text || ''; });
            this.typing = false;
          }
          this._render();
          this._emitChange();
          return;
        }
        if (this.typing) {
          // complete text instantly; advance on next call
          const bubbles = this.display ? (this.display.bubbles || []) : [];
          bubbles.forEach((b, i) => { this.shownText[i] = b.text || ''; });
          this.typing = false;
          this._render();
          this._emitChange();
          return;
        }
        if (this.display) {
          // snapshot before moving on (for prev)
          this.snapshots.push({ opIndex: this.cursor - 1, state: this._snapshotState() });
          if (this.snapshots.length > 500) this.snapshots.shift();
        }
        this.display = null;
        const d = this._advanceRaw(Infinity);
        if (d) this.present(d);
      },

      prev() {
        this._clearTimers();
        if (!this.snapshots.length) return;
        const snap = this.snapshots.pop();
        this.state = snap.state;
        this.cursor = snap.opIndex;
        this.display = null;
        this.finished = false;
        this._allowTransition = false; // scrubbing back = instant switch
        const d = this._advanceRaw(Infinity);
        if (d) this.present(d);
        else this._render();
      },

      choose(target) {
        this._clearTimers();
        this.display = null;
        this._allowTransition = false;
        if (target === 'end') { this.finished = true; this._emitChange(); this._render(); return; }
        if (this.labels[target] === undefined) {
          if (this.onError) this.onError('choice target label "' + target + '" not found');
          return;
        }
        this.cursor = this.labels[target];
        const d = this._advanceRaw(Infinity);
        if (d) this.present(d);
      },

      restart() {
        this._clearTimers();
        this.resetState();
        this.cursor = 0;
        this.snapshots = [];
        this.finished = false;
        this.display = null;
        this._allowTransition = false; // fresh start = no entrance anim
        const d = this._advanceRaw(Infinity);
        if (d) this.present(d);
        else this._render();
      },

      seekTo(opIndex) {
        this._clearTimers();
        this.resetState();
        this.cursor = 0;
        this.snapshots = [];
        this.finished = false;
        this.display = null;
        this._allowTransition = false; // seek = instant switch
        // execute everything strictly before the target
        while (this.cursor < opIndex) {
          const op = this.ops[this.cursor];
          this.cursor++;
          if (op.op === 'jump') break; // don't follow jumps during seek
          this.applyOpState(op);
        }
        if (this.cursor >= this.ops.length) { this.finished = true; this._emitChange(); this._render(); return; }
        const d = this._advanceRaw(Infinity);
        if (d) this.present(d);
        else this._render();
      },

      /* -------- export -------- */

      // render the CURRENT frame to a canvas at `scale` (choices excluded)
      exportCurrentFrame(scale) {
        if (!scale) scale = this.state ? this.state.opts.exportscale : 2;
        const canvas = this._exportCanvas(scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        const display = this._exportDisplay(this.display);
        if (this.onRender) this.onRender(this.state, display, ctx, true);
        else DG_RENDER(ctx, this.state, display);
        return canvas;
      },

      // replay the whole sequence; returns [{index, canvas}] for every speech op
      exportAll(scale, onProgress) {
        this._clearTimers();
        const saved = { state: this._snapshotState(), cursor: this.cursor, display: this.display, finished: this.finished, snapshots: this.snapshots, suppress: this._suppressAudio };
        this._suppressAudio = true;
        this.resetState();
        this.cursor = 0;
        this.finished = false;
        const results = [];
        try {
          let steps = 0;
          const guard = () => { if (++steps > MAX_STEPS) throw new Error('sequence loop detected during export'); };
          const canvas = this._exportCanvas(scale);
          const ctx = canvas.getContext('2d');
          while (this.cursor < this.ops.length && !this.finished) {
            guard();
            const op = this.ops[this.cursor];
            this.cursor++;
            if (op.op === 'jump') {
              if (op.label === 'end') { this.finished = true; break; }
              const target = this.labels[op.label];
              if (target === undefined) break;
              this.cursor = target;
              continue;
            }
            if (op.op === 'end') { this.finished = true; break; }
            const d = this.applyOpState(op);
            if (d && d.op === 'speech') {
              // apply speaker exprs (applyOpState did it), then draw
              ctx.clearRect(0, 0, this._W(), this._H());
              ctx.save();
              ctx.scale(scale, scale);
              if (this.onRender) this.onRender(this.state, d, ctx, true);
              else DG_RENDER(ctx, this.state, d);
              ctx.restore();
              results.push({ canvas: this._copyCanvas(canvas), index: results.length });
              if (onProgress) onProgress(results.length);
            }
          }
        } finally {
          // restore (also when export throws, e.g. loop guard) — never leave audio suppressed
          this.state = saved.state;
          this.cursor = saved.cursor;
          this.display = saved.display;
          this.finished = saved.finished;
          this.snapshots = saved.snapshots;
          this._suppressAudio = saved.suppress;
        }
        return results;
      },

      /* -------- internals -------- */

      _W() { return 667; },
      _H() { return 500; },

      _exportCanvas(scale) {
        const c = document.createElement('canvas');
        c.width = Math.round(667 * (scale || 2));
        c.height = Math.round(500 * (scale || 2));
        return c;
      },

      _copyCanvas(c) {
        const copy = document.createElement('canvas');
        copy.width = c.width; copy.height = c.height;
        copy.getContext('2d').drawImage(c, 0, 0);
        return copy;
      },

      _exportDisplay(display) {
        if (!display) return { bubbles: [], choices: null };
        return { bubbles: display.bubbles, choices: null };
      },

      _snapshotState() {
        const s = this.state;
        return {
          bgPath: s.bgPath, bgImg: s.bgImg, title: s.title,
          opts: Object.assign({}, s.opts),
          actors: new Map([...s.actors].map(([k, a]) => [k, Object.assign({}, a)])),
          bubbles: s.bubbles,
        };
      },

      _loadActorSprite(a) {
        if (!this._spriteLoader) return;
        const path = (a.pattern || '').replace(/\{id\}/g, a.id).replace(/\{expr\}/g, a.expr);
        this._spriteLoader(path, (img, xform) => {
          const cur = this.state.actors.get(a.id);
          if (cur && cur.pattern === a.pattern && cur.expr === a.expr) {
            cur.img = img;
            if (xform !== undefined) cur.xform = xform || null; // per-sprite scale/offset
            if (this.display) this._render();
          }
        });
      },

      _render() {
        if (!this.onRender) return;
        const display = this.display;
        let view = null;
        if (display) {
          // merge typewriter progress into a render view (never mutate ops)
          const bubbles = (display.bubbles || []).map((b, i) => {
            const nb = Object.assign({}, b);
            if (this.shownText && this.shownText[i] !== undefined) nb.shownText = this.shownText[i];
            return nb;
          });
          view = { op: display.op, bubbles, choices: display.choices, lineNo: display.lineNo };
        }
        this.onRender(this.state, view, undefined, undefined, this.transition);
      },

      _emitChange() {
        if (!this.onChange) return;
        this.onChange({
          index: this.cursor,
          finished: this.finished,
          typing: this.typing,
          choices: this.display && this.display.op === 'choice' ? this.display.choices : null,
          title: this.state ? this.state.title : '',
          lineNo: this.display ? this.display.lineNo : null,
          canPrev: this.snapshots.length > 0,
        });
      },

      _clearTimers() {
        if (this._typingTimer) { clearTimeout(this._typingTimer); this._typingTimer = null; }
        if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
      },

      /* loader injection (set by app) */
      setLoaders(bgLoader, spriteLoader) {
        this._bgLoader = bgLoader;
        this._spriteLoader = spriteLoader;
      },

      /* audio hooks (set by app): playBgm(path), stopBgm(), playSfx(path), playVoice(actorId, n) */
      setAudioHooks(hooks) {
        this._audio = hooks || null;
      },
    };

    // fallback render if no onRender wired (Node tests)
    function DG_RENDER(ctx, state, display) {
      // minimal: black frame
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 667, 500);
    }

    return player;
  }

  return { create };
});
