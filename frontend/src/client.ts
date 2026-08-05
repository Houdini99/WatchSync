// WatchSyncClient — the imperative core that owns the socket, the sync engine,
// and the active player, and projects everything into the Zustand store. React
// components call its methods; it never imports React.

import { captions } from './lib/captions';
import {
  ensureClientId,
  readHostToken,
  readSeatToken,
  storeHostToken,
  storeSeatToken,
} from './lib/identity';
import { playPing } from './lib/sound';
import { Socket } from './lib/socket';
import { pickPlayer, type Player } from './sync/players';
import { SyncEngine } from './sync/SyncEngine';
import { nextId, useStore } from './store';
import type { ChatItem, Media, Snapshot, StreamView, VideoView } from './types';

const PING_INTERVAL_MS = 15000;
const MAX_JOIN_ATTEMPTS = 3;
const JOIN_RETRY_MS = 500;

function sameMedia(a: Media | null, b: Media | null): boolean {
  if (!a || !b) return a === b;
  return a.source === b.source && a.kind === b.kind;
}

class WatchSyncClient {
  /** Effective identity. Starts from the locally-persisted id, but the server may
   *  assign a different one on join (if our id collided with an occupied seat) —
   *  we adopt whatever `joined` returns so "you"/host/mine checks stay correct. */
  clientId = ensureClientId();
  private socket: Socket | null = null;
  private sync: SyncEngine | null = null;

  player: Player | null = null;
  private currentMedia: Media | null = null;
  /** The proxy playlist path the Html5Player is currently loaded with (incl. the
   *  `?g=` generation), so we know when a seek-respawn requires a reload. */
  private currentStreamPath: string | null = null;
  private lastVideoState: VideoView | null = null;

  private roomId = '';
  private nickname = 'guest';
  private hostToken: string | null = null;
  private seatToken: string | null = null;
  private hasJoinedOnce = false;
  private joinAttempts = 0;
  private kicked = false;

  private mounts: { video: HTMLVideoElement; ytMount: HTMLElement } | null = null;
  private pingTimer: number | null = null;
  private ytTitlePoll: number | null = null;
  private typingTimers = new Map<string, number>();
  private resyncResolvers: Array<(ok: boolean) => void> = [];

  // ---- connection lifecycle ----

  connect(roomId: string, nickname: string) {
    // Tear down any prior connection first, so a second connect() can never
    // orphan a still-reconnecting socket (which would churn the seat server-side).
    if (this.socket) this.disconnect();

    this.roomId = roomId;
    this.nickname = nickname;
    this.hostToken = readHostToken(roomId);
    this.seatToken = readSeatToken(roomId);
    this.joinAttempts = 0;
    this.kicked = false;

    const socket = new Socket();
    this.socket = socket;
    this.sync = new SyncEngine((msg) => socket.send(msg));

    socket.onStatus((connected) => {
      useStore.getState().setConnected(connected);
      if (connected) {
        this.sendJoin();
        useStore.getState().setStatus('');
      } else if (!this.kicked) {
        // Suppress the reconnect notice when we were kicked/banned — the close is
        // intentional and the reason is already shown.
        useStore.getState().setStatus('Disconnected — reconnecting…', true);
      }
    });

    socket.on('welcome', (m) => {
      if (this.sync) this.sync.connId = m.conn_id;
    });
    socket.on('joined', (m) => {
      this.joinAttempts = 0;
      // Adopt the server's effective identity + persist the seat secret so a
      // reconnect reclaims this exact seat (and host status).
      this.clientId = m.client_id;
      this.seatToken = m.seat_token;
      storeSeatToken(this.roomId, m.seat_token);
      const store = useStore.getState();
      this.sync?.setDriftTolerance(m.config.drift_tolerance_sec);
      store.setConfig(m.config.allowed_rates, m.config.max_queue_length);
      if (!this.hasJoinedOnce) {
        store.setChat(m.chat_history.map((e) => this.toChatItem(e)));
      }
      this.hasJoinedOnce = true;
      // The socket carried our session cookie; adopt the server's view of the
      // account so the UI agrees with what the room sees.
      if (m.account) {
        store.setAccount({
          username: m.account.username,
          displayName: m.account.display_name,
          color: m.account.color,
        });
      }
      const changed = !sameMedia(m.snapshot.video.media, this.currentMedia);
      this.applySnapshot(m.snapshot);
      // If the player already exists for this media (a reconnect), snap straight
      // to the live position; otherwise the mount effect will applyInitial.
      if (!changed && this.player && m.snapshot.video.media) {
        this.sync?.applyInitial(m.snapshot.video);
      }
    });
    socket.on('join_error', (m) => {
      // When we created this room (we hold its host token), a "not found" on the
      // first connect is almost always a transient race rather than a genuinely
      // missing room — retry a few times before bouncing the creator back to the
      // landing page. Plain joiners (no host token) still fail fast on a dead link.
      if (this.hostToken && this.joinAttempts < MAX_JOIN_ATTEMPTS && this.socket?.isOpen) {
        this.joinAttempts++;
        useStore.getState().setStatus('Connecting…', true);
        window.setTimeout(() => this.sendJoin(), JOIN_RETRY_MS);
        return;
      }
      useStore.getState().setStatus(m.error, true);
      this.disconnect();
      const store = useStore.getState();
      store.reset();
      store.setStatus(m.error, true);
      history.pushState(null, '', '/');
    });
    socket.on('kicked', (m) => {
      // Host removed us. Fully disconnect (so we don't auto-reconnect straight
      // back in) and bounce to the landing page with the reason shown.
      this.kicked = true;
      this.disconnect();
      const store = useStore.getState();
      store.reset();
      store.setStatus(m.reason, true);
      history.pushState(null, '', '/');
    });
    socket.on('action_error', (m) => useStore.getState().setStatus(m.error, true));
    socket.on('room_state', (m) => {
      this.applySnapshot(m.snapshot);
      this.sync?.onRoomState(m.snapshot.video, m.caused_by);
    });
    socket.on('heartbeat', (m) =>
      this.sync?.onHeartbeat({ current_time: m.current_time, paused: m.paused, rate: m.rate }),
    );
    socket.on('chat_message', (m) => this.onChat(m));
    socket.on('system_message', (m) =>
      useStore.getState().addChat({ id: nextId(), kind: 'system', text: m.text, ts: m.ts, mine: false }),
    );
    socket.on('reaction', (m) => this.onReaction(m));
    socket.on('typing', (m) => this.onTyping(m));
    socket.on('pong', (m) => this.onPong(m.client_time));
    socket.on('sync_snapshot', (m) => {
      this.lastVideoState = m.snapshot.video;
      if (m.snapshot.video.media && this.player) this.sync?.applyInitial(m.snapshot.video);
      const resolvers = this.resyncResolvers;
      this.resyncResolvers = [];
      resolvers.forEach((r) => r(true));
    });

    socket.connect();
    this.startPinging();
  }

  private sendJoin() {
    this.socket?.send({
      type: 'join_room',
      room_id: this.roomId,
      nickname: this.nickname,
      client_id: this.clientId,
      host_token: this.hostToken,
      seat_token: this.seatToken,
    });
  }

  disconnect() {
    this.stopPinging();
    this.socket?.close();
    this.socket = null;
    this.sync?.clearPlayer();
    this.sync = null;
    this.teardownPlayer();
    captions.onMedia(null);
    this.hasJoinedOnce = false;
  }

  // ---- snapshot → store ----

  private applySnapshot(snap: Snapshot) {
    const store = useStore.getState();
    const isHost = snap.host_client_id ? snap.host_client_id === this.clientId : false;
    store.patchRoom({
      isHost,
      locked: snap.locked,
      persistent: snap.persistent,
      registered: snap.registered,
      users: snap.users,
      queue: snap.queue,
      media: snap.video.media,
      stream: snap.video.stream ?? null,
      rate: snap.video.rate || 1,
    });
    // No client-side codec warnings anymore: non-YouTube media is muxed to HLS
    // server-side (audio transcoded to AAC), which is exactly what used to break
    // for MKV. Unplayable sources now surface as a stream error instead.
    store.setMediaWarning(null);
    this.lastVideoState = snap.video;
  }

  // ---- player lifecycle (driven by the VideoPlayer mount effect) ----

  setMounts(video: HTMLVideoElement, ytMount: HTMLElement) {
    this.mounts = { video, ytMount };
  }

  /** Reconcile the mounted player with the room's current media + proxy stream.
   *  Driven by the VideoPlayer mount effect whenever media or stream changes. */
  reconcilePlayer() {
    if (!this.mounts || !this.sync) return;
    const { media, stream } = useStore.getState();
    captions.onMedia(media);
    if (!media) {
      this.teardownPlayer();
      useStore.getState().setStatus('');
      return;
    }
    if (media.kind === 'youtube') {
      this.ensureYouTube(media);
    } else {
      this.ensureProxyStream(media, stream);
    }
  }

  /** YouTube: unchanged IFrame path — no server-side proxy, no offset. */
  private ensureYouTube(media: Media) {
    this.sync!.setStreamOffset(0);
    if (this.player && this.currentStreamPath === null && sameMedia(media, this.currentMedia)) return;
    this.mountPlayer(media, media, null);
    this.pollYouTubeTitle(media);
  }

  /** Non-YouTube: play the server-side HLS proxy off /api/streams once ffmpeg
   *  has produced a playlist. Reloads in place when the stream is respawned
   *  (e.g. on a seek — the `?g=` generation in the path changes). */
  private ensureProxyStream(media: Media, stream: StreamView | null) {
    const store = useStore.getState();
    if (!stream || stream.error) {
      this.teardownPlayer();
      if (stream?.error) {
        store.setStatus('This media could not be streamed (unsupported codec, auth, or DRM).', true);
      } else {
        store.setStatus('');
      }
      return;
    }
    if (!stream.ready) {
      // Server is still resolving the source + spawning ffmpeg. Wait for it.
      this.teardownPlayer();
      store.setStatus('Preparing stream…');
      return;
    }
    // Ready. Map the offset for sync, then (re)load only when the generation changed.
    this.sync!.setStreamOffset(stream.offset);
    if (this.player && this.currentStreamPath === stream.path) return;
    store.setStatus('');
    // hls.js plays the local playlist; keep the logical media for title/live/UI.
    const hlsMedia: Media = { ...media, kind: 'hls', source: stream.path };
    this.mountPlayer(media, hlsMedia, stream.path);
  }

  /** Tear down the old player and mount a fresh one. `logical` is the media used
   *  for UI/title/live; `playable` is what the player actually loads (identical
   *  for YouTube, the local proxy playlist for everything else). */
  private mountPlayer(logical: Media, playable: Media, streamPath: string | null) {
    this.teardownPlayer();
    this.currentMedia = logical;
    this.currentStreamPath = streamPath;
    const player = pickPlayer(playable, this.mounts!);
    this.player = player;
    player.load(playable);
    this.sync!.setLive(!!logical.is_live);
    this.sync!.setMediaSource(logical.source);
    this.sync!.setPlayer(player);
    if (this.lastVideoState?.media) this.sync!.applyInitial(this.lastVideoState);
    this.applyLockToPlayer();
    player.events.addEventListener('mediaerror', () => {
      useStore.getState().setStatus('This media failed to load — check the URL, CORS, or codec.', true);
    });
    player.events.addEventListener('autoplayblocked', (e) => {
      const blocked = !!((e as CustomEvent).detail as { blocked?: boolean } | undefined)?.blocked;
      useStore.getState().setAutoplayBlocked(blocked);
    });
  }

  /** User tapped the "click for sound" overlay after a blocked autoplay: the tap
   *  is the gesture the browser wanted, so unmuting is allowed now. */
  resumeWithSound() {
    useStore.getState().setAutoplayBlocked(false);
    this.player?.resumeUnmuted();
  }

  private pollYouTubeTitle(media: Media) {
    if (this.ytTitlePoll) clearInterval(this.ytTitlePoll);
    let tries = 0;
    this.ytTitlePoll = window.setInterval(() => {
      tries++;
      const t = this.player?.getTitle();
      if (t) {
        this.stopYtTitlePoll();
        if (t !== media.title) this.socket?.send({ type: 'media_title', title: t });
      } else if (tries > 20) {
        this.stopYtTitlePoll();
      }
    }, 500);
  }

  private stopYtTitlePoll() {
    if (this.ytTitlePoll) {
      clearInterval(this.ytTitlePoll);
      this.ytTitlePoll = null;
    }
  }

  teardownPlayer() {
    if (this.player) {
      try {
        this.player.unload();
      } catch {
        /* ignore */
      }
      this.player = null;
    }
    useStore.getState().setAutoplayBlocked(false);
    this.sync?.clearPlayer();
    this.sync?.setMediaSource(null);
    this.stopYtTitlePoll();
    this.currentMedia = null;
    this.currentStreamPath = null;
  }

  applyLockToPlayer() {
    const { isHost, locked } = useStore.getState();
    this.player?.setEnabled(isHost || !locked);
  }

  // ---- outgoing intents ----

  /** Load a URL now. The server resolves the source (yt-dlp) and mux/transcodes
   *  it to HLS on demand, so the client just sends the raw URL and the player
   *  waits for the proxy stream to become ready. */
  async submitVideo(rawUrl: string) {
    const url = rawUrl.trim();
    if (!url) return;
    this.socket?.send({ type: 'change_video', url });
  }

  /** Add a URL to the queue (the server resolves its title in the background). */
  async submitToQueue(rawUrl: string) {
    const url = rawUrl.trim();
    if (!url) return;
    this.socket?.send({ type: 'queue_add', url });
    useStore.getState().showToast('Added to queue');
  }
  queueRemove(index: number) {
    this.socket?.send({ type: 'queue_remove', index });
  }
  queueMove(from: number, to: number) {
    this.socket?.send({ type: 'queue_move', from, to });
  }
  queueSkip() {
    this.socket?.send({ type: 'queue_skip' });
  }
  lockRoom(locked: boolean) {
    this.socket?.send({ type: 'lock_room', locked });
  }
  setPersistent(persistent: boolean) {
    this.socket?.send({ type: 'set_persistent', persistent });
  }
  /** Host-only: remove a user (they may rejoin). */
  kickUser(clientId: string) {
    this.socket?.send({ type: 'kick_user', client_id: clientId });
  }
  /** Host-only: remove a user and block their rejoin for this room. */
  banUser(clientId: string) {
    this.socket?.send({ type: 'ban_user', client_id: clientId });
  }

  /** Apply a speed change locally *and* tell the server (our echo is ignored,
   *  so without the local apply the originator's video would never change). */
  setRate(rate: number): boolean {
    const { locked, isHost } = useStore.getState();
    if (locked && !isHost) return false;
    this.player?.setRate(rate);
    useStore.getState().patchRoom({ rate });
    this.socket?.send({ type: 'set_rate', rate });
    return true;
  }

  sendChat(text: string) {
    const trimmed = text.trim();
    if (trimmed) this.socket?.send({ type: 'chat_message', text: trimmed });
  }
  sendReaction(emoji: string) {
    this.socket?.send({ type: 'reaction', emoji });
  }
  sendTyping(typing: boolean) {
    this.socket?.send({ type: 'typing', typing });
  }

  resync(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.socket?.isOpen) return resolve(false);
      this.resyncResolvers.push(resolve);
      this.socket.send({ type: 'sync_request' });
      window.setTimeout(() => {
        const idx = this.resyncResolvers.indexOf(resolve);
        if (idx >= 0) {
          this.resyncResolvers.splice(idx, 1);
          resolve(false);
        }
      }, 3000);
    });
  }

  // ---- incoming event handling ----

  private toChatItem(e: { kind: 'chat' | 'system'; nickname?: string; color?: string | null; text: string; client_id?: string; ts: number }): ChatItem {
    return {
      id: nextId(),
      kind: e.kind,
      nickname: e.nickname,
      color: e.color,
      text: e.text,
      clientId: e.client_id,
      ts: e.ts,
      mine: e.client_id ? e.client_id === this.clientId : false,
    };
  }

  private onChat(m: { nickname: string; color: string | null; text: string; client_id: string; ts: number }) {
    const mine = m.client_id === this.clientId;
    const store = useStore.getState();
    store.addChat({
      id: nextId(),
      kind: 'chat',
      nickname: m.nickname,
      color: m.color,
      text: m.text,
      clientId: m.client_id,
      ts: m.ts,
      mine,
    });
    if (mine) return;
    // Ping on every incoming message (the chat lives in a sidebar while you watch
    // the video, so the audio cue matters even when the chat tab is open).
    if (store.soundEnabled) playPing();
    const chatActive = store.activeTab === 'chat' && !document.hidden;
    if (chatActive) return;
    store.incUnread();
  }

  private onReaction(m: { emoji: string; nickname: string; color: string | null }) {
    useStore.getState().addReaction({
      id: nextId(),
      emoji: m.emoji,
      nickname: m.nickname,
      color: m.color,
      left: 10 + Math.random() * 80,
      drift: Math.round(Math.random() * 60 - 30),
    });
  }

  private onTyping(m: { client_id: string; nickname: string; typing: boolean }) {
    if (m.client_id === this.clientId) return;
    const store = useStore.getState();
    const existing = this.typingTimers.get(m.client_id);
    if (existing) clearTimeout(existing);
    if (m.typing) {
      store.setTyper(m.client_id, m.nickname);
      const tid = window.setTimeout(() => {
        store.setTyper(m.client_id, null);
        this.typingTimers.delete(m.client_id);
      }, 5000);
      this.typingTimers.set(m.client_id, tid);
    } else {
      store.setTyper(m.client_id, null);
      this.typingTimers.delete(m.client_id);
    }
  }

  private onPong(clientTime: number) {
    const rtt = Date.now() - clientTime;
    if (this.sync) this.sync.latencyMs = rtt / 2;
    const cls = rtt < 80 ? 'good' : rtt < 250 ? 'warn' : 'bad';
    useStore.getState().setPing(Math.round(rtt), cls);
  }

  private startPinging() {
    this.stopPinging();
    const ping = () => this.socket?.send({ type: 'ping', client_time: Date.now() });
    ping();
    this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
  }
  private stopPinging() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---- room creation ----

  async createRoom(): Promise<string> {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create room');
    const { id, hostToken } = (await res.json()) as { id: string; hostToken: string };
    storeHostToken(id, hostToken);
    return id;
  }
}

export const client = new WatchSyncClient();

// The caption overlay reads playback time straight off whichever player is
// mounted (for YouTube the IFrame API keeps this fresh locally — no bridge
// round-trip per call).
captions.attachTimeSource(() => client.player?.getTime() ?? null);
