document.getElementById('status-bar').addEventListener('click', function (e) {
  e.stopPropagation();
  toggleMenu();
});

document.getElementById('settings-btn').addEventListener('click', function (e) {
  e.stopPropagation();
  toggleMenu();
});

document.addEventListener('click', function (e) {
  if (menuEl.classList.contains('open') && !menuEl.contains(e.target)) {
    menuEl.classList.remove('open');
  }
});

document.getElementById('add-server-btn').addEventListener('click', function () {
  var input = document.getElementById('add-server-input');
  var errorEl = document.getElementById('add-server-error');
  var url = input.value.trim();

  if (!url.match(/^wss?:\/\/.+/)) {
    errorEl.textContent = 'URL must start with ws:// or wss://';
    errorEl.style.display = 'block';
    return;
  }

  errorEl.style.display = 'none';
  input.value = '';
  BackendManager.addBackend(url);
});

document.getElementById('add-server-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') {
    document.getElementById('add-server-btn').click();
  }
});

BackendManager.init();

setInterval(function () {
  var now = Date.now();
  for (var i = 0; i < BackendManager.backends.length; i++) {
    var entry = BackendManager.backends[i];
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN && now - entry.lastMessageAt > 60000) {
      entry.ws.onclose = entry.ws.onerror = null;
      entry.ws.close();
      BackendManager._connect(entry);
    }
  }
  mergeAndRender();
}, 5000);

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  for (var i = 0; i < BackendManager.backends.length; i++) {
    var entry = BackendManager.backends[i];
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.onclose = entry.ws.onerror = null;
      entry.ws.close();
    }
    BackendManager._connect(entry);
  }
});
