// Stand-in for hls.js in tests: records what the player asked of it.
export default class FakeHls {
  static supported = true;
  static instances = [];
  static Events = { FRAG_BUFFERED: 'hlsFragBuffered', ERROR: 'hlsError' };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  static ErrorDetails = { BUFFER_SEEK_OVER_HOLE: 'bufferSeekOverHole', BUFFER_NUDGE_ON_STALL: 'bufferNudgeOnStall' };
  static isSupported() {
    return FakeHls.supported;
  }

  constructor(config) {
    this.config = config;
    this.calls = [];
    this.handlers = {};
    FakeHls.instances.push(this);
  }
  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
  }
  /** Test helper: raise an hls.js event as the library would. */
  emit(event, data) {
    for (const fn of this.handlers[event] ?? []) fn(event, data);
  }
  loadSource(src) {
    this.calls.push(['loadSource', src]);
  }
  attachMedia(media) {
    this.calls.push(['attachMedia', media]);
  }
  destroy() {
    this.calls.push(['destroy']);
  }
}
