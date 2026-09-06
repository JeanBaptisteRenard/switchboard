const path = require('path');
const fs = require('fs');

/** Subagent transcripts land under <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl.
 *  We surface them as first-class rows with a synthetic sessionId so they're addressable
 *  exactly like top-level sessions (search, archive, rename, etc).
 */
function subagentSessionId(parentSessionId, agentId) {
  if (parentSessionId.includes(':')) throw new TypeError(`parentSessionId must not contain ':': ${parentSessionId}`);
  if (agentId.includes(':')) throw new TypeError(`agentId must not contain ':': ${agentId}`);
  return `sub:${parentSessionId}:${agentId}`;
}

/** Resolve the absolute jsonl path for a row from session_cache.
 *  Works for both top-level sessions and subagents. */
function resolveJsonlPath(projectsDir, row) {
  if (!row || !row.folder) return null;
  if (row.parentSessionId && row.agentId) {
    return path.join(projectsDir, row.folder, row.parentSessionId, 'subagents', `agent-${row.agentId}.jsonl`);
  }
  return path.join(projectsDir, row.folder, row.sessionId + '.jsonl');
}

/** Read sidecar { agentType, description } if present. */
function readSubagentMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/** A user turn that contains ONLY tool_result blocks isn't a real message —
 *  it's the harness feeding tool output back to the model. Counting these
 *  inflates per-day message counts dramatically (observed 116991 msg/day).
 *  Returns true only when content is a non-empty array whose every item is a
 *  {type:'tool_result'} block. */
function isToolResultOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(c => c && c.type === 'tool_result');
}

/** Pure helper: given an array of raw JSONL lines (strings) and a fallback date
 *  (YYYY-MM-DD, used when a line has no usable timestamp), accumulate per-(date,
 *  model) metrics. Returns an array of:
 *    { date, model, messageCount, toolCallCount, inputTokens, outputTokens,
 *      cacheReadTokens, cacheCreationTokens }
 *  Tokens and tool calls are only attributed to assistant lines; synthetic /
 *  model-less assistant lines bucket under model '' (counted as a message but
 *  with zero tokens). User turns that are purely tool_result aren't counted as
 *  messages. Non-message line types are ignored entirely.
 *
 *  sinceTimestampExclusive (optional): skip any entry whose own `timestamp` is
 *  <= this ISO8601 string. Used to dedupe a compaction mirror's recopied
 *  prefix -- see .ai/contexts/session-cache.md.
 */
function extractDailyMetrics(lines, fallbackDate, sinceTimestampExclusive) {
  const map = new Map();
  const bucket = (date, model) => {
    const key = `${date}|${model}`;
    let m = map.get(key);
    if (!m) {
      m = {
        date, model,
        messageCount: 0, toolCallCount: 0,
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
      };
      map.set(key, m);
    }
    return m;
  };

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (sinceTimestampExclusive && (!entry.timestamp || entry.timestamp <= sinceTimestampExclusive)) continue;

    const ts = typeof entry.timestamp === 'string' && entry.timestamp.length >= 10
      ? entry.timestamp.slice(0, 10)
      : fallbackDate;

    const isAssistant = entry.type === 'assistant' ||
      (entry.type === 'message' && entry.role === 'assistant');
    const isUser = entry.type === 'user' ||
      (entry.type === 'message' && entry.role === 'user');

    if (isAssistant) {
      let model = entry.message?.model || '';
      if (model === '<synthetic>') model = '';
      const m = bucket(ts, model);
      m.messageCount += 1;
      if (model) {
        const usage = entry.message?.usage || {};
        m.inputTokens += usage.input_tokens | 0;
        m.outputTokens += usage.output_tokens | 0;
        m.cacheReadTokens += usage.cache_read_input_tokens | 0;
        m.cacheCreationTokens += usage.cache_creation_input_tokens | 0;
      }
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && c.type === 'tool_use') m.toolCallCount += 1;
        }
      }
    } else if (isUser) {
      if (isToolResultOnly(entry.message?.content)) continue;
      bucket(ts, '').messageCount += 1;
    }
  }

  return Array.from(map.values());
}

// --- First-prompt selection ---
// Some records typed `user` carry no prompt: `!`-prefixed shell input, the
// caveat Claude Code wraps local-command output in, that output itself, and
// bare slash-command invocations. /clear and /model open a BRAND NEW transcript
// whose only records are that bookkeeping, so treating one as the session
// summary both mistitles every session started by /clear and lists
// content-free transcripts as phantom sidebar entries.
// Anchored: a bookkeeping record IS one of these envelopes, it does not merely
// mention one. A prompt quoting <local-command-stdout> (pasting a transcript
// excerpt) is a real turn, and skipping it can leave a whole session unindexed.
const LOCAL_COMMAND_RE = /^\s*<(bash-input|bash-stdout|local-command-caveat|local-command-stdout)>/;
// The CLI emits both tag orders — <command-name> first, and <command-message>
// first (/auto-compact, /pre-compact) — so a command record is recognised by
// the presence of <command-name> alongside one of its siblings, not by position.
const COMMAND_NAME_RE = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_SIBLING_RE = /<command-(message|args)>/;
const COMMAND_ARGS_RE = /<command-args>([^<]*)<\/command-args>/;

/** Classify a user message's text as a summary candidate:
 *    'prompt'  — a real user turn, used as-is.
 *    'command' — a slash-command invocation, usable only as a fallback.
 *    'skip'    — local-command bookkeeping, never a summary.
 */
function classifyUserText(text) {
  if (!text || LOCAL_COMMAND_RE.test(text)) return { kind: 'skip', text: '' };
  const cmd = text.match(COMMAND_NAME_RE);
  if (cmd && COMMAND_SIBLING_RE.test(text)) {
    const name = cmd[1].trim();
    const args = (text.match(COMMAND_ARGS_RE)?.[1] || '').trim();
    return { kind: 'command', text: (args ? name + ' ' + args : name).slice(0, 120) };
  }
  const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
  return { kind: 'prompt', text: taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120) };
}

/** Parse a single .jsonl file into a session object (or null if invalid).
 *  opts.parentSessionId — if set, treat as a subagent transcript and stamp the
 *  parent reference into the returned row.
 *  opts.dedupeSinceTimestamp — if set (ISO8601), entries at or before this
 *  timestamp are excluded from messageCount/textContent/summary-candidate/
 *  dailyMetrics (but NOT from created/modified/slug/etc, which reflect the
 *  file's true span). Used to dedupe a compaction mirror's recopied prefix
 *  against the transcript it continues from -- see .ai/contexts/session-cache.md.
 */
function readSessionFile(filePath, folder, projectPath, opts = {}) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  const cutoff = opts.dedupeSinceTimestamp || null;
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    // Fallback title for a session whose only user turn is a slash command.
    let commandSummary = '';
    let assistantSeen = false;
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    let agentId = null;
    let bridgeSessionId = null;
    let sidechainSeen = false;
    // Real conversation time bounds. Resuming a session appends untimestamped
    // bookkeeping records (last-prompt, mode, ai-title, …) which bump the file's
    // mtime without any actual activity, so mtime can't be the displayed time.
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (const line of lines) {
      // Per-line try/catch: a JSONL file being written concurrently by a live
      // Claude CLI session can have its tail captured mid-write — one truncated
      // line should not invalidate the whole file. Skip the malformed line and
      // keep parsing.
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.timestamp) {
        // ISO-8601 UTC strings — lexicographic comparison is chronological
        if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
        if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
      }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.agentId && !agentId) agentId = entry.agentId;
      if (entry.isSidechain) sidechainSeen = true;
      // Compaction mirror dedup key -- see .ai/contexts/session-cache.md
      if (entry.type === 'bridge-session' && typeof entry.bridgeSessionId === 'string' &&
          entry.bridgeSessionId && !bridgeSessionId) {
        bridgeSessionId = entry.bridgeSessionId;
      }
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      // Everything below this line double-counts a compaction mirror's
      // recopied prefix if not gated: skip entries at/before the cutoff.
      if (cutoff && (!entry.timestamp || entry.timestamp <= cutoff)) continue;
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) {
        assistantSeen = true;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        const cand = classifyUserText(text);
        if (cand.kind === 'prompt') summary = cand.text;
        else if (cand.kind === 'command' && !commandSummary) commandSummary = cand.text;
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    // A slash command stands in as the title only when the session went on to
    // do something. Bookkeeping-only transcripts (a bare /clear) have nothing
    // to show and must not be indexed at all.
    if (!summary && assistantSeen) summary = commandSummary;
    if (!summary || messageCount < 1) return null;

    const fallbackDate = stat.mtime.toISOString().slice(0, 10);
    const dailyMetrics = extractDailyMetrics(lines, fallbackDate, cutoff);

    if (isSubagent) {
      // Sidechain marker must be present — otherwise the file lives under a
      // subagents/ directory but isn't actually a subagent transcript. Bail.
      if (!sidechainSeen) return null;
      if (!agentId) {
        // Fall back to filename: agent-<id>.jsonl
        const m = fileBase.match(/^agent-(.+)$/);
        if (m) agentId = m[1];
      }
      if (!agentId) return null;
      const meta = readSubagentMeta(filePath) || {};
      const subagentType = meta.agentType || null;
      const description = meta.description || null;
      return {
        sessionId: subagentSessionId(opts.parentSessionId, agentId),
        folder, projectPath,
        summary: description || summary,
        firstPrompt: summary,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        messageCount, textContent, slug, customTitle, aiTitle,
        parentSessionId: opts.parentSessionId,
        agentId,
        subagentType,
        description,
        dailyMetrics,
      };
    }

    return {
      sessionId: fileBase, folder, projectPath,
      summary, firstPrompt: summary,
      // created/modified are display+sort values from message timestamps;
      // fileMtime is the cache-invalidation key (compared against stat.mtime
      // in refreshFolder). Old transcripts without timestamps fall back to stat.
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: lastTimestamp || stat.mtime.toISOString(),
      fileMtime: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
      bridgeSessionId,
      dailyMetrics,
    };
  } catch {
    return null;
  }
}

/** Merge top-level sessions sharing a bridgeSessionId within a project folder
 *  (issue #197) -- see .ai/contexts/session-cache.md for the measurement this
 *  is built on.
 *
 *  A compaction mirror duplicates its parent's tail verbatim -- same
 *  timestamps -- up to the compaction point, then keeps receiving genuinely
 *  new content afterward (the CLI writes to the mirror, not the parent, once
 *  compaction happens). Every member of a bridgeSessionId group keeps its OWN
 *  session_cache row (own fileMtime, own incremental refresh -- unchanged),
 *  but every member except the earliest (`created`) gets `mergedIntoSessionId`
 *  set to the earliest member's sessionId, and has its own
 *  messageCount/textContent/dailyMetrics recomputed excluding anything at or
 *  before its immediate predecessor's `modified` -- exactly the recopied
 *  overlap, no more. This way nothing is dropped on either side of a
 *  compaction, and nothing is counted twice. Callers exclude
 *  `mergedIntoSessionId`-tagged rows from sidebar/session-count listings;
 *  session_metrics aggregates need no such exclusion, since parent and mirror
 *  contribute under distinct sessionIds with non-overlapping timestamp
 *  ranges.
 *
 *  Sessions with no bridgeSessionId, and subagents (parentSessionId set), are
 *  left untouched -- absence must never collapse unrelated sessions into one.
 *
 *  existingRows: rows already in session_cache for this folder (DB shape).
 *  freshRows: sessions just produced by readSessionFile() this pass.
 *  reread(sessionId, dedupeSinceTimestamp): re-parses the named session's own
 *    file with a cutoff (null means a full, uncut read), returning a new
 *    session object (or null if nothing survives). Called for ANY group
 *    member -- fresh or already-cached, winner or not -- whose recorded
 *    mergedIntoSessionId disagrees with the role just computed for it here.
 *    That disagreement is the only signal a stored row's
 *    messageCount/session_metrics can be trusted by: a mirror indexed before
 *    its parent was known has mergedIntoSessionId=null and a cutoff that was
 *    never applied, so caching a row is never on its own proof that its
 *    contribution is already correctly deduplicated -- and the reverse case
 *    is just as real: if a group's earliest file is deleted (a real path --
 *    session deletion), its former child is promoted to winner on the next
 *    pass, but its stored contribution is still cutoff-filtered against a
 *    predecessor that no longer exists, under-counting until it is re-read in
 *    full. A member whose mergedIntoSessionId already matches its computed
 *    role (child of the current winner, or winner with no mergedIntoSessionId
 *    at all) is left untouched -- its stored contribution was already
 *    computed against this exact cutoff, so the frozen parent in the common
 *    case is never re-read on a routine pass.
 *
 *  Returns { toUpsert, toDelete }:
 *  - toUpsert: every row that must be written this pass -- unchanged fresh
 *    reads, and any group member (fresh or already-cached) whose
 *    re-derivation produced new content.
 *  - toDelete: sessionIds of already-cached rows whose re-derivation came
 *    back null (nothing survives the newly-applicable cutoff) -- these must
 *    be actively removed, not left with their pre-cutoff stale content.
 */
function mergeBridgeGroups(existingRows, freshRows, reread) {
  const bySessionId = new Map();
  const freshSessionIds = new Set();
  for (const row of existingRows || []) {
    if (row.parentSessionId) continue;
    bySessionId.set(row.sessionId, {
      sessionId: row.sessionId, created: row.created, modified: row.modified,
      bridgeSessionId: row.bridgeSessionId || null,
      mergedIntoSessionId: row.mergedIntoSessionId || null,
    });
  }
  for (const row of freshRows || []) {
    if (row.parentSessionId) continue;
    freshSessionIds.add(row.sessionId);
    bySessionId.set(row.sessionId, {
      sessionId: row.sessionId, created: row.created, modified: row.modified,
      bridgeSessionId: row.bridgeSessionId || null,
      // readSessionFile() never sets this field, so a fresh row's value here
      // is always null -- a fresh non-winner is therefore always re-derived,
      // same as before this field-based check existed.
      mergedIntoSessionId: row.mergedIntoSessionId || null,
    });
  }

  const groups = new Map();
  for (const entry of bySessionId.values()) {
    if (!entry.bridgeSessionId) continue;
    if (!groups.has(entry.bridgeSessionId)) groups.set(entry.bridgeSessionId, []);
    groups.get(entry.bridgeSessionId).push(entry);
  }

  const replacements = new Map(); // sessionId -> new row object, or null (nothing survives the cutoff)

  for (const members of groups.values()) {
    members.sort((a, b) => {
      if (a.created < b.created) return -1;
      if (a.created > b.created) return 1;
      return a.sessionId < b.sessionId ? -1 : 1;
    });
    const winnerId = members[0].sessionId;
    // The winner can itself carry a stale mergedIntoSessionId: if its former
    // earlier sibling's file was deleted (a real path -- session deletion),
    // this member is promoted from child to winner on this pass -- including
    // down to a group of one, once every other member is gone. Its stored
    // contribution was cutoff-filtered against a predecessor that no longer
    // exists, so -- unlike an already-settled winner -- it must be re-read in
    // full (no cutoff) rather than left as first-among-equals untouched. This
    // check must run even for a size-1 group, so it sits before the
    // `members.length < 2` guard below (which only concerns the non-winner
    // loop, meaningless with a single member).
    if (members[0].mergedIntoSessionId) {
      const rederivedWinner = reread(winnerId, null);
      if (rederivedWinner) rederivedWinner.mergedIntoSessionId = null;
      replacements.set(winnerId, rederivedWinner);
    }
    if (members.length < 2) continue;
    for (let i = 1; i < members.length; i++) {
      const member = members[i];
      if (member.mergedIntoSessionId === winnerId) continue; // already correctly derived against this exact cutoff
      const cutoff = members[i - 1].modified;
      const rederived = reread(member.sessionId, cutoff);
      if (rederived) rederived.mergedIntoSessionId = winnerId;
      replacements.set(member.sessionId, rederived);
    }
  }

  const toUpsert = [];
  const toDelete = [];

  for (const row of freshRows || []) {
    if (row.parentSessionId) { toUpsert.push(row); continue; }
    if (replacements.has(row.sessionId)) {
      const replacement = replacements.get(row.sessionId);
      if (replacement) toUpsert.push(replacement);
      // else: nothing new since its predecessor -- never inserted at all.
    } else {
      toUpsert.push(row);
    }
  }

  for (const row of existingRows || []) {
    if (row.parentSessionId) continue;
    if (freshSessionIds.has(row.sessionId)) continue; // already handled above
    if (!replacements.has(row.sessionId)) continue; // winner, or already correctly derived -- no change
    const replacement = replacements.get(row.sessionId);
    if (replacement) toUpsert.push(replacement);
    else toDelete.push(row.sessionId);
  }

  return { toUpsert, toDelete };
}

/** Enumerate every jsonl in a project folder: top-level sessions plus any
 *  subagent transcripts under <folder>/<parentSessionId>/subagents/*.jsonl
 *  (or directly under <folder>/<parentSessionId>/*.jsonl for legacy layouts).
 *  Returns [{ filePath, sessionId, parentSessionId|null }]. */
function enumerateSessionFiles(folderPath) {
  const out = [];
  let topEntries;
  try {
    topEntries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch { return out; }

  // Top-level .jsonl files = ordinary sessions
  for (const e of topEntries) {
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push({
        filePath: path.join(folderPath, e.name),
        sessionId: path.basename(e.name, '.jsonl'),
        parentSessionId: null,
      });
    }
  }

  // UUID subdirs may hold subagent transcripts
  for (const e of topEntries) {
    if (!e.isDirectory()) continue;
    const parentSessionId = e.name;
    const subDir = path.join(folderPath, parentSessionId);
    // Preferred layout: subagents/ subfolder
    const subagentsDir = path.join(subDir, 'subagents');
    try {
      if (fs.statSync(subagentsDir).isDirectory()) {
        for (const f of fs.readdirSync(subagentsDir)) {
          if (!f.endsWith('.jsonl')) continue;
          out.push({
            filePath: path.join(subagentsDir, f),
            sessionId: path.basename(f, '.jsonl'),
            parentSessionId,
          });
        }
        continue;
      }
    } catch {}
    // Fallback: jsonl directly in the UUID dir (older CLI versions)
    try {
      for (const f of fs.readdirSync(subDir)) {
        if (!f.endsWith('.jsonl')) continue;
        out.push({
          filePath: path.join(subDir, f),
          sessionId: path.basename(f, '.jsonl'),
          parentSessionId,
        });
      }
    } catch {}
  }

  return out;
}

/** Lightweight refresh path. Reads only the first ~256 KB / 500 lines of a
 *  jsonl file to extract display-level metadata (summary, slug, titles,
 *  agentId). Does NOT compute textContent or messageCount — the caller is
 *  expected to merge with the cached row for unchanged fields. Designed so
 *  the fs.watch flush can update a live 200+ MB host-session JSONL in ~ms
 *  instead of seconds.
 *
 *  Returns the same shape as the display subset of readSessionFile() so it
 *  can be merged into a cached row before upsert. Returns null if the chunk
 *  doesn't yet contain a usable first-user-message.
 */
function readSessionDisplayHeader(filePath, opts = {}) {
  const fileBase = path.basename(filePath, '.jsonl');
  const isSubagent = Boolean(opts.parentSessionId);
  const MAX_BYTES = 256 * 1024;
  const MAX_LINES = 500;
  try {
    const stat = fs.statSync(filePath);
    const readLen = Math.min(MAX_BYTES, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readLen);
    const n = fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8', 0, n);
    const lines = text.split('\n');
    // Drop the potentially-partial last line unless we read the whole file
    if (n < stat.size) lines.pop();

    let summary = '';
    let commandSummary = '';
    let assistantSeen = false;
    let slug = null, customTitle = null, aiTitle = null, agentId = null;
    let sidechainSeen = false;
    let lineCount = 0;
    for (const line of lines) {
      if (!line) continue;
      if (++lineCount > MAX_LINES) break;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.agentId && !agentId) agentId = entry.agentId;
      if (entry.isSidechain) sidechainSeen = true;
      if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) {
        assistantSeen = true;
      }
      if (entry.type === 'custom-title' && entry.customTitle && !customTitle) customTitle = entry.customTitle;
      if (entry.type === 'ai-title' && entry.aiTitle && !aiTitle) aiTitle = entry.aiTitle;
      const msg = entry.message;
      const txt = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        const cand = classifyUserText(txt);
        if (cand.kind === 'prompt') summary = cand.text;
        else if (cand.kind === 'command' && !commandSummary) commandSummary = cand.text;
      }
    }

    if (!summary && assistantSeen) summary = commandSummary;
    if (!summary) return null;

    if (isSubagent) {
      if (!sidechainSeen) return null;
      if (!agentId) {
        const m = fileBase.match(/^agent-(.+)$/);
        if (m) agentId = m[1];
      }
      if (!agentId) return null;
      const meta = readSubagentMeta(filePath) || {};
      return {
        sessionId: subagentSessionId(opts.parentSessionId, agentId),
        summary: meta.description || summary,
        firstPrompt: summary,
        modified: stat.mtime.toISOString(),
        slug, customTitle, aiTitle,
        parentSessionId: opts.parentSessionId,
        agentId,
        subagentType: meta.agentType || null,
        description: meta.description || null,
      };
    }

    return {
      sessionId: fileBase,
      summary, firstPrompt: summary,
      modified: stat.mtime.toISOString(),
      slug, customTitle, aiTitle,
    };
  } catch {
    return null;
  }
}

module.exports = { readSessionFile, readSessionDisplayHeader, classifyUserText, subagentSessionId, resolveJsonlPath, readSubagentMeta, enumerateSessionFiles, extractDailyMetrics, isToolResultOnly, mergeBridgeGroups };
