// Html5Player: what the native-video adapter reports to the sync engine.
// A scripted stand-in for <video>; events are dispatched by hand where a real
// element would queue them.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

globalThis.window ??= globalThis;
globalThis.document ??= { pictureInPictureElement: null };
const { Html5Player } = await import('../src/sync/players/Html5Player.ts');
const { default: FakeHls } = await import('hls.js');

class FakeTimeRanges {
  constructor(ranges) {
    this.ranges = ranges;
  }
  get length() {
    return this.ranges.length;
  }
  start(i) {
    return this.ranges[i][0];
  }
  end(i) {
    return this.ranges[i][1];
  }
}

class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  seeking = false;
  ended = false;
  readyState = 4;
  playbackRate = 1;
  muted = false;
  volume = 1;
  controls = true;
  style = {};
  error = null;
  disablePictureInPicture = false;
  buffered = new FakeTimeRanges([[0, 100]]);
  plays = 0;

  nativeHls = '';
  canPlayType(type) {
    return type === 'application/vnd.apple.mpegurl' ? this.nativeHls : '';
  }
  play() {
    this.plays++;
    this.paused = false;
    this.ended = false;
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
  removeAttribute() {}
  load() {}
  emit(type) {
    this.dispatchEvent(new Event(type));
  }
}

let video;
let player;
let events;

const of = (type) => events.filter((e) => e.type === type).map((e) => e.detail);

/** Advance in watchdog-sized steps: a single mock tick moves Date to its end
 *  before firing the interval callbacks inside it, which compresses time. */
function advance(ms) {
  for (let left = ms; left > 0; left -= 250) mock.timers.tick(Math.min(250, left));
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  video = new FakeVideo();
  player = new Html5Player(video);
  events = [];
  for (const type of ['play', 'pause', 'seek', 'ratechange', 'buffering', 'ended']) {
    player.events.addEventListener(type, (e) => events.push({ type, detail: e.detail }));
  }
});

afterEach(() => {
  player.unload();
  mock.timers.reset();
});

describe('stall watchdog', () => {
  test('a playing element whose clock stops is buffering', () => {
    video.paused = false;
    video.currentTime = 10;
    advance(1000);
    assert.deepEqual(of('buffering'), []);
    advance(1000);
    assert.deepEqual(of('buffering'), [{ buffering: true }]);
  });

  test('progress ends the stall', () => {
    video.paused = false;
    advance(2000);
    video.currentTime = 0.5;
    advance(500);
    assert.deepEqual(of('buffering'), [{ buffering: true }, { buffering: false }]);
  });

  test('a paused player stays buffering until it could actually resume', () => {
    video.paused = false;
    advance(2000);
    // The room pauses for us; the data is still missing.
    video.paused = true;
    video.readyState = 2;
    advance(3000);
    assert.deepEqual(of('buffering'), [{ buffering: true }]);
    video.readyState = 4;
    advance(500);
    assert.deepEqual(of('buffering'), [{ buffering: true }, { buffering: false }]);
  });

  test('a seek in flight is not progress', () => {
    video.paused = false;
    advance(2000);
    video.seeking = true;
    video.currentTime = 40;
    advance(3000);
    assert.deepEqual(of('buffering'), [{ buffering: true }]);
  });

  test('a seek that takes too long to land while playing is a stall', () => {
    video.paused = false;
    video.seeking = true;
    video.currentTime = 40;
    advance(2000);
    assert.deepEqual(of('buffering'), [{ buffering: true }]);
  });

  test('waiting while paused is not a stall', () => {
    video.emit('waiting');
    assert.deepEqual(of('buffering'), []);
  });

  test('waiting right after our own correction is not reported', () => {
    video.paused = false;
    video.currentTime = 10;
    player.applyState({ currentTime: 20, paused: false, rate: 1 });
    video.emit('waiting');
    assert.deepEqual(of('buffering'), []);
    advance(2500);
    video.emit('waiting');
    assert.deepEqual(of('buffering'), [{ buffering: true }]);
  });

  test('transitions are reported once', () => {
    video.paused = false;
    video.emit('waiting');
    advance(3000);
    video.emit('waiting');
    assert.deepEqual(of('buffering'), [{ buffering: true }]);
  });
});

describe('seeks', () => {
  test('a burst reports where it started and where it ended', () => {
    video.currentTime = 10;
    video.emit('seeked');
    advance(100);
    video.currentTime = 20;
    video.emit('seeked');
    advance(100);
    video.currentTime = 30;
    video.emit('seeked');
    assert.deepEqual(of('seek'), [{ currentTime: 10 }]);
    advance(300);
    assert.deepEqual(of('seek'), [{ currentTime: 10 }, { currentTime: 30 }]);
  });

  test('separate seeks are each reported at once', () => {
    video.currentTime = 10;
    video.emit('seeked');
    advance(1000);
    video.currentTime = 20;
    video.emit('seeked');
    assert.deepEqual(of('seek'), [{ currentTime: 10 }, { currentTime: 20 }]);
  });

  test('our own correction seek is not reported as the viewer\'s', () => {
    video.currentTime = 10;
    player.applyState({ currentTime: 50, paused: true, rate: 1 });
    video.emit('seeking'); // the browser queues this right after the write
    advance(3000); // an HLS seek can land long after the call
    video.emit('seeked');
    assert.deepEqual(of('seek'), []);
    video.currentTime = 70;
    video.emit('seeking');
    video.emit('seeked');
    assert.deepEqual(of('seek'), [{ currentTime: 70 }]);
  });

  /** Regression: a 4s timer forgot our correction, and when it finally landed
   *  on a slow link its `seeked` was reported as the viewer's — dragging the
   *  whole room back to where this viewer had stalled. */
  test('a correction that lands after a long wait is still ours', () => {
    video.currentTime = 10;
    player.applyState({ currentTime: 180, paused: false, rate: 1 });
    video.emit('seeking');
    advance(11000);
    video.emit('seeked');
    assert.deepEqual(of('seek'), []);
  });

  test('a viewer seek made while ours is in flight is theirs', () => {
    video.currentTime = 10;
    player.applyState({ currentTime: 180, paused: false, rate: 1 });
    video.emit('seeking');
    advance(1000);
    video.currentTime = 42; // the viewer grabs the scrubber
    video.emit('seeking');
    video.emit('seeked');
    assert.deepEqual(of('seek'), [{ currentTime: 42 }]);
  });

  test('a write that never produced a seeking event is forgotten', () => {
    video.currentTime = 10;
    player.applyState({ currentTime: 180, paused: false, rate: 1 });
    advance(11000); // no `seeking` ever came for it
    video.currentTime = 42;
    video.emit('seeking');
    video.emit('seeked');
    assert.deepEqual(of('seek'), [{ currentTime: 42 }]);
  });
});

describe('rate', () => {
  test('rates we set are not reported; the viewer\'s are', () => {
    player.setRate(1.05);
    assert.equal(video.playbackRate, 1.05);
    video.emit('ratechange');
    assert.deepEqual(of('ratechange'), []);

    video.playbackRate = 1.5; // native speed menu
    video.emit('ratechange');
    assert.deepEqual(of('ratechange'), [{ rate: 1.5 }]);
  });

  test('a nudge does not swallow a click that lands right after it', () => {
    player.setRate(1.05);
    video.emit('ratechange');
    video.pause();
    assert.equal(of('pause').length, 1);
  });
});

describe('applyState', () => {
  test('never restarts an ended video from the top', () => {
    video.ended = true;
    video.currentTime = 100;
    player.applyState({ currentTime: 100, paused: false, rate: 1 });
    assert.equal(video.plays, 0);
    player.applyState({ currentTime: 50, paused: false, rate: 1 });
    assert.equal(video.currentTime, 50);
    assert.equal(video.plays, 1);
  });

  test('applying state is not reported back as intent', () => {
    video.currentTime = 10;
    player.applyState({ currentTime: 10, paused: false, rate: 1 });
    player.applyState({ currentTime: 10, paused: true, rate: 1 });
    assert.deepEqual(events.filter((e) => e.type === 'play' || e.type === 'pause'), []);
  });
});

describe('HLS engine', () => {
  const HLS = { kind: 'hls', source: '/api/streams/r/index.m3u8?g=1', start: 0, title: 't' };
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    FakeHls.instances.length = 0;
    FakeHls.supported = true;
    delete globalThis.MediaSource;
  });
  afterEach(() => {
    delete globalThis.MediaSource;
  });

  test('hls.js wins even when the browser claims native HLS (current Chrome)', async () => {
    globalThis.MediaSource = class {};
    video.nativeHls = 'maybe';
    player.load(HLS);
    await flush();
    assert.equal(FakeHls.instances.length, 1);
    assert.deepEqual(FakeHls.instances[0].calls, [['loadSource', HLS.source], ['attachMedia', video]]);
    assert.equal(video.src, undefined, 'the native player is not handed the playlist');
  });

  test('without MSE the browser\'s own HLS support is the fallback', async () => {
    video.nativeHls = 'maybe';
    player.load(HLS);
    await flush();
    assert.equal(FakeHls.instances.length, 0, 'hls.js is not even fetched');
    assert.equal(video.src, HLS.source);
  });

  test('hls.js stepping over a buffer hole is not a viewer seek', async () => {
    globalThis.MediaSource = class {};
    player.load(HLS);
    await flush();
    const hls = FakeHls.instances[0];
    hls.emit(FakeHls.Events.ERROR, { details: 'bufferSeekOverHole', fatal: false });
    video.currentTime += 0.3;
    video.emit('seeking');
    video.emit('seeked');
    assert.deepEqual(of('seek'), []);
  });

  test('hls.js refusing to run falls back to native, then to an error', async () => {
    globalThis.MediaSource = class {};
    FakeHls.supported = false;
    const errors = [];
    player.events.addEventListener('mediaerror', (e) => errors.push(e.detail));
    player.load(HLS);
    await flush();
    assert.deepEqual(errors, [{ code: 'hls-unsupported' }]);
    video.nativeHls = 'maybe';
    player.load(HLS);
    await flush();
    assert.equal(video.src, HLS.source);
  });
});

test('a pause raised by a media error is not reported as the viewer\'s', () => {
  video.paused = false;
  video.error = { code: 4, message: 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_PARSE' };
  video.pause();
  assert.deepEqual(of('pause'), []);
});

test('canPlayAt needs buffered runway past the target', () => {
  video.buffered = new FakeTimeRanges([[0, 20], [30, 60]]);
  assert.equal(player.canPlayAt(18.5), true);
  assert.equal(player.canPlayAt(19.5), false);
  assert.equal(player.canPlayAt(25), false);
  assert.equal(player.canPlayAt(45), true);
  video.buffered = new FakeTimeRanges([]);
  assert.equal(player.canPlayAt(0), false);
});

test('an unloaded player reports nothing', () => {
  player.unload();
  video.paused = false;
  video.emit('play');
  advance(5000);
  assert.deepEqual(events, []);
});
