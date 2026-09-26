// Central reactive UI state (Zustand). The imperative WatchSyncClient writes to
// it via `useStore.getState()`; React components read from it with selectors.

import { create } from 'zustand';
import type { Account, ChatItem, FloatingReaction, Media, StreamView, SubtitleTrack, UserView } from './types';

export type View = 'landing' | 'nickname' | 'room' | 'privacy';
export type Tab = 'chat' | 'queue' | 'users';
export type Theme = 'dark' | 'light';
export type PingClass = 'good' | 'warn' | 'bad' | '';

let seq = 0;
export const nextId = () => ++seq;

interface Status {
  text: string;
  warn: boolean;
}

interface StoreState {
  view: View;
  roomId: string | null;
  connected: boolean;

  /** Signed-in account, or null for guests. Survives room resets — signing
   *  out is explicit, leaving a room is not. */
  account: Account | null;
  /** Auth modal visibility (login/register). */
  authOpen: boolean;

  isHost: boolean;
  locked: boolean;
  persistent: boolean;
  /** Current room is an instance of a registered (custom-slug) room. */
  registered: boolean;
  users: UserView[];
  queue: Media[];
  media: Media | null;
  /** Proxy stream for the current media (non-YouTube), or null. */
  stream: StreamView | null;
  rate: number;
  allowedRates: number[];
  maxQueueLength: number;

  chat: ChatItem[];
  typers: Record<string, string>; // clientId -> nickname
  unread: number;
  reactions: FloatingReaction[];

  ping: number | null;
  pingClass: PingClass;

  activeTab: Tab;
  soundEnabled: boolean;
  theme: Theme;

  /** App-level subtitles for the current (YouTube) media — local per viewer. */
  captionTracks: SubtitleTrack[] | null; // null until fetched for this media
  captionsLoading: boolean;
  captionLang: string | null;
  captionText: string | null;

  /** Browser blocked unmuted autoplay; video is playing muted until the viewer
   *  taps the sound overlay. */
  autoplayBlocked: boolean;
  mediaWarning: string | null;
  status: Status;
  toast: string | null;
  appVersion: string | null;

  // actions
  setView: (v: View) => void;
  setRoomId: (id: string | null) => void;
  setConnected: (c: boolean) => void;
  setAccount: (a: Account | null) => void;
  setAuthOpen: (open: boolean) => void;
  patchRoom: (p: Partial<Pick<StoreState, 'isHost' | 'locked' | 'persistent' | 'registered' | 'users' | 'queue' | 'media' | 'stream' | 'rate'>>) => void;
  setConfig: (allowedRates: number[], maxQueueLength: number) => void;

  addChat: (item: ChatItem) => void;
  setChat: (items: ChatItem[]) => void;
  setTyper: (clientId: string, nickname: string | null) => void;
  incUnread: () => void;
  clearUnread: () => void;
  addReaction: (r: FloatingReaction) => void;
  removeReaction: (id: number) => void;

  setCaptionTracks: (tracks: SubtitleTrack[] | null) => void;
  setCaptionsLoading: (loading: boolean) => void;
  setCaptionLang: (lang: string | null) => void;
  setCaptionText: (text: string | null) => void;

  setPing: (ping: number, cls: PingClass) => void;
  setActiveTab: (t: Tab) => void;
  toggleSound: () => void;
  setTheme: (t: Theme) => void;
  setAutoplayBlocked: (b: boolean) => void;
  setMediaWarning: (w: string | null) => void;
  setStatus: (text: string, warn?: boolean) => void;
  showToast: (msg: string) => void;
  setAppVersion: (v: string) => void;
  reset: () => void;
}

let toastTimer: number | null = null;

const MAX_REACTIONS = 40;

const initialRate = 1;

export const useStore = create<StoreState>((set) => ({
  view: 'landing',
  roomId: null,
  connected: false,

  account: null,
  authOpen: false,

  isHost: false,
  locked: false,
  persistent: false,
  registered: false,
  users: [],
  queue: [],
  media: null,
  stream: null,
  rate: initialRate,
  allowedRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  maxQueueLength: 200,

  chat: [],
  typers: {},
  unread: 0,
  reactions: [],

  ping: null,
  pingClass: '',

  activeTab: 'chat',
  soundEnabled: localStorage.getItem('ws_sound') !== '0',
  theme: (localStorage.getItem('ws_theme') as Theme) || 'dark',

  captionTracks: null,
  captionsLoading: false,
  captionLang: null,
  captionText: null,

  autoplayBlocked: false,
  mediaWarning: null,
  status: { text: '', warn: false },
  toast: null,
  appVersion: null,

  setView: (view) => set({ view }),
  setRoomId: (roomId) => set({ roomId }),
  setConnected: (connected) => set({ connected }),
  setAccount: (account) => set({ account }),
  setAuthOpen: (authOpen) => set({ authOpen }),
  patchRoom: (p) => set(p),
  setConfig: (allowedRates, maxQueueLength) => set({ allowedRates, maxQueueLength }),

  addChat: (item) => set((s) => ({ chat: [...s.chat, item].slice(-300) })),
  setChat: (chat) => set({ chat }),
  setTyper: (clientId, nickname) =>
    set((s) => {
      const typers = { ...s.typers };
      if (nickname) typers[clientId] = nickname;
      else delete typers[clientId];
      return { typers };
    }),
  incUnread: () => set((s) => ({ unread: s.unread + 1 })),
  clearUnread: () => set({ unread: 0 }),
  // Capped. Removal happens only on the CSS animationend in VideoPlayer, and
  // CSS animations are throttled or paused in a background tab (and the layer
  // is not mounted at all outside the room view), so that event may never
  // fire. Someone spamming the reaction bar while a viewer sits in another tab
  // grew this without limit — plus one DOM node each once they returned.
  addReaction: (r) => set((s) => ({ reactions: [...s.reactions, r].slice(-MAX_REACTIONS) })),
  removeReaction: (id) => set((s) => ({ reactions: s.reactions.filter((r) => r.id !== id) })),

  setCaptionTracks: (captionTracks) => set({ captionTracks }),
  setCaptionsLoading: (captionsLoading) => set({ captionsLoading }),
  setCaptionLang: (captionLang) => set({ captionLang }),
  setCaptionText: (captionText) => set({ captionText }),

  setPing: (ping, pingClass) => set({ ping, pingClass }),
  setActiveTab: (activeTab) => set({ activeTab }),
  toggleSound: () =>
    set((s) => {
      const soundEnabled = !s.soundEnabled;
      localStorage.setItem('ws_sound', soundEnabled ? '1' : '0');
      return { soundEnabled };
    }),
  setTheme: (theme) => {
    localStorage.setItem('ws_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },
  setAutoplayBlocked: (autoplayBlocked) => set({ autoplayBlocked }),
  setMediaWarning: (mediaWarning) => set({ mediaWarning }),
  setStatus: (text, warn = false) => set({ status: { text, warn } }),
  showToast: (toast) => {
    set({ toast });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 2500);
  },
  setAppVersion: (appVersion) => set({ appVersion }),
  reset: () =>
    set({
      view: 'landing',
      roomId: null,
      connected: false,
      isHost: false,
      locked: false,
      persistent: false,
      registered: false,
      users: [],
      queue: [],
      media: null,
      stream: null,
      rate: initialRate,
      chat: [],
      typers: {},
      unread: 0,
      reactions: [],
      captionTracks: null,
      captionsLoading: false,
      captionLang: null,
      captionText: null,
      autoplayBlocked: false,
      mediaWarning: null,
      status: { text: '', warn: false },
    }),
}));
