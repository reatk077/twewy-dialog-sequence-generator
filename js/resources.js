/* resources.js — Resource store: characters (sprites+voices) & locations (backgrounds)
 * plus BGM tracks and SFX clips. Pure data layer, browser + Node safe (localStorage
 * guarded). UI lives in app.js.
 *
 * Schemes usable inside the script DSL:
 *   chara://<charId>/<expr>   -> character sprite dataURL   (sprite pattern)
 *   loc://<locId>/<variant>   -> location image dataURL     (@bg path)
 *   bgm://<bgmId>             -> BGM audio dataURL          (@bgm path)
 *   sfx://<sfxId>             -> SFX audio dataURL          (@sfx path)
 *   voice://<charId>/<n>      -> character voice dataURL    (line attr voice=n)
 *
 * Packaging: exportCharacter / exportLocation / exportBgm / exportSfx produce
 * portable JSON bundles (dataURLs embedded) that others can import.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DGResources = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const STORAGE_KEY = 'dg.resources.v1';
  const CHAR_TYPE = 'dgchar';
  const LOC_TYPE = 'dgloc';
  const BGM_TYPE = 'dgbgm';
  const SFX_TYPE = 'dgsfx';
  const VERSION = 1;

  let onQuotaWarning = null;
  function setQuotaWarning(fn) { onQuotaWarning = fn; }

  let data = { characters: {}, locations: {}, bgms: {}, sfx: {} };

  function load() {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.characters && parsed.locations) data = parsed;
      }
    } catch (e) { /* corrupted storage — start fresh */ }
    // migrate older stores that lack audio sections
    if (!data.bgms) data.bgms = {};
    if (!data.sfx) data.sfx = {};
    Object.values(data.characters).forEach(c => {
      if (!c.voices) c.voices = {};
      if (!c.spriteXform) c.spriteXform = {};
    });
  }

  function save() {
    try {
      if (typeof localStorage === 'undefined') return { ok: true };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return { ok: true };
    } catch (e) {
      if (onQuotaWarning) onQuotaWarning(String(e && e.name || e));
      return { ok: false, error: e };
    }
  }

  /* ---------- ids ---------- */

  function slugify(name, fallback) {
    let s = String(name || '').toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fff]/g, '');
    if (!s) s = fallback;
    return s;
  }

  function uniqueId(base, taken) {
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(base + n)) n++;
    return base + n;
  }

  /* ---------- characters ---------- */

  function addCharacter({ name, defaultSide }) {
    const base = slugify(name, 'char' + (Object.keys(data.characters).length + 1));
    const id = uniqueId(base, new Set(Object.keys(data.characters)));
    data.characters[id] = {
      id,
      name: name || id,
      defaultSide: defaultSide === 'right' ? 'right' : 'left',
      sprites: {},
      voices: {},
      spriteXform: {},
    };
    save();
    return data.characters[id];
  }

  function updateCharacter(id, patch) {
    const c = data.characters[id];
    if (!c) return null;
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.defaultSide !== undefined) c.defaultSide = patch.defaultSide;
    save();
    return c;
  }

  function deleteCharacter(id) {
    delete data.characters[id];
    save();
  }

  function setCharSprite(charId, expr, dataURL) {
    const c = data.characters[charId];
    if (!c) return;
    if (dataURL === null) delete c.sprites[String(expr)];
    else c.sprites[String(expr)] = dataURL;
    save();
  }

  function charSprite(charId, expr) {
    const c = data.characters[charId];
    if (!c) return null;
    return c.sprites[String(expr)] || null;
  }

  function charSpriteCount(charId) {
    const c = data.characters[charId];
    return c ? Object.keys(c.sprites).length : 0;
  }

  /* ---- per-sprite transform (scale + x/y offset) ----
   * Stored per expression; applied every time the sprite renders in a sequence. */

  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (Number.isNaN(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function setSpriteXform(charId, expr, xform) {
    const c = data.characters[charId];
    if (!c) return;
    if (!xform) {
      delete c.spriteXform[String(expr)];
    } else {
      c.spriteXform[String(expr)] = {
        scale: clampNum(xform.scale, 0.3, 3, 1),
        ox: clampNum(xform.ox, -300, 300, 0),
        oy: clampNum(xform.oy, -300, 300, 0),
      };
    }
    save();
  }

  function spriteXform(charId, expr) {
    const c = data.characters[charId];
    if (!c) return null;
    const x = c.spriteXform[String(expr)];
    return x ? { scale: Number(x.scale) || 1, ox: Number(x.ox) || 0, oy: Number(x.oy) || 0 } : null;
  }

  // chara://<id>/<expr> -> xform | null
  function resolveSpriteXform(path) {
    const m = /^chara:\/\/([^/]+)\/(\d+)$/.exec(String(path || ''));
    if (!m) return null;
    return spriteXform(m[1], parseInt(m[2], 10));
  }

  /* ---- character voices (voice slots 1..N) ---- */

  function setCharVoice(charId, n, dataURL) {
    const c = data.characters[charId];
    if (!c) return;
    if (dataURL === null) delete c.voices[String(n)];
    else c.voices[String(n)] = dataURL;
    save();
  }

  function charVoice(charId, n) {
    const c = data.characters[charId];
    if (!c) return null;
    return c.voices[String(n)] || null;
  }

  function charVoiceCount(charId) {
    const c = data.characters[charId];
    return c ? Object.keys(c.voices).length : 0;
  }

  /* ---------- locations ---------- */

  function addLocation({ name }) {
    const base = slugify(name, 'loc' + (Object.keys(data.locations).length + 1));
    const id = uniqueId(base, new Set(Object.keys(data.locations)));
    data.locations[id] = {
      id,
      name: name || id,
      images: {},
    };
    save();
    return data.locations[id];
  }

  function updateLocation(id, patch) {
    const l = data.locations[id];
    if (!l) return null;
    if (patch.name !== undefined) l.name = patch.name;
    save();
    return l;
  }

  function deleteLocation(id) {
    delete data.locations[id];
    save();
  }

  // variant: { id, name, dataURL }
  function setLocImage(locId, variantId, variantName, dataURL) {
    const l = data.locations[locId];
    if (!l) return;
    if (dataURL === null) delete l.images[String(variantId)];
    else l.images[String(variantId)] = { name: variantName || String(variantId), dataURL };
    save();
  }

  function locImage(locId, variantId) {
    const l = data.locations[locId];
    if (!l) return null;
    const v = l.images[String(variantId)];
    return v ? v.dataURL : null;
  }

  function locVariantName(locId, variantId) {
    const l = data.locations[locId];
    if (!l) return null;
    const v = l.images[String(variantId)];
    return v ? v.name : null;
  }

  /* ---------- BGM tracks ---------- */

  function addBgm({ name }) {
    const base = slugify(name, 'bgm' + (Object.keys(data.bgms).length + 1));
    const id = uniqueId(base, new Set(Object.keys(data.bgms)));
    data.bgms[id] = { id, name: name || id, dataURL: null };
    save();
    return data.bgms[id];
  }

  function updateBgm(id, patch) {
    const b = data.bgms[id];
    if (!b) return null;
    if (patch.name !== undefined) b.name = patch.name;
    if (patch.dataURL !== undefined) b.dataURL = patch.dataURL;
    save();
    return b;
  }

  function deleteBgm(id) {
    delete data.bgms[id];
    save();
  }

  function bgmData(id) {
    const b = data.bgms[id];
    return b ? b.dataURL : null;
  }

  function allBgms() { return Object.values(data.bgms); }

  /* ---------- SFX clips ---------- */

  function addSfx({ name }) {
    const base = slugify(name, 'sfx' + (Object.keys(data.sfx).length + 1));
    const id = uniqueId(base, new Set(Object.keys(data.sfx)));
    data.sfx[id] = { id, name: name || id, dataURL: null };
    save();
    return data.sfx[id];
  }

  function updateSfx(id, patch) {
    const s = data.sfx[id];
    if (!s) return null;
    if (patch.name !== undefined) s.name = patch.name;
    if (patch.dataURL !== undefined) s.dataURL = patch.dataURL;
    save();
    return s;
  }

  function deleteSfx(id) {
    delete data.sfx[id];
    save();
  }

  function sfxData(id) {
    const s = data.sfx[id];
    return s ? s.dataURL : null;
  }

  function allSfx() { return Object.values(data.sfx); }

  /* ---------- DSL scheme resolution ---------- */

  // chara://<id>/<expr> -> dataURL | null
  function resolveSprite(path) {
    const m = /^chara:\/\/([^/]+)\/(\d+)$/.exec(String(path || ''));
    if (!m) return null;
    return charSprite(m[1], parseInt(m[2], 10));
  }

  // loc://<id>/<variant> -> dataURL | null
  function resolveBg(path) {
    const m = /^loc:\/\/([^/]+)\/([^/]+)$/.exec(String(path || ''));
    if (!m) return null;
    return locImage(m[1], m[2]);
  }

  // bgm://<id> -> dataURL | null
  function resolveBgm(path) {
    const m = /^bgm:\/\/([^/]+)$/.exec(String(path || ''));
    if (!m) return null;
    return bgmData(m[1]);
  }

  // sfx://<id> -> dataURL | null
  function resolveSfx(path) {
    const m = /^sfx:\/\/([^/]+)$/.exec(String(path || ''));
    if (!m) return null;
    return sfxData(m[1]);
  }

  // voice://<charId>/<n> -> dataURL | null
  function resolveVoice(path) {
    const m = /^voice:\/\/([^/]+)\/(\d+)$/.exec(String(path || ''));
    if (!m) return null;
    return charVoice(m[1], parseInt(m[2], 10));
  }

  /* ---------- packaging ---------- */

  function exportCharacter(id) {
    const c = data.characters[id];
    if (!c) return null;
    return JSON.stringify({
      type: CHAR_TYPE,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      character: JSON.parse(JSON.stringify(c)),
    });
  }

  function importCharacter(json) {
    let obj;
    try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
    if (!obj || obj.type !== CHAR_TYPE || !obj.character) return { ok: false, error: '不是有效的角色包' };
    const c = obj.character;
    const base = slugify(c.name, c.id || 'char');
    const id = uniqueId(base, new Set(Object.keys(data.characters)));
    data.characters[id] = {
      id,
      name: c.name || id,
      defaultSide: c.defaultSide === 'right' ? 'right' : 'left',
      sprites: {},
      voices: {},
      spriteXform: {},
    };
    (Object.keys(c.sprites || {})).forEach(k => {
      if (typeof c.sprites[k] === 'string' && c.sprites[k].startsWith('data:')) data.characters[id].sprites[k] = c.sprites[k];
    });
    (Object.keys(c.voices || {})).forEach(k => {
      if (typeof c.voices[k] === 'string' && c.voices[k].startsWith('data:')) data.characters[id].voices[k] = c.voices[k];
    });
    (Object.keys(c.spriteXform || {})).forEach(k => {
      const x = c.spriteXform[k];
      if (x && typeof x === 'object') {
        data.characters[id].spriteXform[k] = {
          scale: clampNum(x.scale, 0.3, 3, 1),
          ox: clampNum(x.ox, -300, 300, 0),
          oy: clampNum(x.oy, -300, 300, 0),
        };
      }
    });
    save();
    return { ok: true, id };
  }

  function exportLocation(id) {
    const l = data.locations[id];
    if (!l) return null;
    return JSON.stringify({
      type: LOC_TYPE,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      location: JSON.parse(JSON.stringify(l)),
    });
  }

  function importLocation(json) {
    let obj;
    try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
    if (!obj || obj.type !== LOC_TYPE || !obj.location) return { ok: false, error: '不是有效的地点包' };
    const l = obj.location;
    const base = slugify(l.name, l.id || 'loc');
    const id = uniqueId(base, new Set(Object.keys(data.locations)));
    data.locations[id] = { id, name: l.name || id, images: {} };
    (Object.keys(l.images || {})).forEach(k => {
      const v = l.images[k];
      if (v && typeof v.dataURL === 'string' && v.dataURL.startsWith('data:')) {
        data.locations[id].images[k] = { name: v.name || k, dataURL: v.dataURL };
      }
    });
    save();
    return { ok: true, id };
  }

  function allCharacters() { return Object.values(data.characters); }
  function allLocations() { return Object.values(data.locations); }
  function getCharacter(id) { return data.characters[id] || null; }
  function getLocation(id) { return data.locations[id] || null; }

  /* ---------- BGM / SFX packaging ---------- */

  function exportBgm(id) {
    const b = data.bgms[id];
    if (!b) return null;
    return JSON.stringify({ type: BGM_TYPE, version: VERSION, exportedAt: new Date().toISOString(), bgm: JSON.parse(JSON.stringify(b)) });
  }

  function importBgm(json) {
    let obj;
    try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
    if (!obj || obj.type !== BGM_TYPE || !obj.bgm) return { ok: false, error: '不是有效的音乐包' };
    const b = obj.bgm;
    const base = slugify(b.name, b.id || 'bgm');
    const id = uniqueId(base, new Set(Object.keys(data.bgms)));
    data.bgms[id] = { id, name: b.name || id, dataURL: (typeof b.dataURL === 'string' && b.dataURL.startsWith('data:')) ? b.dataURL : null };
    save();
    return { ok: true, id };
  }

  function exportSfx(id) {
    const s = data.sfx[id];
    if (!s) return null;
    return JSON.stringify({ type: SFX_TYPE, version: VERSION, exportedAt: new Date().toISOString(), sfx: JSON.parse(JSON.stringify(s)) });
  }

  function importSfx(json) {
    let obj;
    try { obj = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
    if (!obj || obj.type !== SFX_TYPE || !obj.sfx) return { ok: false, error: '不是有效的音效包' };
    const s = obj.sfx;
    const base = slugify(s.name, s.id || 'sfx');
    const id = uniqueId(base, new Set(Object.keys(data.sfx)));
    data.sfx[id] = { id, name: s.name || id, dataURL: (typeof s.dataURL === 'string' && s.dataURL.startsWith('data:')) ? s.dataURL : null };
    save();
    return { ok: true, id };
  }

  return {
    load, save, setQuotaWarning,
    addCharacter, updateCharacter, deleteCharacter,
    setCharSprite, charSprite, charSpriteCount,
    setCharVoice, charVoice, charVoiceCount,
    setSpriteXform, spriteXform, resolveSpriteXform,
    addLocation, updateLocation, deleteLocation,
    setLocImage, locImage, locVariantName,
    addBgm, updateBgm, deleteBgm, bgmData, allBgms,
    addSfx, updateSfx, deleteSfx, sfxData, allSfx,
    resolveSprite, resolveBg, resolveBgm, resolveSfx, resolveVoice,
    exportCharacter, importCharacter, exportLocation, importLocation,
    exportBgm, importBgm, exportSfx, importSfx,
    allCharacters, allLocations, getCharacter, getLocation,
  };
});
