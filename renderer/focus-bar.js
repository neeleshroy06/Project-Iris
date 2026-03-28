document.getElementById('btnAddFocus').addEventListener('click', () => {
  window.irisShell?.send('focus-bar:add-regions');
});

document.getElementById('btnDoneFocus').addEventListener('click', () => {
  window.irisShell?.send('focus-bar:done-drawing');
});
