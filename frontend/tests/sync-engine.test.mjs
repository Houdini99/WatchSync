// SyncEngine behaviour: how the local player is steered toward the room.
// Runs on Node's built-in test runner with fake timers — `npm test`.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

globalThis.window ??= globalThis;
globalThis.document ??= { visibilityState: 'visible' };
const { SyncEngine } = await import('../src/sync/SyncEngine.ts');

/** A scriptable stand-in for the Player interface. */
class FakePlayer {
  events = new EventTarget();
  time = 0;
  rate = 1;
  paused = false;
  seeking = false;
  ended = false;
  nudgeable = true;
  /** Buffered ranges as [start, end] pairs. */
  buffered = [[0, Infinity]];
  applied = [];
  rates = [];

  getTime() { return this.time; }
  getRate() { return this.rate; }
  isPaused() { return this.paused; }
  isSeeking() { return this.seeking; }
  isEnded() { return this.ended; }
  getTitle() { return null; }
  canNudgeRate() { return this.nudgeable; }
  canPlayAt(t) { return this.buffered.some(([a, b]) => t >= a && t <= b); }
  applyState(s) {
    this.applied.push({ ...s });
    this.time = s.currentTime;
    this.paused = s.paused;
    this.rate = s.rate;
  }
  setRate(r) {
    this.rates.push(r);
    this.rate = r;
  }
  fire(type, detail) {
    this.events.dispatchEvent(new CustomEvent(type, { detail }));
  }
  load() {}
  unload() {}
  setEnabled() {}
  toggleMute() { return false; }
  setVolume() {}
  resumeUnmuted() {}
  seekBy() {}
  togglePlay() {}
  supportsPiP() { return false; }
  togglePiP() {}
}

const MEDIA = { kind: 'hls', source: 'https://example.com/a.mp4', start: 0, title: 'a' };
const video = (current_time, extra = {}) => ({
  media: MEDIA,
  current_time,
  paused: false,
  rate: 1,
  server_time: 0,
  ...extra,
});

let engine;
let player;
let sent;

const heartbeat = (current_time, paused = false, rate = 1) =>
  engine.onHeartbeat({ current_time, paused, rate });
const kinds = () => sent.map((m) => m.type);
const lastApplied = () => player.applied[player.applied.length - 1];

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  sent = [];
  engine = new SyncEngine((m) => sent.push(m));
  engine.connId = 'me';
  engine.setDriftTolerance(1.5);
  player = new FakePlayer();
  engine.setPlayer(player);
  mock.timers.tick(3000); // past the post-load settle window
});

afterEach(() => {
  mock.timers.reset();
  document.visibilityState = 'visible';
});

describe('drift correction', () => {
  test('drift inside the tolerance is left alone', () => {
    player.time = 10;
    heartbeat(11);
    assert.deepEqual(player.applied, []);
    assert.deepEqual(player.rates, []);
  });

  test('moderate drift is closed with a rate nudge, not a seek', () => {
    player.time = 10;
    heartbeat(12.5); // 2.5s behind
    assert.deepEqual(player.applied, []);
    assert.equal(player.rates.length, 1);
    assert.ok(player.rate > 1 && player.rate <= 1.1, `rate ${player.rate}`);

    // Caught up: back to the room's rate.
    mock.timers.tick(4000);
    player.time = 16.3;
    heartbeat(16.5);
    assert.equal(player.rate, 1);
  });

  test('a player ahead of the room is slowed down', () => {
    player.time = 13;
    heartbeat(10.5);
    assert.ok(player.rate < 1 && player.rate >= 0.9, `rate ${player.rate}`);
  });

  test('a big gap is one seek followed by a cooldown', () => {
    player.time = 10;
    heartbeat(20);
    assert.deepEqual(player.applied, [{ currentTime: 20, paused: false, rate: 1 }]);

    // The seek has not landed yet; measuring now would stack a second one.
    player.time = 10;
    mock.timers.tick(4000);
    heartbeat(24);
    assert.equal(player.applied.length, 1);

    mock.timers.tick(1500);
    heartbeat(25.5);
    assert.equal(player.applied.length, 2);
  });

  test('a nudge that makes no progress escalates to a seek', () => {
    let room = 13;
    let elapsed = 0;
    player.time = 10;
    heartbeat(room);
    assert.equal(player.applied.length, 0, 'starts as a nudge');
    while (player.applied.length === 0 && elapsed < 60_000) {
      mock.timers.tick(4000);
      elapsed += 4000;
      room += 4;
      player.time += 4; // pinned: plays, but never faster
      heartbeat(room);
    }
    assert.equal(elapsed, 16_000, 'gives up after 15s without progress');
    assert.deepEqual(player.applied, [{ currentTime: room, paused: false, rate: 1 }]);
  });

  test('a player that cannot nudge tolerates up to twice the tolerance', () => {
    player.nudgeable = false;
    player.time = 10;
    heartbeat(12.5);
    assert.deepEqual(player.applied, []);
    assert.deepEqual(player.rates, []);
    heartbeat(13.5);
    assert.equal(lastApplied().currentTime, 13.5);
  });

  test('live streams track pause and rate but never seek', () => {
    engine.setLive(true);
    player.time = 10;
    heartbeat(300, false, 1.5);
    assert.deepEqual(player.applied, []);
    assert.equal(player.rate, 1.5);
  });

  test('latency is compensated while playing', () => {
    engine.latencyMs = 200;
    player.time = 10;
    heartbeat(20);
    assert.ok(Math.abs(lastApplied().currentTime - 20.2) < 1e-9);
  });
});

describe('pause and resume', () => {
  test('the room pausing lines the player up on its position', () => {
    player.time = 10;
    heartbeat(11, true);
    assert.deepEqual(lastApplied(), { currentTime: 11, paused: true, rate: 1 });
  });

  test('a small offset is not worth a seek on pause', () => {
    player.time = 10.8;
    heartbeat(11, true);
    assert.deepEqual(lastApplied(), { currentTime: 10.8, paused: true, rate: 1 });
  });

  test('resuming starts from where the player is', () => {
    player.paused = true;
    player.time = 10;
    heartbeat(11);
    assert.deepEqual(lastApplied(), { currentTime: 10, paused: false, rate: 1 });
  });

  test('a paused room pulls a paused player into line', () => {
    player.paused = true;
    player.time = 10;
    heartbeat(12, true);
    assert.deepEqual(lastApplied(), { currentTime: 12, paused: true, rate: 1 });
  });

  test('an ended player is not restarted from the top', () => {
    player.ended = true;
    player.paused = true;
    player.time = 100;
    heartbeat(99);
    assert.deepEqual(player.applied, [], 'the room is about to finish too');
    heartbeat(80);
    assert.deepEqual(lastApplied(), { currentTime: 80, paused: false, rate: 1 });
  });
});

describe('buffering', () => {
  test('stalls are debounced going in and immediate coming out', () => {
    player.fire('buffering', { buffering: true });
    mock.timers.tick(400);
    player.fire('buffering', { buffering: false });
    mock.timers.tick(1000);
    assert.deepEqual(kinds(), [], 'a 400ms hiccup never reaches the room');

    player.fire('buffering', { buffering: true });
    mock.timers.tick(600);
    assert.deepEqual(kinds(), ['buffering_start']);
    player.fire('buffering', { buffering: false });
    assert.deepEqual(kinds(), ['buffering_start', 'buffering_end']);
  });

  test('an unbuffered target holds the room instead of playing into the hole', () => {
    player.buffered = [[0, 12]];
    player.time = 10;
    heartbeat(20);
    assert.deepEqual(kinds(), ['buffering_start'], 'reported at once, not debounced');
    assert.deepEqual(lastApplied(), { currentTime: 20, paused: true, rate: 1 });

    // The room waits for us; our data arrives while the cooldown still runs.
    mock.timers.tick(2000);
    heartbeat(20.05, true);
    assert.deepEqual(kinds(), ['buffering_start']);
    player.buffered = [[0, 50]];
    mock.timers.tick(2000);
    heartbeat(20.05, true);
    assert.deepEqual(kinds(), ['buffering_start', 'buffering_end']);
  });

  test('starvation and a player stall are one hold', () => {
    player.buffered = [[0, 12]];
    player.time = 10;
    heartbeat(20);
    player.fire('buffering', { buffering: true });
    player.buffered = [[0, 50]];
    heartbeat(20, true);
    assert.deepEqual(kinds(), ['buffering_start'], 'the stall still holds the room');
    player.fire('buffering', { buffering: false });
    assert.deepEqual(kinds(), ['buffering_start', 'buffering_end']);
  });

  test('a deliberate action releases a starvation hold', () => {
    player.buffered = [[0, 12]];
    player.time = 10;
    heartbeat(20);
    engine.onRoomState(video(5), 'someone-else');
    assert.deepEqual(kinds(), ['buffering_start', 'buffering_end']);
    assert.deepEqual(lastApplied(), { currentTime: 5, paused: false, rate: 1 });
  });

  test('tearing the player down releases the room', () => {
    player.fire('buffering', { buffering: true });
    mock.timers.tick(600);
    engine.clearPlayer();
    assert.deepEqual(kinds(), ['buffering_start', 'buffering_end']);
  });

  test('a rejoin restates the buffering state', () => {
    engine.onJoined();
    assert.deepEqual(kinds(), ['buffering_end']);
    player.fire('buffering', { buffering: true });
    mock.timers.tick(600);
    engine.onJoined();
    assert.deepEqual(kinds(), ['buffering_end', 'buffering_start', 'buffering_start']);
    player.fire('buffering', { buffering: false });
    assert.equal(kinds().at(-1), 'buffering_end');
  });
});

describe('room state and intents', () => {
  test('our own echo is ignored; someone else\'s intent is snapped to', () => {
    player.time = 10;
    engine.onRoomState(video(30), 'me');
    assert.deepEqual(player.applied, []);
    engine.onRoomState(video(30), 'someone-else');
    assert.deepEqual(lastApplied(), { currentTime: 30, paused: false, rate: 1 });
  });

  test('incidental room states go through the drift gate', () => {
    player.time = 10;
    engine.onRoomState(video(11), null);
    assert.deepEqual(player.applied, []);
  });

  test('local actions are not overridden while they propagate', () => {
    player.time = 50;
    player.fire('seek', { currentTime: 50 });
    assert.deepEqual(sent, [{ type: 'seek', current_time: 50 }]);
    heartbeat(10);
    assert.deepEqual(player.applied, []);
    mock.timers.tick(2100);
    heartbeat(50.2);
    assert.deepEqual(player.applied, []);
  });

  test('events from a replaced player are ignored', () => {
    const old = player;
    player = new FakePlayer();
    engine.setPlayer(player);
    mock.timers.tick(3000);
    old.fire('pause', { currentTime: 5 });
    old.fire('ended');
    assert.deepEqual(sent, []);
  });

  test('intents are held back while a new player settles', () => {
    engine.setPlayer(new FakePlayer());
    player.fire('pause', { currentTime: 0 });
    assert.deepEqual(sent, []);
  });

  test('a seek from the UI is sent once and applied without an echo', () => {
    player.time = 10;
    assert.equal(engine.jumpTo(83), true);
    assert.deepEqual(sent, [{ type: 'seek', current_time: 83 }]);
    assert.deepEqual(lastApplied(), { currentTime: 83, paused: false, rate: 1 });
    heartbeat(10.5); // a heartbeat already in flight must not yank us back
    assert.equal(player.applied.length, 1);
  });

  test('a UI seek keeps a paused room paused, and is refused for live media', () => {
    heartbeat(10, true);
    engine.jumpTo(20);
    assert.deepEqual(lastApplied(), { currentTime: 20, paused: true, rate: 1 });
    engine.setLive(true);
    assert.equal(engine.jumpTo(30), false);
  });

  test('stream offsets map between content and stream time', () => {
    engine.setStreamOffset(100);
    player.time = 10; // content second 110
    player.fire('seek', { currentTime: 10 });
    assert.deepEqual(sent, [{ type: 'seek', current_time: 110 }]);
    mock.timers.tick(2100);
    heartbeat(130);
    assert.deepEqual(lastApplied(), { currentTime: 30, paused: false, rate: 1 });
  });
});

describe('background pages', () => {
  test('a pause while the page is hidden is not sent to the room', () => {
    document.visibilityState = 'hidden';
    player.fire('pause', { currentTime: 10 });
    assert.deepEqual(sent, []);
    document.visibilityState = 'visible';
    player.fire('pause', { currentTime: 10 });
    assert.deepEqual(sent, [{ type: 'play_pause', paused: true, current_time: 10 }]);
  });

  test('a player paused in the background is left alone, then resynced on return', () => {
    document.visibilityState = 'hidden';
    player.paused = true;
    player.time = 10;
    heartbeat(40);
    assert.deepEqual(player.applied, [], 'no play() from a hidden page');
    document.visibilityState = 'visible';
    assert.equal(engine.needsResyncOnVisible(), true);
  });

  test('no resync is needed when the room is paused too, or we kept playing', () => {
    heartbeat(10, true);
    player.paused = true;
    assert.equal(engine.needsResyncOnVisible(), false);
    heartbeat(10);
    player.paused = false;
    assert.equal(engine.needsResyncOnVisible(), false);
  });

  test('a hidden page still follows the room pausing', () => {
    document.visibilityState = 'hidden';
    player.time = 10;
    heartbeat(10.2, true);
    assert.equal(player.paused, true);
  });
});
