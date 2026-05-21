/* =============================================
   STATIONWAVE — mixer.js

   Web Audio API DJ Mixer
   ─────────────────────
   Signal chain:

   [Mic Input]  → GainNode(micGain)  ─┐
                                       ├→ DestinationNode → WebRTC stream → listeners
   [Music File] → GainNode(musGain)  ─┘
                       ↓
               AnalyserNode → visualizer canvas

   Features:
   • Load any audio file from device
   • Separate mic + music volume faders
   • Play / Pause / Stop music
   • Mic mute toggle
   • Real-time level meters for both channels
   • Mixed stream sent via WebRTC (existing PeerJS logic)
   ============================================= */

'use strict';

/* ─────────────────────────────────────────────
   MIXER STATE
───────────────────────────────────────────── */
const mixer = {
  ctx:           null,   // AudioContext
  destination:   null,   // MediaStreamAudioDestinationNode  → WebRTC
  analyser:      null,   // AnalyserNode for visualizer

  /* Mic chain */
  micStream:     null,   // raw MediaStream from getUserMedia
  micSource:     null,   // MediaStreamAudioSourceNode
  micGain:       null,   // GainNode
  micActive:     false,

  /* Music chain */
  musicBuffer:   null,   // decoded AudioBuffer
  musicSource:   null,   // AudioBufferSourceNode (recreated on each play)
  musicGain:     null,   // GainNode
  musicPlaying:  false,
  musicPaused:   false,
  musicOffset:   0,      // seconds — where we paused
  musicStart:    0,      // ctx.currentTime when playback started
  musicDuration: 0,

  /* Level meter buffers */
  micAnalyser:   null,
  musAnalyser:   null,

  animFrame:     null,
};

/* ─────────────────────────────────────────────
   INIT — call once when host enters a room
───────────────────────────────────────────── */
function mixerInit() {
  if (mixer.ctx) return;   // already initialised

  mixer.ctx         = new (window.AudioContext || window.webkitAudioContext)();
  mixer.destination = mixer.ctx.createMediaStreamDestination();

  /* Master analyser — feeds the visualizer canvas */
  mixer.analyser          = mixer.ctx.createAnalyser();
  mixer.analyser.fftSize  = 256;
  mixer.analyser.connect(mixer.destination);

  /* Mic gain node */
  mixer.micGain = mixer.ctx.createGain();
  mixer.micGain.gain.value = 0.8;
  mixer.micGain.connect(mixer.analyser);

  /* Music gain node */
  mixer.musicGain = mixer.ctx.createGain();
  mixer.musicGain.gain.value = 0.7;
  mixer.musicGain.connect(mixer.analyser);

  /* Per-channel analysers for the level meters */
  mixer.micAnalyser         = mixer.ctx.createAnalyser();
  mixer.micAnalyser.fftSize = 32;
  mixer.micGain.connect(mixer.micAnalyser);

  mixer.musAnalyser         = mixer.ctx.createAnalyser();
  mixer.musAnalyser.fftSize = 32;
  mixer.musicGain.connect(mixer.musAnalyser);

  /* Expose the mixed stream + analyser for the WebRTC / visualizer layers */
  state.mediaStream = mixer.destination.stream;
  state.analyser    = mixer.analyser;

  startMeterLoop();
  console.log('🎚 Mixer initialised');
}

async function mixerDestroy() {
  if (mixer.animFrame) cancelAnimationFrame(mixer.animFrame);
  mixerStopMusic();
  if (mixer.micStream) {
    mixer.micStream.getTracks().forEach(t => t.stop());
    mixer.micStream = null;
  }
  if (mixer.ctx) {
    await mixer.ctx.close().catch(() => {});
    mixer.ctx = null;
  }
  Object.assign(mixer, {
    destination: null, analyser: null,
    micSource: null, micGain: null, micActive: false,
    musicBuffer: null, musicSource: null, musicGain: null,
    musicPlaying: false, musicPaused: false,
    musicOffset: 0, musicDuration: 0,
    micAnalyser: null, musAnalyser: null, animFrame: null,
  });
  console.log('🎚 Mixer destroyed');
}

/* ─────────────────────────────────────────────
   MIC CONTROLS
───────────────────────────────────────────── */
async function mixerToggleMic() {
  if (!mixer.ctx) mixerInit();
  if (mixer.ctx.state === 'suspended') await mixer.ctx.resume();

  if (mixer.micActive) {
    /* Mute mic */
    if (mixer.micStream) {
      mixer.micStream.getTracks().forEach(t => t.stop());
      mixer.micStream = null;
    }
    if (mixer.micSource) { mixer.micSource.disconnect(); mixer.micSource = null; }
    mixer.micActive = false;
    updateMicUI(false);
    showToast('🔇 Mic off');
  } else {
    /* Unmute mic */
    try {
      mixer.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
        video: false,
      });
      mixer.micSource = mixer.ctx.createMediaStreamSource(mixer.micStream);
      mixer.micSource.connect(mixer.micGain);
      mixer.micActive = true;
      updateMicUI(true);
      showToast('🎙 Mic on — you are live!');

      /* Tell server mic is active */
      socket?.emit('mic:status', { active: true });
    } catch (err) {
      showToast('❌ Mic access denied');
      console.error(err);
    }
  }

  /* Always broadcast the current mixed stream */
  broadcastMixedStream();
}

function mixerSetMicVolume(val) {
  if (mixer.micGain) mixer.micGain.gain.value = val / 100;
  document.getElementById('mic-vol-display').textContent = Math.round(val) + '%';
}

/* ─────────────────────────────────────────────
   MUSIC FILE LOADING
───────────────────────────────────────────── */
function mixerLoadFile(file) {
  if (!file) return;
  if (!mixer.ctx) mixerInit();

  const reader = new FileReader();
  reader.onload = async e => {
    try {
      mixerStopMusic();
      mixer.musicBuffer   = await mixer.ctx.decodeAudioData(e.target.result);
      mixer.musicDuration = mixer.musicBuffer.duration;
      mixer.musicOffset   = 0;
      mixer.musicPaused   = false;

      updateMusicUI('LOADED', file.name);
      document.getElementById('music-duration').textContent = formatTime(mixer.musicDuration);
      showToast(`🎵 Loaded: ${file.name}`);
    } catch (err) {
      showToast('❌ Could not decode audio file');
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
}

/* ─────────────────────────────────────────────
   MUSIC PLAYBACK CONTROLS
───────────────────────────────────────────── */
async function mixerPlayMusic() {
  if (!mixer.musicBuffer) { showToast('Load a music file first'); return; }
  if (!mixer.ctx) mixerInit();
  if (mixer.ctx.state === 'suspended') await mixer.ctx.resume();

  /* Stop any current source */
  if (mixer.musicSource) {
    try { mixer.musicSource.stop(); } catch {}
    mixer.musicSource.disconnect();
  }

  mixer.musicSource = mixer.ctx.createBufferSource();
  mixer.musicSource.buffer = mixer.musicBuffer;
  mixer.musicSource.connect(mixer.musicGain);
  mixer.musicSource.loop   = document.getElementById('music-loop')?.checked || false;

  mixer.musicSource.onended = () => {
    if (!mixer.musicPaused) {
      mixer.musicPlaying = false;
      mixer.musicOffset  = 0;
      updateMusicUI('STOPPED');
      updateProgressBar(0);
    }
  };

  mixer.musicSource.start(0, mixer.musicOffset);
  mixer.musicStart   = mixer.ctx.currentTime - mixer.musicOffset;
  mixer.musicPlaying = true;
  mixer.musicPaused  = false;

  updateMusicUI('PLAYING');
  broadcastMixedStream();
  startProgressLoop();
}

function mixerPauseMusic() {
  if (!mixer.musicPlaying || !mixer.musicSource) return;
  mixer.musicOffset  = mixer.ctx.currentTime - mixer.musicStart;
  mixer.musicPaused  = true;
  mixer.musicPlaying = false;
  try { mixer.musicSource.stop(); } catch {}
  updateMusicUI('PAUSED');
}

function mixerStopMusic() {
  if (mixer.musicSource) {
    try { mixer.musicSource.stop(); } catch {}
    mixer.musicSource.disconnect();
    mixer.musicSource = null;
  }
  mixer.musicPlaying = false;
  mixer.musicPaused  = false;
  mixer.musicOffset  = 0;
  updateProgressBar(0);
  updateMusicUI('STOPPED');
}

function mixerSetMusicVolume(val) {
  if (mixer.musicGain) mixer.musicGain.gain.value = val / 100;
  document.getElementById('music-vol-display').textContent = Math.round(val) + '%';
}

function mixerSeek(val) {
  if (!mixer.musicBuffer) return;
  mixer.musicOffset = (val / 100) * mixer.musicDuration;
  if (mixer.musicPlaying) mixerPlayMusic();
}

function mixerToggleLoop() {
  if (mixer.musicSource) {
    mixer.musicSource.loop = document.getElementById('music-loop').checked;
  }
}

/* ─────────────────────────────────────────────
   WEBRTC — broadcast the mixed stream
───────────────────────────────────────────── */
async function broadcastMixedStream() {
  if (!mixer.destination) return;

  /* Update the global mediaStream so WebRTC uses the mixer output */
  state.mediaStream = mixer.destination.stream;

  /* If already broadcasting, just update the stream in existing peer calls */
  if (activeCalls.length > 0) {
    activeCalls.forEach(call => {
      const sender = call.peerConnection?.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) {
        const track = mixer.destination.stream.getAudioTracks()[0];
        if (track) sender.replaceTrack(track).catch(console.warn);
      }
    });
    return;
  }

  /* Otherwise start a new broadcast */
  try {
    const peerId = await createPeer();
    socket?.emit('webrtc:host_broadcasting', { peerId });
  } catch (err) {
    console.warn('Could not start broadcast:', err);
  }
}

/* ─────────────────────────────────────────────
   LEVEL METERS (animated)
───────────────────────────────────────────── */
function startMeterLoop() {
  const micData = new Uint8Array(mixer.micAnalyser?.frequencyBinCount || 16);
  const musData = new Uint8Array(mixer.musAnalyser?.frequencyBinCount || 16);

  function loop() {
    mixer.animFrame = requestAnimationFrame(loop);

    if (mixer.micAnalyser) {
      mixer.micAnalyser.getByteFrequencyData(micData);
      const level = Math.max(...micData) / 255;
      setMeterLevel('mic-meter', level);
    }

    if (mixer.musAnalyser) {
      mixer.musAnalyser.getByteFrequencyData(musData);
      const level = Math.max(...musData) / 255;
      setMeterLevel('mus-meter', level);
    }
  }
  loop();
}

function setMeterLevel(id, level) {
  const el = document.getElementById(id);
  if (!el) return;
  const pct = Math.round(level * 100);
  el.style.width = pct + '%';
  el.style.background = pct > 80
    ? 'linear-gradient(90deg,#ff3cac,#ff0000)'
    : pct > 50
    ? 'linear-gradient(90deg,#7b2fff,#ff3cac)'
    : 'linear-gradient(90deg,#00f5d4,#7b2fff)';
}

/* ─────────────────────────────────────────────
   PROGRESS BAR
───────────────────────────────────────────── */
let progressLoop = null;

function startProgressLoop() {
  if (progressLoop) clearInterval(progressLoop);
  progressLoop = setInterval(() => {
    if (!mixer.musicPlaying || !mixer.musicBuffer) return;
    const elapsed = mixer.ctx.currentTime - mixer.musicStart;
    const pct     = Math.min((elapsed / mixer.musicDuration) * 100, 100);
    updateProgressBar(pct);
    document.getElementById('music-current').textContent = formatTime(elapsed);
  }, 500);
}

function updateProgressBar(pct) {
  const bar   = document.getElementById('music-progress');
  const thumb = document.getElementById('progress-seek');
  if (bar)   bar.style.width   = pct + '%';
  if (thumb) thumb.value       = pct;
}

/* ─────────────────────────────────────────────
   UI UPDATES
───────────────────────────────────────────── */
function updateMicUI(active) {
  const btn = document.getElementById('mixer-mic-btn');
  const lbl = document.getElementById('mixer-mic-label');
  if (!btn) return;
  if (active) {
    btn.classList.add('active');
    btn.classList.remove('muted');
    if (lbl) lbl.textContent = 'MIC ON';
  } else {
    btn.classList.remove('active');
    btn.classList.add('muted');
    if (lbl) lbl.textContent = 'MIC OFF';
  }
}

function updateMusicUI(status, filename) {
  const lbl  = document.getElementById('music-status-label');
  const name = document.getElementById('music-filename');
  const play = document.getElementById('music-play-btn');
  const paus = document.getElementById('music-pause-btn');

  if (name && filename) {
    name.textContent = filename.length > 30 ? filename.slice(0, 28) + '…' : filename;
  }
  if (lbl) {
    lbl.textContent = status;
    lbl.className   = 'music-status ' + status.toLowerCase();
  }
  if (play) play.disabled = (status === 'PLAYING');
  if (paus) paus.disabled = (status !== 'PLAYING');
}

/* ─────────────────────────────────────────────
   UTILS
───────────────────────────────────────────── */
function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ─────────────────────────────────────────────
   INJECT MIXER HTML into the room stage
   Called from enterRoom() in app.js
───────────────────────────────────────────── */
function injectMixerPanel() {
  /* Only show for hosts */
  if (!state.isHost) return;

  /* Don't inject twice */
  if (document.getElementById('dj-mixer')) return;

  const panel = document.createElement('div');
  panel.id        = 'dj-mixer';
  panel.className = 'dj-mixer';
  panel.innerHTML = `
    <div class="mixer-header">
      <span class="mixer-title">🎚 DJ MIXER</span>
      <span class="mixer-subtitle">MIC + MUSIC — LIVE TO LISTENERS</span>
    </div>

    <div class="mixer-channels">

      <!-- ── MIC CHANNEL ── -->
      <div class="mixer-channel">
        <div class="channel-label">🎙 MICROPHONE</div>

        <div class="meter-wrap">
          <div class="meter-track"><div class="meter-fill" id="mic-meter"></div></div>
        </div>

        <div class="fader-wrap">
          <label class="fader-label">VOLUME</label>
          <input type="range" min="0" max="150" value="80" class="fader"
            oninput="mixerSetMicVolume(this.value)">
          <span class="fader-val" id="mic-vol-display">80%</span>
        </div>

        <button class="mixer-mic-btn muted" id="mixer-mic-btn" onclick="mixerToggleMic()">
          🎙
        </button>
        <div class="channel-status" id="mixer-mic-label">MIC OFF</div>
      </div>

      <!-- ── DIVIDER ── -->
      <div class="mixer-divider">
        <div class="divider-line"></div>
        <span class="divider-icon">MIX</span>
        <div class="divider-line"></div>
      </div>

      <!-- ── MUSIC CHANNEL ── -->
      <div class="mixer-channel">
        <div class="channel-label">🎵 MUSIC</div>

        <div class="meter-wrap">
          <div class="meter-track"><div class="meter-fill" id="mus-meter"></div></div>
        </div>

        <div class="fader-wrap">
          <label class="fader-label">VOLUME</label>
          <input type="range" min="0" max="150" value="70" class="fader"
            oninput="mixerSetMusicVolume(this.value)">
          <span class="fader-val" id="music-vol-display">70%</span>
        </div>

        <!-- File picker -->
        <label class="file-pick-btn" for="music-file-input">
          📂 LOAD TRACK
        </label>
        <input type="file" id="music-file-input" accept="audio/*" style="display:none"
          onchange="mixerLoadFile(this.files[0])">

        <div class="music-filename" id="music-filename">No track loaded</div>
      </div>
    </div>

    <!-- ── TRANSPORT ── -->
    <div class="transport">
      <div class="transport-time">
        <span id="music-current">0:00</span>
        <span class="time-sep">/</span>
        <span id="music-duration">0:00</span>
        <span class="music-status stopped" id="music-status-label">STOPPED</span>
      </div>

      <div class="progress-wrap">
        <div class="progress-track">
          <div class="progress-fill" id="music-progress"></div>
        </div>
        <input type="range" min="0" max="100" value="0" class="progress-seek" id="progress-seek"
          oninput="mixerSeek(this.value)">
      </div>

      <div class="transport-btns">
        <button class="t-btn play"  id="music-play-btn"  onclick="mixerPlayMusic()"  disabled>▶ PLAY</button>
        <button class="t-btn pause" id="music-pause-btn" onclick="mixerPauseMusic()" disabled>⏸ PAUSE</button>
        <button class="t-btn stop"  onclick="mixerStopMusic()">⏹ STOP</button>
        <label class="loop-toggle">
          <input type="checkbox" id="music-loop" onchange="mixerToggleLoop()">
          🔁 LOOP
        </label>
      </div>
    </div>
  `;

  /* Insert the mixer panel into the stage, after the visualizer */
  const visualizer = document.querySelector('.visualizer-container');
  if (visualizer) {
    visualizer.insertAdjacentElement('afterend', panel);
  } else {
    document.querySelector('.stage')?.appendChild(panel);
  }

  /* Init the audio engine */
  mixerInit();
}
