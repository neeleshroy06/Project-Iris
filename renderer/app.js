import {
  GeminiLiveSession,
  MODEL_LIVE_FLASH,
  DEFAULT_LIVE_SYSTEM_INSTRUCTION,
  withObservationMode,
} from './lib/gemini-live.js';
import { withLongTermMemory } from './lib/iris-live-prompts.js';
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
  btnThemeToggle: $('btnThemeToggle'),
  transcript: $('transcript'),
  previewWrap: $('previewWrap'),
  previewVideo: $('previewVideo'),
  previewPlaceholder: $('previewPlaceholder'),
  desktopPicker: $('desktopPicker'),
  desktopPickerGrid: $('desktopPickerGrid'),
  desktopPickerCancel: $('desktopPickerCancel'),
  observationModeGroup: $('observationModeGroup'),
  obsModeSilent: $('obsModeSilent'),
  obsModeAmbient: $('obsModeAmbient'),
  transcriptComposerInput: $('transcriptComposerInput'),
};

const THEME_STORAGE_KEY = 'iris-theme';
const OBSERVATION_STORAGE_KEY = 'iris-observation-mode';

/** Last line typed in the conversation composer if it looks like a Google email (for Calendar tool). */
let lastComposerEmail = '';

function newDockId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `dock-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Mirror interactive rows (downloads, links) to the compact focus bar when the shell is running. */
function pushToFocusBarDock(item) {
  try {
    if (typeof window.iris?.pushFocusBarDock !== 'function') return;
    window.iris.pushFocusBarDock(item);
  } catch {
    /* ignore */
  }
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* ignore */
  }
  const label = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const title = t === 'dark' ? 'Light mode' : 'Dark mode';
  for (const id of ['btnThemeToggle', 'btnWelcomeThemeToggle']) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.setAttribute('aria-label', label);
      btn.title = title;
    }
  }
}

function initTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') applyTheme(saved);
    else applyTheme('dark');
  } catch {
    applyTheme('dark');
  }
}

function setMainAppHidden(hidden) {
  const main = $('mainApp');
  if (!main) return;
  if (hidden) {
    main.setAttribute('aria-hidden', 'true');
    main.classList.add('main-app--behind-welcome');
  } else {
    main.removeAttribute('aria-hidden');
    main.classList.remove('main-app--behind-welcome');
  }
}

function initWelcome() {
  const root = $('welcomeScreen');
  if (!root) return;
  root.classList.remove('welcome-screen--hidden');
  root.setAttribute('aria-hidden', 'false');
  setMainAppHidden(true);
}

function dismissWelcome() {
  const root = $('welcomeScreen');
  if (root) {
    root.classList.add('welcome-screen--hidden');
    root.setAttribute('aria-hidden', 'true');
  }
  setMainAppHidden(false);
  closeWelcomeDemoModal();
  /* Main was display:none; nudge layout + preview after it paints again */
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function openWelcomeDemoModal() {
  const m = $('welcomeDemoModal');
  if (!m) return;
  m.classList.remove('hidden');
  m.setAttribute('aria-hidden', 'false');
}

function closeWelcomeDemoModal() {
  const m = $('welcomeDemoModal');
  if (!m) return;
  m.classList.add('hidden');
  m.setAttribute('aria-hidden', 'true');
}

let session = null;
let mic = null;
let screenCap = null;
let player = null;
let setupWatchdog = null;

/** Set when screen capture comes from Electron desktopCapturer picker (e.g. `window:` / `screen:` id). */
let lastElectronCaptureId = null;

/** Normalized 0–1 rects drawn on each JPEG when mapping is confident (from main process). */
let captureFocusNormRegions = null;

/** JPEG encode size from ScreenCapture (what Gemini receives). */
let lastEncodeWidth = 0;
let lastEncodeHeight = 0;

/** Last frame sent to Live (and to spreadsheet export). */
let lastScreenJpegBase64 = null;

let pendingUserEl = null;
let pendingIrisEl = null;

/** @type {'silent' | 'ambient'} */
let observationMode = 'silent';
function loadObservationMode() {
  try {
    const v = localStorage.getItem(OBSERVATION_STORAGE_KEY);
    if (v === 'ambient' || v === 'silent') return v;
  } catch {
    /* ignore */
  }
  return 'silent';
}

function getObservationMode() {
  return observationMode;
}

function setObservationModeUi(mode) {
  observationMode = mode === 'ambient' ? 'ambient' : 'silent';
  if (els.obsModeAmbient) els.obsModeAmbient.checked = observationMode === 'ambient';
  if (els.obsModeSilent) els.obsModeSilent.checked = observationMode === 'silent';
}

function saveObservationMode(mode) {
  try {
    localStorage.setItem(OBSERVATION_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function syncObservationModeToMain() {
  try {
    window.iris?.syncObservationMode?.(getObservationMode());
  } catch {
    /* ignore */
  }
}

function setObservationGroupDisabled(disabled) {
  els.observationModeGroup?.classList.toggle('observation-mode--disabled', !!disabled);
  const inputs = els.observationModeGroup?.querySelectorAll('input[name="observationMode"]');
  inputs?.forEach((el) => {
    el.disabled = !!disabled;
  });
}

function initObservationMode() {
  setObservationModeUi(loadObservationMode());
  syncObservationModeToMain();
  const onChange = () => {
    const m = els.obsModeAmbient?.checked ? 'ambient' : 'silent';
    setObservationModeUi(m);
    saveObservationMode(getObservationMode());
    syncObservationModeToMain();
  };
  els.obsModeSilent?.addEventListener('change', onChange);
  els.obsModeAmbient?.addEventListener('change', onChange);
  if (typeof window.iris?.onObservationMode === 'function') {
    window.iris.onObservationMode((payload) => {
      const m = payload?.mode;
      if (m !== 'ambient' && m !== 'silent') return;
      if (getObservationMode() === m) return;
      setObservationModeUi(m);
      saveObservationMode(getObservationMode());
    });
  }
}

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
    window.__irisCaptureMeta = null;
    window.iris?.notifyCaptureMetrics?.(null);
    return;
  }
  const t = stream.getVideoTracks?.()?.[0];
  const settings = t?.getSettings?.() || {};
  const meta = {
    videoWidth: v.videoWidth || 0,
    videoHeight: v.videoHeight || 0,
    encodeWidth: lastEncodeWidth || 0,
    encodeHeight: lastEncodeHeight || 0,
    displaySurface: settings.displaySurface ?? null,
    electronSourceId: lastElectronCaptureId,
  };
  window.__irisCaptureMeta = meta;
  window.iris?.notifyCaptureMetrics?.(meta);
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
    lastEncodeWidth = 0;
    lastEncodeHeight = 0;
    window.__irisCaptureMeta = null;
    captureFocusNormRegions = null;
    window.iris?.notifyCaptureMetrics?.(null);
  }
}

/** Window or tab share (not full monitor) — compact UI works best. */
function isWindowLikeShare(displaySurface, electronSourceId) {
  if (displaySurface === 'window' || displaySurface === 'browser') return true;
  if (electronSourceId && String(electronSourceId).startsWith('window:')) return true;
  return false;
}

function tryMinimizeForWindowShare() {
  if (!session?.connected) return;
  const stream = els.previewVideo?.srcObject;
  const t = stream?.getVideoTracks?.()?.[0];
  const settings = t?.getSettings?.() || {};
  const displaySurface = settings.displaySurface ?? null;
  if (!isWindowLikeShare(displaySurface, lastElectronCaptureId)) return;
  try {
    window.iris?.minimizeCompact?.({
      electronSourceId: lastElectronCaptureId,
      windowTitleHint: t?.label || '',
    });
  } catch {
    /* ignore */
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
  /* In Electron, prefer our in-app picker (themed UI + scrollbars). getDisplayMedia opens the
   * OS/native screen dialog first, which cannot be styled with app CSS. */
  const canUseElectronPicker = typeof window.iris?.getDesktopSources === 'function';
  if (canUseElectronPicker) {
    try {
      const sources = await window.iris.getDesktopSources();
      if (sources?.length) {
        const id = await pickDesktopSourceThumbnails(sources);
        lastElectronCaptureId = id;
        return await createElectronDesktopStream(id);
      }
    } catch (err) {
      if (err?.message === 'cancelled') throw err;
      console.warn('Electron desktop picker failed, trying getDisplayMedia', err);
    }
  }

  return await createDisplayMediaStream();
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

    captureFocusNormRegions = null;
    screenCap = new ScreenCapture((b64) => {
      lastScreenJpegBase64 = b64;
      session.sendScreenJpegBase64(b64);
    }, {
      fps: 1,
      maxWidth: 1280,
      quality: 0.72,
      getFocusRegions: () => captureFocusNormRegions || [],
    });
    const capInfo = await screenCap.start(stream);
    lastEncodeWidth = capInfo?.width || 0;
    lastEncodeHeight = capInfo?.height || 0;
    setScreenShareUi(true);
    screenCap.attachPreview(els.previewVideo);
    requestAnimationFrame(() => pushCaptureMetrics());
    setTimeout(() => {
      pushCaptureMetrics();
      tryMinimizeForWindowShare();
    }, 320);
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

function stopScreenShareOnly() {
  try {
    screenCap?.stop();
  } catch {
    /* ignore */
  }
  screenCap = null;
  setScreenShareUi(false);
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

/** Internal Live markers must never appear in the conversation UI (they may leak into transcription). */
function transcriptLooksLikeIrisClientMarker(s) {
  return typeof s === 'string' && s.includes('[Iris client]');
}

function onInputTx({ text, finished }) {
  const raw = text || '';
  if (transcriptLooksLikeIrisClientMarker(raw)) {
    if (finished && pendingUserEl) {
      pendingUserEl.closest('.msg')?.remove();
      pendingUserEl = null;
    }
    return;
  }
  const el = ensurePendingBubble('you');
  el.textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (finished) {
    finalizePending('you');
    const t = raw.trim();
    if (t.length >= 3 && window.iris?.appendMemoryTurn) {
      void window.iris.appendMemoryTurn({ role: 'user', text: t });
    }
  }
}

function onOutputTx({ text, finished }) {
  const raw = text || '';
  if (transcriptLooksLikeIrisClientMarker(raw)) {
    if (finished && pendingIrisEl) {
      pendingIrisEl.closest('.msg')?.remove();
      pendingIrisEl = null;
    }
    return;
  }
  const el = ensurePendingBubble('iris');
  el.textContent = text;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (finished) {
    finalizePending('iris');
    const t = raw.trim();
    if (t.length >= 3 && window.iris?.appendMemoryTurn) {
      void window.iris.appendMemoryTurn({ role: 'assistant', text: t });
    }
  }
}

function normalizeFunctionCalls(toolCall) {
  if (!toolCall) return [];
  const list = toolCall.functionCalls || toolCall.function_calls;
  return Array.isArray(list) ? list : [];
}

function fcArgs(fc) {
  const raw = fc.args ?? fc.arguments;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function addFileDownloadMessage(
  filename,
  base64,
  mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-iris msg-attachment';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Iris';
  const inner = document.createElement('div');
  inner.className = 'msg-body';
  const a = document.createElement('a');
  a.className = 'file-download-link';
  a.textContent = `Download ${filename}`;
  a.download = filename;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], {
    type: mimeType,
  });
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.addEventListener('click', () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  inner.appendChild(a);
  wrap.append(label, inner);
  els.transcript.appendChild(wrap);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  pushToFocusBarDock({
    id: newDockId(),
    type: 'download',
    filename,
    base64,
    mimeType,
  });
}

function addCalendarEventMessage(title, htmlLink) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-iris msg-calendar';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Iris';
  const inner = document.createElement('div');
  inner.className = 'msg-body';
  const p = document.createElement('p');
  p.textContent = `Calendar event created: ${title || 'Event'}`;
  inner.appendChild(p);
  if (htmlLink) {
    const a = document.createElement('a');
    a.className = 'file-download-link';
    a.href = htmlLink;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'Open in Google Calendar';
    inner.appendChild(a);
  }
  wrap.append(label, inner);
  els.transcript.appendChild(wrap);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (htmlLink) {
    pushToFocusBarDock({
      id: newDockId(),
      type: 'link',
      title: `Calendar: ${title || 'Event'}`,
      url: htmlLink,
      actionLabel: 'Open in Google Calendar',
    });
  }
}

function addMapsLinkMessage(placeLabel, mapsUrl) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-iris msg-maps';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.textContent = 'Iris';
  const inner = document.createElement('div');
  inner.className = 'msg-body';
  const p = document.createElement('p');
  p.textContent = `Google Maps: ${placeLabel || 'Place'}`;
  inner.appendChild(p);
  if (mapsUrl) {
    const a = document.createElement('a');
    a.className = 'file-download-link';
    a.href = mapsUrl;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'Open in Google Maps';
    inner.appendChild(a);
  }
  wrap.append(label, inner);
  els.transcript.appendChild(wrap);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  if (mapsUrl) {
    pushToFocusBarDock({
      id: newDockId(),
      type: 'link',
      title: `Google Maps: ${placeLabel || 'Place'}`,
      url: mapsUrl,
      actionLabel: 'Open in Google Maps',
    });
  }
}

function isPlausibleGoogleEmail(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 5 || t.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}

function getCalendarEmailFromArgsOrComposer(args) {
  const fromArgs = args?.googleAccountEmail ?? args?.google_account_email;
  if (typeof fromArgs === 'string' && isPlausibleGoogleEmail(fromArgs)) return fromArgs.trim();
  if (lastComposerEmail) return lastComposerEmail;
  return '';
}

function appendTypedUserMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-you';
  wrap.innerHTML = '<div class="msg-label">You (typed)</div><div class="msg-body"></div>';
  const body = wrap.querySelector('.msg-body');
  body.textContent = text;
  els.transcript.appendChild(wrap);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function sendTranscriptComposer() {
  const input = els.transcriptComposerInput;
  if (!input || input.disabled || !session?.connected) return;
  const text = input.value.trim();
  if (!text) return;
  submitTypedLineToLive(text);
  input.value = '';
}

function submitTypedLineToLive(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || !session?.connected) return;
  session.sendText(t);
  appendTypedUserMessage(t);
  if (isPlausibleGoogleEmail(t)) {
    lastComposerEmail = t.toLowerCase();
  }
}

function updateTranscriptComposerState() {
  const input = els.transcriptComposerInput;
  if (!input) return;
  const on = !!(session?.connected);
  input.disabled = !on;
  input.placeholder = on
    ? 'Type here and press Enter — sent to Live (e.g. your Google email when Iris asks)'
    : 'Start a session to type messages to Iris…';
}

async function handleLiveToolCall(toolCall) {
  if (!session?.connected) return;
  const calls = normalizeFunctionCalls(toolCall);
  const responses = [];
  const canExport =
    typeof window.iris?.invokeExportScreenFile === 'function' ||
    typeof window.iris?.invokeBuildXlsxFromScreen === 'function';

  for (const fc of calls) {
    const id = fc.id ?? fc.callId ?? '';
    const name = fc.name ?? fc.functionName ?? '';
    const isXlsx = name === 'generate_xlsx_from_screen_chart';
    const isTxt = name === 'generate_txt_from_screen';
    const isCal = name === 'create_google_calendar_event';
    const isMaps = name === 'get_google_maps_link_from_screen';

    if (isCal) {
      const args = fcArgs(fc);
      try {
        if (
          typeof window.iris?.invokeGoogleCalendarCreateEvent !== 'function' ||
          typeof window.iris?.getGoogleCalendarStatus !== 'function'
        ) {
          responses.push({
            id,
            name,
            response: { success: false, userMessage: 'Calendar is not available in this build.' },
          });
          continue;
        }

        const status = await window.iris.getGoogleCalendarStatus();
        if (!status?.configured) {
          responses.push({
            id,
            name,
            response: {
              success: false,
              userMessage:
                'Google Calendar OAuth is not configured on this machine (missing GOOGLE_OAUTH_CLIENT_ID / SECRET in .env).',
            },
          });
          continue;
        }

        const emailRaw = getCalendarEmailFromArgsOrComposer(args);
        if (!emailRaw) {
          responses.push({
            id,
            name,
            response: {
              success: false,
              userMessage:
                'Ask the user for the Google account email for Calendar. They can type it in the conversation box at the bottom of the Conversation panel and press Enter (you will see it as typed text), or say it. Then call this tool again with googleAccountEmail or after they have typed it. Do not invent an email.',
            },
          });
          continue;
        }

        if (!status.connected && typeof window.iris.startGoogleCalendarAuth === 'function') {
          try {
            await window.iris.startGoogleCalendarAuth();
          } catch (authErr) {
            responses.push({
              id,
              name,
              response: {
                success: false,
                userMessage:
                  (authErr?.message || String(authErr)) +
                  ' If Google said the app is not verified: in the browser choose “Advanced”, then continue. While the OAuth app is in Testing, add their Google account under Google Cloud → OAuth consent screen → Test users.',
              },
            });
            continue;
          }
        }

        const after = await window.iris.getGoogleCalendarStatus();
        if (!after?.connected) {
          responses.push({
            id,
            name,
            response: {
              success: false,
              userMessage:
                'Google sign-in did not finish (no token saved). Complete the browser window, use “Advanced” if Google warns about verification, and ensure this Google account is listed as a Test user if the app is in Testing. Then try the calendar request again.',
            },
          });
          continue;
        }

        const r = await window.iris.invokeGoogleCalendarCreateEvent({
          googleAccountEmail: String(emailRaw).trim(),
          summary: args.summary,
          start: args.start,
          end: args.end,
          timeZone: args.timeZone,
          description: args.description,
        });
        if (r?.success) {
          addCalendarEventMessage(r.summary, r.htmlLink);
          responses.push({
            id,
            name,
            response: {
              success: true,
              summary: r.summary,
              htmlLink: r.htmlLink,
            },
          });
        } else {
          responses.push({
            id,
            name,
            response: {
              success: false,
              userMessage: r?.userMessage || r?.error || 'Calendar event failed.',
            },
          });
        }
      } catch (e) {
        responses.push({
          id,
          name,
          response: { success: false, error: e?.message || String(e) },
        });
      }
      continue;
    }

    if (isMaps) {
      const args = fcArgs(fc);
      try {
        if (typeof window.iris?.invokeMapsLinkFromScreen !== 'function') {
          responses.push({
            id,
            name,
            response: { success: false, userMessage: 'Maps link is not available in this build.' },
          });
          continue;
        }
        const img = lastScreenJpegBase64;
        if (!img) {
          responses.push({
            id,
            name,
            response: {
              success: false,
              userMessage: 'Share your screen first so the map or address is visible.',
            },
          });
          continue;
        }
        const userHint = typeof args.userHint === 'string' ? args.userHint.trim() : '';
        const r = await window.iris.invokeMapsLinkFromScreen({
          imageBase64: img,
          userHint,
        });
        addMapsLinkMessage(r.label, r.mapsUrl);
        responses.push({
          id,
          name,
          response: {
            success: true,
            mapsUrl: r.mapsUrl,
            label: r.label,
            query: r.query,
          },
        });
      } catch (e) {
        responses.push({
          id,
          name,
          response: {
            success: false,
            userMessage: e?.message || String(e),
          },
        });
      }
      continue;
    }

    if (!isXlsx && !isTxt) {
      responses.push({
        id,
        name: name || 'unknown',
        response: { success: false, error: 'unknown_tool' },
      });
      continue;
    }
    const args = fcArgs(fc);
    const title = typeof args.title === 'string' ? args.title : '';
    try {
      const img = lastScreenJpegBase64;
      if (!img) {
        responses.push({
          id,
          name,
          response: {
            success: false,
            userMessage: 'Share your screen first so content is visible.',
          },
        });
        continue;
      }
      if (!canExport) {
        responses.push({
          id,
          name,
          response: { success: false, error: 'export_unavailable' },
        });
        continue;
      }
      const format = isTxt ? 'txt' : 'xlsx';
      let r;
      if (typeof window.iris.invokeExportScreenFile === 'function') {
        r = await window.iris.invokeExportScreenFile({ imageBase64: img, title, format });
      } else if (format === 'xlsx') {
        r = await window.iris.invokeBuildXlsxFromScreen({ imageBase64: img, title });
      } else {
        responses.push({
          id,
          name,
          response: { success: false, error: 'export_unavailable' },
        });
        continue;
      }
      const mime =
        format === 'txt'
          ? 'text/plain;charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      addFileDownloadMessage(r.filename, r.base64, mime);
      const summary =
        format === 'xlsx' && r.rowCount != null
          ? `Created ${r.filename} with ${r.rowCount} rows.`
          : `Created ${r.filename}.`;
      responses.push({
        id,
        name,
        response: {
          success: true,
          filename: r.filename,
          ...(format === 'xlsx' && r.rowCount != null ? { rowCount: r.rowCount } : {}),
          summary,
        },
      });
    } catch (e) {
      responses.push({
        id,
        name,
        response: {
          success: false,
          error: e?.message || String(e),
        },
      });
    }
  }
  if (responses.length) {
    session.sendToolResponse(responses);
  }
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
    if (typeof window.iris?.memorySessionEnded === 'function') {
      await window.iris.memorySessionEnded();
    }
  } catch {
    /* ignore */
  }

  try {
    session?.disconnect();
  } catch {
    /* ignore */
  }
  session = null;

  lastComposerEmail = '';
  updateTranscriptComposerState();

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
  lastScreenJpegBase64 = null;
  setObservationGroupDisabled(false);
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

  let memoryProfile = '';
  try {
    const mem = await window.iris?.getMemoryProfile?.();
    memoryProfile = typeof mem?.profileText === 'string' ? mem.profileText : '';
  } catch {
    /* ignore */
  }

  const systemInstruction = withLongTermMemory(
    withObservationMode(DEFAULT_LIVE_SYSTEM_INSTRUCTION, getObservationMode()),
    memoryProfile
  );

  session = new GeminiLiveSession(apiKey, {
    model: MODEL_LIVE_FLASH,
    voiceName: 'Kore',
    systemInstruction,
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

    updateTranscriptComposerState();
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

  session.onToolCall = (tc) => {
    void handleLiveToolCall(tc);
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

els.previewVideo.addEventListener('loadedmetadata', () => {
  pushCaptureMetrics();
  tryMinimizeForWindowShare();
});

if (typeof window.iris?.onApplyFocusGrounding === 'function') {
  window.iris.onApplyFocusGrounding((text) => {
    if (session?.connected && text) session.sendText(text);
  });
}

if (typeof window.iris?.onCaptureFocusRegions === 'function') {
  window.iris.onCaptureFocusRegions((payload) => {
    if (payload?.composite && Array.isArray(payload.regions) && payload.regions.length) {
      captureFocusNormRegions = payload.regions;
    } else {
      captureFocusNormRegions = null;
    }
  });
}

if (typeof window.iris?.onStopScreenShare === 'function') {
  window.iris.onStopScreenShare(() => {
    stopScreenShareOnly();
  });
}

els.btnStart.addEventListener('click', () => startSession());
els.btnStop.addEventListener('click', () => stopAll());
els.btnShareScreen.addEventListener('click', () => void startScreenShare());
els.btnThemeToggle?.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

$('btnWelcomeThemeToggle')?.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

$('btnWelcomeGetStarted')?.addEventListener('click', () => dismissWelcome());
$('btnWelcomeViewDemo')?.addEventListener('click', () => openWelcomeDemoModal());
$('btnWelcomeDemoClose')?.addEventListener('click', () => closeWelcomeDemoModal());
$('btnWelcomeDemoGetStarted')?.addEventListener('click', () => dismissWelcome());

const welcomeDemoModal = $('welcomeDemoModal');
welcomeDemoModal?.addEventListener('click', (ev) => {
  if (ev.target === welcomeDemoModal) closeWelcomeDemoModal();
});

window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const m = $('welcomeDemoModal');
  if (m && !m.classList.contains('hidden')) closeWelcomeDemoModal();
});

window.addEventListener('beforeunload', () => {
  stopAll();
});

function initTranscriptComposer() {
  const input = els.transcriptComposerInput;
  if (!input) return;
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    sendTranscriptComposer();
  });
  updateTranscriptComposerState();
}

if (typeof window.iris?.onFocusBarComposerSubmit === 'function') {
  window.iris.onFocusBarComposerSubmit((text) => {
    submitTypedLineToLive(text);
  });
}

initTheme();
initObservationMode();
initWelcome();
initTranscriptComposer();

setStatus('idle', 'Disconnected');
