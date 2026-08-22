/* audio.js — Web Audio engine for BGM / SFX / character voices.
 * No-op safe in headless (Node) environments. Plays from any fetchable URL
 * (data: URIs from the resource store, blob: or http(s) files).
 *
 * Concurrency guarantees:
 *   - BGM: at most ONE looped source at any time. A generation token makes any
 *     in-flight async decode from an older playBgm()/stopBgm() call a no-op, so
 *     rapid replays (seek/restart/@bgm re-triggers) can never stack BGMs.
 *   - Voice: at most one at a time (new voice interrupts the old).
 *   - SFX: intentionally allowed to overlap.
 *
 * Recording: startAudioTrack() routes the master bus into a MediaStreamDestination
 * so a canvas captureStream + MediaRecorder can mux audio into the video.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DGAudio = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const S = {
    ctx: null,
    master: null,
    bgmSource: null,
    bgmGain: null,
    voiceSource: null,
    recDest: null,
    vol: { bgm: 0.7, sfx: 0.9, voice: 1.0 },
    bgmGen: 0,
    voiceGen: 0,
  };

  function ensure() {
    if (typeof window === 'undefined' || !window.AudioContext) return null; // headless
    if (!S.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      S.ctx = new AC();
      S.master = S.ctx.createGain();
      S.master.gain.value = 1;
      S.master.connect(S.ctx.destination);
    }
    if (S.ctx.state === 'suspended') {
      try {
        const p = S.ctx.resume();
        if (p && p.then) p.catch(() => { /* autoplay policy — unlock() on gesture handles it */ });
      } catch (e) { /* noop */ }
    }
    return S.ctx;
  }

  // Browser autoplay policy: an AudioContext created/resumed outside a user
  // gesture stays suspended and silent. Unlock on the FIRST user gesture so
  // timer-driven playback (playback mode, transitions) can actually sound.
  function unlock() {
    const ctx = ensure();
    if (ctx && ctx.state === 'suspended') {
      try {
        const p = ctx.resume();
        if (p && p.then) p.catch(() => {});
      } catch (e) { /* noop */ }
    }
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    ['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach((t) => {
      document.addEventListener(t, unlock, { once: true, passive: true });
    });
  }

  async function loadBuffer(url) {
    const ctx = ensure();
    if (!ctx) return null;
    const res = await fetch(url);
    if (!res.ok) throw new Error('audio load failed: ' + url);
    const ab = await res.arrayBuffer();
    return ctx.decodeAudioData(ab);
  }

  // build source -> per-type gain -> master bus
  function makeSource(ctx, buf, gainValue) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    src.connect(gain);
    gain.connect(S.master);
    return { src, gain };
  }

  /* ---------------- BGM (single instance, looped) ---------------- */

  function stopBgmSource() { // stop the current source WITHOUT bumping the token
    if (S.bgmSource) {
      try { S.bgmSource.stop(); } catch (e) { /* already stopped */ }
      try { S.bgmSource.disconnect(); } catch (e) { /* noop */ }
      S.bgmSource = null;
    }
    S.bgmGain = null;
  }

  async function playBgm(url) {
    const ctx = ensure();
    if (!ctx) return;
    const gen = ++S.bgmGen;   // this call's identity
    stopBgmSource();
    let buf;
    try { buf = await loadBuffer(url); } catch (e) { console.warn('[audio] bgm load failed:', url, e); return; }
    if (gen !== S.bgmGen) return; // superseded by a newer playBgm/stopBgm — drop silently
    if (!buf) return;
    const { src, gain } = makeSource(ctx, buf, S.vol.bgm);
    src.loop = true;
    src.start();
    S.bgmSource = src;
    S.bgmGain = gain;
  }

  function stopBgm() {
    S.bgmGen++; // invalidate any in-flight playBgm
    stopBgmSource();
  }

  /* ---------------- SFX (one-shot, may overlap) ---------------- */

  async function playSfx(url) {
    const ctx = ensure();
    if (!ctx) return;
    let buf;
    try { buf = await loadBuffer(url); } catch (e) { console.warn('[audio] sfx load failed:', url, e); return; }
    if (!buf) return;
    const { src, gain } = makeSource(ctx, buf, S.vol.sfx);
    src.start();
  }

  /* ---------------- Voice (one at a time) ---------------- */

  async function playVoice(url) {
    const ctx = ensure();
    if (!ctx) return;
    const gen = ++S.voiceGen; // this call's identity
    if (S.voiceSource) {
      try { S.voiceSource.stop(); } catch (e) { /* noop */ }
      S.voiceSource = null;
    }
    let buf;
    try { buf = await loadBuffer(url); } catch (e) { console.warn('[audio] voice load failed:', url, e); return; }
    if (gen !== S.voiceGen) return; // a newer voice call superseded this one
    if (!buf) return;
    const { src, gain } = makeSource(ctx, buf, S.vol.voice);
    src.start();
    S.voiceSource = src;
  }

  /* ---------------- volume ---------------- */

  function setVolume(kind, v) {
    S.vol[kind] = v;
    if (kind === 'bgm' && S.bgmGain) S.bgmGain.gain.value = v;
  }

  function getVolume(kind) { return S.vol[kind]; }

  /* ---------------- recording audio track ---------------- */

  // route the master bus into a MediaStreamDestination; returns the audio track
  function startAudioTrack() {
    const ctx = ensure();
    if (!ctx || !ctx.createMediaStreamDestination) return null;
    if (!S.recDest) {
      S.recDest = ctx.createMediaStreamDestination();
      S.master.connect(S.recDest);
    }
    const tracks = S.recDest.stream.getAudioTracks();
    return tracks.length ? tracks[0] : null;
  }

  function stopAudioTrack() {
    if (S.recDest && S.master) {
      try { S.master.disconnect(S.recDest); } catch (e) { /* noop */ }
    }
    S.recDest = null;
  }

  return {
    playBgm, stopBgm, playSfx, playVoice,
    setVolume, getVolume,
    unlock,
    startAudioTrack, stopAudioTrack,
  };
});
