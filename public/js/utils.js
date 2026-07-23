var stateLabel = {
  running: 'Running',
  stopped: 'Stopped',
  waiting_for_permission: 'Waiting',
  error: 'Error',
  closed: 'Closed',
};

var stateBadgeClass = {
  running: 'badge-running',
  stopped: 'badge-stopped',
  waiting_for_permission: 'badge-waiting',
  error: 'badge-waiting',
  closed: 'badge-closed',
};

var stateDotClass = {
  running: 'dot-running',
  stopped: 'dot-stopped',
  waiting_for_permission: 'dot-waiting',
  error: 'dot-waiting',
  closed: 'dot-closed',
};

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '\u2026' : str;
}

function shortModel(model) {
  if (!model) return '';
  var m = model.toLowerCase();
  if (m.indexOf('opus') !== -1)   return 'Opus';
  if (m.indexOf('sonnet') !== -1) return 'Sonnet';
  if (m.indexOf('haiku') !== -1)  return 'Haiku';
  return model;
}

function shortHostname(hostname) {
  if (typeof hostname !== 'string') return hostname;
  var withoutTrailingDot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (!/\.local$/i.test(withoutTrailingDot) || !isDnsHostname(withoutTrailingDot)) {
    return hostname;
  }
  return withoutTrailingDot.slice(0, -'.local'.length);
}

function hostnameDisplayMap(hostnames) {
  var rawHostsByDisplay = new Map();
  var rawHosts = new Set();
  var i;

  for (i = 0; i < hostnames.length; i++) {
    var rawHostname = hostnames[i];
    if (typeof rawHostname !== 'string') continue;
    rawHosts.add(rawHostname);
    var displayHostname = shortHostname(rawHostname);
    var matchingRawHosts = rawHostsByDisplay.get(displayHostname);
    if (!matchingRawHosts) {
      matchingRawHosts = new Set();
      rawHostsByDisplay.set(displayHostname, matchingRawHosts);
    }
    matchingRawHosts.add(rawHostname);
  }

  var displayHostnames = new Map();
  rawHosts.forEach(function (rawHostname) {
    var displayHostname = shortHostname(rawHostname);
    displayHostnames.set(
      rawHostname,
      rawHostsByDisplay.get(displayHostname).size > 1 ? rawHostname : displayHostname,
    );
  });
  return displayHostnames;
}

function projKey(p) {
  var dir = p.source === 'claude' ? p.projectDir
    : p.source === 'opencode' ? p.sessionId
    : null;
  return p._backendKey + '::' + (dir || p.projectName);
}

function isDnsHostname(hostname) {
  if (hostname.length > 253) return false;
  var labels = hostname.split('.');
  if (labels.length < 2) return false;
  for (var i = 0; i < labels.length; i++) {
    if (labels[i].length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(labels[i])) {
      return false;
    }
  }
  return true;
}
