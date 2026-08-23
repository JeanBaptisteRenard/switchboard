// --- Sidebar rendering ---
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// visibleSessionCount, sessionMaxAgeDays, attentionSessions, responseReadySessions,
// sessionBusyState, cachedProjects, cachedAllProjects, gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml (utils.js), ICONS (icons.js),
// showSession (terminal-manager.js), confirmAndStopSession, pollActiveSessions,
// showNewSessionPopover, openSettingsViewer, showResumeSessionDialog,
// showJsonlViewer, forkSession, openSession, loadProjects (app.js/dialogs.js)

function slugId(slug) {
  return 'slug-' + slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function folderId(projectPath) {
  return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// --- Subagent localStorage helpers ---

// One-time GC: prune sessionIds that no longer exist in sessionMap.
// Runs once per page load (lazily on first read) to keep the stored set
// from growing indefinitely across long-lived Switchboard instances.
let _expandedSubagentsGCDone = false;
function _gcExpandedSubagentsOnce() {
  if (_expandedSubagentsGCDone) return;
  _expandedSubagentsGCDone = true;
  try {
    const raw = new Set(JSON.parse(localStorage.getItem('expandedSubagents') || '[]'));
    const pruned = new Set([...raw].filter(id => sessionMap.has(id)));
    if (pruned.size !== raw.size) {
      localStorage.setItem('expandedSubagents', JSON.stringify([...pruned]));
    }
  } catch {} // eslint: allowEmptyCatch
}

function getExpandedSubagents() {
  _gcExpandedSubagentsOnce();
  try {
    return new Set(JSON.parse(localStorage.getItem('expandedSubagents') || '[]'));
  } catch (e) { return new Set(); }
}

function saveExpandedSubagents(set) {
  try {
    localStorage.setItem('expandedSubagents', JSON.stringify([...set]));
  } catch (e) {}
}

// Subagent type → accent color (background / border)
const SUBAGENT_TYPE_COLORS = {
  explore:   { bg: 'rgba(62,207,130,0.18)',  border: '#3ecf82' },
  plan:      { bg: 'rgba(128,136,255,0.20)', border: '#8088ff' },
  implement: { bg: 'rgba(255,170,64,0.18)',  border: '#ffaa40' },
  review:    { bg: 'rgba(96,190,240,0.18)',  border: '#60bef0' },
  test:      { bg: 'rgba(255,100,100,0.18)', border: '#ff6464' },
  default:   { bg: 'rgba(160,160,180,0.15)', border: '#a0a0b4' },
};

function subagentTypeColor(type) {
  const key = (type || '').toLowerCase();
  return SUBAGENT_TYPE_COLORS[key] || SUBAGENT_TYPE_COLORS.default;
}

// --- Live subagent tracking — see .ai/contexts/subagent-observability.md ---
// parentSessionId → Map<agentId, lastSeenAtMs>. A spawn — real or _bootstrap —
// adds an agent; a _heartbeat only refreshes one already tracked. The TTL below
// then evicts agents that went silent without evicting one that merely runs
// longer than a minute.
const activeSubagentsByParent = new Map();
const SUBAGENT_LIVE_TTL_MS = 60000;

function isSubagentActive(parentSessionId, agentId) {
  const map = activeSubagentsByParent.get(parentSessionId);
  return !!map && map.has(agentId);
}

function parentHasActiveSubagent(parentSessionId) {
  const map = activeSubagentsByParent.get(parentSessionId);
  return !!map && map.size > 0;
}

function pruneStaleSubagents() {
  const cutoff = Date.now() - SUBAGENT_LIVE_TTL_MS;
  for (const [parentId, map] of activeSubagentsByParent) {
    for (const [agentId, lastSeenAt] of map) {
      if (lastSeenAt < cutoff) map.delete(agentId);
    }
    if (map.size === 0) activeSubagentsByParent.delete(parentId);
  }
  if (window.ATRACE) window.atrace('subagents.prune', null, { map: 'activeSubagentsByParent', cutoff, parents: activeSubagentsByParent.size, agents: [...activeSubagentsByParent.values()].reduce((n, m) => n + m.size, 0), fn: 'pruneStaleSubagents' });
}

// Drop all live-subagent state for a parent whose PTY just stopped, and sync
// the DOM immediately. Called from app.js's updateRunningIndicators():
// stop-session kills the PTY without emitting subagent-completed, and
// detectSubagentTransitions skips exited sessions, so no completion event
// will ever arrive — without this the parent's has-busy-agents indicator
// (and the children's .running) would linger until the TTL prune.
function clearActiveSubagentsFor(parentSessionId) {
  const map = activeSubagentsByParent.get(parentSessionId);
  if (!map) return;
  const agentIds = [...map.keys()];
  if (window.ATRACE) window.atrace('store.mutate', parentSessionId, { map: 'activeSubagentsByParent', op: 'delete-parent', from: map.size, to: 0, agentIds, fn: 'clearActiveSubagentsFor' });
  activeSubagentsByParent.delete(parentSessionId);
  for (const agentId of agentIds) {
    reflectSubagentRunningState(parentSessionId, agentId);
  }
}

function caretIdFor(parentSessionId) {
  return 'sub-caret-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function subagentDomId(parentSessionId, agentId) {
  return 'si-sub:' + parentSessionId + ':' + agentId;
}

function reflectSubagentRunningState(parentSessionId, agentId) {
  const running = isSubagentActive(parentSessionId, agentId);
  const el = document.getElementById(subagentDomId(parentSessionId, agentId));
  if (el) {
    el.classList.toggle('running', running);
    const dot = el.querySelector('.session-status-dot');
    if (dot) dot.classList.toggle('running', running);
  }
  const caret = document.getElementById(caretIdFor(parentSessionId));
  if (caret) caret.classList.toggle('has-running-child', parentHasActiveSubagent(parentSessionId));
  // Parent session item: "subagents are working under this session" indicator.
  // Unlike the caret badge, the parent item is always visible, so this shows
  // whether the subagent group is expanded or collapsed. CSS gives the
  // session's own states (needs-attention, response-ready, cli-busy)
  // precedence over it.
  const parentEl = document.getElementById('si-' + parentSessionId);
  if (parentEl) parentEl.classList.toggle('has-busy-agents', parentHasActiveSubagent(parentSessionId));
  if (window.ATRACE) window.atrace('class.subagent', parentSessionId, { agentId, running, childEl: el ? el.id : null, caretEl: caret ? caret.id : null, parentEl: parentEl ? parentEl.id : null, 'has-busy-agents': parentHasActiveSubagent(parentSessionId), fn: 'reflectSubagentRunningState' });
}

(function initSubagentLiveListeners() {
  if (!window.api) return; // guard for test/non-Electron contexts without preload

  if (typeof window.api.onSubagentSpawned === 'function') {
    window.api.onSubagentSpawned((payload) => {
      const { parentSessionId, agentId, _heartbeat } = payload || {};
      if (!parentSessionId || !agentId) return;
      let map = activeSubagentsByParent.get(parentSessionId);
      // A heartbeat means "still alive", never "started": it must not create
      // an entry for an agent we are not tracking.
      if (_heartbeat && !(map && map.has(agentId))) {
        if (window.ATRACE) window.atrace('recv.subagent-spawned', parentSessionId, { map: 'activeSubagentsByParent', op: 'ignore', agentId, heartbeat: true, applied: false, reason: 'heartbeat-for-untracked-agent', fn: 'onSubagentSpawned' });
        return;
      }
      if (!map) {
        map = new Map();
        activeSubagentsByParent.set(parentSessionId, map);
      }
      if (window.ATRACE) window.atrace('recv.subagent-spawned', parentSessionId, { map: 'activeSubagentsByParent', op: 'set', agentId, from: map.get(agentId) ?? null, applied: true, bootstrap: !!payload._bootstrap, heartbeat: !!_heartbeat, fn: 'onSubagentSpawned' });
      map.set(agentId, Date.now());
      reflectSubagentRunningState(parentSessionId, agentId);
    });
  }

  if (typeof window.api.onSubagentCompleted === 'function') {
    window.api.onSubagentCompleted((payload) => {
      const { parentSessionId, agentId } = payload || {};
      if (!parentSessionId || !agentId) return;
      const map = activeSubagentsByParent.get(parentSessionId);
      if (window.ATRACE) window.atrace('recv.subagent-completed', parentSessionId, { map: 'activeSubagentsByParent', op: 'delete', agentId, from: map ? (map.get(agentId) ?? null) : null, to: null, fn: 'onSubagentCompleted' });
      if (map) {
        map.delete(agentId);
        if (map.size === 0) activeSubagentsByParent.delete(parentSessionId);
      }
      reflectSubagentRunningState(parentSessionId, agentId);
    });
  }
})();

function buildSubagentItem(session) {
  const item = document.createElement('div');
  item.className = 'sidebar-subagent session-item js-stateful';
  item.id = 'si-' + session.sessionId;
  const isRunning = isSubagentActive(session.parentSessionId, session.agentId);
  if (isRunning) item.classList.add('running');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  if (window.ATRACE) window.atrace('class.render', session.sessionId, { el: item.id, cls: item.className, parent: session.parentSessionId || null, agentId: session.agentId || null, fn: 'buildSubagentItem' });
  item.dataset.sessionId = session.sessionId;
  item.dataset.subagent = '1';

  const { bg, border } = subagentTypeColor(session.subagentType);
  item.style.borderLeftColor = border;

  const row = document.createElement('div');
  row.className = 'session-row';

  const typePill = document.createElement('span');
  typePill.className = 'sidebar-subagent-type';
  typePill.textContent = session.subagentType || 'sub';
  typePill.style.background = bg;
  typePill.style.borderColor = border;

  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (isRunning ? ' running' : '');

  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = session.description || session.summary || session.aiTitle || session.sessionId;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = session.messageCount ? session.messageCount + ' msgs' : '';

  info.appendChild(summaryEl);
  info.appendChild(metaEl);

  row.appendChild(typePill);
  row.appendChild(dot);
  row.appendChild(info);
  item.appendChild(row);

  return item;
}

// Shared by buildSessionsList and buildSlugGroup — see .ai/contexts/subagent-observability.md
function appendSubagentChildren(parentEl, parentSessionId, subagentIndex) {
  const children = subagentIndex && subagentIndex.get(parentSessionId);
  if (!children || children.length === 0) return;

  const expandedSet = getExpandedSubagents();
  const caretId = caretIdFor(parentSessionId);
  const isExpanded = expandedSet.has(parentSessionId);

  const caret = document.createElement('div');
  caret.className = 'sidebar-children-caret js-stateful';
  caret.id = caretId;
  if (isExpanded) caret.classList.add('expanded');
  if (parentHasActiveSubagent(parentSessionId)) caret.classList.add('has-running-child');
  caret.innerHTML = `<span class="caret-arrow">&#9654;</span> ${children.length} subagent${children.length !== 1 ? 's' : ''}<span class="caret-running-dot"></span>`;

  const childrenContainer = document.createElement('div');
  childrenContainer.className = 'sidebar-subagents-container js-stateful';
  childrenContainer.id = 'subc-' + parentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  childrenContainer.style.display = isExpanded ? '' : 'none';

  for (const child of children) {
    childrenContainer.appendChild(buildSubagentItem(child));
  }

  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = childrenContainer.style.display !== 'none';
    childrenContainer.style.display = open ? 'none' : '';
    caret.classList.toggle('expanded', !open);
    const set = getExpandedSubagents();
    if (open) { set.delete(parentSessionId); } else { set.add(parentSessionId); }
    saveExpandedSubagents(set);
  });

  parentEl.after(caret);
  caret.after(childrenContainer);
}

// See .ai/contexts/subagent-observability.md (slug-group orphan-detection fix)
function collectTopLevelSessionIds(el) {
  const ids = [];
  if (el.dataset && el.dataset.sessionId && !el.dataset.subagent) ids.push(el.dataset.sessionId);
  el.querySelectorAll('[data-session-id]').forEach((child) => {
    if (!child.dataset.subagent) ids.push(child.dataset.sessionId);
  });
  return ids;
}

function buildSlugGroup(slug, sessions, subagentIndex) {
  const group = document.createElement('div');
  const id = slugId(slug);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group js-stateful' : 'slug-group collapsed js-stateful';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified) > new Date(a.modified) ? b : a);
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug);
  const mostRecentTime = new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive all sessions in group';
  archiveSlugBtn.innerHTML = ICONS.archive(14);

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      const sessionEl = buildSessionItem(session);
      sessionsContainer.appendChild(sessionEl);
      appendSubagentChildren(sessionEl, session.sessionId, subagentIndex);
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more js-stateful';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older js-stateful';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        const sessionEl = buildSessionItem(session);
        olderDiv.appendChild(sessionEl);
        appendSubagentChildren(sessionEl, session.sessionId, subagentIndex);
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      const sessionEl = buildSessionItem(session);
      sessionsContainer.appendChild(sessionEl);
      appendSubagentChildren(sessionEl, session.sessionId, subagentIndex);
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

function renderProjects(projects, resort) {
  pruneStaleSubagents();
  const newSidebar = document.createElement('div');

  // Sort project groups using sortedOrder as source of truth
  if (!resort && sortedOrder.length > 0) {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects = [...projects].sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }
  // projects are now in the correct order (data order for resort, preserved order otherwise)

  // Detect worktree projects and group them under their parent
  const worktreePattern = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;
  const worktreeMap = new Map(); // parentPath → [worktreeProject, ...]
  const worktreeSet = new Set();
  for (const project of projects) {
    const match = project.projectPath.match(worktreePattern);
    if (match) {
      const parentPath = match[1];
      if (!worktreeMap.has(parentPath)) worktreeMap.set(parentPath, []);
      worktreeMap.get(parentPath).push(project);
      worktreeSet.add(project.projectPath);
    }
  }

  const newSortedOrder = [];

  // Build subagent child index from all sessions in this project: parentSessionId → [sessions]
  function buildSubagentIndex(sessions) {
    const index = new Map();
    for (const s of sessions) {
      if (s.parentSessionId) {
        if (!index.has(s.parentSessionId)) index.set(s.parentSessionId, []);
        index.get(s.parentSessionId).push(s);
      }
    }
    return index;
  }

  // Process a project's sessions: filter, sort, slug-group, order, and truncate.
  // Returns { filtered, visible, older, sortOrderEntry } or null if project should be skipped.
  function processProjectSessions(project, resort) {
    // Separate subagents from top-level sessions
    const allSessions = project.sessions;
    const subagentIndex = buildSubagentIndex(allSessions);
    let filtered = allSessions.filter(s => !s.parentSessionId);
    if (showStarredOnly) filtered = filtered.filter(s => s.starred);
    if (showRunningOnly) filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
    if (showTodayOnly) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = filtered.filter(s => {
        if (!s.modified) return false;
        const d = new Date(s.modified);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || searchMatchIds !== null;
    // see .ai/contexts/subagent-observability.md
    const keepForOrphanSubagents = !anyFilterActive && subagentIndex.size > 0;
    if (filtered.length === 0 && !project._projectMatchedOnly && !keepForOrphanSubagents && (project.sessions.length > 0 || anyFilterActive)) return null;

    // Sort
    filtered = [...filtered].sort((a, b) => {
      const aRunning = activePtyIds.has(a.sessionId) || pendingSessions.has(a.sessionId);
      const bRunning = activePtyIds.has(b.sessionId) || pendingSessions.has(b.sessionId);
      const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
      const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return new Date(b.modified) - new Date(a.modified);
    });

    // Slug grouping
    const slugMap = new Map();
    const ungrouped = [];
    for (const session of filtered) {
      if (session.slug) {
        if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
        slugMap.get(session.slug).push(session);
      } else {
        ungrouped.push(session);
      }
    }
    const allItems = [];
    for (const session of ungrouped) {
      const isRunning = activePtyIds.has(session.sessionId) || pendingSessions.has(session.sessionId);
      allItems.push({ sortTime: new Date(session.modified).getTime(), pinned: !!session.starred, running: isRunning, element: buildSessionItem(session) });
    }
    for (const [slug, sessions] of slugMap) {
      const mostRecentTime = Math.max(...sessions.map(s => new Date(s.modified).getTime()));
      const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId) || pendingSessions.has(s.sessionId));
      const hasPinned = sessions.some(s => s.starred);
      const element = sessions.length === 1 ? buildSessionItem(sessions[0]) : buildSlugGroup(slug, sessions, subagentIndex);
      allItems.push({ sortTime: mostRecentTime, pinned: hasPinned, running: hasRunning, element });
    }

    // Sort render items
    const prevEntry = sortedOrder.find(e => e.projectPath === project.projectPath);
    if (resort || !prevEntry) {
      allItems.sort((a, b) => {
        const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
        const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
        if (aPri !== bPri) return bPri - aPri;
        return b.sortTime - a.sortTime;
      });
    } else {
      const orderIndex = new Map(prevEntry.itemIds.map((id, i) => [id, i]));
      allItems.sort((a, b) => {
        const aPos = orderIndex.get(a.element.id);
        const bPos = orderIndex.get(b.element.id);
        if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
        if (aPos === undefined && bPos !== undefined) return -1;
        if (aPos !== undefined && bPos === undefined) return 1;
        return b.sortTime - a.sortTime;
      });
    }

    // Truncate
    let visible = [];
    let older = [];
    if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
      visible = allItems;
    } else {
      let count = 0;
      const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
      for (const item of allItems) {
        if (item.running || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
          visible.push(item);
          count++;
        } else {
          older.push(item);
        }
      }
      if (visible.length === 0 && older.length > 0) { visible = older; older = []; }
    }

    return {
      filtered, visible, older, subagentIndex,
      sortOrderEntry: { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) },
    };
  }

  // Build the sessions list DOM (shared between projects and worktrees)
  function buildSessionsList(fId, visible, older, subagentIndex, projectPath) {
    const sessionsList = document.createElement('div');
    sessionsList.className = 'project-sessions';
    sessionsList.id = 'sessions-' + fId;
    for (const item of visible) {
      sessionsList.appendChild(item.element);
      // Attach subagent children for top-level sessions
      const sid = item.element.dataset && item.element.dataset.sessionId;
      if (sid) appendSubagentChildren(item.element, sid, subagentIndex);
    }
    if (older.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'sessions-more-toggle js-stateful';
      moreBtn.id = 'older-' + fId;
      moreBtn.textContent = `+ ${older.length} older`;
      const olderList = document.createElement('div');
      olderList.className = 'sessions-older js-stateful';
      olderList.id = 'older-list-' + fId;
      olderList.style.display = 'none';
      for (const item of older) {
        olderList.appendChild(item.element);
        const sid = item.element.dataset && item.element.dataset.sessionId;
        if (sid) appendSubagentChildren(item.element, sid, subagentIndex);
      }
      sessionsList.appendChild(moreBtn);
      sessionsList.appendChild(olderList);
    }

    // Orphan subagents: children whose parentSessionId has no top-level session in this project.
    // See .ai/contexts/subagent-observability.md for why collectTopLevelSessionIds is needed here.
    if (subagentIndex) {
      const allTopLevelIds = new Set([...visible, ...older].flatMap(i => collectTopLevelSessionIds(i.element)));
      const orphans = [];
      for (const [parentId, kids] of subagentIndex) {
        if (!allTopLevelIds.has(parentId)) {
          for (const k of kids) orphans.push(k);
        }
      }
      if (orphans.length > 0) {
        // Persist expand/collapse per project. Default = collapsed: this
        // section is rarely the user's focus and can grow long on long-lived
        // projects (this very session has 1300+ orphan subagents).
        const orphanStateKey = 'orphanExpanded:' + projectPath;
        const expanded = localStorage.getItem(orphanStateKey) === '1';

        const orphanGroup = document.createElement('div');
        orphanGroup.className = 'sidebar-orphan-subagents' + (expanded ? '' : ' collapsed');
        // Stable id so morphdom reconciles the element instead of rebuilding
        // it from scratch on every render, preventing minor flicker.
        orphanGroup.id = 'orphan-' + fId;

        const orphanLabel = document.createElement('div');
        orphanLabel.className = 'sidebar-orphan-label';
        orphanLabel.innerHTML = `<span class="orphan-caret">&#9656;</span> Orphan subagents <span class="orphan-count">${orphans.length}</span>`;
        orphanLabel.addEventListener('click', () => {
          const isCollapsed = orphanGroup.classList.toggle('collapsed');
          localStorage.setItem(orphanStateKey, isCollapsed ? '0' : '1');
        });
        orphanGroup.appendChild(orphanLabel);

        for (const orphan of orphans) {
          orphanGroup.appendChild(buildSubagentItem(orphan));
        }
        sessionsList.appendChild(orphanGroup);
      }
    }

    return sessionsList;
  }

  for (const project of projects) {
    // Skip worktree projects — they'll be rendered nested under their parent
    if (worktreeSet.has(project.projectPath)) continue;

    const result = processProjectSessions(project, resort);
    if (!result) continue;
    const { filtered, visible, older, subagentIndex, sortOrderEntry } = result;
    newSortedOrder.push(sortOrderEntry);
    const fId = folderId(project.projectPath);

    // Build DOM
    const group = document.createElement('div');
    group.className = 'project-group' + (project.missing ? ' missing' : '');
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header js-stateful';
    header.id = 'ph-' + fId;
    // shortProjectPath() is upstream's shared helper (utils.js); escapeHtml stays
    // because this is innerHTML — upstream's variant interpolates the raw path.
    const shortName = shortProjectPath(project.projectPath);
    const missingIcon = project.missing ? '<svg class="project-missing-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ' : '';
    header.innerHTML = `<span class="arrow">&#9660;</span> ${missingIcon}<span class="project-name">${escapeHtml(shortName)}</span>`;

    const scheduleBtn = document.createElement('button');
    scheduleBtn.className = 'project-schedule-btn';
    scheduleBtn.title = 'Create scheduled task';
    scheduleBtn.innerHTML = ICONS.schedule(16);
    header.appendChild(scheduleBtn);

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'project-settings-btn';
    settingsBtn.title = 'Project settings';
    settingsBtn.innerHTML = ICONS.gear(16);
    header.appendChild(settingsBtn);

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = 'Archive all sessions';
    archiveGroupBtn.innerHTML = ICONS.archive(18);
    header.appendChild(archiveGroupBtn);

    if (project.missing) {
      const remapBtn = document.createElement('button');
      remapBtn.className = 'project-remap-btn';
      remapBtn.title = 'Change project path';
      remapBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
      header.appendChild(remapBtn);
    }

    const newBtn = document.createElement('button');
    newBtn.className = 'project-new-btn';
    newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
    newBtn.title = 'New session';
    header.appendChild(newBtn);

    const sessionsList = buildSessionsList(fId, visible, older, subagentIndex, project.projectPath);

    // Auto-collapse if project path is missing, most recent session is older than threshold, or project matched with no sessions
    if (project.missing) {
      header.classList.add('collapsed');
    } else if (project._projectMatchedOnly) {
      header.classList.add('collapsed');
    } else if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
        header.classList.add('collapsed');
      }
    }

    group.appendChild(header);
    group.appendChild(sessionsList);

    // Render nested worktree sub-groups
    const childWorktrees = worktreeMap.get(project.projectPath) || [];
    for (const wt of childWorktrees) {
      const wtResult = processProjectSessions(wt, resort);
      if (!wtResult) continue;
      newSortedOrder.push(wtResult.sortOrderEntry);

      const wtName = wt.projectPath.match(worktreePattern)?.[2] || wt.projectPath.split('/').pop();
      const wtFId = folderId(wt.projectPath);

      const wtGroup = document.createElement('div');
      wtGroup.className = 'worktree-group';
      wtGroup.id = wtFId;

      const wtHeader = document.createElement('div');
      wtHeader.className = 'worktree-header js-stateful';
      wtHeader.id = 'ph-' + wtFId;
      wtHeader.innerHTML = `<span class="worktree-branch-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8c0-2.76-2.46-5-5.5-5S2 5.24 2 8h2l1-1 1 1h4"/><path d="M13 7.14A5.82 5.82 0 0 1 16.5 6c3.04 0 5.5 2.24 5.5 5h-3l-1-1-1 1h-3"/><path d="M5.89 9.71c-2.15 2.15-2.3 5.47-.35 7.43l4.24-4.25.7-.7.71-.71 2.12-2.12c-1.95-1.96-5.27-1.8-7.42.35"/><path d="M11 15.5c.5 2.5-.17 4.5-1 6.5h4c2-5.5-.5-12-1-14"/></svg></span> <span class="worktree-name">${escapeHtml(wtName)}</span>`;

      const wtHideBtn = document.createElement('button');
      wtHideBtn.className = 'worktree-hide-btn';
      wtHideBtn.title = 'Hide worktree';
      wtHideBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      wtHeader.appendChild(wtHideBtn);

      const wtDeleteBtn = document.createElement('button');
      wtDeleteBtn.className = 'worktree-delete-btn';
      wtDeleteBtn.title = 'Delete worktree from disk';
      wtDeleteBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      wtHeader.appendChild(wtDeleteBtn);

      const wtNewBtn = document.createElement('button');
      wtNewBtn.className = 'project-new-btn worktree-new-btn';
      wtNewBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
      wtNewBtn.title = 'New session in worktree';
      wtHeader.appendChild(wtNewBtn);

      const wtSessionsList = buildSessionsList(wtFId, wtResult.visible, wtResult.older, wtResult.subagentIndex, wt.projectPath);
      wtSessionsList.className = 'worktree-sessions';

      // Auto-collapse worktree if stale
      if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
        const mostRecent = wtResult.filtered[0]?.modified;
        if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
          wtHeader.classList.add('collapsed');
        }
      }

      wtGroup.appendChild(wtHeader);
      wtGroup.appendChild(wtSessionsList);
      sessionsList.appendChild(wtGroup);
    }

    newSidebar.appendChild(group);
  }

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Fast-path: the stateful branches below only apply to a small set of
      // container elements tagged with `js-stateful` at build time. The vast
      // majority of nodes (SVG paths, button children, info divs, etc.) carry
      // none of these classes, so we bail immediately — this alone removes
      // ~589 ms of per-node classList probe overhead on the full 22k-node tree.
      if (!fromEl.classList.contains('js-stateful')) return true;

      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
        return false;
      }
      if (fromEl.classList.contains('project-header')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('slug-group') || fromEl.classList.contains('worktree-header')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('sidebar-children-caret')) {
        if (fromEl.classList.contains('expanded')) {
          toEl.classList.add('expanded');
        } else {
          toEl.classList.remove('expanded');
        }
      }
      if (fromEl.classList.contains('sidebar-subagents-container')) {
        if (fromEl.style.display !== 'none') {
          toEl.style.display = '';
        } else {
          toEl.style.display = 'none';
        }
      }
      if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        toEl.textContent = '- hide older';
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
      }
      return true;
    },
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(projects);

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

function rebindSidebarEvents(projects) {
  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
    }
    const scheduleBtn = header.querySelector('.project-schedule-btn');
    if (scheduleBtn) {
      scheduleBtn.onclick = (e) => { e.stopPropagation(); launchScheduleCreator(project); };
    }
    const settingsBtn = header.querySelector('.project-settings-btn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsViewer('project', project.projectPath); };
    }
    const archiveGroupBtn = header.querySelector('.project-archive-btn');
    if (archiveGroupBtn) {
      archiveGroupBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = project.sessions.filter(s => !s.parentSessionId && !s.archived);
        if (sessions.length === 0) return;
        const shortName = shortProjectPath(project.projectPath);
        if (!confirm(`Archive all ${sessions.length} session${sessions.length > 1 ? 's' : ''} in ${shortName}?`)) return;
        for (const s of sessions) {
          if (activePtyIds.has(s.sessionId)) {
            await window.api.stopSession(s.sessionId);
          }
          await window.api.archiveSession(s.sessionId, 1);
          s.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    const remapBtn = header.querySelector('.project-remap-btn');
    if (remapBtn) {
      remapBtn.onclick = async (e) => {
        e.stopPropagation();
        const newPath = await window.api.browseFolder();
        if (!newPath) return;
        const projectShortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        if (!confirm(`Remap ${projectShortName} to:\n${newPath}?`)) return;
        const result = await window.api.remapProject(project.projectPath, newPath);
        if (result.error) {
          alert('Failed to remap: ' + result.error);
        } else {
          loadProjects();
        }
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn') || e.target.closest('.project-schedule-btn') || e.target.closest('.project-remap-btn')) return;
      header.classList.toggle('collapsed');
    };
  }

  // Bind worktree header events
  sidebarContent.querySelectorAll('.worktree-header').forEach(wtHeader => {
    const wtFId = wtHeader.id.replace('ph-', '');
    const wtProject = projects.find(p => folderId(p.projectPath) === wtFId);
    if (!wtProject) return;

    const wtNewBtn = wtHeader.querySelector('.worktree-new-btn');
    if (wtNewBtn) {
      wtNewBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(wtProject, wtNewBtn); };
    }
    const wtHideBtn = wtHeader.querySelector('.worktree-hide-btn');
    if (wtHideBtn) {
      wtHideBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return;
        await window.api.removeProject(wtProject.projectPath);
        loadProjects();
      };
    }
    const wtDeleteBtn = wtHeader.querySelector('.worktree-delete-btn');
    if (wtDeleteBtn) {
      wtDeleteBtn.onclick = async (e) => {
        e.stopPropagation();
        const name = wtProject.projectPath.split('/').pop();
        const confirmed = await showDeleteWorktreeDialog(name, wtProject.projectPath);
        if (!confirmed) return;
        const result = await window.api.deleteWorktree(wtProject.projectPath);
        if (result && result.ok) {
          loadProjects();
        } else {
          const msg = (result && result.error) ? result.error : 'Unknown error';
          alert(`Failed to delete worktree: ${msg}`);
        }
      };
    }
    wtHeader.onclick = (e) => {
      if (e.target.closest('.worktree-new-btn') || e.target.closest('.worktree-hide-btn') || e.target.closest('.worktree-delete-btn')) return;
      wtHeader.classList.toggle('collapsed');
    };
  });

  sidebarContent.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item:not([data-subagent])');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          if (activePtyIds.has(sid)) await window.api.stopSession(sid);
          await window.api.archiveSession(sid, 1);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  sidebarContent.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  sidebarContent.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    moreBtn.onclick = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      moreBtn.textContent = showing ? `+ ${count} older` : '- hide older';
    };
  });

  sidebarContent.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    // Sessions under missing projects can't be opened — the path no longer exists
    if (item.closest('.project-group.missing')) {
      item.classList.add('disabled');
      item.title = 'Project path no longer exists — use "Change path" to fix';
      item.onclick = () => {};
      return;
    }

    item.onclick = () => {
      if (item.dataset.subagent && session.parentSessionId) {
        showSubagentTranscript(session);
      } else {
        openSession(session);
      }
    };

    // Subagent items are read-only: skip pin, rename, stop, fork, archive, jsonl, launchConfig
    if (item.dataset.subagent) return;

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        confirmAndStopSession(session.sessionId);
      };
    }

    const launchConfigBtn = item.querySelector('.session-launch-config-btn');
    if (launchConfigBtn) {
      launchConfigBtn.onclick = (e) => {
        e.stopPropagation();
        showResumeSessionDialog(session);
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const jsonlBtn = item.querySelector('.session-jsonl-btn');
    if (jsonlBtn) {
      jsonlBtn.onclick = (e) => {
        e.stopPropagation();
        showJsonlViewer(session);
      };
    }

    const deleteBtn = item.querySelector('.session-delete-btn');
    if (deleteBtn) {
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        const ok = await showDeleteSessionDialog(session);
        if (!ok) return;
        if (activePtyIds.has(session.sessionId)) {
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        const res = await window.api.deleteSession(session.sessionId);
        if (!res || !res.ok) {
          // Not a modal: an alert() here is hard to dismiss and blocks the
          // renderer. Flash the button and log the reason instead.
          console.error('[delete-session]', (res && res.error) || 'unknown error');
          if (typeof window.flashButtonText === 'function') {
            window.flashButtonText(deleteBtn, 'Failed', 1500);
          }
          return;
        }
        // The sidebar re-injects transcript-less sessions from pendingSessions on
        // every load, so forget it here or a deleted placeholder card comes back.
        if (typeof pendingSessions !== 'undefined') pendingSessions.delete(session.sessionId);
        if (typeof sessionMap !== 'undefined') sessionMap.delete(session.sessionId);
        // Close the tab too — otherwise it stays open pointing at a transcript
        // that no longer exists for the rest of this run.
        if (typeof destroySession === 'function' && typeof openSessions !== 'undefined'
            && openSessions.has(session.sessionId)) {
          destroySession(session.sessionId);
        }
        loadProjects();
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal && activePtyIds.has(session.sessionId)) {
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        await window.api.archiveSession(session.sessionId, newVal);
        session.archived = newVal;
        loadProjects();
      };
    }
  });

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = sidebarContent.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item js-stateful';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  if (parentHasActiveSubagent(session.sessionId)) item.classList.add('has-busy-agents');
  if (window.ATRACE && item.className !== 'session-item js-stateful') window.atrace('class.render', session.sessionId, { el: item.id, cls: item.className, fn: 'buildSessionItem' });
  item.dataset.sessionId = session.sessionId;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Pin
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.innerHTML = session.starred
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';

  // Running status dot
  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

  // Compact meta line: time + msgs on the left, first UUID segment on the right
  // (replaces the full-width session-id line). The 30s label ticker in app.js
  // updates .session-time only, so it must stay its own span.
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '');
  const shortIdEl = document.createElement('span');
  shortIdEl.className = 'session-short-id';
  shortIdEl.title = session.sessionId;
  shortIdEl.textContent = session.sessionId.split('-')[0];
  metaEl.append(timeEl, shortIdEl);

  if (session.type === 'terminal') {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
    summaryEl.prepend(badge);
  }
  info.appendChild(summaryEl);
  info.appendChild(metaEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'session-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'session-delete-btn';
  deleteBtn.title = 'Delete session (removes the transcript from disk)';
  deleteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  const launchConfigBtn = document.createElement('button');
  launchConfigBtn.className = 'session-launch-config-btn';
  launchConfigBtn.title = 'Resume with config';
  launchConfigBtn.innerHTML = ICONS.launchConfig(14);

  actions.appendChild(stopBtn);
  if (session.type !== 'terminal') {
    actions.appendChild(forkBtn);
    actions.appendChild(jsonlBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(launchConfigBtn);
    actions.appendChild(deleteBtn);
  }

  row.appendChild(pin);
  row.appendChild(dot);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  return item;
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}

// --- Delete session confirmation dialog ---
// Returns a Promise<boolean> — true if the user confirmed deletion.
//
// Deliberately not window.confirm: this is the only action in the app that
// destroys history, and a native prompt blocks the whole renderer (every other
// live terminal with it) and cannot show what is about to be lost. Same shape as
// showDeleteWorktreeDialog below, which is the precedent for a destructive
// confirmation that states its consequences.
async function showDeleteSessionDialog(session) {
  const previewPromise = window.api.deleteSessionPreview
    ? window.api.deleteSessionPreview(session.sessionId)
    : Promise.resolve(null);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'new-session-dialog delete-worktree-dialog';

    const label = cleanDisplayName(session.name || session.aiTitle || session.summary) || session.sessionId;
    dialog.innerHTML = `
      <h3>Delete session "${escapeHtml(label)}"?</h3>
      <div class="delete-worktree-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>The transcript is removed from disk permanently. This cannot be undone — use <strong>Archive</strong> instead to hide a session while keeping the file.</span>
      </div>
      <div class="delete-worktree-status" id="dss-status">
        <span class="dwt-loading">Checking what will be removed…</span>
      </div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="dss-cancel">Cancel</button>
        <button class="delete-worktree-confirm-btn" id="dss-confirm">Delete permanently</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const statusEl = dialog.querySelector('#dss-status');
    const projectLine = `<div class="dwt-dirty-label">Project: ${escapeHtml(session.projectPath || 'unknown')}</div>`;

    previewPromise.then((p) => {
      if (!overlay.isConnected) return;
      if (!p || !p.ok) {
        statusEl.innerHTML = projectLine;
        return;
      }
      const parts = [];
      parts.push(p.transcripts > 0
        ? `${p.transcripts} file${p.transcripts !== 1 ? 's' : ''} on disk`
        : 'no transcript on disk (this session never started)');
      if (p.subagents > 0) parts.push(`${p.subagents} subagent transcript${p.subagents !== 1 ? 's' : ''}`);
      if (p.running) parts.push('session is still running and will be stopped first');
      statusEl.innerHTML = projectLine + `<pre class="dwt-dirty-list">${escapeHtml(parts.join('\n'))}</pre>`;
    }).catch(() => {
      if (overlay.isConnected) statusEl.innerHTML = projectLine;
    });

    function close(confirmed) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(confirmed);
    }

    dialog.querySelector('#dss-cancel').onclick = () => close(false);
    dialog.querySelector('#dss-confirm').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    function onKey(e) { if (e.key === 'Escape') close(false); }
    document.addEventListener('keydown', onKey);
  });
}

// --- Delete worktree confirmation dialog ---
// Returns a Promise<boolean> — true if the user confirmed deletion.
async function showDeleteWorktreeDialog(name, worktreePath) {
  // Fetch worktree status (dirty files) while the dialog is shown
  const statusPromise = window.api.worktreeStatus(worktreePath);

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'new-session-dialog delete-worktree-dialog';

    dialog.innerHTML = `
      <h3>Delete worktree "${escapeHtml(name)}"?</h3>
      <div class="delete-worktree-warning">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Any uncommitted changes in this worktree will be permanently lost.</span>
      </div>
      <div class="delete-worktree-status" id="dwt-status">
        <span class="dwt-loading">Checking worktree status…</span>
      </div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="dwt-cancel">Cancel</button>
        <button class="delete-worktree-confirm-btn" id="dwt-confirm">Delete anyway</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const statusEl = dialog.querySelector('#dwt-status');

    // Populate status once the IPC resolves
    statusPromise.then((status) => {
      if (!overlay.isConnected) return; // dialog already closed
      if (!status || !status.ok) {
        const errMsg = (status && status.error) ? escapeHtml(status.error) : 'Unknown error';
        statusEl.innerHTML = `<span class="dwt-error">Unable to read worktree status: ${errMsg}</span>`;
        return;
      }
      if (status.total === 0) {
        statusEl.innerHTML = `<span class="dwt-clean">Worktree is clean — no uncommitted changes.</span>`;
        return;
      }
      const shown = status.dirty.slice(0, 10);
      const overflow = status.total - shown.length;
      const lines = shown.map(l => escapeHtml(l)).join('\n');
      const extra = overflow > 0 ? `\n+ ${overflow} more…` : '';
      statusEl.innerHTML = `<div class="dwt-dirty-label">${status.total} uncommitted file${status.total !== 1 ? 's' : ''}:</div><pre class="dwt-dirty-list">${lines}${extra}</pre>`;
    }).catch((err) => {
      if (!overlay.isConnected) return;
      statusEl.innerHTML = `<span class="dwt-error">Unable to read worktree status: ${escapeHtml(String(err))}</span>`;
    });

    function close(confirmed) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(confirmed);
    }

    dialog.querySelector('#dwt-cancel').onclick = () => close(false);
    dialog.querySelector('#dwt-confirm').onclick = () => close(true);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    function onKey(e) {
      if (e.key === 'Escape') close(false);
    }
    document.addEventListener('keydown', onKey);
  });
}
