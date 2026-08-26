// Harness registry.
//
// A "harness" is a CLI that drives a model and records its sessions on disk —
// `claude`, and (next) `codex`. Each one owns its transcript layout, its
// transcript format, and its launch flags; the rest of the app addresses them
// only through the shape below.
//
// Note the name: `agent` already means a Claude *subagent* elsewhere in this
// codebase (session_cache.agentId, subagentType), so a harness is deliberately
// not called an agent.
//
// Every harness module exports:
//
//   id              string, matches session_cache.harness
//   label           display name
//   binary          the executable name
//   available()     is this harness usable on this machine
//   sessionsRoot()  directory holding all its transcripts
//   listFolders()   folder keys under that root
//   folderPath(f)   folder key → absolute directory
//   listTranscripts(f)         absolute transcript paths in a folder
//   transcriptPath(row)        cached row → absolute transcript path
//   readSessionFile(file, folder, projectPath) → session row, or null
//   buildLaunchArgs({ sessionId, isNew, options }) → argv after the binary

const claude = require('./claude');

const HARNESSES = { [claude.id]: claude };

const DEFAULT_HARNESS = claude.id;

/** Look up a harness by id, falling back to Claude for rows written before
 *  the harness column existed (and for any unknown value). */
function getHarness(harnessId) {
  return HARNESSES[harnessId] || HARNESSES[DEFAULT_HARNESS];
}

/** Every registered harness, whether or not it is usable here. */
function allHarnesses() {
  return Object.values(HARNESSES);
}

/** Harnesses that can actually be used on this machine. */
function availableHarnesses() {
  return allHarnesses().filter(h => h.available());
}

module.exports = { HARNESSES, DEFAULT_HARNESS, getHarness, allHarnesses, availableHarnesses };
