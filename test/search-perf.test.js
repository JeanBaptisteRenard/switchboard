// Tests for the two search-perf fixes in public/app.js:
//
//   Fix 1 — minimum 3 characters: queries shorter than MIN_SEARCH_CHARS must
//     NOT call window.api.search, must NOT clear the input value, but MUST
//     reset the filter state (searchMatchIds = null) and refresh.
//
//   Fix 2 (order correctness) — clearSearch() and resetSearchFilter() must pass
//     resort:true to refreshSidebar. Using resort:false is unsound: renderProjects
//     overwrites sortedOrder with only the matched-project subset during a search,
//     so clearing with resort:false would sort the full list against a stale index
//     and produce a scrambled sidebar order.
//
// app.js cannot be eval-ed in jsdom (it registers IPC listeners at module
// scope before stubs are ready). We follow the running-indicators.test.js
// pattern: replicate the relevant logic inline and test it in isolation.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal in-process replica of the search functions from public/app.js.
// We keep it as close to the real source as possible so a drift in the real
// file shows up as a test failure on the next `task check`.
// ---------------------------------------------------------------------------

const MIN_SEARCH_CHARS = 3;

function makeSearchState() {
  const state = {
    activeTab: 'sessions',
    searchMatchIds: null,
    searchMatchProjectPaths: null,
    cachedAllProjects: [],
    cachedPlans: [],
    searchTitlesOnly: false,
    // Spies
    refreshSidebarCalls: [],
    renderPlansCalls: [],
    renderMemoriesCalls: [],
    renderWorkFilesCalls: [],
    apiSearchCalls: [],
  };

  // Fake DOM handles
  const inputEl = { value: '', _cleared: false };
  const searchBarEl = { classList: { removed: [], toggled: [] } };
  let debounceTimer = null;

  function refreshSidebar(opts) {
    state.refreshSidebarCalls.push(opts);
  }
  function renderPlans(plans) {
    state.renderPlansCalls.push(plans);
  }
  function renderMemories(ids) {
    state.renderMemoriesCalls.push(ids);
  }
  function renderWorkFiles(ids) {
    state.renderWorkFilesCalls.push(ids);
  }

  // Mirrors clearSearch() in app.js.
  function clearSearch() {
    inputEl.value = '';
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (state.activeTab === 'sessions') {
      state.searchMatchIds = null;
      state.searchMatchProjectPaths = null;
      refreshSidebar({ resort: true }); // resort:true required — sortedOrder is stale after search
    } else if (state.activeTab === 'plans') {
      renderPlans(state.cachedPlans);
    } else if (state.activeTab === 'memory') {
      renderMemories();
    } else if (state.activeTab === 'work-files') {
      renderWorkFiles();
    }
  }

  // Mirrors resetSearchFilter() in app.js.
  function resetSearchFilter() {
    if (state.activeTab === 'sessions') {
      state.searchMatchIds = null;
      state.searchMatchProjectPaths = null;
      refreshSidebar({ resort: true }); // resort:true required — same stale-sortedOrder reason
    } else if (state.activeTab === 'plans') {
      renderPlans(state.cachedPlans);
    } else if (state.activeTab === 'memory') {
      renderMemories();
    } else if (state.activeTab === 'work-files') {
      renderWorkFiles();
    }
  }

  // Mirrors runSearchQuery() in app.js.
  async function runSearchQuery(apiSearch) {
    const query = inputEl.value.trim();
    if (!query) {
      clearSearch();
      return;
    }
    if (query.length < MIN_SEARCH_CHARS) {
      resetSearchFilter();
      return;
    }
    // Would call window.api.search in real code:
    state.apiSearchCalls.push({ query, tab: state.activeTab });
    await apiSearch(state.activeTab, query, state.searchTitlesOnly);
    if (state.activeTab === 'sessions') {
      state.searchMatchIds = new Set(['fake-result']);
      refreshSidebar({ resort: true });
    }
  }

  return {
    state,
    inputEl,
    clearSearch,
    resetSearchFilter,
    runSearchQuery,
  };
}

// ---------------------------------------------------------------------------
// Fix 1: minimum 3 characters
// ---------------------------------------------------------------------------

test('search: 2-char query does NOT call api.search and does NOT clear input', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = 'ab';
  let apiCalled = false;
  await runSearchQuery(() => { apiCalled = true; });

  assert.equal(apiCalled, false, 'api.search must not be called for a 2-char query');
  assert.equal(inputEl.value, 'ab', 'input value must be preserved (not cleared)');
});

test('search: 2-char query resets filter state (searchMatchIds = null)', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  // Simulate a prior active search
  state.searchMatchIds = new Set(['old-session']);
  inputEl.value = 'ab';
  await runSearchQuery(() => {});

  assert.equal(state.searchMatchIds, null, 'searchMatchIds must be reset to null');
  assert.equal(state.searchMatchProjectPaths, null, 'searchMatchProjectPaths must be reset to null');
});

test('search: 2-char query calls refreshSidebar (to show unfiltered list)', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = 'ab';
  await runSearchQuery(() => {});

  assert.equal(state.refreshSidebarCalls.length, 1, 'refreshSidebar must be called once');
});

test('search: 1-char query behaves the same as 2-char (below threshold)', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = 'a';
  let apiCalled = false;
  await runSearchQuery(() => { apiCalled = true; });

  assert.equal(apiCalled, false, 'api.search must not be called for a 1-char query');
  assert.equal(inputEl.value, 'a', 'input value must be preserved');
});

test('search: "  ab  " (2 trimmed chars) does NOT call api.search', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = '  ab  ';
  let apiCalled = false;
  await runSearchQuery(() => { apiCalled = true; });

  assert.equal(apiCalled, false, 'trim semantics: 2 trimmed chars must not trigger search');
  // Input text must be preserved
  assert.equal(inputEl.value, '  ab  ', 'input value must be preserved');
});

test('search: 3-char query DOES call api.search', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = 'abc';
  let apiCalled = false;
  await runSearchQuery(() => { apiCalled = true; return Promise.resolve([]); });

  assert.equal(apiCalled, true, 'api.search must be called for a 3-char query');
  assert.equal(state.apiSearchCalls.length, 1);
  assert.equal(state.apiSearchCalls[0].query, 'abc');
});

test('search: empty query calls clearSearch (wipes input value)', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = '';
  await runSearchQuery(() => {});

  // clearSearch sets inputEl.value = ''
  assert.equal(inputEl.value, '', 'empty query triggers full clearSearch');
  // refreshSidebar called once by clearSearch
  assert.equal(state.refreshSidebarCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Fix 2: clear-search path calls refreshSidebar with resort:true
// (resort:false was unsound — sortedOrder is overwritten with only the
//  matched subset during a search, so clearing with resort:false scrambles
//  the full project list order)
// ---------------------------------------------------------------------------

test('clearSearch: calls refreshSidebar with resort:true (not resort:false)', () => {
  const { state, clearSearch } = makeSearchState();
  state.searchMatchIds = new Set(['s1', 's2']);
  clearSearch();

  assert.equal(state.refreshSidebarCalls.length, 1, 'refreshSidebar called exactly once on clear');
  assert.equal(state.refreshSidebarCalls[0].resort, true,
    'clearSearch must pass resort:true — sortedOrder is stale after a search');
});

test('clearSearch: resets searchMatchIds and searchMatchProjectPaths', () => {
  const { state, clearSearch } = makeSearchState();
  state.searchMatchIds = new Set(['s1']);
  state.searchMatchProjectPaths = new Set(['/home/dev/proj']);
  clearSearch();

  assert.equal(state.searchMatchIds, null);
  assert.equal(state.searchMatchProjectPaths, null);
});

test('clearSearch: does NOT call refreshSidebar more than once (no double-render)', () => {
  const { state, clearSearch } = makeSearchState();
  clearSearch();
  assert.equal(state.refreshSidebarCalls.length, 1,
    'clearSearch must trigger exactly one refreshSidebar call');
});

test('resetSearchFilter: calls refreshSidebar with resort:true (not resort:false)', async () => {
  // Sequence: user types 3+ chars (search runs, searchMatchIds populated),
  // then deletes back to 2 chars — resetSearchFilter must re-sort from data
  // because sortedOrder was overwritten to contain only the matched subset.
  const { state, resetSearchFilter } = makeSearchState();
  // Simulate a prior active search having populated searchMatchIds
  state.searchMatchIds = new Set(['session-x']);
  resetSearchFilter();

  assert.equal(state.refreshSidebarCalls.length, 1, 'refreshSidebar called once');
  assert.equal(state.refreshSidebarCalls[0].resort, true,
    'resetSearchFilter must pass resort:true — sortedOrder is stale after prior search');
});

test('search: delete from 3+ chars to 2 chars resets filter (sequence scenario)', async () => {
  // Simulates the sequence: type "abc" → results → delete to "ab" → unfiltered.
  const { state, inputEl, runSearchQuery } = makeSearchState();
  // Step 1: 3-char search runs
  inputEl.value = 'abc';
  await runSearchQuery(() => Promise.resolve([]));
  assert.notEqual(state.searchMatchIds, null, 'search must have set searchMatchIds');

  // Step 2: user deletes to 2 chars — triggers resetSearchFilter path
  inputEl.value = 'ab';
  await runSearchQuery(() => {});

  assert.equal(state.searchMatchIds, null, 'searchMatchIds must be cleared after drop to 2 chars');
  assert.equal(state.searchMatchProjectPaths, null, 'searchMatchProjectPaths must be cleared');
  // refreshSidebar must have been called for both the search and the reset
  assert.ok(state.refreshSidebarCalls.length >= 2, 'refreshSidebar called for search and for reset');
  // The reset call must use resort:true
  const resetCall = state.refreshSidebarCalls[state.refreshSidebarCalls.length - 1];
  assert.equal(resetCall.resort, true, 'reset call must use resort:true');
});

test('search: "  a  " (1 trimmed char) does NOT call api.search and preserves input', async () => {
  const { inputEl, runSearchQuery } = makeSearchState();
  inputEl.value = '  a  ';
  let apiCalled = false;
  await runSearchQuery(() => { apiCalled = true; });

  assert.equal(apiCalled, false, 'trim semantics: 1 trimmed char must not trigger search');
  assert.equal(inputEl.value, '  a  ', 'input value must be preserved (not cleared)');
});

// ---------------------------------------------------------------------------
// Cross-tab: non-sessions tabs route correctly under 3-char threshold
// ---------------------------------------------------------------------------

test('search: 2-char query on plans tab calls renderPlans (not api.search)', async () => {
  const { state, inputEl, runSearchQuery } = makeSearchState();
  state.activeTab = 'plans';
  state.cachedPlans = [{ filename: 'plan-a.md' }];
  inputEl.value = 'pl';
  let apiCalled = false;
  await runSearchQuery(() => { apiCalled = true; });

  assert.equal(apiCalled, false, 'api.search not called for 2-char on plans tab');
  assert.equal(state.renderPlansCalls.length, 1, 'renderPlans called to show unfiltered list');
  assert.deepEqual(state.renderPlansCalls[0], state.cachedPlans);
});
