/* renderer.js — Canvas renderer for TWEWY-style dialogue frames.
 * Replicates the layout math of the original twewy-message-generator:
 *   canvas 667x500 (= 500 * 644/483), bubble height = H/2.3,
 *   sprite height = H * coeff, bg crop (0,0,img.w-760,img.h),
 *   bubble stack with 40px overlap, 6.4px drop shadow, 20px centered text.
 *
 * Draw order (matches original z-indexes): bg -> back bubble(z3) ->
 * back sprites(z4) -> front sprites(z5) -> front bubble(z6) -> text(z20).
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DGRenderer = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const W = 667;                 // magicNum: height=500, divCoefficient=644/483
  const H = 500;
  const BUBBLE_H = H / 2.3;      // newHeight for bubbles
  const BUBBLE_PAD = 24;         // horizontal text padding inside bubble
  const STACK_OVERLAP = 40;      // -space-y-10 between stacked bubbles
  const STACK_MT = 16;           // mt-4 on bubble column
  const SHADOW = 6.4;            // 0.4rem drop shadow offset
  const FONT_FALLBACK = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';

  const DEFAULT_FONT = '"FOT-NewCezanne-Pro"' + ',' + FONT_FALLBACK;

  function getFont(fontsize) {
    return fontsize + 'px ' + DEFAULT_FONT;
  }

  /* ---------- easing (快起慢动 = ease-out, fast start, decelerating end) ---------- */

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* ---------- text helpers ---------- */

  function wrapText(ctx, text, maxWidth) {
    const out = [];
    for (const rawLine of String(text).split('\n')) {
      if (!rawLine) { out.push(''); continue; }
      let cur = '';
      for (const ch of rawLine) {
        const test = cur + ch;
        if (ctx.measureText(test).width > maxWidth && cur) {
          out.push(cur);
          cur = ch;
        } else {
          cur = test;
        }
      }
      out.push(cur);
    }
    return out;
  }

  /* ---------- drawing ---------- */

  function drawBackground(ctx, state) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const img = state.bgImg;
    if (!img) return;
    const cropW = img.width - 760;
    if (cropW > 0) {
      ctx.drawImage(img, 0, 0, cropW, img.height, 0, 0, W, H);
    } else {
      // fallback: fit whole image
      const s = Math.max(W / img.width, H / img.height);
      const dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
  }

  function drawSprite(ctx, img, x, y, w, h, flip) {
    if (!img) return;
    ctx.save();
    if (flip) {
      ctx.translate(x + w / 2, 0);
      ctx.scale(-1, 1);
      x = -w / 2;
    }
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  // actors: [{img, coeff, slot, flipMode, xform}]  drawn back (high slot) to front (low slot)
  // flip: explicit actor flipMode wins; otherwise left side mirrors when @mirrorleft is on
  // xform: per-sprite {scale, ox, oy} from the resource editor — applied every render
  function drawSpriteGroup(ctx, actors, anchorX, side, mirrorLeft, slotgap) {
    const sorted = actors.slice().sort((a, b) => (b.slot || 0) - (a.slot || 0));
    for (const a of sorted) {
      const h = H * a.coeff;
      const w = h * (a.img.width / a.img.height);
      const y = H * (1 - a.coeff) + 1;
      let x;
      if (side === 'right') {
        x = anchorX - w + slotgap * (a.slot || 0);
      } else {
        x = anchorX - slotgap * (a.slot || 0);
      }
      let flip;
      if (a.flipMode === true || a.flipMode === false) flip = a.flipMode;
      else flip = side === 'left' && mirrorLeft;

      // per-sprite transform: scale around the sprite center + pixel offset
      let dw = w, dh = h, px = x, py = y;
      if (a.xform && (a.xform.scale !== 1 || a.xform.ox || a.xform.oy)) {
        const s = a.xform.scale || 1;
        dw = w * s;
        dh = h * s;
        px = x + (a.xform.ox || 0) - (dw - w) / 2;
        py = y + (a.xform.oy || 0) - (dh - h) / 2;
      }
      drawSprite(ctx, a.img, px, py, dw, dh, flip);
    }
  }

  // bubble: returns rect {x, y, w, h}
  function drawBubble(ctx, state, bubble, y, flip, alpha) {
    const img = state.bubbles && state.bubbles[bubble.box];
    if (!img) return null;
    const h = BUBBLE_H;
    const w = h * (img.width / img.height);
    const x = (W - w) / 2;

    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,1)';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = flip ? -SHADOW : SHADOW;
    ctx.shadowOffsetY = SHADOW;
    if (flip) {
      ctx.translate(x + w / 2, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -w / 2, y, w, h);
    } else {
      ctx.drawImage(img, x, y, w, h);
    }
    ctx.restore();
    return { x, y, w, h };
  }

  function drawBubbleText(ctx, state, bubble, rect, shownText, alpha) {
    const text = (shownText !== undefined && shownText !== null) ? shownText : bubble.text;
    if (!text) return;
    const fontsize = state.opts.fontsize;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    ctx.font = getFont(fontsize);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;

    const maxWidth = rect.w - BUBBLE_PAD * 2;
    const lines = state.opts.wrap ? wrapText(ctx, text, maxWidth) : String(text).split('\n');
    const lineH = fontsize * 1.25;
    const blockH = lines.length * lineH;
    const cx = rect.x + rect.w / 2;
    let cy = rect.y + rect.h / 2 - blockH / 2 + lineH / 2;

    for (const ln of lines) {
      ctx.strokeText(ln, cx, cy);
      ctx.fillText(ln, cx, cy);
      cy += lineH;
    }
    ctx.restore();
  }

  function drawNameTag(ctx, state, names, rect, bubble, alpha) {
    if (!state.opts.shownames) return;
    const name = names || bubble.name;
    if (!name) return;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    const fontsize = Math.max(13, Math.round(state.opts.fontsize * 0.8));
    ctx.font = fontsize + 'px ' + DEFAULT_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    const cx = rect.x + rect.w / 2;
    const y = rect.y - 8;
    ctx.strokeText(name, cx, y);
    ctx.fillText(name, cx, y);
    ctx.restore();
  }

  /* ---------- bubble layout ---------- */

  // final (resting) rects for a display's bubbles — mirrors the original's stacking math
  function computeBubbleRects(state, bubbles) {
    const rects = [];
    if (!bubbles || !bubbles.length) return rects;
    if (bubbles.length === 1) {
      const b = bubbles[0];
      const img = state.bubbles && state.bubbles[b.box];
      const w = img ? BUBBLE_H * (img.width / img.height) : W * 0.5;
      rects.push({ x: (W - w) / 2, y: (H - BUBBLE_H) / 2, w, h: BUBBLE_H });
    } else if (bubbles.length >= 2) {
      const hs = bubbles.map(b => {
        const img = state.bubbles && state.bubbles[b.box];
        const w = img ? BUBBLE_H * (img.width / img.height) : W * 0.5;
        return { w, h: BUBBLE_H };
      });
      const blockH = hs[0].h + hs[1].h - STACK_OVERLAP;
      let y = (H - blockH) / 2 + STACK_MT;
      hs.forEach((s, i) => {
        rects.push({ x: (W - s.w) / 2, y, w: s.w, h: s.h });
        y += s.h - STACK_OVERLAP;
      });
    }
    return rects;
  }

  // draw one display's whole bubble set shifted by yOffset with global alpha
  function drawBubbleSet(ctx, state, display, yOffset, alpha) {
    if (!display) return;
    const bubbles = display.bubbles || [];
    if (!bubbles.length) return;
    const rects = computeBubbleRects(state, bubbles);
    bubbles.forEach((b, i) => {
      const rect = rects[i];
      if (!rect) return;
      const ry = rect.y + yOffset;
      const moved = { x: rect.x, y: ry, w: rect.w, h: rect.h };
      drawBubble(ctx, state, b, ry, resolveFlip(state, b) === true, alpha);
      drawBubbleText(ctx, state, b, moved, b.shownText, alpha);
      drawNameTag(ctx, state, bubbleNames(state, b), moved, b, alpha);
    });
  }

  /* ---------- main render ---------- */

  // display: { bubbles:[{speakers, text, box, flip, side, name, shownText}], choices }
  // transition: { from, to, progress, dur, dist } | null
  //   — step transition: 'from' bubbles slide UP & fade (ease-out), 'to' bubbles
  //     rise from below-center (ease-out) into the current dialogue position.
  function render(ctx, state, display, transition) {
    const opts = state.opts;
    ctx.clearRect(0, 0, W, H);
    drawBackground(ctx, state);

    const bubbles = display && display.bubbles ? display.bubbles : [];
    const rects = computeBubbleRects(state, bubbles);
    const tr = (transition && transition.progress !== undefined && transition.progress < 1) ? transition : null;
    const slotgap = opts.slotgap;

    if (tr) {
      // exiting step: previous bubbles slide up (fast-start ease-out) and fade out
      const e = easeOutCubic(tr.progress);
      drawBubbleSet(ctx, state, tr.from, -e * tr.dist, 1 - tr.progress);
    }

    // back bubble (z3)
    if (!tr && rects.length >= 2) {
      const b = bubbles[0];
      drawBubble(ctx, state, b, rects[0].y, resolveFlip(state, b) === true);
    }

    // sprites: back (z4) then front (z5), both sides
    const left = [], right = [];
    state.actors.forEach((a) => {
      if (!a.visible || !a.img) return;
      const item = { img: a.img, coeff: a.coeff, slot: a.slot, side: a.side, flipMode: a.flip, xform: a.xform };
      (a.side === 'right' ? right : left).push(item);
    });
    const ANCHOR = 16; // -mx-4
    drawSpriteGroup(ctx, right, W - ANCHOR, 'right', opts.mirrorleft, slotgap);
    drawSpriteGroup(ctx, left, ANCHOR, 'left', opts.mirrorleft, slotgap);

    if (tr) {
      // entering step: new bubbles rise from below-center into place
      const e = easeOutCubic(tr.progress);
      drawBubbleSet(ctx, state, tr.to, (1 - e) * tr.dist, e);
      return;
    }

    // front bubble (z6)
    if (rects.length === 1) {
      const b = bubbles[0];
      const rect = rects[0];
      drawBubble(ctx, state, b, rect.y, resolveFlip(state, b) === true);
    } else if (rects.length >= 2) {
      const b = bubbles[1];
      drawBubble(ctx, state, b, rects[1].y, resolveFlip(state, b) === true);
    }

    // text + name tags
    bubbles.forEach((b, i) => {
      const rect = rects[i];
      if (!rect) return;
      drawBubbleText(ctx, state, b, rect, b.shownText);
      drawNameTag(ctx, state, bubbleNames(state, b), rect, b);
    });
  }

  function resolveFlip(state, bubble) {
    if (bubble.flip === true || bubble.flip === false) return bubble.flip;
    // auto: flip toward the speaker side (cosmetic shadow direction)
    const sideOverride = bubble.side;
    if (sideOverride === 'left') return true;
    if (sideOverride === 'right') return false;
    const ids = (bubble.speakers || []).map(s => s.id);
    if (!ids.length) return false;
    const sides = new Set(ids.map(id => {
      const a = state.actors.get(id);
      return a ? a.side : null;
    }).filter(Boolean));
    if (sides.size !== 1) return false;
    return sides.has('left');
  }

  function bubbleNames(state, bubble) {
    if (bubble.name) return bubble.name;
    if (!bubble.speakers || !bubble.speakers.length) return null;
    const names = bubble.speakers.map(s => {
      const a = state.actors.get(s.id);
      return a ? a.name : s.id;
    });
    return names.join(' & ');
  }

  function createExportCanvas(scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(W * scale);
    c.height = Math.round(H * scale);
    return c;
  }

  return {
    W, H, BUBBLE_H, FONT_FALLBACK, DEFAULT_FONT,
    getFont, wrapText, render, createExportCanvas,
    easeOutCubic, computeBubbleRects,
  };
});
