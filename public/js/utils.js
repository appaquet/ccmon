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

function _relativeTime(iso) {
  if (!iso) return '';
  var diffMs = Date.now() - new Date(iso).getTime();
  var mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

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

function _fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function projKey(p) {
  return p._backendKey + '::' + (p.projectDir || p.projectName);
}
