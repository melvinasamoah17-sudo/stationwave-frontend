'use strict';

/* ── Config ── */
const API_BASE = (window.SW_CONFIG && window.SW_CONFIG.BACKEND_URL) 
  ? window.SW_CONFIG.BACKEND_URL 
  : 'https://stationwave-backend-production.up.railway.app';
const PEER_HOST = 'localhost';
const PEER_PORT = 3001;
const PEER_PATH = '/peerjs';
const APP_URL   = window.location.href.split('?')[0].split('#')[0];

/* ── Module-level handles ── */
let socket      = null;   // Socket.io connection
let peer        = null;   // PeerJS instance
let activeCalls = [];     // MediaConnection[]  (listener: [1 call]; host: [N calls])
let audioEl     = null;   // <audio> element for listener playback

/* ── App state ── */
const state = {
  currentRoom:  null,
  userName:     '',
  isHost:       false,
  micActive:    false,
  mediaStream:  null,   // host's raw mic stream
  audioCtx:     null,
  analyser:     null,
  animFrame:    null,
  msgCount:     0,
  listeners:    [],
};

/* ═══════════════════════════════════════════
   API HELPER
═══════════════════════════════════════════ */
async function apiFetch(path, options = {}) {
  const res  = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

/* ═══════════════════════════════════════════
   SOCKET.IO
═══════════════════════════════════════════ */
function connectSocket() {
  if (socket?.connected) return;

  socket = io(API_BASE, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => console.log('🔌 socket:', socket.id));

  /* Someone joined the room */
  socket.on('room:user_joined', ({ socketId, userName, isHost, peerId, listenerCount, systemMessage }) => {
    if (!state.listeners.find(l => l.socketId === socketId)) {
      state.listeners.push({ socketId, userName, isHost, peerId });
    }
    renderListeners();
    setListenerCount(listenerCount);
    if (systemMessage) appendMessage(systemMessage);
  });

  /* Someone left */
  socket.on('room:user_left', ({ socketId, listenerCount, systemMessage }) => {
    state.listeners = state.listeners.filter(l => l.socketId !== socketId);
    renderListeners();
    setListenerCount(listenerCount);
    if (systemMessage) appendMessage(systemMessage);
  });

  /* Chat */
  socket.on('chat:message',  msg => appendMessage(msg));
  socket.on('chat:reaction', msg => { appendMessage(msg); spawnFloatingReaction(msg.emoji); });
  socket.on('mic:status',    ({ systemMessage }) => { if (systemMessage) appendMessage(systemMessage); });

  /* ── WebRTC: host started broadcasting ── */
  socket.on('webrtc:host_started', ({ peerId, systemMessage }) => {
    console.log('📡 Host started broadcasting, peerId:', peerId);
    if (systemMessage) appendMessage(systemMessage);
    if (!state.isHost) callHost(peerId);
    updateAudioStatus('LIVE AUDIO', true);
  });

  /* ── WebRTC: host stopped ── */
  socket.on('webrtc:host_stopped', ({ systemMessage }) => {
    console.log('🔇 Host stopped broadcasting');
    if (systemMessage) appendMessage(systemMessage);
    closeAllCalls();
    updateAudioStatus('NO AUDIO', false);
  });

  /* Room history on join */
  socket.on('room:history', ({ room, messages }) => {
    messages.forEach(appendMessage);
    // If host is already broadcasting when we join, connect immediately
    if (!state.isHost && room.hostPeerId) {
      console.log('📡 Host already live, connecting to:', room.hostPeerId);
      callHost(room.hostPeerId);
      updateAudioStatus('LIVE AUDIO', true);
    }
  });

  socket.on('room:ended', () => {
    showToast('📻 Host ended the station');
    setTimeout(() => leaveRoom(true), 1500);
  });

  socket.on('error', ({ message }) => showToast('⚠️ ' + message));
}

/* ═══════════════════════════════════════════
   PEERJS — SETUP
═══════════════════════════════════════════ */
function createPeer() {
  return new Promise((resolve, reject) => {
    // Destroy stale peer
    if (peer && !peer.destroyed) peer.destroy();

    const peerId = 'sw-' + Math.random().toString(36).slice(2, 10);

    peer = new Peer(peerId, {
      host:   PEER_HOST,
      port:   PEER_PORT,
      path:   PEER_PATH,
      secure: false,
      debug:  1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    });

    peer.on('open', id => {
      console.log('🔵 PeerJS open, id:', id);
      resolve(id);
    });

    peer.on('error', err => {
      console.error('PeerJS error:', err);
      showToast('⚠️ Connection error: ' + err.type);
      reject(err);
    });

    /* HOST: answer every incoming call from listeners */
    peer.on('call', call => {
      if (!state.isHost || !state.mediaStream) return;
      console.log('📞 Listener calling, answering with mic stream');
      call.answer(state.mediaStream);
      activeCalls.push(call);

      call.on('close', () => {
        activeCalls = activeCalls.filter(c => c !== call);
      });
      call.on('error', err => console.warn('Call error:', err));
    });
  });
}

/* ═══════════════════════════════════════════
   PEERJS — LISTENER CALLS HOST
═══════════════════════════════════════════ */
function callHost(hostPeerId) {
  if (!peer || peer.destroyed) {
    console.warn('Peer not ready, cannot call host');
    return;
  }

  // Close any existing call first
  closeAllCalls();

  console.log('📞 Calling host peer:', hostPeerId);

  // Listeners call with null stream (they only receive)
  const call = peer.call(hostPeerId, null);
  if (!call) { console.warn('peer.call() returned null'); return; }

  activeCalls.push(call);

  call.on('stream', remoteStream => {
    console.log('🎵 Receiving audio stream from host');
    playRemoteStream(remoteStream);
    wireAnalyserToStream(remoteStream);
  });

  call.on('close', () => {
    activeCalls = activeCalls.filter(c => c !== call);
    console.log('📞 Call closed');
  });

  call.on('error', err => console.warn('Listener call error:', err));
}

/* ── Play received audio stream ── */
function playRemoteStream(stream) {
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id       = 'remote-audio';
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
  audioEl.play().catch(err => {
    // Browsers block autoplay — show an unmute button
    console.warn('Autoplay blocked:', err);
    showUnmutePrompt();
  });
}

function showUnmutePrompt() {
  const existing = document.getElementById('unmute-prompt');
  if (existing) return;

  const btn = document.createElement('button');
  btn.id        = 'unmute-prompt';
  btn.className = 'btn btn-primary';
  btn.style.cssText = 'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:9999;padding:14px 32px;font-size:14px';
  btn.textContent   = '🔊 Tap to hear live audio';
  btn.onclick = () => {
    audioEl?.play();
    btn.remove();
  };
  document.body.appendChild(btn);
}

/* ── Close all active peer calls ── */
function closeAllCalls() {
  activeCalls.forEach(c => { try { c.close(); } catch {} });
  activeCalls = [];
  if (audioEl) { audioEl.srcObject = null; }
}

/* ═══════════════════════════════════════════
   MIC TOGGLE  (HOST ONLY)
═══════════════════════════════════════════ */
async function toggleMic() {
  const micBtn = document.getElementById('mic-btn');

  if (state.micActive) {
    /* ── STOP BROADCASTING ── */
    closeAllCalls();

    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(t => t.stop());
      state.mediaStream = null;
    }
    state.micActive = false;
    micBtn.classList.remove('active');
    micBtn.classList.add('muted');
    document.getElementById('mic-status').textContent = 'MUTED';
    updateAudioStatus('OFF AIR', false);

    socket?.emit('webrtc:host_stopped');
    socket?.emit('mic:status', { active: false });
    showToast('🔇 Microphone off');

  } else {
    /* ── START BROADCASTING ── */
    try {
      /* 1. Get mic */
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate:       44100,
        },
        video: false,
      });
      state.mediaStream = stream;

      /* 2. Wire analyser for visualizer */
      wireAnalyserToStream(stream);

      /* 3. Make sure PeerJS peer is open */
      const peerId = await createPeer();

      /* 4. Tell server we're live — listeners will call us */
      socket?.emit('webrtc:host_broadcasting', { peerId });
      socket?.emit('mic:status', { active: true });

      state.micActive = true;
      micBtn.classList.remove('muted');
      micBtn.classList.add('active');
      document.getElementById('mic-status').textContent = 'BROADCASTING';
      updateAudioStatus('ON AIR', true);
      showToast('🎙 You are LIVE — listeners can hear you!');

    } catch (err) {
      console.error('Mic error:', err);
      if (err.name === 'NotAllowedError') {
        showToast('❌ Mic permission denied — check browser settings');
      } else {
        showToast('❌ Could not start mic: ' + err.message);
      }
    }
  }
}

function setVolume(val) {
  document.getElementById('vol-display').textContent = val;
  if (audioEl) audioEl.volume = val / 100;
}

/* ── Wire an audio stream to the Web Audio analyser ── */
function wireAnalyserToStream(stream) {
  try {
    if (!state.audioCtx || state.audioCtx.state === 'closed') {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Reconnect analyser
    if (state.analyser) {
      try { state.analyser.disconnect(); } catch {}
    }
    state.analyser          = state.audioCtx.createAnalyser();
    state.analyser.fftSize  = 256;
    const src = state.audioCtx.createMediaStreamSource(stream);
    src.connect(state.analyser);
  } catch (err) {
    console.warn('Analyser wiring failed:', err);
  }
}

/* ── Update the audio status badge ── */
function updateAudioStatus(text, live) {
  const el = document.getElementById('audio-status');
  if (!el) return;
  el.textContent = text;
  el.className   = 'audio-status-badge' + (live ? ' live' : '');
}

/* ═══════════════════════════════════════════
   HOME — LIVE ROOMS
═══════════════════════════════════════════ */
const DEMO_ROOMS = [
  { id:'latenightvibes', title:'Late Night Vibes',    description:'Smooth lo-fi beats to code and chill to', genre:'Lo-Fi',      listener_count:47,  tags:['chill','beats'] },
  { id:'hiphoptalk',     title:'Hip-Hop Talk Radio',  description:'Breaking down the best albums of the year',genre:'Hip-Hop',    listener_count:213, tags:['talk','music'] },
  { id:'nighowls',       title:'Night Owls Podcast',  description:'Real convos at 2am with real people',     genre:'Podcast',    listener_count:88,  tags:['talk'] },
  { id:'techbeats',      title:'Tech House Takeover', description:'Deep electronic sounds from the globe',   genre:'Electronic', listener_count:331, tags:['edm','house'] },
];

async function loadLiveRooms() {
  try   { const { rooms } = await apiFetch('/api/rooms'); renderRoomCards(rooms); }
  catch { renderRoomCards(DEMO_ROOMS); }
}

function renderRoomCards(rooms) {
  const grid = document.getElementById('rooms-grid');
  grid.innerHTML = '';
  if (!rooms.length) {
    grid.innerHTML = `<p style="color:var(--muted);font-family:'Space Mono',monospace;font-size:12px;letter-spacing:2px">NO LIVE ROOMS YET — BE THE FIRST TO GO LIVE</p>`;
    return;
  }
  rooms.forEach(room => {
    const count   = room.listener_count ?? 0;
    const tags    = room.tags ?? [];
    const bar     = Array.from({length:10}, () => `<div class="wave-bar" style="--h:${Math.floor(Math.random()*20+6)}px;--d:${(0.4+Math.random()*0.8).toFixed(2)}s"></div>`).join('');
    const tagHtml = [room.genre, ...tags].map(t => `<span class="tag ${t===room.genre?'genre':''}">${t}</span>`).join('');
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-card-header">
        <div class="live-dot">LIVE</div>
        <div class="listener-count">👥 ${Number(count).toLocaleString()}</div>
      </div>
      <h3>${escapeHtml(room.title)}</h3>
      <p>${escapeHtml(room.description || '')}</p>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="room-tags">${tagHtml}</div>
        <div class="wave-bars">${bar}</div>
      </div>`;
    card.addEventListener('click', () => {
      document.getElementById('join-id').value = room.id;
      openJoinModal();
    });
    grid.appendChild(card);
  });
}

/* ═══════════════════════════════════════════
   SCREEN NAVIGATION
═══════════════════════════════════════════ */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function goHome() { leaveRoom(true); showScreen('home'); loadLiveRooms(); }

/* ═══════════════════════════════════════════
   MODALS
═══════════════════════════════════════════ */
function openCreateModal() { closeModals(); document.getElementById('create-modal').classList.add('open'); }
function openJoinModal()   { closeModals(); document.getElementById('join-modal').classList.add('open');   }
function closeModals()     { document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open')); }
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', e => { if (e.target===o) closeModals(); }));
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModals(); });

/* ═══════════════════════════════════════════
   CREATE ROOM
═══════════════════════════════════════════ */
async function createRoom() {
  const name  = document.getElementById('create-name').value.trim();
  const title = document.getElementById('create-title').value.trim();
  const desc  = document.getElementById('create-desc').value.trim();
  const genre = document.getElementById('create-genre').value;

  if (!name)  { showToast('Please enter your name');    return; }
  if (!title) { showToast('Please enter a room title'); return; }

  try {
    showToast('Creating your station…');
    const { room } = await apiFetch('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ title, description: desc, genre, host_name: name }),
    });
    state.userName = name;
    state.isHost   = true;
    closeModals();
    await enterRoom(room, true);
  } catch (err) {
    showToast('❌ ' + err.message);
  }
}

/* ═══════════════════════════════════════════
   JOIN ROOM
═══════════════════════════════════════════ */
async function joinRoom() {
  const name      = document.getElementById('join-name').value.trim();
  const roomInput = document.getElementById('join-id').value.trim();

  if (!name)      { showToast('Please enter your name');         return; }
  if (!roomInput) { showToast('Please enter a room ID or link'); return; }

  const match  = roomInput.match(/[?&]room=([^&]+)/);
  const roomId = match ? match[1] : roomInput.toLowerCase().replace(/\s+/g, '');

  try {
    showToast('Joining station…');
    const { room } = await apiFetch(`/api/rooms/${roomId}`);
    state.userName = name;
    state.isHost   = false;
    closeModals();
    await enterRoom(room, false);
  } catch {
    showToast('❌ Room not found or server offline');
  }
}

/* ═══════════════════════════════════════════
   ENTER ROOM
═══════════════════════════════════════════ */
async function enterRoom(room, isHost) {
  state.currentRoom = room;
  state.isHost      = isHost;
  state.listeners   = [];
  state.msgCount    = 0;

  /* Update all UI fields */
  document.getElementById('room-title-nav').textContent   = room.title;
  document.getElementById('stage-room-title').textContent = room.title;
  document.getElementById('stage-room-desc').textContent  = room.description || '';
  document.getElementById('stage-genre').textContent      = (room.genre || 'Music').toUpperCase();
  document.getElementById('share-url').textContent        = `${APP_URL}?room=${room.id}`;
  document.getElementById('role-display').textContent     = isHost ? 'HOST' : 'LISTENER';
  document.getElementById('mic-status').textContent       = 'MUTED';
  document.getElementById('chat-messages').innerHTML      = '';
  document.getElementById('msg-count').textContent        = '0 MESSAGES';

  /* Optimistic listener entry */
  state.listeners.push({ socketId: 'me', userName: state.userName, isHost });
  if (!isHost) state.listeners.push({ socketId: 'host', userName: room.host_name, isHost: true });
  renderListeners();

  showScreen('room');
  startVisualizer();
  updateAudioStatus(isHost ? 'OFF AIR' : 'CONNECTING…', false);

  /* Connect Socket.io first */
  connectSocket();

  /* Create PeerJS peer (listeners need it to receive calls too) */
  try {
    const peerId = await createPeer();
    /* Join the socket room, passing our peer ID */
    socket.emit('room:join', { roomId: room.id, userName: state.userName, isHost, peerId });
  } catch (err) {
    console.warn('PeerJS setup failed, joining without peer:', err);
    socket.emit('room:join', { roomId: room.id, userName: state.userName, isHost, peerId: null });
  }

  if (history.pushState) history.pushState(null, '', `?room=${room.id}`);
}

/* ═══════════════════════════════════════════
   LEAVE ROOM
═══════════════════════════════════════════ */
function leaveRoom(silent = false) {
  /* Stop audio */
  closeAllCalls();
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach(t => t.stop());
    state.mediaStream = null;
  }

  /* Signal server */
  if (socket && state.currentRoom) {
    if (state.isHost) {
      socket.emit('webrtc:host_stopped');
      socket.emit('room:end');
    } else {
      socket.emit('room:leave');
    }
  }

  /* Clean up Web Audio */
  if (state.animFrame)  { cancelAnimationFrame(state.animFrame); state.animFrame = null; }
  if (state.audioCtx)   { state.audioCtx.close().catch(()=>{}); state.audioCtx = null; }

  /* Destroy peer */
  if (peer && !peer.destroyed) { peer.destroy(); peer = null; }

  /* Remove audio element */
  if (audioEl) { audioEl.remove(); audioEl = null; }

  state.micActive   = false;
  state.isHost      = false;
  state.currentRoom = null;
  state.listeners   = [];

  if (history.pushState) history.pushState(null, '', APP_URL);
  if (!silent) { showScreen('home'); loadLiveRooms(); }
}

/* ═══════════════════════════════════════════
   VISUALIZER
═══════════════════════════════════════════ */
function startVisualizer() {
  const canvas = document.getElementById('visualizer-canvas');
  const ctx    = canvas.getContext('2d');

  function resize() {
    canvas.width  = canvas.offsetWidth  * devicePixelRatio;
    canvas.height = canvas.offsetHeight * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
  }
  resize();
  window.addEventListener('resize', resize);

  function draw() {
    state.animFrame = requestAnimationFrame(draw);
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    ctx.clearRect(0, 0, W, H);

    let da;
    if (state.analyser) {
      da = new Uint8Array(state.analyser.frequencyBinCount);
      state.analyser.getByteFrequencyData(da);
    } else {
      // Idle simulation
      da      = new Uint8Array(64);
      const t = Date.now() / 1000;
      for (let i = 0; i < 64; i++) {
        da[i] = Math.abs(Math.sin(t * 2.1 + i * 0.3) * Math.sin(t * 0.7 + i * 0.15) * 40 + 10);
      }
    }

    const bw = (W / da.length) * 1.8;
    let x = 0;
    for (let i = 0; i < da.length; i++) {
      const bh = (da[i] / 255) * H * 0.9;
      const g  = ctx.createLinearGradient(0, H, 0, H - bh);
      g.addColorStop(0,   '#7b2fff44');
      g.addColorStop(0.5, '#7b2fff99');
      g.addColorStop(1,   '#ff3cac');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, H - bh, bw - 2, bh, 2);
      ctx.fill();
      x += bw + 1;
    }
  }
  draw();
}

/* ═══════════════════════════════════════════
   LISTENERS UI
═══════════════════════════════════════════ */
const EMOJIS = ['🎵','🎤','🎧','🌙','⚡','🔥','🌊','🎯','✨','🎶'];
function randomEmoji() { return EMOJIS[Math.floor(Math.random() * EMOJIS.length)]; }

function renderListeners() {
  const grid = document.getElementById('listeners-grid');
  grid.innerHTML = '';
  state.listeners.forEach(l => {
    const d = document.createElement('div');
    d.className = 'listener-avatar';
    d.innerHTML = `
      <div class="avatar-ring ${l.isHost ? 'host' : ''}">
        <div class="avatar-inner">${randomEmoji()}</div>
        ${l.isHost ? '<span class="host-badge">HOST</span>' : ''}
      </div>
      <span class="avatar-name">${escapeHtml(l.userName)}</span>`;
    grid.appendChild(d);
  });
}

function setListenerCount(n) {
  document.getElementById('listener-count-display').textContent =
    `${n} LISTENER${n !== 1 ? 'S' : ''}`;
}

/* ═══════════════════════════════════════════
   CHAT
═══════════════════════════════════════════ */
function appendMessage(msg) {
  if (!msg) return;
  const container = document.getElementById('chat-messages');
  const div       = document.createElement('div');
  div.className   = 'msg' + (msg.isSystem ? ' system' : '');

  const t    = new Date(msg.sentAt || Date.now());
  const time = `${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;

  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-author ${msg.isHost?'host-tag':''} ${msg.isSystem?'system-tag':''}">
        ${escapeHtml(msg.author)}
      </span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-text">${escapeHtml(msg.content)}</div>`;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  state.msgCount++;
  document.getElementById('msg-count').textContent =
    `${state.msgCount} MESSAGE${state.msgCount !== 1 ? 'S' : ''}`;
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat:message', { content: text });
  input.value = '';
}

function sendReaction(emoji) {
  if (!socket) return;
  socket.emit('chat:reaction', { emoji });
}

function spawnFloatingReaction(emoji) {
  const el       = document.createElement('div');
  el.className   = 'reaction-float';
  el.textContent = emoji;
  el.style.left  = (20 + Math.random() * 60) + 'vw';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ═══════════════════════════════════════════
   SHARE / COPY
═══════════════════════════════════════════ */
function copyRoomLink() {
  const url = document.getElementById('share-url').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast('✅ Link copied to clipboard!'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    showToast('✅ Link copied!');
  }
}

/* ═══════════════════════════════════════════
   TOAST
═══════════════════════════════════════════ */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

/* ═══════════════════════════════════════════
   UTILS
═══════════════════════════════════════════ */
function escapeHtml(s = '') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════════════
   URL PARAM — AUTO JOIN
═══════════════════════════════════════════ */
function checkUrlRoom() {
  const roomId = new URLSearchParams(window.location.search).get('room');
  if (roomId) {
    document.getElementById('join-id').value = roomId;
    document.getElementById('name-prompt').style.display = 'flex';
  }
}

function submitPromptName() {
  const name = document.getElementById('prompt-name').value.trim();
  if (!name) { showToast('Please enter a name'); return; }
  document.getElementById('join-name').value = name;
  document.getElementById('name-prompt').style.display = 'none';
  joinRoom();
}

/* ═══════════════════════════════════════════
   CANVAS POLYFILL
═══════════════════════════════════════════ */
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x,y,w,h,r){
    this.beginPath(); this.moveTo(x+r,y); this.lineTo(x+w-r,y);
    this.quadraticCurveTo(x+w,y,x+w,y+r); this.lineTo(x+w,y+h-r);
    this.quadraticCurveTo(x+w,y+h,x+w-r,y+h); this.lineTo(x+r,y+h);
    this.quadraticCurveTo(x,y+h,x,y+h-r); this.lineTo(x,y+r);
    this.quadraticCurveTo(x,y,x+r,y); this.closePath();
  };
}

/* ═══════════════════════════════════════════
   INIT
═══════════════════════════════════════════ */
loadLiveRooms();
checkUrlRoom();
