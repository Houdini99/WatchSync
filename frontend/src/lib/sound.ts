// A short, soft "ping" for new chat messages, synthesized with Web Audio so we
// ship no audio assets.

let audioCtx: AudioContext | null = null;

export function playPing() {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!audioCtx) audioCtx = new Ctor();
    // An AudioContext created outside a user gesture (e.g. on an incoming chat
    // message) starts "suspended" under browser autoplay policy and stays silent
    // until resumed. The user has already interacted to join the room, so this
    // resume is allowed and is a no-op once the context is running.
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.start(t);
    o.stop(t + 0.2);
  } catch {
    /* ignore */
  }
}
