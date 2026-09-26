// Wire protocol types — kept in lockstep with the Rust `protocol.rs`. Field
// names are snake_case to match what the server serializes.

export interface Media {
  kind: 'youtube' | 'hls' | 'file';
  id?: string;
  source: string;
  start: number;
  title: string;
  /** A live stream — play the live edge and skip position drift-correction. */
  is_live?: boolean;
}

export interface UserView {
  client_id: string;
  nickname: string;
  color: string;
  is_host: boolean;
  buffering: boolean;
  disconnected: boolean;
}

/** Server-side HLS proxy backing the current (non-YouTube) media. */
export interface StreamView {
  /** HLS playlist path (relative). Carries `?g=` so a respawn forces a reload. */
  path: string;
  /** Content-second ffmpeg started at; stream-time 0 maps to this content time. */
  offset: number;
  ready: boolean;
  error: boolean;
}

export interface VideoView {
  media: Media | null;
  current_time: number;
  paused: boolean;
  rate: number;
  server_time: number;
  /** Present when the media plays through the server-side HLS proxy. */
  stream?: StreamView | null;
}

export interface Snapshot {
  id: string;
  locked: boolean;
  persistent: boolean;
  /** Instance of a registered (custom-slug) room — the URL is permanent even
   *  though the room state is not. */
  registered: boolean;
  host_client_id: string | null;
  users: UserView[];
  video: VideoView;
  queue: Media[];
}

export interface ChatHistoryEntry {
  kind: 'chat' | 'system';
  nickname?: string;
  color?: string;
  text: string;
  client_id?: string;
  ts: number;
}

export interface JoinConfig {
  allowed_rates: number[];
  max_queue_length: number;
  drift_tolerance_sec: number;
}

// ---- Server → Client ----

export type ServerMsg =
  | { type: 'welcome'; conn_id: string }
  | {
      type: 'joined';
      you_are_host: boolean;
      client_id: string;
      seat_token: string;
      snapshot: Snapshot;
      chat_history: ChatHistoryEntry[];
      config: JoinConfig;
      /** The account this socket's session resolved to, if signed in. */
      account?: { username: string; display_name: string; color: string | null };
    }
  | { type: 'join_error'; error: string }
  | { type: 'kicked'; reason: string }
  | { type: 'action_error'; error: string }
  | { type: 'room_state'; snapshot: Snapshot; caused_by: string | null }
  | { type: 'heartbeat'; current_time: number; paused: boolean; rate: number; server_time: number }
  | { type: 'chat_message'; nickname: string; color: string | null; text: string; client_id: string; ts: number }
  | { type: 'system_message'; text: string; ts: number }
  | { type: 'reaction'; emoji: string; nickname: string; color: string | null; client_id: string; ts: number }
  | { type: 'typing'; client_id: string; nickname: string; typing: boolean }
  | { type: 'pong'; client_time: number; server_time: number }
  | { type: 'sync_snapshot'; snapshot: Snapshot };

// ---- Client → Server ----

export type ClientMsg =
  | {
      type: 'join_room';
      room_id: string;
      nickname: string;
      client_id: string;
      host_token: string | null;
      seat_token: string | null;
    }
  | { type: 'change_video'; url: string; title?: string; is_live?: boolean }
  | { type: 'play_pause'; paused: boolean; current_time?: number }
  | { type: 'seek'; current_time: number }
  | { type: 'set_rate'; rate: number }
  | { type: 'buffering_start' }
  | { type: 'buffering_end' }
  | { type: 'queue_add'; url: string; title?: string; is_live?: boolean }
  | { type: 'queue_remove'; index: number }
  | { type: 'queue_move'; from: number; to: number }
  | { type: 'queue_skip'; ended_media?: string }
  | { type: 'queue_play'; index: number }
  | { type: 'kick_user'; client_id: string }
  | { type: 'ban_user'; client_id: string }
  | { type: 'transfer_host'; client_id: string }
  | { type: 'lock_room'; locked: boolean }
  | { type: 'set_persistent'; persistent: boolean }
  | { type: 'media_title'; title: string }
  | { type: 'chat_message'; text: string }
  | { type: 'reaction'; emoji: string }
  | { type: 'typing'; typing: boolean }
  | { type: 'sync_request' }
  | { type: 'ping'; client_time: number };

/** One subtitle language available for the current media (see /api/subtitles). */
export interface SubtitleTrack {
  lang: string;
  name: string;
  kind: 'manual' | 'auto' | 'translated';
  /** Direct (CORS-enabled) WebVTT URL, fetched browser-side when possible —
   *  YouTube auto-translate requests only succeed from viewer IPs, not ours. */
  url: string;
}

// ---- Accounts & registered rooms (HTTP API, camelCase JSON) ----

/** The signed-in account, or absent for guests — every flow works without one. */
export interface Account {
  username: string;
  displayName: string;
  color: string | null;
}

/** One registered room slug owned by the signed-in user. */
export interface MyRoomEntry {
  slug: string;
  createdAt: number;
  /** A live instance currently exists in memory. */
  live: boolean;
  userCount: number;
}

// ---- Local UI types ----

export interface ChatItem {
  id: number;
  kind: 'chat' | 'system';
  nickname?: string;
  color?: string | null;
  text: string;
  clientId?: string;
  ts: number;
  mine: boolean;
}

export interface FloatingReaction {
  id: number;
  emoji: string;
  nickname: string;
  color?: string | null;
  left: number;
  drift: number;
}
