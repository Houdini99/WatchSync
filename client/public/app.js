import { pickPlayer } from '/player.js';
import { SyncEngine } from '/sync.js';

const $ = (sel) => document.querySelector(sel);
const purify = (s) => (window.DOMPurify ? window.DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) : String(s).replace(/[<>]/g, ''));

const els = {
  landing: $('#landing'),
  landingVersion: $('#landing-version'),
  createRoom: $('#create-room'),
  nicknameModal: $('#nickname-modal'),
  nicknameInput: $('#nickname-input'),
  nicknameJoin: $('#nickname-join'),
  room: $('#room'),
  videoTitle: $('#video-title'),
  pingIndicator: $('#ping-indicator'),
  speedBtn: $('#speed-btn'),
  speedMenu: $('#speed-menu'),
  pipBtn: $('#pip-btn'),
  resyncBtn: $('#resync-btn'),
  soundToggle: $('#sound-toggle'),
  themeToggle: $('#theme-toggle'),
  fullscreenBtn: $('#fullscreen-btn'),
  copyLink: $('#copy-link'),
  lockWrap: $('#lock-wrap'),
  lockToggle: $('#lock-toggle'),
  persistWrap: $('#persist-wrap'),
  persistToggle: $('#persist-toggle'),
  playerMount: $('#player-mount'),
  placeholder: $('#player-placeholder'),
  video: $('#html5-video'),
  ytMount: $('#yt-mount'),
  reactionLayer: $('#reaction-layer'),
  urlForm: $('#url-form'),
  urlInput: $('#url-input'),
  queueAdd: $('#queue-add'),
  status: $('#status-line'),
  mediaWarning: $('#media-warning'),
  tabs: document.querySelectorAll('.tab'),
  panels: document.querySelectorAll('.tab-panel'),
  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  typingIndicator: $('#typing-indicator'),
  reactions: document.querySelectorAll('.react-btn'),
  queueList: $('#queue-list'),
  queueEmpty: $('#queue-empty'),
  queueCount: $('#queue-count'),
  queueSkip: $('#queue-skip'),
  userList: $('#user-list'),
  userCount: $('#user-count'),
  unreadBadge: $('#unread-badge'),
  toast: $('#toast'),
};

const state = {
  socket: null,
  roomId: null,
  clientId: ensureClientId(),
  hostToken: null,
  nickname: null,
  isHost: false,
  locked: false,
  persistent: false,
  currentMedia: null,
  currentRate: 1,
  allowedRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  player: null,
  sync: null,
  activeTab: 'chat',
  unread: 0,
  soundEnabled: localStorage.getItem('ws_sound') !== '0',
  baseTitle: 'WatchSync',
  ytTitlePoll: null,
  typers: new Map(),
  typingSent: false,
  typingTimer: null,
  hasJoinedOnce: false,
};

// ---------- identity / theme ----------
function ensureClientId() {
  let id = localStorage.getItem('ws_client_id');
  if (!id || id.length < 8) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`)
      .replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    localStorage.setItem('ws_client_id', id);
  }
  return id;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  els.themeToggle.textContent = theme === 'light' ? '☀️' : '🌙';
}
applyTheme(localStorage.getItem('ws_theme') || 'dark');

els.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem('ws_theme', next);
  applyTheme(next);
});

// ---------- routing ----------
function readRoomFromUrl() {
  const m = location.pathname.match(/^\/r\/([a-z0-9]+)$/i);
  return m ? m[1] : null;
}

async function boot() {
  const roomId = readRoomFromUrl();
  if (roomId) showNicknameModal(roomId);
  else showLanding();
  fetch('/api/health').then((r) => r.json()).then((h) => {
    if (h?.version && els.landingVersion) els.landingVersion.textContent = `v${h.version}`;
  }).catch(() => {});
}

function showLanding() {
  els.landing.classList.remove('hidden');
  els.room.classList.add('hidden');
  els.nicknameModal.classList.add('hidden');
}

function showNicknameModal(roomId) {
  state.roomId = roomId;
  els.landing.classList.add('hidden');
  els.nicknameModal.classList.remove('hidden');
  const stored = localStorage.getItem('ws_nickname');
  if (stored) els.nicknameInput.value = stored;
  setTimeout(() => els.nicknameInput.focus(), 50);
}

// ---------- creation ----------
els.createRoom.addEventListener('click', async () => {
  els.createRoom.disabled = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create room');
    const { id, hostToken } = await res.json();
    localStorage.setItem(`ws_host_${id}`, hostToken);
    history.pushState(null, '', `/r/${id}`);
    showNicknameModal(id);
  } catch (e) {
    toast(e.message);
  } finally {
    els.createRoom.disabled = false;
  }
});

els.nicknameJoin.addEventListener('click', () => joinRoom());
els.nicknameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

async function joinRoom() {
  const nickname = (els.nicknameInput.value || '').trim().slice(0, 24) || 'guest';
  localStorage.setItem('ws_nickname', nickname);
  state.nickname = nickname;
  state.hostToken = localStorage.getItem(`ws_host_${state.roomId}`) || null;

  els.nicknameModal.classList.add('hidden');
  els.room.classList.remove('hidden');
  updateSoundButton();
  connectSocket();
}

// ---------- socket ----------
function connectSocket() {
  if (state.socket) return; // guard against double-connect
  state.socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  state.sync = new SyncEngine(state.socket);

  state.sync.addEventListener('latency', (e) => updatePingIndicator(e.detail.rtt));

  state.socket.on('connect', () => {
    state.socket.emit('join_room', {
      roomId: state.roomId,
      nickname: state.nickname,
      clientId: state.clientId,
      hostToken: state.hostToken,
    }, (resp) => {
      if (!resp?.ok) {
        toast(resp?.error || 'Could not join room');
        showLanding();
        return;
      }
      state.isHost = resp.youAreHost;
      if (resp.config?.allowedRates?.length) {
        state.allowedRates = resp.config.allowedRates;
        renderSpeedMenu();
      }
      if (!state.hasJoinedOnce && Array.isArray(resp.chatHistory)) {
        renderChatHistory(resp.chatHistory);
      }
      state.hasJoinedOnce = true;
      setStatus('');
      applySnapshot(resp.snapshot, /* initial */ true);
      // Snap straight to the room's live position on join/reconnect instead of
      // drifting in until the next heartbeat. Safe to call once the player exists.
      if (state.player && resp.snapshot?.video?.media) {
        state.sync.applyInitial(resp.snapshot.video);
      }
    });
  });

  state.socket.on('connect_error', () => setStatus('Disconnected — retrying…', true));
  state.socket.on('disconnect', () => setStatus('Disconnected — retrying…', true));
  state.socket.io.on('reconnect', () => setStatus(''));

  state.socket.on('room_state', (snap) => applySnapshot(snap, false));
  state.socket.on('chat_message', appendChat);
  state.socket.on('system_message', appendSystem);
  state.socket.on('reaction', showReaction);
  state.socket.on('typing', onTyping);
}

function applySnapshot(snap, isInitial) {
  state.locked = snap.locked;
  state.persistent = !!snap.persistent;
  state.isHost = snap.hostClientId
    ? snap.hostClientId === state.clientId
    : snap.hostSocketId === state.socket.id;
  renderUsers(snap.users);
  renderQueue(snap.queue);
  applyLockUI();
  applyPersistUI();
  updateRateUI(snap.video?.rate || 1);

  const mediaChanged =
    snap.video?.media?.source !== state.currentMedia?.source ||
    snap.video?.media?.type !== state.currentMedia?.type;

  if (snap.video?.media && mediaChanged) {
    loadMedia(snap.video.media, isInitial ? snap.video : null);
  } else if (!snap.video?.media && state.player) {
    teardownPlayer();
  } else if (snap.video?.media && !mediaChanged) {
    updateVideoTitle(snap.video.media.title);
  }

  setStatus('');
}

// ---------- player lifecycle ----------
function loadMedia(media, initialVideoState) {
  teardownPlayer();
  state.currentMedia = media;
  els.placeholder.classList.add('hidden');
  state.player = pickPlayer(media, { videoEl: els.video, ytMount: els.ytMount });
  state.player.load(media);
  state.sync.setPlayer(state.player, media);
  if (initialVideoState) state.sync.applyInitial(initialVideoState);
  applyLockUI();
  updateVideoTitle(media.title);
  showMediaWarning(media);
  updatePipButton();
  bindMediaErrors();

  // YouTube: title resolves once iframe loads; poll briefly and broadcast.
  if (media.type === 'youtube') {
    if (state.ytTitlePoll) clearInterval(state.ytTitlePoll);
    let tries = 0;
    state.ytTitlePoll = setInterval(() => {
      tries++;
      const t = state.player?.getTitle?.();
      if (t) {
        clearInterval(state.ytTitlePoll);
        state.ytTitlePoll = null;
        if (t !== media.title) state.socket.emit('media_title', { title: t });
      }
      if (tries > 20) { clearInterval(state.ytTitlePoll); state.ytTitlePoll = null; }
    }, 500);
  }
}

function bindMediaErrors() {
  state.player?.events.addEventListener('mediaerror', () => {
    setStatus('This media failed to load — check the URL, CORS, or codec.', true);
  });
}

function teardownPlayer() {
  if (state.player) {
    try { state.player.unload(); } catch {}
    state.player = null;
  }
  if (state.ytTitlePoll) { clearInterval(state.ytTitlePoll); state.ytTitlePoll = null; }
  state.currentMedia = null;
  els.placeholder.classList.remove('hidden');
  updateVideoTitle(null);
  els.mediaWarning.classList.add('hidden');
  updatePipButton();
}

function showMediaWarning(media) {
  const url = (media?.source || '').toLowerCase();
  if (/\.mkv(\?|#|$)/.test(url)) {
    els.mediaWarning.innerHTML =
      'MKV files often play without audio because most browsers can\'t decode their audio streams ' +
      '(AC-3, DTS, EAC-3). To fix, remux to MP4 — keeps video quality, only re-encodes audio: ' +
      '<code>ffmpeg -i input.mkv -c:v copy -c:a aac -b:a 192k output.mp4</code>';
    els.mediaWarning.classList.remove('hidden');
  } else {
    els.mediaWarning.classList.add('hidden');
  }
}

function updateVideoTitle(title) {
  const t = title && String(title).trim();
  els.videoTitle.textContent = t || '';
  els.videoTitle.title = t || '';
  refreshTabTitle();
}

// ---------- url / queue ----------
els.urlForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = els.urlInput.value.trim();
  if (!url) return;
  state.socket.emit('change_video', { url }, (resp) => {
    if (!resp?.ok) toast(resp?.error || 'Failed to load');
    else els.urlInput.value = '';
  });
});

els.queueAdd.addEventListener('click', () => {
  const url = els.urlInput.value.trim();
  if (!url) return;
  state.socket.emit('queue_add', { url }, (resp) => {
    if (!resp?.ok) toast(resp?.error || 'Failed to queue');
    else { els.urlInput.value = ''; toast('Added to queue'); }
  });
});

els.queueSkip.addEventListener('click', () => state.socket.emit('queue_skip'));

// ---------- speed control ----------
function renderSpeedMenu() {
  els.speedMenu.innerHTML = '';
  state.allowedRates.forEach((rate) => {
    const btn = document.createElement('button');
    btn.className = 'speed-option';
    btn.textContent = `${rate}×`;
    btn.dataset.rate = rate;
    btn.addEventListener('click', () => {
      setRate(rate);
      closeSpeedMenu();
    });
    els.speedMenu.appendChild(btn);
  });
  updateRateUI(state.currentRate);
}

// Apply a speed change locally *and* tell the server. Applying to our own
// player matters: the server echoes the broadcast back with causedBy=us, which
// the sync engine ignores — so without the local apply the originator's video
// would never actually change speed.
function setRate(rate) {
  if (state.locked && !state.isHost) return toast('Host has locked controls');
  if (state.player) state.player.setRate(rate);
  updateRateUI(rate);
  state.socket.emit('set_rate', { rate });
}

function updateRateUI(rate) {
  state.currentRate = rate;
  els.speedBtn.textContent = `${rate}×`;
  els.speedBtn.classList.toggle('active', rate !== 1);
  els.speedMenu.querySelectorAll('.speed-option').forEach((b) => {
    b.classList.toggle('selected', Number(b.dataset.rate) === rate);
  });
}

function closeSpeedMenu() { els.speedMenu.classList.add('hidden'); }
els.speedBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.locked && !state.isHost) return toast('Host has locked controls');
  els.speedMenu.classList.toggle('hidden');
});
document.addEventListener('click', closeSpeedMenu);
els.speedMenu.addEventListener('click', (e) => e.stopPropagation());

// ---------- PiP ----------
function updatePipButton() {
  const show = state.player && state.currentMedia?.type !== 'youtube' && state.player.supportsPiP?.();
  els.pipBtn.classList.toggle('hidden', !show);
}
els.pipBtn.addEventListener('click', () => state.player?.togglePiP?.());

// ---------- host controls ----------
els.lockToggle.addEventListener('change', () => {
  state.socket.emit('lock_room', { locked: els.lockToggle.checked });
});
els.persistToggle.addEventListener('change', () => {
  state.socket.emit('set_persistent', { persistent: els.persistToggle.checked });
});

els.copyLink.addEventListener('click', async () => {
  const url = `${location.origin}/r/${state.roomId}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { toast(url); }
});

els.resyncBtn.addEventListener('click', async () => {
  els.resyncBtn.disabled = true;
  els.resyncBtn.classList.add('spinning');
  const ok = await state.sync.resync();
  toast(ok ? 'Resynced' : 'Resync failed');
  els.resyncBtn.disabled = false;
  els.resyncBtn.classList.remove('spinning');
});

els.fullscreenBtn.addEventListener('click', toggleFullscreen);

els.soundToggle.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  localStorage.setItem('ws_sound', state.soundEnabled ? '1' : '0');
  updateSoundButton();
});

function updateSoundButton() {
  els.soundToggle.textContent = state.soundEnabled ? '🔔' : '🔕';
  els.soundToggle.classList.toggle('muted', !state.soundEnabled);
}

function applyLockUI() {
  els.lockWrap.classList.toggle('hidden', !state.isHost);
  els.lockToggle.checked = state.locked;
  els.playerMount.classList.toggle('locked-overlay', state.locked && !state.isHost);
  els.room.classList.toggle('locked', state.locked && !state.isHost);
  if (state.player) state.player.setEnabled(state.isHost || !state.locked);
}

function applyPersistUI() {
  els.persistWrap.classList.toggle('hidden', !state.isHost);
  els.persistToggle.checked = state.persistent;
}

// ---------- chat ----------
els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat(els.chatInput.value);
  els.chatInput.value = '';
  signalTyping(false);
});

els.chatInput.addEventListener('input', () => {
  signalTyping(els.chatInput.value.trim().length > 0);
});
els.chatInput.addEventListener('blur', () => signalTyping(false));

function signalTyping(typing) {
  if (typing) {
    if (!state.typingSent) { state.typingSent = true; state.socket?.emit('typing', { typing: true }); }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => signalTyping(false), 3000);
  } else if (state.typingSent) {
    state.typingSent = false;
    clearTimeout(state.typingTimer);
    state.socket?.emit('typing', { typing: false });
  }
}

els.reactions.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.socket.emit('reaction', { emoji: btn.dataset.emoji });
  });
});

function sendChat(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  state.socket.emit('chat_message', { text: trimmed });
}

const URL_RE = /\b(https?:\/\/[^\s<>"]+[^\s<>".,!?:;)])/g;

function renderMessageBody(text) {
  const safe = purify(text);
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of safe.matchAll(URL_RE)) {
    if (m.index > last) frag.appendChild(document.createTextNode(safe.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = m[0];
    frag.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < safe.length) frag.appendChild(document.createTextNode(safe.slice(last)));
  return frag;
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function appendChat(msg, opts = {}) {
  const stick = isNearBottom(els.chatLog);
  const mine = msg.clientId ? msg.clientId === state.clientId : msg.socketId === state.socket?.id;
  const node = document.createElement('div');
  node.className = 'chat-msg' + (mine ? ' self' : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const nick = document.createElement('span');
  nick.className = 'nick';
  nick.textContent = msg.nickname;
  if (msg.color && !mine) nick.style.color = msg.color;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(msg.ts);
  meta.appendChild(nick);
  meta.appendChild(time);
  node.appendChild(meta);
  const body = document.createElement('div');
  body.appendChild(renderMessageBody(msg.text));
  node.appendChild(body);
  els.chatLog.appendChild(node);
  if (stick) els.chatLog.scrollTop = els.chatLog.scrollHeight;
  if (!opts.history) notifyChat(msg, mine);
}

function appendSystem(msg) {
  const stick = isNearBottom(els.chatLog);
  const node = document.createElement('div');
  node.className = 'chat-msg system';
  node.textContent = msg.text;
  els.chatLog.appendChild(node);
  if (stick) els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function renderChatHistory(history) {
  els.chatLog.innerHTML = '';
  for (const entry of history) {
    if (entry.kind === 'system') appendSystem(entry);
    else appendChat(entry, { history: true });
  }
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function notifyChat(msg, mine) {
  if (mine) return;
  const chatTabActive = state.activeTab === 'chat' && !document.hidden;
  if (chatTabActive) return;
  state.unread++;
  els.unreadBadge.textContent = state.unread;
  els.unreadBadge.classList.remove('hidden');
  refreshTabTitle();
  if (state.soundEnabled) playPing();
}

function clearUnread() {
  state.unread = 0;
  els.unreadBadge.classList.add('hidden');
  refreshTabTitle();
}

function refreshTabTitle() {
  const t = state.currentMedia?.title;
  const base = t ? `${t} — ${state.baseTitle}` : state.baseTitle;
  document.title = state.unread > 0 ? `(${state.unread}) ${base}` : base;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeTab === 'chat') clearUnread();
});

// ---------- typing indicator ----------
function onTyping(payload) {
  if (!payload || payload.clientId === state.clientId) return;
  if (payload.typing) {
    state.typers.set(payload.clientId, payload.nickname);
    // Auto-expire stale typing flags if no "stop" arrives.
    clearTimeout(state.typers.get(`${payload.clientId}:t`));
    const tid = setTimeout(() => { state.typers.delete(payload.clientId); renderTyping(); }, 5000);
    state.typers.set(`${payload.clientId}:t`, tid);
  } else {
    clearTimeout(state.typers.get(`${payload.clientId}:t`));
    state.typers.delete(`${payload.clientId}:t`);
    state.typers.delete(payload.clientId);
  }
  renderTyping();
}

function renderTyping() {
  const names = [...state.typers.entries()]
    .filter(([k]) => !k.endsWith(':t'))
    .map(([, v]) => v);
  if (!names.length) { els.typingIndicator.textContent = ''; els.typingIndicator.classList.remove('active'); return; }
  let text;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = 'Several people are typing…';
  els.typingIndicator.textContent = text;
  els.typingIndicator.classList.add('active');
}

// ---------- floating reactions ----------
function showReaction(payload) {
  if (!payload?.emoji) return;
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = payload.emoji;
  // Spread launch position across the lower band of the player.
  el.style.left = `${10 + Math.random() * 80}%`;
  el.style.setProperty('--drift', `${(Math.random() * 60 - 30).toFixed(0)}px`);
  const label = document.createElement('span');
  label.className = 'reaction-name';
  label.textContent = payload.nickname || '';
  if (payload.color) label.style.color = payload.color;
  el.appendChild(label);
  els.reactionLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 3000);
}

// ---------- queue / users ----------
function renderQueue(queue) {
  els.queueCount.textContent = queue.length;
  els.queueEmpty.classList.toggle('hidden', queue.length > 0);
  els.queueList.innerHTML = '';
  const editable = state.isHost || !state.locked;
  queue.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    const pos = document.createElement('span');
    pos.className = 'queue-pos';
    pos.textContent = idx + 1;
    li.appendChild(pos);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title || item.source;
    title.title = item.source;
    li.appendChild(title);
    const actions = document.createElement('span');
    actions.className = 'queue-actions';
    if (editable) {
      if (idx > 0) actions.appendChild(queueBtn('↑', 'Move up', () => state.socket.emit('queue_move', { from: idx, to: idx - 1 })));
      if (idx < queue.length - 1) actions.appendChild(queueBtn('↓', 'Move down', () => state.socket.emit('queue_move', { from: idx, to: idx + 1 })));
      actions.appendChild(queueBtn('×', 'Remove', () => state.socket.emit('queue_remove', { index: idx }), 'danger'));
    }
    li.appendChild(actions);
    els.queueList.appendChild(li);
  });
}

function queueBtn(label, title, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function renderUsers(users) {
  els.userCount.textContent = users.filter((u) => !u.disconnected).length;
  els.userList.innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'user-item' + (u.disconnected ? ' offline' : '');
    const left = document.createElement('span');
    left.className = 'user-name';
    const dot = document.createElement('span');
    dot.className = 'user-dot';
    dot.style.background = u.color || 'var(--accent)';
    left.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = u.nickname + (u.clientId === state.clientId ? ' (you)' : '');
    left.appendChild(name);
    li.appendChild(left);
    const right = document.createElement('span');
    right.className = 'user-tags';
    if (u.disconnected) right.appendChild(pill('away', 'away-pill'));
    if (u.buffering) right.appendChild(pill('buffering', 'buffer-pill'));
    if (u.isHost) right.appendChild(pill('HOST', 'host-pill'));
    li.appendChild(right);
    els.userList.appendChild(li);
  });
}

function pill(text, cls) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

// ---------- tabs ----------
els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabs.forEach((t) => t.classList.remove('active'));
    els.panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`[data-tab-panel="${tab.dataset.tab}"]`).classList.add('active');
    state.activeTab = tab.dataset.tab;
    if (state.activeTab === 'chat') {
      clearUnread();
      els.chatLog.scrollTop = els.chatLog.scrollHeight;
    }
  });
});

// ---------- ping indicator ----------
function updatePingIndicator(rtt) {
  els.pingIndicator.textContent = `${Math.round(rtt)}ms`;
  els.pingIndicator.classList.remove('good', 'warn', 'bad');
  if (rtt < 80) els.pingIndicator.classList.add('good');
  else if (rtt < 250) els.pingIndicator.classList.add('warn');
  else els.pingIndicator.classList.add('bad');
}

// ---------- fullscreen ----------
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    els.playerMount.requestFullscreen().catch(() => toast('Fullscreen not allowed'));
  }
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!state.player) return;
  if (state.locked && !state.isHost) return;

  switch (e.key.toLowerCase()) {
    case ' ':
    case 'k':
      e.preventDefault();
      state.player.togglePlay();
      break;
    case 'arrowleft':
      e.preventDefault();
      state.player.seekBy(-5);
      flashStatus('⏪ -5s');
      break;
    case 'arrowright':
      e.preventDefault();
      state.player.seekBy(5);
      flashStatus('⏩ +5s');
      break;
    case 'j':
      e.preventDefault();
      state.player.seekBy(-10);
      flashStatus('⏪ -10s');
      break;
    case 'l':
      e.preventDefault();
      state.player.seekBy(10);
      flashStatus('⏩ +10s');
      break;
    case 'm':
      e.preventDefault();
      state.player.toggleMute();
      break;
    case 'f':
      e.preventDefault();
      toggleFullscreen();
      break;
  }
});

let statusTimer = null;
function flashStatus(text) {
  setStatus(text);
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => setStatus(''), 800);
}

// ---------- ping sound ----------
let audioCtx = null;
function playPing() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
  } catch {}
}

// ---------- misc ----------
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2500);
}

function setStatus(text, warn = false) {
  els.status.textContent = text;
  els.status.classList.toggle('warn', warn);
}

(function loadIo() {
  if (window.io) return boot();
  const s = document.createElement('script');
  s.src = '/socket.io/socket.io.js';
  s.onload = boot;
  s.onerror = () => toast('Could not load socket library');
  document.head.appendChild(s);
})();
