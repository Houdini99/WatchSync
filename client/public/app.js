import { pickPlayer } from '/player.js';
import { SyncEngine } from '/sync.js';

const $ = (sel) => document.querySelector(sel);
const purify = (s) => (window.DOMPurify ? window.DOMPurify.sanitize(s, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) : String(s).replace(/[<>]/g, ''));

const els = {
  landing: $('#landing'),
  createRoom: $('#create-room'),
  nicknameModal: $('#nickname-modal'),
  nicknameInput: $('#nickname-input'),
  nicknameJoin: $('#nickname-join'),
  room: $('#room'),
  videoTitle: $('#video-title'),
  pingIndicator: $('#ping-indicator'),
  resyncBtn: $('#resync-btn'),
  soundToggle: $('#sound-toggle'),
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
  reactions: document.querySelectorAll('.react-btn'),
  queueList: $('#queue-list'),
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
  hostToken: null,
  nickname: null,
  isHost: false,
  locked: false,
  persistent: false,
  currentMedia: null,
  player: null,
  sync: null,
  activeTab: 'chat',
  unread: 0,
  soundEnabled: localStorage.getItem('ws_sound') !== '0',
  baseTitle: 'WatchSync',
  ytTitlePoll: null,
};

// ---------- routing ----------
function readRoomFromUrl() {
  const m = location.pathname.match(/^\/r\/([a-z0-9]+)$/i);
  return m ? m[1] : null;
}

async function boot() {
  const roomId = readRoomFromUrl();
  if (roomId) showNicknameModal(roomId);
  else showLanding();
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
  state.socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  state.sync = new SyncEngine(state.socket);

  state.sync.addEventListener('latency', (e) => updatePingIndicator(e.detail.rtt));

  state.socket.on('connect', () => {
    state.socket.emit('join_room', {
      roomId: state.roomId,
      nickname: state.nickname,
      hostToken: state.hostToken,
    }, (resp) => {
      if (!resp?.ok) {
        toast(resp?.error || 'Could not join room');
        showLanding();
        return;
      }
      state.isHost = resp.youAreHost;
      applySnapshot(resp.snapshot, /* initial */ true);
    });
  });

  state.socket.on('connect_error', () => setStatus('Disconnected — retrying…', true));
  state.socket.on('disconnect', () => setStatus('Disconnected — retrying…', true));
  state.socket.on('reconnect', () => setStatus(''));

  state.socket.on('room_state', (snap) => applySnapshot(snap, false));
  state.socket.on('chat_message', appendChat);
  state.socket.on('system_message', appendSystem);
}

function applySnapshot(snap, isInitial) {
  state.locked = snap.locked;
  state.persistent = !!snap.persistent;
  state.isHost = snap.hostSocketId === state.socket.id;
  renderUsers(snap.users);
  renderQueue(snap.queue);
  applyLockUI();
  applyPersistUI();

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
        if (t !== media.title) {
          state.socket.emit('media_title', { title: t });
        }
      }
      if (tries > 20) { clearInterval(state.ytTitlePoll); state.ytTitlePoll = null; }
    }, 500);
  }
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
  document.title = t ? `${t} — ${state.baseTitle}` : state.baseTitle;
  if (state.unread > 0) document.title = `(${state.unread}) ${document.title}`;
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
  const ok = await state.sync.resync();
  toast(ok ? 'Resynced' : 'Resync failed');
  els.resyncBtn.disabled = false;
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
});

els.reactions.forEach((btn) => {
  btn.addEventListener('click', () => sendChat(btn.dataset.emoji));
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

function appendChat(msg) {
  const node = document.createElement('div');
  node.className = 'chat-msg' + (msg.socketId === state.socket?.id ? ' self' : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const nick = document.createElement('span');
  nick.className = 'nick';
  nick.textContent = msg.nickname;
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
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
  notifyChat(msg);
}

function appendSystem(msg) {
  const node = document.createElement('div');
  node.className = 'chat-msg system';
  node.textContent = msg.text;
  els.chatLog.appendChild(node);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function notifyChat(msg) {
  if (msg.socketId === state.socket?.id) return;
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

// ---------- queue / users ----------
function renderQueue(queue) {
  els.queueCount.textContent = queue.length;
  els.queueList.innerHTML = '';
  queue.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.title || item.source;
    li.appendChild(title);
    const btn = document.createElement('button');
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.addEventListener('click', () => state.socket.emit('queue_remove', { index: idx }));
    li.appendChild(btn);
    els.queueList.appendChild(li);
  });
}

function renderUsers(users) {
  els.userCount.textContent = users.length;
  els.userList.innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.className = 'user-item';
    const name = document.createElement('span');
    name.textContent = u.nickname + (u.socketId === state.socket?.id ? ' (you)' : '');
    li.appendChild(name);
    const right = document.createElement('span');
    if (u.buffering) {
      const b = document.createElement('span');
      b.className = 'buffer-pill';
      b.textContent = 'buffering';
      right.appendChild(b);
    }
    if (u.isHost) {
      const h = document.createElement('span');
      h.className = 'host-pill';
      h.textContent = 'HOST';
      right.appendChild(h);
    }
    li.appendChild(right);
    els.userList.appendChild(li);
  });
}

// ---------- tabs ----------
els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    els.tabs.forEach((t) => t.classList.remove('active'));
    els.panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`[data-tab-panel="${tab.dataset.tab}"]`).classList.add('active');
    state.activeTab = tab.dataset.tab;
    if (state.activeTab === 'chat') clearUnread();
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
