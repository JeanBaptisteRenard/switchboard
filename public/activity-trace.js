// Renderer half of the opt-in activity trace. The renderer never writes: it
// forwards to the main process, the single writer.
// See docs/activity-trace.md and .ai/contexts/ipc-bridge.md "Activity trace".
(function initActivityTrace() {
  const api = window.api;
  const on = !!(api && api.activityTraceEnabled && typeof api.traceActivity === 'function');
  window.ATRACE = on;
  window.atrace = on
    ? function atrace(cat, sid, fields) {
      try { api.traceActivity(cat, sid === undefined ? null : sid, fields || null); } catch {}
    }
    : function atraceDisabled() {};
})();
