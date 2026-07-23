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
          updateBackendMenu();
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

  reconnect: function (entry) {
    if (entry.ws) {
      entry.ws.onclose = entry.ws.onerror = null;
      entry.ws.close();
    }
    this._connect(entry);
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
  var displayHostnames = configuredHostnameDisplayMap(BackendManager.backends);
  for (var i = 0; i < BackendManager.backends.length; i++) {
    var e = BackendManager.backends[i];
    merged = merged.concat(mergeBackendProjects(e, displayHostnames));
  }
  render(getSortedProjects(merged));
}

function configuredHostnameDisplayMap(entries) {
  var hostnames = [];
  for (var i = 0; i < entries.length; i++) {
    hostnames.push(backendHostname(entries[i]));
  }
  return hostnameDisplayMap(hostnames);
}

function mergeBackendProjects(entry, displayHostnames) {
  var hostname = backendHostname(entry);
  var displayHostname = displayHostnames
    ? displayHostnames.get(hostname)
    : hostnameDisplayMap([hostname]).get(hostname);
  var projects = [];
  var i;
  var project;
  var copy;
  var key;
  for (i = 0; i < entry.projects.length; i++) {
    project = entry.projects[i];
    copy = {};
    for (key in project) {
      if (Object.prototype.hasOwnProperty.call(project, key)) copy[key] = project[key];
    }
    copy._backendKey = hostname;
    copy._displayHostname = displayHostname;
    copy._hostname = hostname;
    projects.push(copy);
  }
  return projects;
}

function backendHostname(entry) {
  return entry.hostname || entry.url;
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
  var displayHostnames = configuredHostnameDisplayMap(BackendManager.backends);
  list.innerHTML = '';
  BackendManager.backends.forEach(function (entry, index) {
    var row = document.createElement('div');
    row.className = 'backend-row';

    var hostname = backendHostname(entry);
    var displayName = displayHostnames.get(hostname);
    var showUrl = entry.hostname ? entry.url : null;

    var dotClass = 'status-dot status-dot-' + entry.status;
    var labelClass = 'status-label-' + entry.status;
    var statusText = entry.status === 'connected' ? 'Connected'
      : entry.status === 'connecting' ? 'Connecting...'
      : 'Disconnected';

    row.innerHTML = `
      <div class="backend-info">
        <div class="backend-host" title="${esc(displayName)}">${esc(displayName)}</div>
        ${showUrl ? '<div class="backend-url" title="' + esc(entry.url) + '">' + esc(entry.url) + '</div>' : ''}
      </div>
      <div class="backend-status">
        <span class="${dotClass}"></span>
        <span class="${labelClass}">${esc(statusText)}</span>
      </div>
      <button class="remove-btn" ${index === 0 ? 'disabled' : ''} data-index="${index}">Remove</button>
    `;

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
