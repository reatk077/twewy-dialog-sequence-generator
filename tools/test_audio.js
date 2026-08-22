// Audio engine concurrency test (fake Web Audio): verifies only ONE BGM can
// play at a time even with overlapping async decodes, and that stop cancels.
// node tools/test_audio.js
const assert = require('assert');

let startedSources = [];
let gainNodes = [];
let decodeQueue = [];

class FakeNode { connect() {} disconnect() {} }
class FakeGain extends FakeNode { constructor() { super(); this.gain = { value: 0 }; } }
class FakeSource extends FakeNode {
  constructor() { super(); this.buffer = null; this.loop = false; this.started = false; }
  start() { this.started = true; startedSources.push(this); }
  stop() { this.stopped = true; }
}
class FakeAC {
  constructor() { this.state = 'running'; this.destination = new FakeNode(); this.resumeCalls = 0; }
  createGain() { const g = new FakeGain(); gainNodes.push(g); return g; }
  createBufferSource() { return new FakeSource(); }
  resume() { this.resumeCalls++; this.state = 'running'; }
  decodeAudioData() { return new Promise((res) => { decodeQueue.push(res); }); }
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [{ id: 'audio' }] } }; }
}

global.window = { AudioContext: FakeAC };
global.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });

const DGAudio = require('../js/audio.js');
const fakeBuf = { length: 1 };
const tick = () => new Promise(r => setTimeout(r, 0));

(async function () {
  // --- two rapid playBgm calls: only the LATEST may start ---
  startedSources = []; gainNodes = []; decodeQueue = [];
  DGAudio.playBgm('data:audio/a');
  DGAudio.playBgm('data:audio/b');
  await tick(); await tick(); // let fetch/decode microtasks queue up
  assert.strictEqual(decodeQueue.length, 2, 'two decodes queued');
  assert.strictEqual(startedSources.length, 0, 'nothing starts before decodes resolve');
  decodeQueue.shift()(fakeBuf); // older decode (a) resolves first
  await tick();
  assert.strictEqual(startedSources.length, 0, 'superseded decode must NOT start');
  decodeQueue.shift()(fakeBuf); // newest decode (b) resolves
  await tick();
  assert.strictEqual(startedSources.length, 1, 'exactly one BGM source started');
  assert.strictEqual(startedSources[0].loop, true, 'bgm loops');
  console.log('audio1 OK: overlapping playBgm -> single source (generation token)');

  // --- stopBgm cancels an in-flight load ---
  startedSources = []; decodeQueue = [];
  DGAudio.playBgm('data:audio/c');
  await tick(); await tick();
  DGAudio.stopBgm();
  decodeQueue.shift()(fakeBuf);
  await tick();
  assert.strictEqual(startedSources.length, 0, 'stopBgm cancels pending decode');
  console.log('audio2 OK: stopBgm invalidates in-flight playBgm');

  // --- rapid playVoice: only the latest starts ---
  startedSources = []; decodeQueue = [];
  DGAudio.playVoice('data:voice/x');
  DGAudio.playVoice('data:voice/y');
  await tick(); await tick();
  decodeQueue.shift()(fakeBuf);
  await tick();
  assert.strictEqual(startedSources.length, 0, 'superseded voice does not start');
  decodeQueue.shift()(fakeBuf);
  await tick();
  assert.strictEqual(startedSources.length, 1, 'exactly one voice source started');
  console.log('audio3 OK: overlapping playVoice -> single voice');

  // --- volume applies to the started BGM gain ---
  DGAudio.setVolume('bgm', 0.3);
  startedSources = []; gainNodes = []; decodeQueue = [];
  DGAudio.playBgm('data:audio/d');
  await tick(); await tick();
  decodeQueue.shift()(fakeBuf);
  await tick();
  assert.strictEqual(gainNodes.length, 1, 'bgm gain created');
  assert.ok(Math.abs(gainNodes[0].gain.value - 0.3) < 1e-9, 'bgm gain uses current volume, got ' + gainNodes[0].gain.value);
  DGAudio.setVolume('bgm', 0.8);
  assert.ok(Math.abs(gainNodes[0].gain.value - 0.8) < 1e-9, 'slider updates live gain');
  console.log('audio4 OK: bgm volume slider drives the live gain');

  // --- recording audio track ---
  const track = DGAudio.startAudioTrack();
  assert.ok(track && track.id === 'audio', 'audio track exposed for recording');
  DGAudio.stopAudioTrack(); // no throw
  console.log('audio5 OK: recording audio track hook');

  // --- gesture unlock: resumes a suspended context (autoplay policy) ---
  {
    let lastAC = null;
    class SuspendedAC extends FakeAC {
      constructor() { super(); this.state = 'suspended'; lastAC = this; }
    }
    global.window.AudioContext = SuspendedAC;
    // fresh module instance (fresh S.ctx) so unlock() creates the context
    const path = require.resolve('../js/audio.js');
    delete require.cache[path];
    const A2 = require('../js/audio.js');
    A2.unlock(); // simulate the first user gesture
    assert.ok(lastAC, 'unlock created the AudioContext');
    assert.ok(lastAC.resumeCalls >= 1, 'unlock resumed the suspended context');
    assert.strictEqual(lastAC.state, 'running', 'context running after unlock');
    console.log('audio6 OK: unlock() creates+resumes context on user gesture (autoplay handled)');
  }

  delete global.window;
  delete global.fetch;
  console.log('ALL AUDIO TESTS PASSED');
})().catch(e => { console.error('AUDIO TEST FAILED:', e); process.exit(1); });
