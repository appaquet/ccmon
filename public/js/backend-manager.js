var BackendManager = {
  backends: [],

  init: function () {
    this.backends.push(this._createEntry('ws://' + location.host + '/ws'));

    try {
      var saved = JSON.parse(localStorage.getItem('ccmon-backends') || '[]');
      for (var i = 0; i < saved.length; i++) {
        var url = saved[i];
        if (typeof url === 'string' && url !== this.backends[0].url) {
          this.backends.push(this._createEntry(url));
        }
      }
    } catch (_) {}

    for (var i = 0; i < this.backends.length; i++) {
      this._connect(this.backends[i]);
    }
  },

  _createEntry: function (url) {
    return { url: url, ws: null, hostname: null, status: 'connecting', projects: [], backoff: 1000, lastMessageAt: Date.now() };
  },

  _connect: function (entry) {
    entry.status = 'connecting';
    updateStatusPill();
    updateBackendMenu();

    try {
      var ws = new WebSocket(entry.url);
      entry.ws = ws;
      var self = this;

      ws.onopen = function () {
        entry.backoff = 1000;
        entry.status = 'connected';
        entry.projects = [];
        updateStatusPill();
        updateBackendMenu();
      };

      ws.onmessage = function (e) {
        entry.lastMessageAt = Date.now();
        try {
          var data = JSON.parse(e.data);
          if (Array.isArray(data)) {
            entry.projects = data;
          } else {
            if (data.hostname) entry.hostname = data.hostname;
            entry.projects = data.projects || [];
          }
          mergeAndRender();
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onclose = ws.onerror = function () {
        if (entry.ws !== ws) return;
        entry.status = 'disconnected';
        entry.projects = [];
        mergeAndRender();
        updateStatusPill();
        updateBackendMenu();
        var delay = entry.backoff;
        entry.backoff = Math.min(entry.backoff * 2, 30000);
        setTimeout(function () {
          if (self.backends.indexOf(entry) !== -1) {
            self._connect(entry);
          }
        }, delay);
      };
    } catch (err) {
      entry.status = 'disconnected';
      updateStatusPill();
      updateBackendMenu();
    }
  },

  addBackend: function (url) {
    var entry = this._createEntry(url);
    this.backends.push(entry);
    this._saveExtras();
    this._connect(entry);
    updateBackendMenu();
  },

  removeBackend: function (index) {
    if (index === 0) return;
    var entry = this.backends[index];
    if (entry.ws) {
      entry.ws.onclose = entry.ws.onerror = null;
      entry.ws.close();
      entry.ws = null;
    }
    this.backends.splice(index, 1);
    this._saveExtras();
    mergeAndRender();
    updateBackendMenu();
  },

  _saveExtras: function () {
    var urls = [];
    for (var i = 1; i < this.backends.length; i++) {
      urls.push(this.backends[i].url);
    }
    localStorage.setItem('ccmon-backends', JSON.stringify(urls));
  },
};

function mergeAndRender() {
  var merged = [];
  for (var i = 0; i < BackendManager.backends.length; i++) {
    var e = BackendManager.backends[i];
    for (var j = 0; j < e.projects.length; j++) {
      var p = e.projects[j];
      var copy = {};
      for (var k in p) {
        if (Object.prototype.hasOwnProperty.call(p, k)) copy[k] = p[k];
      }
      copy._backendKey = e.hostname || e.url;
      merged.push(copy);
    }
  }
  render(getSortedProjects(merged));
}

function updateStatusPill() {
  var bar = document.getElementById('status-bar');
  var statuses = [];
  for (var i = 0; i < BackendManager.backends.length; i++) {
    statuses.push(BackendManager.backends[i].status);
  }
  var connectedCount = 0;
  for (var i = 0; i < statuses.length; i++) {
    if (statuses[i] === 'connected') connectedCount++;
  }
  var total = statuses.length;

  if (connectedCount === total) {
    bar.textContent = '\u25CF Connected';
    bar.style.color = '#22c55e';
  } else if (connectedCount > 0) {
    bar.textContent = '\u25CF Partial';
    bar.style.color = '#f59e0b';
  } else {
    bar.textContent = '\u27F3 Reconnecting...';
    bar.style.color = '#f97316';
  }
}

function updateBackendMenu() {
  var list = document.getElementById('backend-list');
  list.innerHTML = '';
  BackendManager.backends.forEach(function (entry, index) {
    var row = document.createElement('div');
    row.className = 'backend-row';

    var displayName = entry.hostname || entry.url;
    var showUrl = entry.hostname ? entry.url : null;

    var dotClass = 'status-dot status-dot-' + entry.status;
    var labelClass = 'status-label-' + entry.status;
    var statusText = entry.status === 'connected' ? 'Connected'
      : entry.status === 'connecting' ? 'Connecting...'
      : 'Disconnected';

    row.innerHTML = '\n      <div class="backend-info">\n        <div class="backend-host" title="' + esc(displayName) + '">' + esc(displayName) + '</div>\n        ' + (showUrl ? '<div class="backend-url" title="' + esc(entry.url) + '">' + esc(entry.url) + '</div>' : '') + '\n      </div>\n      <div class="backend-status">\n        <span class="' + dotClass + '"></span>\n        <span class="' + labelClass + '">' + esc(statusText) + '</span>\n      </div>\n      <button class="remove-btn" ' + (index === 0 ? 'disabled' : '') + ' data-index="' + index + '">Remove</button>\n    ';

    row.querySelector('.remove-btn').addEventListener('click', function (e) {
      var idx = parseInt(e.currentTarget.dataset.index, 10);
      BackendManager.removeBackend(idx);
    });

    list.appendChild(row);
  });
}

var menuEl = document.getElementById('backend-menu');

function toggleMenu() {
  menuEl.classList.toggle('open');
  if (menuEl.classList.contains('open')) {
    updateBackendMenu();
  }
}
