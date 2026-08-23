// Shared subagent liveness timings.
// Classic <script> in the renderer, require()-d in the main process and tests.
// see .ai/contexts/subagent-observability.md

const SUBAGENT_LIVE_TTL_MS = 60000;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUBAGENT_LIVE_TTL_MS };
}
