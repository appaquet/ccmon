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

function projKey(p) {
  var dir = p.source === 'claude' ? p.projectDir
    : p.source === 'opencode' ? p.sessionId
    : null;
  return p._backendKey + '::' + (dir || p.projectName);
}
