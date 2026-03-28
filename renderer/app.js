import { GeminiLiveSession, MODEL_LIVE_FLASH } from './lib/gemini-live.js';
import {
  MicStreamer,
  ScreenCapture,
  PcmPlayer,
  createDisplayMediaStream,
  createElectronDesktopStream,
} from './lib/media.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnShareScreen: $('btnShareScreen'),
  btnSendText: $('btnSendText'),
  textSend: $('textSend'),
  transcript: $('transcript'),
  previewWrap: $('previewWrap'),
  previewVideo: $('previewVideo'),
  previewPlaceholder: $('previewPlaceholder'),
  desktopPicker: $('desktopPicker'),
  desktopPickerGrid: $('desktopPickerGrid'),
  desktopPickerCancel: $('desktopPickerCancel'),
};

let session = null;
let mic = null;
let screenCap = null;
let player = null;
let setupWatchdog = null;

/** Set when screen capture comes from Electron desktopCapturer picker (e.g. `window:` / `screen:` id). */
let lastElectronCaptureId = null;

let pendingUserEl = null;
let pendingIrisEl = null;

function setSessionLiveForShell(live) {
  try {
    window.iris?.setSessionLive?.(live);
  } catch {
    /* ignore */
  }
}

function setStatus(mode, label) {
  els.status.className = 'status';
  if (mode === 'idle') els.status.classList.add('status-idle');
  else if (mode === 'connecting') els.status.classList.add('status-connecting');
  else if (mode === 'live') els.status.classList.add('status-live');
  else if (mode === 'error') els.status.classList.add('status-error');
  els.status.textContent = label;
}

function setRunning(running) {
  els.btnStart.disabled = running;
  els.btnStop.disabled = !running;
  els.textSend.disabled = !running;
  els.btnSendText.disabled = !running;
  if (!running) {
    els.btnShareScreen.disabled = true;
    els.btnShareScreen.textContent = 'Share screen';
    els.previewWrap?.classList.remove('sharing');
  }
}

function pushCaptureMetrics() {
  const v = els.previewVideo;
  const stream = v?.srcObject;
  if (!stream) {
    window.iris?.notifyCaptureMetrics?.(null);
    return;
  }
  const t = stream.getVideoTracks?.()?.[0];
  const settings = t?.getSettings?.() || {};
  window.iris?.notifyCaptureMetrics?.({
    videoWidth: v.videoWidth || 0,
    videoHeight: v.videoHeight || 0,
    displaySurface: settings.displaySurface ?? null,
    electronSourceId: lastElectronCaptureId,
  });
}

function setScreenShareUi(active) {
  if (active) {
    els.previewPlaceholder.classList.add('hidden');
    els.previewVideo.classList.add('active');
    els.previewWrap.classList.add('sharing');
    els.btnShareScreen.textContent = 'Change shared screen';
  } else {
    els.previewWrap.classList.remove('sharing');
    els.previewVideo.classList.remove('active');
    els.previewVideo.srcObject = null;
    els.previewPlaceholder.classList.remove('hidden');
    els.btnShareScreen.textContent = 'Share screen';
    lastElectronCaptureId = null;
    window.iris?.notifyCaptureMetrics?.(null);
  }
}

function pickDesktopSourceThumbnails(sources) {
  return new Promise((resolve, reject) => {
    const grid = els.desktopPickerGrid;
    const root = els.desktopPicker;
    const cancel = els.desktopPickerCancel;

    const cleanup = () => {
      grid.replaceChildren();
      root.classList.add('hidden');
      root.setAttribute('aria-hidden', 'true');
      cancel.onclick = null;
      root.removeEventListener('click', onBackdrop);
    };

    const onBackdrop = (ev) => {
      if (ev.target === root) fail();
    };

    const fail = () => {
      cleanup();
      reject(new Error('cancelled'));
    };

    grid.replaceChildren();
    for (const s of sources) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'desktop-picker-item';
      const img = document.createElement('img');
      img.src = s.thumbnailDataUrl;
      img.alt = '';
      const span = document.createElement('span');
      span.textContent = s.name;
      btn.append(img, span);
      btn.addEventListener('click', () => {
        cleanup();
        resolve(s.id);
      });
      grid.appendChild(btn);
    }

    cancel.onclick = () => fail();
    root.addEventListener('click', onBackdrop);
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
  });
}

async function acquireScreenVideoStream() {
  lastElectronCaptureId = null;
  try {
    return await createDisplayMediaStream();
  } catch (err) {
    console.warn('getDisplayMedia failed, trying Electron desktopCapturer', err);
    if (typeof window.iris?.getDesktopSources !== 'function') {
      throw err;
    }
    const sources = await window.iris.getDesktopSources();
    if (!sources?.length) {
      throw err;
    }
    const id = await pickDesktopSourceThumbnails(sources);
    lastElectronCaptureId = id;
    return createElectronDesktopStream(id);
  }
}

async function startScreenShare() {
  if (!session?.connected) {
    alert('Start a session first (wait until status is Live).');
    return;
  }

  els.btnShareScreen.disabled = true;
  try {
    try {
      screenCap?.stop();
    } catch {
      /* ignore */
    }
    screenCap = null;
    setScreenShareUi(false);

    const stream = await acquireScreenVideoStream();

    screenCap = new ScreenCapture((b64) => session.sendScreenJpegBase64(b64), {
      fps: 1,
      maxWidth: 1280,
      quality: 0.72,
    });
    await screenCap.start(stream);
    setScreenShareUi(true);
    screenCap.attachPreview(els.previewVideo);
    requestAnimationFrame(() => pushCaptureMetrics());
    setTimeout(() => pushCaptureMetrics(), 300);
  } catch (e) {
    console.error(e);
    setScreenShareUi(false);
    screenCap = null;
    if (e?.message === 'cancelled') {
      return;
    }
    alert(
      'Screen share failed or was denied.\n\n' +
        '• Click Share screen again; in the dialog, pick Entire screen or a window and confirm.\n' +
        '• Windows: if a “screen capture” permission appeared, allow it for Iris.\n' +
        '• macOS: System Settings → Privacy & Security → Screen Recording — enable Iris.\n\n' +
        `Detail: ${e?.message || e}`
    );
  } finally {
    els.btnShareScreen.disabled = false;
  }
}

function ensurePendingBubble(role) {
  if (role === 'you') {
    if (pendingUserEl) return pendingUserEl;
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-you';
    wrap.innerHTML =
      '<div class="msg-label">You</div><div class="msg-body partial"></div>';
    els.transcript.appendChild(wrap);
    pendingUserEl = wrap.querySelector('.msg-body');
    return pendingUserEl;
  }
  if (pendingIrisEl) return pendingIrisEl;
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-iris';
  wrap.innerHTML =
    '<div class="msg-label">Iris</div><div class="msg-body partial"></div>';
  els.transcript.appendChild(wrap);
  pendingIrisEl = wrap.querySelector('.msg-body');
  return pendingIrisEl;
}

function finalizePending(role) {
  if (role === 'you' && pendingUserEl) {
    pendingUserEl.classList.remove('partial');
    pendingUserEl = null;
  }
  if (role === 'iris' && pendingIrisEl) {
    pendingIrisEl.classList.remove('partial');
    pendingIrisEl = null;
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function onInputTx({ text, finished }) {
  const el = ensurePendingBubble('you');
  el.textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (finished) finalizePending('you');
}

function onOutputTx({ text, finished }) {
  const el = ensurePendingBubble('iris');
  el.textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (finished) finalizePending('iris');
}

async function stopAll() {
  setSessionLiveForShell(false);
  setRunning(false);
  setStatus('idle', 'Disconnected');

  try {
    mic?.stop();
  } catch {
    /* ignore */
  }
  mic = null;

  try {
    screenCap?.stop();
  } catch {
    /* ignore */
  }
  screenCap = null;

  try {
    session?.disconnect();
  } catch {
    /* ignore */
  }
  session = null;

  try {
    player?.interrupt();
  } catch {
    /* ignore */
  }
  try {
    await player?.destroy();
  } catch {
    /* ignore */
  }
  player = null;

  if (setupWatchdog) {
    clearTimeout(setupWatchdog);
    setupWatchdog = null;
  }

  setScreenShareUi(false);

  pendingUserEl = null;
  pendingIrisEl = null;
}

async function startSession() {
  const apiKey = await window.iris.getGeminiApiKey();
  if (!apiKey) {
    setStatus('error', 'Missing API key');
    alert(
      'Set GEMINI_API_KEY in a .env file next to main.js (see .env.example). Get a key from Google AI Studio.'
    );
    return;
  }

  await stopAll();
  setStatus('connecting', 'Connecting…');
  setRunning(true);

  player = new PcmPlayer();

  session = new GeminiLiveSession(apiKey, {
    model: MODEL_LIVE_FLASH,
    voiceName: 'Kore',
  });

  session.onSetupComplete = async () => {
    if (setupWatchdog) {
      clearTimeout(setupWatchdog);
      setupWatchdog = null;
    }
    setStatus('live', 'Live');
    els.btnShareScreen.disabled = false;

    try {
      mic = new MicStreamer((b64) => session.sendAudioPcm16Base64(b64));
      await mic.start();
    } catch (e) {
      console.error(e);
      alert('Microphone failed: ' + (e.message || e));
      await stopAll();
      return;
    }

    setSessionLiveForShell(true);

    try {
      await startScreenShare();
    } catch {
      /* startScreenShare already alerts */
    }
  };

  session.onAudioBase64 = async (b64) => {
    try {
      await player.playBase64Pcm16Le(b64);
    } catch (e) {
      console.error('playback', e);
    }
  };

  session.onInputTranscription = onInputTx;
  session.onOutputTranscription = onOutputTx;

  session.onInterrupted = () => {
    player?.interrupt();
  };

  session.onTurnComplete = () => {
    finalizePending('you');
    finalizePending('iris');
  };

  session.onError = (err) => {
    console.error(err);
    setStatus('error', 'Error');
    alert(err?.message || String(err));
  };

  session.onClose = () => {};

  session.connect();

  setupWatchdog = setTimeout(() => {
    if (els.status.textContent === 'Connecting…') {
      setStatus('error', 'Timeout');
      alert('Connection stalled. Check API key, model access, and network.');
      stopAll();
    }
  }, 25000);
}

function sendTypedText() {
  const t = els.textSend.value.trim();
  if (!t || !session?.connected) return;
  session.sendText(t);
  els.textSend.value = '';
}

els.previewVideo.addEventListener('loadedmetadata', () => {
  pushCaptureMetrics();
});

if (typeof window.iris?.onApplyFocusGrounding === 'function') {
  window.iris.onApplyFocusGrounding((text) => {
    if (session?.connected && text) session.sendText(text);
  });
}

els.btnStart.addEventListener('click', () => startSession());
els.btnStop.addEventListener('click', () => stopAll());
els.btnShareScreen.addEventListener('click', () => void startScreenShare());
els.btnSendText.addEventListener('click', sendTypedText);
els.textSend.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTypedText();
});

window.addEventListener('beforeunload', () => {
  stopAll();
});

setStatus('idle', 'Disconnected');
