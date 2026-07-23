function renderContextBar(inputTokens, tasksDone, tasksTotal) {
  var MAX_CTX = 128000;
  var tokens = inputTokens || 0;
  var pct = Math.min(100, Math.round((tokens / MAX_CTX) * 100));
  var fillClass = tokens > 120000 ? 'ctx-fill ctx-fill-danger'
    : tokens > 100000 ? 'ctx-fill ctx-fill-warn'
    : 'ctx-fill';
  var label = tokens >= 1000 ? Math.round(tokens / 1000) + 'k' : String(tokens);
  var tasksHtml = tasksTotal > 0
    ? '<span class="ctx-tasks">\u{1F4CB} ' + tasksDone + '/' + tasksTotal + '</span>'
    : '';
  return `
    <div class="ctx-row">
      <span>💭</span>
      <div class="ctx-bar-container">
        <div class="ctx-bar">
          <div class="${fillClass}" style="width:${pct}%"></div>
        </div>
      </div>
      <span class="ctx-label">${esc(label)}</span>
      ${tasksHtml}
    </div>
  `;
}

function renderAgentRow(opts) {
  var label = opts.label;
  var model = opts.model;
  var userActivity = opts.userActivity;
  var assistantActivity = opts.assistantActivity;
  var isActive = opts.isActive;
  var dotClass = isActive ? 'agent-dot agent-dot-active' : 'agent-dot agent-dot-idle';
  var modelHtml = model
    ? '<span class="agent-model">\u{1F916} ' + esc(shortModel(model)) + '</span>'
    : '';
  var userHtml = '';
  if (userActivity && userActivity.text) {
    userHtml = '<div class="agent-msg agent-msg-in">\u25B6 ' + esc(truncate(userActivity.text, 80)) + '</div>';
  }
  var assistantHtml = '';
  if (assistantActivity) {
    var actText = assistantActivity.text || assistantActivity.tool;
    if (actText) {
      assistantHtml = '<div class="agent-msg agent-msg-out">\u25C0 ' + esc(truncate(actText, 80)) + '</div>';
    }
  }
  return `
    <div class="agent-row">
      <div class="agent-header">
        <span class="${dotClass}"></span>
        <span class="agent-label">${esc(label)}</span>
        ${modelHtml}
      </div>
      ${userHtml}
      ${assistantHtml}
    </div>
  `;
}

function subagentLabel(agent) {
  return 'Sub: ' + (agent.description || agent.sessionName || agent.slug || agent.agentId);
}

function cardHeaderData(proj, displayName) {
  var state = proj.state || 'stopped';
  var sessionName = typeof proj.sessionName === 'string' && proj.sessionName.trim()
    ? proj.sessionName
    : '';
  return {
    hostname: proj._displayHostname || proj._hostname || proj._backendKey || '',
    projectName: displayName || proj.displayName || proj.projectName,
    sessionName: sessionName,
    state: state,
    stateLabel: stateLabel[state] || state,
  };
}

function crossServerDisplayName(proj, isCrossServerCollision) {
  if (!isCrossServerCollision) return undefined;
  return (proj._displayHostname || proj._hostname || proj._backendKey) + ':' + proj.projectName;
}

function createCard(proj, flashStopped, flashNotification, displayName, key) {
  var card = document.createElement('div');
  var header = cardHeaderData(proj, displayName);
  var s = header.state;
  var isWaitingFlash = s === 'waiting_for_permission' && !flashWaitingDismissed.has(key);
  var isErrorFlash = s === 'error' && !flashErrorDismissed.has(key);
  var flashClasses = isWaitingFlash ? ' card-flashing-waiting'
    : isErrorFlash ? ' card-flashing-error'
    : flashStopped ? ' card-flashing-stopped'
    : flashNotification ? ' card-flashing-notification'
    : '';
  card.className = 'card' + flashClasses;

  if (isWaitingFlash) {
    card.addEventListener('click', function () {
      flashWaitingDismissed.add(key);
      card.classList.remove('card-flashing-waiting');
    });
  }
  if (isErrorFlash) {
    card.addEventListener('click', function () {
      flashErrorDismissed.add(key);
      card.classList.remove('card-flashing-error');
    });
  }

  var badgeClass = stateBadgeClass[s] || 'badge-stopped';
  var dotClass = stateDotClass[s] || 'dot-stopped';
  var label = header.stateLabel;

  var tasksDone = proj.tasksDone || 0;
  var tasksTotal = proj.tasksTotal || 0;
  if (proj.tasks && proj.tasks.length > 0) {
    var nonDeleted = proj.tasks.filter(function (t) { return t.status !== 'deleted'; });
    tasksDone = nonDeleted.filter(function (t) { return t.status === 'completed'; }).length;
    tasksTotal = nonDeleted.length;
  }

  var html = `
    <div class="card-identity">
      <div class="card-header">
        <span class="badge ${badgeClass}">
          <span class="dot ${dotClass}"></span>
          ${esc(label)}
        </span>
        <span class="card-project" title="${esc(header.projectName)}">${esc(header.projectName)}</span>
        <span class="card-host" title="${esc(header.hostname)}">${esc(header.hostname)}</span>
      </div>
      ${header.sessionName ? '<div class="card-session" title="' + esc(header.sessionName) + '">' + esc(header.sessionName) + '</div>' : ''}
    </div>
  `;

  html += renderContextBar(proj.inputTokens || 0, tasksDone, tasksTotal);

  var agentsHtml = renderAgentRow({
    label: 'Main agent',
    model: proj.model,
    userActivity: proj.latestUserActivity,
    assistantActivity: proj.latestAssistantActivity,
    isActive: s === 'running',
  });

  if (proj.subagents && proj.subagents.length > 0) {
    for (var i = 0; i < proj.subagents.length; i++) {
      var agent = proj.subagents[i];
      agentsHtml += renderAgentRow({
        label: subagentLabel(agent),
        model: agent.model,
        userActivity: agent.latestUserActivity,
        assistantActivity: agent.latestAssistantActivity,
        isActive: agent.isActive,
      });
    }
  }

  html += '<div class="card-agents">' + agentsHtml + '</div>';

  card.innerHTML = html;
  return card;
}

var prevState = new Map();
var prevNotificationTimestamp = new Map();
var flashStopped = new Map();
var flashNotification = new Map();
var flashWaitingDismissed = new Set();
var flashErrorDismissed = new Set();

// Removes entries from a Map or Set whose keys no longer appear in currentKeys,
// or that fail an optional predicate(key, value). For Sets the value equals the key.
function pruneStale(collection, currentKeys, predicate) {
  var toDelete = [];
  collection.forEach(function (value, key) {
    var stale = !currentKeys[key];
    if (!stale && predicate) stale = predicate(key, value);
    if (stale) toDelete.push(key);
  });
  for (var i = 0; i < toDelete.length; i++) {
    collection.delete(toDelete[i]);
  }
}

var lastSortOrder = [];
var lastSortTime = 0;

function compareProjectsByRecency(a, b) {
  var ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
  var tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
  if (tb !== ta) return tb - ta;
  return String(a.sessionId || '').localeCompare(String(b.sessionId || ''));
}

function getSortedProjects(projects) {
  var now = Date.now();
  if (now - lastSortTime >= 30000) {
    var sorted = projects.slice().sort(compareProjectsByRecency);
    lastSortOrder = sorted.map(function (p) { return projKey(p); });
    lastSortTime = now;
    return sorted;
  }

  var byKey = new Map();
  for (var i = 0; i < projects.length; i++) {
    byKey.set(projKey(projects[i]), projects[i]);
  }
  var knownKeys = {};
  for (var i = 0; i < lastSortOrder.length; i++) {
    knownKeys[lastSortOrder[i]] = true;
  }
  var known = [];
  for (var i = 0; i < lastSortOrder.length; i++) {
    var k = lastSortOrder[i];
    if (byKey.has(k)) known.push(byKey.get(k));
  }
  var newProjects = [];
  for (var i = 0; i < projects.length; i++) {
    if (!knownKeys[projKey(projects[i])]) newProjects.push(projects[i]);
  }
  var result = known.concat(newProjects).sort(compareProjectsByRecency);
  lastSortOrder = result.map(function (p) { return projKey(p); });
  return result;
}

function render(projects) {
  var grid = document.getElementById('project-grid');
  var all = projects.slice();

  var now = Date.now();
  var flashWindow = 5000;
  for (var i = 0; i < all.length; i++) {
    var proj = all[i];
    var key = projKey(proj);
    var prev = prevState.get(key);
    if (prev === 'running' && proj.state === 'stopped') {
      flashStopped.set(key, now);
    }
    if (prev === 'waiting_for_permission' && proj.state !== 'waiting_for_permission') {
      flashWaitingDismissed.delete(key);
    }
    if (prev === 'error' && proj.state !== 'error') {
      flashErrorDismissed.delete(key);
    }
    prevState.set(key, proj.state);

    var prevTs = prevNotificationTimestamp.get(key);
    var curTs = proj.notificationTimestamp;
    if (prevTs !== undefined && curTs && curTs !== prevTs) {
      flashNotification.set(key, now);
    }
    if (curTs !== undefined) {
      prevNotificationTimestamp.set(key, curTs);
    }
  }

  var currentKeys = {};
  for (var i = 0; i < all.length; i++) {
    currentKeys[projKey(all[i])] = true;
  }

  pruneStale(prevState, currentKeys);
  pruneStale(prevNotificationTimestamp, currentKeys);
  pruneStale(flashStopped, currentKeys, function (_, ts) { return now - ts >= flashWindow; });
  pruneStale(flashNotification, currentKeys, function (_, ts) { return now - ts >= flashWindow; });
  pruneStale(flashWaitingDismissed, currentKeys);
  pruneStale(flashErrorDismissed, currentKeys);

  grid.innerHTML = '';

  if (all.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No active projects';
    grid.appendChild(empty);
    return;
  }

  // Server-side disambiguateProjectNames() owns cross-backend disambiguation within
  // a single ccmon host (claude vs opencode) and its output is consumed verbatim by
  // both the web UI and the CLI. This block is a separate, orthogonal concern: it
  // labels projects whose names collide ACROSS multiple ccmon servers (identified by
  // _backendKey = server hostname). A prefix is added only when the same projectName
  // appears under at least two distinct _backendKey values; within-host collisions
  // are already resolved upstream and need no further treatment here.
  var nameToBackendKeys = new Map();
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    var keySet = nameToBackendKeys.get(p.projectName);
    if (!keySet) { keySet = new Set(); nameToBackendKeys.set(p.projectName, keySet); }
    keySet.add(p._backendKey);
  }

  for (var i = 0; i < all.length; i++) {
    var proj = all[i];
    var key = projKey(proj);
    var crossServerCollision = nameToBackendKeys.get(proj.projectName).size > 1;
    var displayName = crossServerDisplayName(proj, crossServerCollision);
    grid.appendChild(createCard(
      proj,
      flashStopped.has(key),
      flashNotification.has(key),
      displayName,
      key,
    ));
  }
}
