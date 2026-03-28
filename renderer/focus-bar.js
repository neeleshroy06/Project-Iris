const btnFocusMode = document.getElementById('btnFocusMode');
const btnStopShare = document.getElementById('btnStopShare');

let drawing = false;

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
