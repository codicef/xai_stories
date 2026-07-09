// ============================================================
// XAI Evaluation Platform — main application logic
// ============================================================

'use strict';

// ── Seeded PRNG (mulberry32) ─────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stringToSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── LLM keys ────────────────────────────────────────────────
const LLMS = [
  '01-ai_Yi-1.5-34B-Chat',
  'deepseek-ai_DeepSeek-R1-Distill-Llama-70B',
  'google_gemma-3-27b-it',
  'openai_gpt-oss-120b',
];

const TEXT_LABELS = ['A', 'B', 'C', 'D'];
const DEMO_USER = '__demo__';

// ── Assignment: deterministic per-user case list ─────────────
function totalCasesFor(userId) {
  return userId === DEMO_USER ? 2 : CONFIG.totalCasesPerUser;
}

function casesPerSessionFor(userId) {
  return userId === DEMO_USER ? 2 : CONFIG.casesPerSession;
}

function getUserCaseIds(userId, allCases) {
  // MM-only evaluators: use precomputed uniform assignment, shuffle for presentation order
  if (precomputedAssignments[userId]) {
    const seed = stringToSeed(userId + '_order');
    return seededShuffle(precomputedAssignments[userId], seed);
  }

  // Other users: balanced random assignment across both datasets
  const n = totalCasesFor(userId);
  const seed = stringToSeed(userId);

  const metabric = allCases.filter((c) => c.dataset === 'metabric').map((c) => c.id);
  const mm = allCases.filter((c) => c.dataset === 'mm').map((c) => c.id);

  const half = Math.floor(n / 2);
  const shuffledM = seededShuffle(metabric, seed);
  const shuffledMm = seededShuffle(mm, seed + 1);

  const assigned = [...shuffledM.slice(0, half), ...shuffledMm.slice(0, n - half)];
  return seededShuffle(assigned, seed + 2);
}

// Returns {A: llm, B: llm, C: llm, D: llm} — stable per (userId, caseId)
function getTextOrder(userId, caseId) {
  const seed = stringToSeed(userId + '|' + caseId);
  const shuffled = seededShuffle(LLMS, seed);
  const order = {};
  TEXT_LABELS.forEach((label, i) => { order[label] = shuffled[i]; });
  return order;
}

// ── State helpers (localStorage) ────────────────────────────
const LS_KEY = 'xai_eval_state';

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

function getUserState(userId) {
  const all = loadState();
  if (!all[userId]) {
    all[userId] = {
      userId,
      caseIds: null,      // assigned after data load
      ratings: {},        // { caseId: { A: {crit:score, ...}, B:..., C:..., D:... }, preference: 'B' }
      textOrders: {},     // { caseId: {A: llm, ...} }
      sessionHistory: [], // list of completed session timestamps
    };
    saveState(all);
  }
  return all[userId];
}

function setUserState(userId, state) {
  const all = loadState();
  all[userId] = state;
  saveState(all);
}

// ── App globals ───────────────────────────────────────────────
let allCases = [];             // full data from stories.json
let caseMap = {};              // id → case object
let precomputedAssignments = {}; // from assignments.json (MM-only users)

let currentUser = null;
let userState = null;
let currentCaseIndex = 0;   // within assigned caseIds
let currentTextLabel = 'A'; // A/B/C/D within current case
let sessionStartIndex = 0;  // first case index of current session

// ── Boot ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  Promise.all([
    fetch('data/stories.json').then((r) => r.json()),
    fetch('data/assignments.json').then((r) => r.json()),
  ])
    .then(([storiesData, assignmentsData]) => {
      allCases = storiesData.cases;
      allCases.forEach((c) => { caseMap[c.id] = c; });
      precomputedAssignments = assignmentsData;
      initApp();
    })
    .catch((err) => {
      document.getElementById('loading').innerHTML =
        '<p class="error">Failed to load data. Make sure you ran <code>scripts/preprocess.py</code> first.</p>';
      console.error(err);
    });
});

function initApp() {
  document.getElementById('loading').classList.add('hidden');
  populateUserSelect();

  const savedUser = sessionStorage.getItem('xai_current_user');
  if (savedUser && (savedUser === DEMO_USER || CONFIG.users.includes(savedUser))) {
    startSession(savedUser);
  } else {
    showView('login-view');
  }
}

// ── Login ─────────────────────────────────────────────────────
function populateUserSelect() {
  const sel = document.getElementById('user-select');
  CONFIG.users.forEach((u) => {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u;
    sel.appendChild(opt);
  });
}

document.addEventListener('click', (e) => {
  if (e.target.id === 'login-btn') handleLogin();
  if (e.target.id === 'demo-btn') handleDemo();
  if (e.target.id === 'logout-btn') handleLogout();
  if (e.target.id === 'start-session-btn') beginNextSession();
  if (e.target.id === 'continue-session-btn') beginNextSession();
  if (e.target.id === 'next-text-btn') advanceText();
  if (e.target.id === 'prev-text-btn') retreatText();
  if (e.target.id === 'submit-case-btn') submitCase();
  if (e.target.id === 'download-btn') downloadSessionData();
  if (e.target.id === 'download-all-btn') downloadAllData();
});

function handleLogin() {
  const sel = document.getElementById('user-select');
  const userId = sel.value;
  if (!userId) return;
  sessionStorage.setItem('xai_current_user', userId);
  startSession(userId);
}

function handleDemo() {
  sessionStorage.setItem('xai_current_user', DEMO_USER);
  startSession(DEMO_USER);
}

function handleLogout() {
  sessionStorage.removeItem('xai_current_user');
  currentUser = null;
  userState = null;
  showView('login-view');
}

// ── Session management ────────────────────────────────────────
function startSession(userId) {
  currentUser = userId;
  userState = getUserState(userId);

  // Assign cases on first login
  if (!userState.caseIds) {
    userState.caseIds = getUserCaseIds(userId, allCases);
    // Pre-compute text orders for all assigned cases
    userState.caseIds.forEach((cid) => {
      userState.textOrders[cid] = getTextOrder(userId, cid);
    });
    setUserState(userId, userState);
  }

  const completedCases = getCompletedCaseCount();
  const totalCases = userState.caseIds.length;

  if (completedCases >= totalCases) {
    showDoneView();
    return;
  }

  showDashboard();
}

function getCompletedCaseCount() {
  return Object.keys(userState.ratings).filter((cid) => isCaseComplete(cid)).length;
}

function isCaseComplete(caseId) {
  const r = userState.ratings[caseId];
  if (!r) return false;
  return TEXT_LABELS.every((label) => r[label] && CONFIG.criteria.every((c) => r[label][c.id] != null));
}

function getRatedCaseCount() {
  return userState.caseIds.filter((cid) => isCaseComplete(cid)).length;
}

function beginNextSession() {
  // Find first incomplete case
  const firstIncomplete = userState.caseIds.findIndex((cid) => !isCaseComplete(cid));
  if (firstIncomplete === -1) {
    showDoneView();
    return;
  }
  currentCaseIndex = firstIncomplete;
  sessionStartIndex = firstIncomplete;
  currentTextLabel = getFirstUnratedText(userState.caseIds[currentCaseIndex]);
  showEvaluationView();
}

function getFirstUnratedText(caseId) {
  const r = userState.ratings[caseId];
  if (!r) return 'A';
  for (const label of TEXT_LABELS) {
    if (!r[label] || CONFIG.criteria.some((c) => r[label][c.id] == null)) {
      return label;
    }
  }
  return 'A';
}

// ── Dashboard view ────────────────────────────────────────────
function showDashboard() {
  showView('dashboard-view');
  const completed = getRatedCaseCount();
  const total = userState.caseIds.length;
  const textTotal = total * 4;
  const textDone = completed * 4;

  document.getElementById('dash-username').textContent =
    currentUser === DEMO_USER ? 'Demo mode' : currentUser;
  document.getElementById('dash-progress-text').textContent =
    `${textDone} / ${textTotal} text evaluations completed (${completed}/${total} cases)`;

  const pct = Math.round((textDone / textTotal) * 100);
  document.getElementById('dash-progress-bar').style.width = pct + '%';
  document.getElementById('dash-progress-bar').textContent = pct + '%';

  // Session info
  const casesLeft = total - completed;
  const casesThisSession = Math.min(casesLeft, casesPerSessionFor(currentUser));
  document.getElementById('dash-session-info').textContent =
    completed === 0
      ? `You have ${total} cases to evaluate. Each session covers ${casesPerSessionFor(currentUser)} cases (~20–30 min).`
      : `${casesLeft} cases remaining. Next session: ${casesThisSession} cases.`;

  const btn = document.getElementById('start-session-btn');
  btn.style.display = casesLeft > 0 ? 'inline-block' : 'none';

  const doneBtn = document.getElementById('download-all-btn');
  doneBtn.style.display = completed > 0 ? 'inline-block' : 'none';
}

// ── Evaluation view ───────────────────────────────────────────
function showEvaluationView() {
  showView('eval-view');
  renderEvalView();
}

function renderEvalView() {
  const caseId = userState.caseIds[currentCaseIndex];
  const caseData = caseMap[caseId];
  const textOrder = userState.textOrders[caseId];

  updateProgressBar();
  renderEvidence(caseData);
  renderTextTabs(caseId, textOrder);
  renderCurrentText(caseId, textOrder);
  renderRatingForm(caseId);
  updateNavButtons(caseId);
}

function updateProgressBar() {
  const total = userState.caseIds.length;
  const completed = getRatedCaseCount();
  const sessionEnd = Math.min(sessionStartIndex + casesPerSessionFor(currentUser), total);
  const sessionCases = sessionEnd - sessionStartIndex;
  const sessionDone = currentCaseIndex - sessionStartIndex;

  document.getElementById('eval-case-counter').textContent =
    `Case ${currentCaseIndex + 1} of ${total}  ·  Session: ${sessionDone + 1}/${sessionCases}`;
  document.getElementById('eval-user-label').textContent =
    currentUser === DEMO_USER ? '🔍 Demo' : currentUser;

  const pct = Math.round((completed / total) * 100);
  document.getElementById('eval-progress-bar').style.width = pct + '%';
}

function getPlotPath(caseData) {
  const idx = parseInt(caseData.sample_idx, 10);
  return `data/plots/${caseData.dataset}_sample_${idx}.png`;
}

function renderEvidence(caseData) {
  const e = caseData.evidence;

  document.getElementById('evidence-dataset').textContent = caseData.dataset_label;
  document.getElementById('evidence-predicted').textContent = e.predicted_survival || '—';
  document.getElementById('evidence-actual').textContent = e.actual_outcome || '—';

  // SHAP plot image
  const img = document.getElementById('shap-plot-img');
  const missing = document.getElementById('shap-plot-missing');
  const plotSrc = getPlotPath(caseData);
  img.src = plotSrc;
  img.classList.remove('hidden');
  missing.classList.add('hidden');
  img.onerror = () => {
    img.classList.add('hidden');
    missing.classList.remove('hidden');
  };

  // SHAP table
  const tbody = document.getElementById('shap-tbody');
  tbody.innerHTML = '';
  (e.shap_features || []).forEach((f) => {
    const tr = document.createElement('tr');
    const isPos = f.shap >= 0;
    const absShap = Math.abs(f.shap);
    const barWidth = Math.min(100, Math.round(absShap * 2000)); // scale for display

    const desc = (e.feature_descriptions || {})[f.name] || '';
    tr.innerHTML = `
      <td class="feat-name" title="${escHtml(desc)}">${escHtml(f.name)}</td>
      <td class="feat-value">${escHtml(f.value)}</td>
      <td class="feat-shap ${isPos ? 'shap-pos' : 'shap-neg'}">
        <div class="shap-bar-wrap">
          <div class="shap-bar ${isPos ? 'shap-bar-pos' : 'shap-bar-neg'}" style="width:${barWidth}%"></div>
          <span>${isPos ? '+' : ''}${f.shap.toFixed(4)}</span>
        </div>
      </td>`;
    tbody.appendChild(tr);
  });

  // Feature descriptions
  const descList = document.getElementById('feat-desc-list');
  descList.innerHTML = '';
  Object.entries(e.feature_descriptions || {}).forEach(([name, desc]) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${escHtml(name)}:</strong> ${escHtml(desc)}`;
    descList.appendChild(li);
  });
}

function renderTextTabs(caseId, textOrder) {
  const tabBar = document.getElementById('text-tab-bar');
  tabBar.innerHTML = '';
  TEXT_LABELS.forEach((label) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (label === currentTextLabel ? ' active' : '');
    const rated = isTextRated(caseId, label);
    btn.textContent = `Text ${label}`;
    if (rated) btn.classList.add('tab-done');
    btn.dataset.label = label;
    btn.addEventListener('click', () => {
      // Save any dirty rating before switching
      saveCurrentRating(caseId);
      currentTextLabel = label;
      renderEvalView();
    });
    tabBar.appendChild(btn);
  });
}

function isTextRated(caseId, label) {
  const r = userState.ratings[caseId];
  if (!r || !r[label]) return false;
  return CONFIG.criteria.every((c) => r[label][c.id] != null);
}

function renderCurrentText(caseId, textOrder) {
  const llm = textOrder[currentTextLabel];
  const narrative = caseMap[caseId].narratives[llm];

  document.getElementById('text-label-heading').textContent = `Text ${currentTextLabel}`;

  const contentEl = document.getElementById('narrative-content');
  // Render markdown if marked.js is available
  if (window.marked) {
    contentEl.innerHTML = marked.parse(narrative);
  } else {
    contentEl.textContent = narrative;
  }
}

function renderRatingForm(caseId) {
  const form = document.getElementById('rating-form');
  form.innerHTML = '';
  const existing = (userState.ratings[caseId] || {})[currentTextLabel] || {};

  CONFIG.criteria.forEach((criterion) => {
    const current = existing[criterion.id];
    const section = document.createElement('div');
    section.className = 'criterion-section';
    section.innerHTML = `
      <div class="criterion-header">
        <span class="criterion-name">${escHtml(criterion.name)}</span>
        <span class="criterion-desc">${escHtml(criterion.description)}</span>
      </div>
      <div class="likert-row" data-criterion="${criterion.id}">
        ${[1, 2, 3, 4, 5].map((v) => `
          <label class="likert-btn ${current === v ? 'selected' : ''}">
            <input type="radio" name="${criterion.id}" value="${v}" ${current === v ? 'checked' : ''}>
            <span class="likert-num">${v}</span>
            <span class="likert-anchor">${criterion.anchors[v] ? escHtml(criterion.anchors[v]) : ''}</span>
          </label>`).join('')}
      </div>`;
    form.appendChild(section);
  });

}

function saveCurrentRating(caseId) {
  if (!userState.ratings[caseId]) userState.ratings[caseId] = {};
  if (!userState.ratings[caseId][currentTextLabel]) {
    userState.ratings[caseId][currentTextLabel] = {};
  }

  CONFIG.criteria.forEach((criterion) => {
    const input = document.querySelector(`input[name="${criterion.id}"]:checked`);
    if (input) {
      userState.ratings[caseId][currentTextLabel][criterion.id] = parseInt(input.value, 10);
    }
  });

  setUserState(currentUser, userState);
}

function updateNavButtons(caseId) {
  const prevBtn = document.getElementById('prev-text-btn');
  const nextBtn = document.getElementById('next-text-btn');
  const submitBtn = document.getElementById('submit-case-btn');

  const idx = TEXT_LABELS.indexOf(currentTextLabel);
  prevBtn.disabled = idx === 0;
  nextBtn.style.display = idx < 3 ? 'inline-block' : 'none';

  const allTextsRated = TEXT_LABELS.every((l) => isTextRated(caseId, l));
  submitBtn.style.display = allTextsRated ? 'inline-block' : 'none';
  submitBtn.disabled = false;
}

function advanceText() {
  const caseId = userState.caseIds[currentCaseIndex];
  saveCurrentRating(caseId);
  const idx = TEXT_LABELS.indexOf(currentTextLabel);
  if (idx < 3) {
    currentTextLabel = TEXT_LABELS[idx + 1];
    renderEvalView();
  }
}

function retreatText() {
  const caseId = userState.caseIds[currentCaseIndex];
  saveCurrentRating(caseId);
  const idx = TEXT_LABELS.indexOf(currentTextLabel);
  if (idx > 0) {
    currentTextLabel = TEXT_LABELS[idx - 1];
    renderEvalView();
  }
}

function submitCase() {
  const caseId = userState.caseIds[currentCaseIndex];
  saveCurrentRating(caseId);

  if (!isCaseComplete(caseId)) {
    const unrated = TEXT_LABELS.filter((l) => !isTextRated(caseId, l));
    alert(`Please rate all criteria for Text ${unrated.join(', ')} before submitting.`);
    return;
  }

  // Advance to next case
  currentCaseIndex++;

  const sessionEnd = Math.min(sessionStartIndex + casesPerSessionFor(currentUser), userState.caseIds.length);
  const totalDone = getRatedCaseCount();

  if (currentCaseIndex >= userState.caseIds.length) {
    // All cases complete
    showDoneView();
  } else if (currentCaseIndex >= sessionEnd) {
    // Session complete
    showSessionCompleteView();
  } else {
    currentTextLabel = getFirstUnratedText(userState.caseIds[currentCaseIndex]);
    renderEvalView();
  }
}

// ── Session complete view ─────────────────────────────────────
function showSessionCompleteView() {
  showView('session-complete-view');

  userState.sessionHistory.push(new Date().toISOString());
  setUserState(currentUser, userState);

  const completed = getRatedCaseCount();
  const total = userState.caseIds.length;
  document.getElementById('sc-stats').textContent =
    `${completed} of ${total} cases complete (${completed * 4} / ${total * 4} text evaluations).`;

  const remaining = total - completed;
  document.getElementById('sc-remaining').textContent =
    remaining > 0
      ? `${remaining} cases remaining. Please take a short break and continue when ready.`
      : '';
}

// ── Done view ─────────────────────────────────────────────────
function showDoneView() {
  showView('done-view');
  document.getElementById('done-user').textContent = currentUser;
  const total = userState.caseIds.length;
  document.getElementById('done-count').textContent = `${total * 4} text evaluations across ${total} patient cases.`;
}

// ── Data export ───────────────────────────────────────────────
function buildExportPayload() {
  const ratings = [];
  userState.caseIds.forEach((caseId, idx) => {
    const r = userState.ratings[caseId];
    if (!r) return;
    const textOrder = userState.textOrders[caseId];
    const caseData = caseMap[caseId];
    const entry = {
      case_index: idx + 1,
      case_id: caseId,
      dataset: caseData.dataset,
      sample_idx: caseData.sample_idx,
      text_order: textOrder,   // { A: llmName, B: ... }
      ratings: {},
      preference: r.preference || null,
    };
    TEXT_LABELS.forEach((label) => {
      if (r[label]) entry.ratings[label] = r[label];
    });
    if (Object.keys(entry.ratings).length > 0) {
      ratings.push(entry);
    }
  });

  return {
    user_id: currentUser,
    exported_at: new Date().toISOString(),
    total_cases_assigned: userState.caseIds.length,
    cases_completed: getRatedCaseCount(),
    ratings,
  };
}

function downloadSessionData() {
  downloadJSON(buildExportPayload(), `xai_eval_${currentUser}_${datestamp()}.json`);
}

function downloadAllData() {
  downloadJSON(buildExportPayload(), `xai_eval_${currentUser}_ALL_${datestamp()}.json`);
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function datestamp() {
  return new Date().toISOString().slice(0, 10);
}

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showView(id) {
  document.querySelectorAll('.view').forEach((el) => el.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

// ── Likert click delegation ───────────────────────────────────
document.addEventListener('change', (e) => {
  if (e.target.type === 'radio' && e.target.name !== 'preference') {
    // Update visual selection
    const row = e.target.closest('.likert-row');
    if (row) {
      row.querySelectorAll('.likert-btn').forEach((btn) => btn.classList.remove('selected'));
      e.target.closest('.likert-btn').classList.add('selected');
    }
    // Auto-advance: save & update nav
    const caseId = userState?.caseIds[currentCaseIndex];
    if (caseId) {
      // Check if all criteria for current text are now filled
      const allFilled = CONFIG.criteria.every((c) => {
        return document.querySelector(`input[name="${c.id}"]:checked`);
      });
      if (allFilled) {
        saveCurrentRating(caseId);
        updateNavButtons(caseId);
        renderTextTabs(caseId, userState.textOrders[caseId]);
      }
    }
  }
  if (e.target.type === 'radio' && e.target.name === 'preference') {
    const row = e.target.closest('.pref-row');
    if (row) {
      row.querySelectorAll('.pref-btn').forEach((btn) => btn.classList.remove('selected'));
      e.target.closest('.pref-btn').classList.add('selected');
    }
  }
});
