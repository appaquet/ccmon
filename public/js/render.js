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
  return '\n    <div class="ctx-row">\n      <span>\u{1F4AD}</span>\n      <div class="ctx-bar-container">\n        <div class="ctx-bar">\n          <div class="' + fillClass + '" style="width:' + pct + '%"></div>\n        </div>\n      </div>\n      <span class="ctx-label">' + esc(label) + '</span>\n      ' + tasksHtml + '\n    </div>\n  ';
}

function renderAgentRow(_a) {
  var label = _a.label, model = _a.model, userActivity = _a.userActivity, assistantActivity = _a.assistantActivity, isActive = _a.isActive;
  var dotClass = isActive ? 'agent-dot agent-dot-active' : 'agent-dot agent-dot-idle';
  var modelHtml = model
    ? '<span class="agent-model">\u{1F916} ' + esc(shortModel(model)) + '</span>'
    : '';
  var userHtml = '';
  if (userActivity === null || userActivity === void 0 ? void 0 : userActivity.text) {
    userHtml = '<div class="agent-msg agent-msg-in">\u25B6 ' + esc(truncate(userActivity.text, 80)) + '</div>';
  }
  var assistantHtml = '';
  if (assistantActivity) {
    var actText = assistantActivity.text !== null && assistantActivity.text !== void 0 ? assistantActivity.text : assistantActivity.tool;
    if (actText) {
      assistantHtml = '<div class="agent-msg agent-msg-out">\u25C0 ' + esc(truncate(actText, 80)) + '</div>';
    }
  }
  return '\n    <div class="agent-row">\n      <div class="agent-header">\n        <span class="' + dotClass + '"></span>\n        <span class="agent-label">' + esc(label) + '</span>\n        ' + modelHtml + '\n      </div>\n      ' + userHtml + '\n      ' + assistantHtml + '\n    </div>\n  ';
}

function createCard(proj, _flashStopped, flashNotification, displayName, key) {
  var card = document.createElement('div');
  var s = proj.state || 'stopped';
  var isWaitingFlash = s === 'waiting_for_permission' && !flashWaitingDismissed.has(key);
  var isErrorFlash = s === 'error' && !flashErrorDismissed.has(key);
  var flashClasses = isWaitingFlash ? ' card-flashing-waiting'
    : isErrorFlash ? ' card-flashing-error'
    : _flashStopped ? ' card-flashing-stopped'
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
  var label = stateLabel[s] || s;

  var tasksDone = proj.tasksDone || 0;
  var tasksTotal = proj.tasksTotal || 0;
  if (proj.tasks && proj.tasks.length > 0) {
    var nonDeleted = proj.tasks.filter(function (t) { return t.status !== 'deleted'; });
    tasksDone = nonDeleted.filter(function (t) { return t.status === 'completed'; }).length;
    tasksTotal = nonDeleted.length;
  }

  var cardName = displayName || proj.projectName;
  var sessionSuffix = proj.sessionName
    ? ' <span style="font-weight:normal;color:var(--muted)">(' + esc(proj.sessionName) + ')</span>'
    : '';
  var sourceLabel = (proj.source === "opencode") ? "OC" : "CC";
  var cardTitle = proj.sessionName ? cardName + ' (' + proj.sessionName + ')' : cardName;
  var html = '\n    <div class="card-header">\n      <span class="card-name" title="' + esc(cardTitle) + '">' + esc(cardName) + sessionSuffix + '</span>\n      <div class="card-pills">\n        <span class="badge-source">' + esc(sourceLabel) + '</span>\n        <span class="badge ' + badgeClass + '">\n          <span class="dot ' + dotClass + '"></span>\n          ' + esc(label) + '\n        </span>\n      </div>\n    </div>\n  ';

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
      var agentLabel = 'Sub: ' + (agent.description || agent.slug || agent.agentId);
      agentsHtml += renderAgentRow({
        label: agentLabel,
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

var lastSortOrder = [];
var lastSortTime = 0;

function getSortedProjects(projects) {
  var now = Date.now();
  if (now - lastSortTime >= 30000) {
    var sorted = projects.slice().sort(function (a, b) {
      var ta = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      var tb = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
      return tb - ta;
    });
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
  var result = newProjects.concat(known);
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

  var keysToDelete = [];
  prevState.forEach(function (_, key) {
    if (!currentKeys[key]) keysToDelete.push(key);
  });
  for (var i = 0; i < keysToDelete.length; i++) {
    prevState.delete(keysToDelete[i]);
  }

  keysToDelete = [];
  prevNotificationTimestamp.forEach(function (_, key) {
    if (!currentKeys[key]) keysToDelete.push(key);
  });
  for (var i = 0; i < keysToDelete.length; i++) {
    prevNotificationTimestamp.delete(keysToDelete[i]);
  }

  var entriesToDelete = [];
  flashStopped.forEach(function (ts, key) {
    if (!currentKeys[key] || now - ts >= flashWindow) entriesToDelete.push(key);
  });
  for (var i = 0; i < entriesToDelete.length; i++) {
    flashStopped.delete(entriesToDelete[i]);
  }

  entriesToDelete = [];
  flashNotification.forEach(function (ts, key) {
    if (!currentKeys[key] || now - ts >= flashWindow) entriesToDelete.push(key);
  });
  for (var i = 0; i < entriesToDelete.length; i++) {
    flashNotification.delete(entriesToDelete[i]);
  }

  var waitingToDelete = [];
  flashWaitingDismissed.forEach(function (key) {
    if (!currentKeys[key]) waitingToDelete.push(key);
  });
  for (var i = 0; i < waitingToDelete.length; i++) {
    flashWaitingDismissed.delete(waitingToDelete[i]);
  }

  var errorToDelete = [];
  flashErrorDismissed.forEach(function (key) {
    if (!currentKeys[key]) errorToDelete.push(key);
  });
  for (var i = 0; i < errorToDelete.length; i++) {
    flashErrorDismissed.delete(errorToDelete[i]);
  }

  grid.innerHTML = '';

  if (all.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No active projects';
    grid.appendChild(empty);
    return;
  }

  var nameCounts = new Map();
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    nameCounts.set(p.projectName, (nameCounts.get(p.projectName) || 0) + 1);
  }

  for (var i = 0; i < all.length; i++) {
    var proj = all[i];
    var key = projKey(proj);
    var displayName = nameCounts.get(proj.projectName) > 1
      ? proj._backendKey + ':' + proj.projectName
      : undefined;
    grid.appendChild(createCard(
      proj,
      flashStopped.has(key),
      flashNotification.has(key),
      displayName,
      key,
    ));
  }
}
