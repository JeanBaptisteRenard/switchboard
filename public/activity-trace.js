// Renderer half of the opt-in activity trace. The renderer never writes: it
// forwards to the main process, the single writer.
// See docs/activity-trace.md and .ai/contexts/ipc-bridge.md "Activity trace".
(function initActivityTrace() {
  const api = window.api;
  const wired = !!(api && typeof api.traceActivity === 'function');
  window.ATRACE = wired && !!api.activityTraceEnabled;
  window.atrace = wired
    ? function atrace(cat, sid, fields) {
      try { api.traceActivity(cat, sid === undefined ? null : sid, fields || null); } catch {}
    }
    : function atraceDisabled() {};
  if (wired && typeof api.onActivityTraceState === 'function') {
    api.onActivityTraceState((enabled) => { window.ATRACE = !!enabled; });
  }
})();
