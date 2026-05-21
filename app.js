/* =============================================
   STATIONWAVE — app.js  (frontend)
   Connects to the Node/Express backend via:
     REST   → fetch('/api/...')
     WS     → Socket.io
   ============================================= */

'use strict';

/* ── Backend URL — change to your deployed URL in production ── */
const API_BASE = 'http://localhost:3001';
const APP_URL  = window.location.href.split('?')[0].split('#')[0];

let socket = null;

const state = {
  currentRoom: null, userName: '', isHost: false,
  micActive: false, mediaStream: null, audioCtx: null,
  analyser: null, animFrame: null, msgCount: 0, listeners: [],
};

/* ── API helper ── */
async function apiFetch(path, options = {}) {
  const res  = await fetch(API_BASE + path, { headers: {'Content-Type':'application/json'}, ...options });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

/* ── Socket.io ── */
function connectSocket() {
  if (socket?.connected) return;
  socket = io(API_BASE, { transports: ['websocket','polling'] });
  socket.on('connect', () => console.log('🔌 socket:', socket.id));
  socket.on('room:user_joined', ({ socketId, userName, isHost, listenerCount, systemMessage }) => {
    if (!state.listeners.find(l => l.socketId === socketId))
      state.listeners.push({ socketId, userName, isHost });
    renderListeners(); setListenerCount(listenerCount);
    if (systemMessage) appendMessage(systemMessage);
  });
  socket.on('room:user_left', ({ socketId, listenerCount, systemMessage }) => {
    state.listeners = state.listeners.filter(l => l.socketId !== socketId);
    renderListeners(); setListenerCount(listenerCount);
    if (systemMessage) appendMessage(systemMessage);
  });
  socket.on('chat:message',  msg => appendMessage(msg));
  socket.on('chat:reaction', msg => { appendMessage(msg); spawnFloatingReaction(msg.emoji); });
  socket.on('mic:status',    ({ systemMessage }) => { if (systemMessage) appendMessage(systemMessage); });
  socket.on('room:ended',    () => { showToast('📻 Host ended the station'); setTimeout(() => leaveRoom(true), 1500); });
  socket.on('room:history',  ({ messages }) => messages.forEach(appendMessage));
  socket.on('error',         ({ message }) => showToast('⚠️ ' + message));
}

/* ── Home: load live rooms ── */
const DEMO_ROOMS = [
  { id:'latenightvibes', title:'Late Night Vibes',   description:'Smooth lo-fi beats to code and chill to', genre:'Lo-Fi',       listener_count:47,  tags:['chill','beats'] },
  { id:'hiphoptalk',     title:'Hip-Hop Talk Radio', description:'Breaking down the best albums of the year',genre:'Hip-Hop',     listener_count:213, tags:['talk','music'] },
  { id:'nighowls',       title:'Night Owls Podcast', description:'Real convos at 2am with real people',     genre:'Podcast',     listener_count:88,  tags:['talk'] },
  { id:'techbeats',      title:'Tech House Takeover', description:'Deep electronic sounds from the globe',   genre:'Electronic',  listener_count:331, tags:['edm','house'] },
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
    const count  = room.listener_count ?? room.listeners ?? 0;
    const tags   = room.tags ?? [];
    const bar    = Array.from({length:10},()=>`<div class="wave-bar" style="--h:${Math.floor(Math.random()*20+6)}px;--d:${(0.4+Math.random()*0.8).toFixed(2)}s"></div>`).join('');
    const tagHtml = [room.genre,...tags].map(t=>`<span class="tag ${t===room.genre?'genre':''}">${t}</span>`).join('');
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-card-header"><div class="live-dot">LIVE</div><div class="listener-count">👥 ${Number(count).toLocaleString()}</div></div>
      <h3>${escapeHtml(room.title)}</h3>
      <p>${escapeHtml(room.description||room.desc||'')}</p>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div class="room-tags">${tagHtml}</div><div class="wave-bars">${bar}</div>
      </div>`;
    card.addEventListener('click', () => { document.getElementById('join-id').value = room.id; openJoinModal(); });
    grid.appendChild(card);
  });
}

/* ── Screen nav ── */
function showScreen(id) { document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); document.getElementById(id).classList.add('active'); }
function goHome() { leaveRoom(true); showScreen('home'); loadLiveRooms(); }

/* ── Modals ── */
function openCreateModal() { closeModals(); document.getElementById('create-modal').classList.add('open'); }
function openJoinModal()   { closeModals(); document.getElementById('join-modal').classList.add('open');   }
function closeModals()     { document.querySelectorAll('.modal-overlay').forEach(m=>m.classList.remove('open')); }
document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{ if(e.target===o) closeModals(); }));
document.addEventListener('keydown', e => { if(e.key==='Escape') closeModals(); });

/* ── Create room ── */
async function createRoom() {
  const name  = document.getElementById('create-name').value.trim();
  const title = document.getElementById('create-title').value.trim();
  const desc  = document.getElementById('create-desc').value.trim();
  const genre = document.getElementById('create-genre').value;
  if (!name)  { showToast('Please enter your name');    return; }
  if (!title) { showToast('Please enter a room title'); return; }
  try {
    showToast('Creating your station…');
    const { room } = await apiFetch('/api/rooms', { method:'POST', body: JSON.stringify({title, description:desc, genre, host_name:name}) });
    state.userName = name; state.isHost = true;
    closeModals(); await enterRoom(room, true);
  } catch(err) { showToast('❌ ' + err.message); }
}

/* ── Join room ── */
async function joinRoom() {
  const name      = document.getElementById('join-name').value.trim();
  const roomInput = document.getElementById('join-id').value.trim();
  if (!name)      { showToast('Please enter your name');         return; }
  if (!roomInput) { showToast('Please enter a room ID or link'); return; }
  const match  = roomInput.match(/[?&]room=([^&]+)/);
  const roomId = match ? match[1] : roomInput.toLowerCase().replace(/\s+/g,'');
  try {
    showToast('Joining station…');
    const { room } = await apiFetch(`/api/rooms/${roomId}`);
    state.userName = name; state.isHost = false;
    closeModals(); await enterRoom(room, false);
  } catch(err) { showToast('❌ Room not found or server offline'); }
}

/* ── Enter room ── */
async function enterRoom(room, isHost) {
  state.currentRoom = room; state.isHost = isHost;
  state.listeners = []; state.msgCount = 0;
  document.getElementById('room-title-nav').textContent   = room.title;
  document.getElementById('stage-room-title').textContent = room.title;
  document.getElementById('stage-room-desc').textContent  = room.description || room.desc || '';
  document.getElementById('stage-genre').textContent      = (room.genre||'Music').toUpperCase();
  document.getElementById('share-url').textContent        = `${APP_URL}?room=${room.id}`;
  document.getElementById('role-display').textContent     = isHost ? 'HOST' : 'LISTENER';
  document.getElementById('mic-status').textContent       = 'MUTED';
  document.getElementById('chat-messages').innerHTML      = '';
  document.getElementById('msg-count').textContent        = '0 MESSAGES';
  state.listeners.push({ socketId:'me', userName: state.userName, isHost });
  if (!isHost) state.listeners.push({ socketId:'host', userName: room.host_name, isHost: true });
  renderListeners();
  showScreen('room'); startVisualizer();
  connectSocket();
  socket.emit('room:join', { roomId: room.id, userName: state.userName, isHost });
  if (history.pushState) history.pushState(null,'',`?room=${room.id}`);
}

/* ── Leave room ── */
function leaveRoom(silent = false) {
  if (socket && state.currentRoom) {
    state.isHost ? socket.emit('room:end') : socket.emit('room:leave');
  }
  if (state.mediaStream) { state.mediaStream.getTracks().forEach(t=>t.stop()); state.mediaStream = null; }
  if (state.animFrame)   { cancelAnimationFrame(state.animFrame); state.animFrame = null; }
  if (state.audioCtx)    { state.audioCtx.close().catch(()=>{}); state.audioCtx = null; }
  state.micActive = false; state.isHost = false; state.currentRoom = null; state.listeners = [];
  if (history.pushState) history.pushState(null,'',APP_URL);
  if (!silent) { showScreen('home'); loadLiveRooms(); }
}

/* ── Mic ── */
async function toggleMic() {
  const micBtn = document.getElementById('mic-btn');
  if (state.micActive) {
    if (state.mediaStream) { state.mediaStream.getTracks().forEach(t=>t.stop()); state.mediaStream = null; }
    state.micActive = false;
    micBtn.classList.remove('active'); micBtn.classList.add('muted');
    document.getElementById('mic-status').textContent = 'MUTED';
    socket?.emit('mic:status', { active: false }); showToast('🔇 Microphone off');
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
      state.mediaStream = stream; state.micActive = true;
      if (!state.audioCtx || state.audioCtx.state==='closed')
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.audioCtx.createAnalyser(); state.analyser.fftSize = 256;
      state.audioCtx.createMediaStreamSource(stream).connect(state.analyser);
      micBtn.classList.remove('muted'); micBtn.classList.add('active');
      document.getElementById('mic-status').textContent = state.isHost ? 'BROADCASTING' : 'UNMUTED';
      socket?.emit('mic:status', { active: true }); showToast('🎙 Microphone active — speak now!');
    } catch { showToast('❌ Mic access denied'); }
  }
}
function setVolume(val) { document.getElementById('vol-display').textContent = val; }

/* ── Visualizer ── */
function startVisualizer() {
  const canvas = document.getElementById('visualizer-canvas');
  const ctx    = canvas.getContext('2d');
  function resize() { canvas.width=canvas.offsetWidth*devicePixelRatio; canvas.height=canvas.offsetHeight*devicePixelRatio; ctx.scale(devicePixelRatio,devicePixelRatio); }
  resize(); window.addEventListener('resize',resize);
  function draw() {
    state.animFrame = requestAnimationFrame(draw);
    const W=canvas.offsetWidth, H=canvas.offsetHeight;
    ctx.clearRect(0,0,W,H);
    let da;
    if (state.analyser && state.micActive) { da=new Uint8Array(state.analyser.frequencyBinCount); state.analyser.getByteFrequencyData(da); }
    else { da=new Uint8Array(64); const t=Date.now()/1000; for(let i=0;i<64;i++) da[i]=Math.abs(Math.sin(t*2.1+i*0.3)*Math.sin(t*0.7+i*0.15)*80+20); }
    const bw=(W/da.length)*1.8; let x=0;
    for (let i=0;i<da.length;i++) {
      const bh=(da[i]/255)*H*0.9;
      const g=ctx.createLinearGradient(0,H,0,H-bh);
      g.addColorStop(0,'#7b2fff44'); g.addColorStop(0.5,'#7b2fff99'); g.addColorStop(1,'#ff3cac');
      ctx.fillStyle=g; ctx.beginPath(); ctx.roundRect(x,H-bh,bw-2,bh,2); ctx.fill(); x+=bw+1;
    }
  }
  draw();
}

/* ── Listeners ── */
const EMOJIS=['🎵','🎤','🎧','🌙','⚡','🔥','🌊','🎯','✨','🎶'];
function randomEmoji() { return EMOJIS[Math.floor(Math.random()*EMOJIS.length)]; }
function renderListeners() {
  const grid = document.getElementById('listeners-grid');
  grid.innerHTML = '';
  state.listeners.forEach(l => {
    const d = document.createElement('div');
    d.className='listener-avatar';
    d.innerHTML=`<div class="avatar-ring ${l.isHost?'host':''}"><div class="avatar-inner">${randomEmoji()}</div>${l.isHost?'<span class="host-badge">HOST</span>':''}</div><span class="avatar-name">${escapeHtml(l.userName)}</span>`;
    grid.appendChild(d);
  });
}
function setListenerCount(n) { document.getElementById('listener-count-display').textContent=`${n} LISTENER${n!==1?'S':''}`; }

/* ── Chat ── */
function appendMessage(msg) {
  if (!msg) return;
  const c=document.getElementById('chat-messages'), d=document.createElement('div');
  d.className='msg'+(msg.isSystem?' system':'');
  const t=new Date(msg.sentAt||Date.now());
  const time=`${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;
  d.innerHTML=`<div class="msg-header"><span class="msg-author ${msg.isHost?'host-tag':''} ${msg.isSystem?'system-tag':''}">${escapeHtml(msg.author)}</span><span class="msg-time">${time}</span></div><div class="msg-text">${escapeHtml(msg.content)}</div>`;
  c.appendChild(d); c.scrollTop=c.scrollHeight;
  state.msgCount++; document.getElementById('msg-count').textContent=`${state.msgCount} MESSAGE${state.msgCount!==1?'S':''}`;
}
function sendMessage() { const i=document.getElementById('chat-input'),t=i.value.trim(); if(!t||!socket)return; socket.emit('chat:message',{content:t}); i.value=''; }
function sendReaction(e) { if(!socket)return; socket.emit('chat:reaction',{emoji:e}); }
function spawnFloatingReaction(emoji) { const el=document.createElement('div'); el.className='reaction-float'; el.textContent=emoji; el.style.left=(20+Math.random()*60)+'vw'; document.body.appendChild(el); setTimeout(()=>el.remove(),2600); }

/* ── Copy link ── */
function copyRoomLink() {
  const url=document.getElementById('share-url').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(()=>showToast('✅ Link copied!'));
  else { const ta=document.createElement('textarea'); ta.value=url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); showToast('✅ Link copied!'); }
}

/* ── Toast ── */
function showToast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3000); }

/* ── Utils ── */
function escapeHtml(s='') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ── URL param auto-join ── */
function checkUrlRoom() {
  const roomId=new URLSearchParams(window.location.search).get('room');
  if (roomId) { document.getElementById('join-id').value=roomId; document.getElementById('name-prompt').style.display='flex'; }
}
function submitPromptName() {
  const name=document.getElementById('prompt-name').value.trim();
  if (!name) { showToast('Please enter a name'); return; }
  document.getElementById('join-name').value=name;
  document.getElementById('name-prompt').style.display='none';
  joinRoom();
}

/* ── Canvas polyfill ── */
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect=function(x,y,w,h,r){this.beginPath();this.moveTo(x+r,y);this.lineTo(x+w-r,y);this.quadraticCurveTo(x+w,y,x+w,y+r);this.lineTo(x+w,y+h-r);this.quadraticCurveTo(x+w,y+h,x+w-r,y+h);this.lineTo(x+r,y+h);this.quadraticCurveTo(x,y+h,x,y+h-r);this.lineTo(x,y+r);this.quadraticCurveTo(x,y,x+r,y);this.closePath();};
}

/* ── Init ── */
loadLiveRooms();
checkUrlRoom();
