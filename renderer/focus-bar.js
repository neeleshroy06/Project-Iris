const btnFocusMode = document.getElementById('btnFocusMode');
const btnStopShare = document.getElementById('btnStopShare');
const btnFocusComposer = document.getElementById('btnFocusComposer');
const focusComposerWrap = document.getElementById('focusComposerWrap');
const focusComposerInput = document.getElementById('focusComposerInput');
const focusInteractions = document.getElementById('focusInteractions');
const focusRoot = document.getElementById('focusRoot');
const obsSilent = document.getElementById('obsModeSilentBar');
const obsAmbient = document.getElementById('obsModeAmbientBar');

let drawing = false;

function notifySize() {
  requestAnimationFrame(() => {
    if (!focusRoot) return;
    const rect = focusRoot.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    window.irisShell?.send?.('focus-bar:resize', { width: w, height: h });
  });
}

function setComposerOpen(open) {
  if (!focusComposerWrap || !focusComposerInput) return;
  if (open) {
    focusComposerWrap.classList.remove('is-hidden');
    focusComposerWrap.setAttribute('aria-hidden', 'false');
    focusComposerInput.focus();
    if (btnFocusComposer) btnFocusComposer.classList.add('btn-done');
  } else {
    focusComposerWrap.classList.add('is-hidden');
    focusComposerWrap.setAttribute('aria-hidden', 'true');
    focusComposerInput.value = '';
    if (btnFocusComposer) btnFocusComposer.classList.remove('btn-done');
  }
  notifySize();
}

function toggleComposer() {
  const open = focusComposerWrap?.classList.contains('is-hidden');
  setComposerOpen(!!open);
}

function submitComposer() {
  const t = focusComposerInput?.value?.trim() ?? '';
  if (!t) {
    setComposerOpen(false);
    return;
  }
  window.irisShell?.send?.('focus-bar:composer-submit', t);
  setComposerOpen(false);
}

function setObservationUi(mode) {
  const m = mode === 'ambient' ? 'ambient' : 'silent';
  if (obsAmbient) obsAmbient.checked = m === 'ambient';
  if (obsSilent) obsSilent.checked = m === 'silent';
}

async function initObservationFromMain() {
  try {
    const r = await window.irisShell?.getObservationMode?.();
    if (r?.mode === 'ambient' || r?.mode === 'silent') setObservationUi(r.mode);
  } catch {
    /* ignore */
  }
  if (typeof window.irisShell?.onObservationMode === 'function') {
    window.irisShell.onObservationMode((payload) => {
      if (payload?.mode === 'ambient' || payload?.mode === 'silent') setObservationUi(payload.mode);
    });
  }
}

function onObservationBarChange() {
  const m = obsAmbient?.checked ? 'ambient' : 'silent';
  window.irisShell?.send?.('focus-bar:set-observation-mode', m);
}

obsSilent?.addEventListener('change', onObservationBarChange);
obsAmbient?.addEventListener('change', onObservationBarChange);

void initObservationFromMain();

function setFocusButtonDrawing(isDrawing) {
  drawing = isDrawing;
  btnFocusMode.textContent = isDrawing ? 'Done' : 'Add focus';
  btnFocusMode.classList.toggle('btn-done', isDrawing);
}

btnFocusMode.addEventListener('click', () => {
  if (!drawing) {
    window.irisShell?.send('focus-bar:add-regions');
    setFocusButtonDrawing(true);
  } else {
    window.irisShell?.send('focus-bar:done-drawing');
    setFocusButtonDrawing(false);
  }
});

btnStopShare.addEventListener('click', () => {
  setFocusButtonDrawing(false);
  window.irisShell?.send('focus-bar:stop-share');
});

btnFocusComposer?.addEventListener('click', () => toggleComposer());

focusComposerInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    submitComposer();
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    setComposerOpen(false);
  }
});

function updateInteractionsVisibility() {
  if (!focusInteractions) return;
  const has = focusInteractions.querySelector('.focus-dock-item');
  focusInteractions.hidden = !has;
  notifySize();
}

function removeDockItemEl(id) {
  const sid = String(id);
  const el = focusInteractions?.querySelector(`[data-dock-id="${sid.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
  el?.remove();
  updateInteractionsVisibility();
}

function attachDismiss(btn, id) {
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    window.irisShell?.send?.('focus-bar:dock-dismiss', id);
    removeDockItemEl(id);
  });
}

function renderDockItem(item) {
  if (!item || typeof item.id !== 'string') return;
  const id = item.id;
  const wrap = document.createElement('div');
  wrap.className = 'focus-dock-item';
  wrap.dataset.dockId = id;

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'focus-dock-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  attachDismiss(dismiss, id);

  const title = document.createElement('div');
  title.className = 'focus-dock-item__title';

  const actions = document.createElement('div');
  actions.className = 'focus-dock-item__actions';

  if (item.type === 'download' && item.base64 && item.filename) {
    title.textContent = `Download · ${item.filename}`;
    const a = document.createElement('a');
    a.className = 'file-download-link';
    a.textContent = `Download ${item.filename}`;
    a.download = item.filename;
    try {
      const mime = typeof item.mimeType === 'string' ? item.mimeType : undefined;
      const bytes = Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.addEventListener('click', () => {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
    } catch {
      title.textContent = 'File (could not prepare download)';
    }
    actions.appendChild(a);
  } else if (item.type === 'link' && item.url) {
    title.textContent = typeof item.title === 'string' ? item.title : 'Link';
    const label =
      typeof item.actionLabel === 'string' && item.actionLabel.trim()
        ? item.actionLabel.trim()
        : 'Open link';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'linkish';
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      void window.irisShell?.openExternal?.(item.url);
    });
    actions.appendChild(b);
  } else {
    return;
  }

  wrap.append(dismiss, title, actions);
  focusInteractions?.appendChild(wrap);
  updateInteractionsVisibility();
}

function clearDock() {
  if (!focusInteractions) return;
  focusInteractions.innerHTML = '';
  focusInteractions.hidden = true;
  notifySize();
}

function syncDockFromMain(items) {
  clearDock();
  if (!Array.isArray(items)) return;
  for (const it of items) {
    renderDockItem(it);
  }
}

async function initDock() {
  window.irisShell?.onDockSync?.((items) => syncDockFromMain(items));
  window.irisShell?.onDockPush?.((item) => renderDockItem(item));
  window.irisShell?.onDockClear?.(() => {
    clearDock();
    setComposerOpen(false);
  });
  try {
    const snap = await window.irisShell?.getDockSnapshot?.();
    if (snap?.items?.length) syncDockFromMain(snap.items);
  } catch {
    /* ignore */
  }
}

void initDock();

if (typeof ResizeObserver !== 'undefined' && focusRoot) {
  const ro = new ResizeObserver(() => notifySize());
  ro.observe(focusRoot);
}

window.addEventListener('load', () => notifySize());
