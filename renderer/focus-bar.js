const btnFocusMode = document.getElementById('btnFocusMode');
const btnStopShare = document.getElementById('btnStopShare');
const obsSilent = document.getElementById('obsModeSilentBar');
const obsAmbient = document.getElementById('obsModeAmbientBar');

let drawing = false;

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
