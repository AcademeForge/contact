'use strict';

/* ─── CONFIG ──────────────────────────────────────────────────────────────── */
const API_BASE   = 'https://afooyyydhlwngzssgqih.supabase.co/functions/v1/contact-requests-unified';
const SUBMIT_URL = API_BASE;
const STATUS_URL = API_BASE + '/status';
const CACHE_KEY  = 'af_collab_requests_cache_v1';
const CACHE_TTL  = 10 * 60 * 1000; // 10 minutes
const PAGE_LIMIT = 20;

/* ─── STATE ───────────────────────────────────────────────────────────────── */
let currentTab   = 'submit';
let allRequests  = [];
let filteredList = [];
let currentPage  = 1;
let isLoading    = false;

/* ─── UTILS ───────────────────────────────────────────────────────────────── */
const $   = id => document.getElementById(id);
const esc = t  => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

/* ─── THEME SYNC ──────────────────────────────────────────────────────────── */
function syncTheme() {
  document.documentElement.setAttribute('data-theme',
    localStorage.getItem('af_dark_mode') === '1' ? 'dark' : 'light');
}
syncTheme();
window.addEventListener('storage', e => { if (e.key === 'af_dark_mode') syncTheme(); });

/* ─── TOAST ───────────────────────────────────────────────────────────────── */
let _toastTimer = null;

function showToast(msg, type = 'info', title = '') {
  const wrap = $('toastWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  const labels = { ok: 'Done', info: 'Info', err: 'Error', warn: 'Notice' };
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<div class="toast-body">
    <p>${esc(title || labels[type] || 'Info')}</p>
    <p>${esc(msg)}</p>
  </div>
  <span class="toast-x" onclick="this.parentElement.remove()">×</span>`;
  wrap.appendChild(el);
  _toastTimer = setTimeout(() => { if (el && el.parentElement) el.remove(); }, 3500);
}

/* ─── CACHE (namespaced per uuid) ─────────────────────────────────────────── */
function cacheKeyFor(uuid) { return CACHE_KEY + ':' + (uuid || 'anon'); }

function cacheSet(uuid, data) {
  try {
    localStorage.setItem(cacheKeyFor(uuid), JSON.stringify({ ts: Date.now(), d: data }));
  } catch (_) { /* storage full or unavailable */ }
}

function cacheGet(uuid) {
  try {
    const raw = localStorage.getItem(cacheKeyFor(uuid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || Date.now() - parsed.ts > CACHE_TTL) return null;
    return parsed.d;
  } catch { return null; }
}

function cacheClear(uuid) {
  try { localStorage.removeItem(cacheKeyFor(uuid)); } catch (_) {}
}

/* ─── SESSION ─────────────────────────────────────────────────────────────── */
function getSession() {
  return {
    loggedIn: localStorage.getItem('af_student_logged_in') === 'true',
    uuid:     localStorage.getItem('af_student_uuid')   || '',
    id:       localStorage.getItem('af_student_id')     || '',
    email:    localStorage.getItem('af_student_email')  || '',
    name:     localStorage.getItem('af_student_name')   || '',
    mobile:   localStorage.getItem('af_student_mobile') ||
              localStorage.getItem('af_student_phone')  || '',
  };
}

/* ─── TAB SWITCH ──────────────────────────────────────────────────────────── */
function switchTab(tab) {
  currentTab = tab;
  $('tabSubmit').classList.toggle('active', tab === 'submit');
  $('tabStatus').classList.toggle('active', tab === 'status');
  $('panelSubmit').classList.toggle('hidden', tab !== 'submit');
  $('panelStatus').classList.toggle('hidden', tab !== 'status');
  if (tab === 'status') loadStatus(false);
}

/* ─── STATUS NORMALISATION ────────────────────────────────────────────────── */
const STATUS_NORM = {
  pending:     'pending',
  in_review:   'in_review',
  solved:      'solved',
  open:        'open',
  in_progress: 'in_progress',
  resolved:    'resolved',
  rejected:    'rejected',
  closed:      'closed',
};

function normStatus(raw) {
  const k = (raw || '').toLowerCase().replace(/[^a-z_]/g, '');
  return STATUS_NORM[k] || k || 'unknown';
}

function statusLabel(s) {
  const map = {
    pending:     'Pending Review',
    in_review:   'In Review',
    solved:      'Responded',
    open:        'Open',
    in_progress: 'In Progress',
    resolved:    'Resolved',
    rejected:    'Not Proceeding',
    closed:      'Closed',
    unknown:     'Unknown',
  };
  return map[s] || s;
}

function isOpenStatus(s) {
  return s === 'pending' || s === 'in_review' || s === 'open';
}
function isProgressStatus(s) {
  return s === 'in_progress' || s === 'in_review';
}
function isResolvedStatus(s) {
  return s === 'solved' || s === 'resolved';
}

/* ─── BOOLEAN NORMALISATION ───────────────────────────────────────────────── */
function normBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string')  return v.toUpperCase() === 'T' || v === 'true' || v === '1';
  return !!v;
}

/* ─── REASON META (idea stages) ───────────────────────────────────────────── */
const REASON_META = {
  just_an_idea:      { icon: '💡', label: 'Concept Stage' },
  has_prototype:     { icon: '🛠️', label: 'Has Prototype / MVP' },
  needs_tech:        { icon: '⚙️', label: 'Needs Tech Help' },
  needs_design:      { icon: '🎨', label: 'Needs Design Help' },
  wants_collab:      { icon: '🤝', label: 'Looking for Co-founder' },
  existing_product:  { icon: '📦', label: 'Existing Product' },
  open_source:       { icon: '🌐', label: 'Open Source / Community' },
  other:             { icon: '💬', label: 'Other' },
};

function reasonMeta(key) {
  return REASON_META[key] || { icon: '💡', label: key || 'Idea' };
}

/* ─── COPY REQUEST ID ─────────────────────────────────────────────────────── */
function copyId(id) {
  navigator.clipboard.writeText(id)
    .then(() => showToast('Pitch ID copied to clipboard.', 'ok', 'Copied!'))
    .catch(() => showToast('Please copy manually: ' + id, 'warn', 'Copy manually'));
}

/* ─── RENDER ONE CARD ─────────────────────────────────────────────────────── */
function renderCard(r, idx) {
  const rm        = reasonMeta(r.contact_reason);
  const sKey      = normStatus(r.status);
  const teamRead  = normBool(r.team_read);
  const reqSolved = normBool(r.request_solved);
  const shortId   = (r.id || '').toString().slice(0, 8).toUpperCase();
  const delay     = Math.min(idx * 0.04, 0.36);
  const desc      = (r.problem_description || '').trim();

  return `
  <div class="req-card" style="animation-delay:${delay}s;">
    <div class="rc-head">
      <div class="rc-reason">
        <span class="rc-reason-icon">${esc(rm.icon)}</span>
        ${esc(rm.label)}
      </div>
      <div class="rc-id">
        <span>#${esc(shortId)}</span>
        <button class="rc-copy" onclick="copyId('${esc(r.id || '')}')" aria-label="Copy ID">⎘</button>
      </div>
    </div>
    <div class="rc-body">
      ${desc ? `<div class="rc-desc">${esc(desc)}</div>` : ''}
      <div class="rc-badges">
        <span class="badge s-${esc(sKey)}">${esc(statusLabel(sKey))}</span>
      </div>
      ${r.status_note
        ? `<div class="rc-note">💬 ${esc(r.status_note)}</div>`
        : ''}
      <div class="rc-flags">
        <span class="flag ${teamRead ? 'read' : 'unread'}">
          ${teamRead ? '✓ Seen by Team' : '⏳ Awaiting Review'}
        </span>
        <span class="flag ${reqSolved ? 'solved' : 'pending'}">
          ${reqSolved ? '✅ Resolved' : '🔄 Being Reviewed'}
        </span>
      </div>
      <div class="rc-meta">
        <span class="rc-meta-item">📅 ${esc(relTime(r.created_at))}</span>
        ${r.updated_at && r.updated_at !== r.created_at
          ? `<span class="rc-meta-item">🔄 Updated ${esc(relTime(r.updated_at))}</span>`
          : ''}
      </div>
    </div>
  </div>`;
}

/* ─── SKELETONS ───────────────────────────────────────────────────────────── */
function renderSkeletons(n = 3) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += `<div class="skeleton-card" style="height:${148 + (i % 2) * 24}px;animation-delay:${i * 0.07}s;"></div>`;
  }
  return h;
}

/* ─── FILTER / SEARCH / SORT ──────────────────────────────────────────────── */
function applyFilters() {
  const q      = ($('searchInp') ? $('searchInp').value : '').toLowerCase().trim();
  const status = $('filterSel') ? $('filterSel').value : '';
  const order  = $('sortSel')   ? $('sortSel').value   : 'desc';

  filteredList = allRequests.filter(r => {
    const sKey = normStatus(r.status);
    if (status && sKey !== status && r.status !== status) return false;
    if (q) {
      const hay = [r.contact_reason, r.status, r.status_note, r.problem_description]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filteredList.sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    return order === 'asc' ? ta - tb : tb - ta;
  });
}

/* ─── SUMMARY STRIP ───────────────────────────────────────────────────────── */
function updateSummary(requests) {
  const strip = $('summaryStrip');
  if (!strip) return;
  if (!requests || !requests.length) {
    strip.style.display = 'none';
    return;
  }
  strip.style.display = '';
  $('sumTotal').textContent = requests.length;

  let openCnt = 0, progCnt = 0, resCnt = 0;
  for (const r of requests) {
    const s = normStatus(r.status);
    if (isOpenStatus(s))     openCnt++;
    if (isProgressStatus(s)) progCnt++;
    if (isResolvedStatus(s)) resCnt++;
  }
  $('sumOpen').textContent = openCnt;
  $('sumProg').textContent = progCnt;
  $('sumRes').textContent  = resCnt;
}

/* ─── RENDER STATUS LIST ──────────────────────────────────────────────────── */
function renderStatusList() {
  const content = $('statusContent');
  if (!content) return;
  applyFilters();

  if (!filteredList.length) {
    const hasData = allRequests.length > 0;
    content.innerHTML = `
      <div class="state-box">
        <div class="state-emoji">${hasData ? '🔍' : '📭'}</div>
        <div class="state-title">${hasData ? 'No Matches' : 'No Pitches Yet'}</div>
        <div class="state-sub">${hasData
          ? 'Try adjusting your filter or search term.'
          : "You haven't submitted any product ideas yet."
        }</div>
        ${!hasData
          ? `<button class="state-btn" onclick="switchTab('submit')">Share Your Idea →</button>`
          : ''}
      </div>`;
    $('pagRow').classList.add('hidden');
    return;
  }

  const totalPages = Math.ceil(filteredList.length / PAGE_LIMIT);
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_LIMIT;
  const slice = filteredList.slice(start, start + PAGE_LIMIT);

  content.innerHTML = slice.map((r, i) => renderCard(r, i)).join('');

  if (filteredList.length > PAGE_LIMIT) {
    $('pagRow').classList.remove('hidden');
    $('pagPrev').disabled = currentPage <= 1;
    $('pagNext').disabled = currentPage >= totalPages;
    $('pagInfo').textContent = `Page ${currentPage} of ${totalPages}`;
  } else {
    $('pagRow').classList.add('hidden');
  }
}

/* ─── LOAD STATUS (API) ───────────────────────────────────────────────────── */
async function loadStatus(forceRefresh = false) {
  if (isLoading) return;

  const session = getSession();
  const content = $('statusContent');
  if (!content) return;

  if (!session.uuid || !session.email) {
    content.innerHTML = `
      <div class="state-box">
        <div class="state-emoji">🔐</div>
        <div class="state-title">Login Required</div>
        <div class="state-sub">Your session doesn't have valid account details. Please log in to view your submitted ideas.</div>
        <button class="state-btn" onclick="window.location.href='/student/index.html'">Log In</button>
      </div>`;
    return;
  }

  if (!forceRefresh) {
    const cached = cacheGet(session.uuid);
    if (cached) {
      allRequests = cached;
      updateSummary(allRequests);
      if ($('controls')) $('controls').style.display = '';
      renderStatusList();
      silentRefresh(session);
      return;
    }
  }

  isLoading = true;
  content.innerHTML = renderSkeletons(3);
  if ($('controls')) $('controls').style.display = 'none';
  if ($('summaryStrip')) $('summaryStrip').style.display = 'none';
  if ($('pagRow')) $('pagRow').classList.add('hidden');

  try {
    const requests = await fetchRequests(session);
    allRequests = requests;
    cacheSet(session.uuid, requests);
    updateSummary(allRequests);
    if ($('controls')) $('controls').style.display = '';
    currentPage = 1;
    renderStatusList();
  } catch (err) {
    if (err.code === 401) {
      content.innerHTML = `
        <div class="state-box">
          <div class="state-emoji">🔐</div>
          <div class="state-title">Session Expired</div>
          <div class="state-sub">${esc(err.message || 'Please log in again to view your submitted ideas.')}</div>
          <button class="state-btn" onclick="window.location.href='/student/index.html'">Log In Again</button>
        </div>`;
    } else {
      content.innerHTML = `
        <div class="state-box">
          <div class="state-emoji">📡</div>
          <div class="state-title">Could Not Load Pitches</div>
          <div class="state-sub">${esc(err.message || 'A network error occurred.')}</div>
          <button class="state-btn" onclick="loadStatus(true)">Try Again</button>
        </div>`;
    }
    showToast(err.message || 'Failed to load pitches.', 'err', 'Error');
  } finally {
    isLoading = false;
  }
}

async function silentRefresh(session) {
  try {
    const requests = await fetchRequests(session);
    allRequests = requests;
    cacheSet(session.uuid, requests);
    updateSummary(allRequests);
    renderStatusList();
  } catch { /* silent — user already sees cached data */ }
}

async function fetchRequests(session, attempt = 1) {
  const MAX_ATTEMPTS = 2;
  const TIMEOUT_MS   = 12000;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(STATUS_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_uuid: session.uuid,
        email:        session.email,
        limit: 100,
        page:  1,
      }),
    });
    clearTimeout(timer);

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (res.status === 401) {
      const e = new Error(data.message || 'Authentication required. Please log in again.');
      e.code = 401;
      throw e;
    }
    if (res.status === 429) throw new Error(data.message || 'Too many requests. Please wait and try again.');
    if (!res.ok)            throw new Error(data.message || `Server error (${res.status}).`);
    if (!data.success)      throw new Error(data.message || 'Unexpected server response.');

    return Array.isArray(data.requests) ? data.requests : [];

  } catch (err) {
    clearTimeout(timer);
    if (err.code === 401) throw err;
    if (err.name === 'AbortError') throw new Error('Request timed out. Please check your connection.');
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, attempt * 800));
      return fetchRequests(session, attempt + 1);
    }
    throw err;
  }
}

/* ─── FILTER / SORT HANDLERS ──────────────────────────────────────────────── */
let _debounce = null;

function onSearch() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => { currentPage = 1; renderStatusList(); }, 200);
}
function onFilter() { currentPage = 1; renderStatusList(); }
function onSort()   { currentPage = 1; renderStatusList(); }

function goPage(dir) {
  currentPage = Math.max(1, currentPage + dir);
  renderStatusList();
  const content = $('statusContent');
  if (content) content.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─── CHAR COUNTER ────────────────────────────────────────────────────────── */
function initDescCounter() {
  const ta  = $('fDesc');
  const cnt = $('descCount');
  if (!ta || !cnt) return;
  ta.addEventListener('input', () => {
    const len = ta.value.length;
    cnt.textContent = `${len} / 2000`;
    cnt.style.color = len > 1800 ? 'var(--red, #ef4444)' : 'var(--text-muted)';
  });
}

/* ─── SUBMIT IDEA ─────────────────────────────────────────────────────────── */
async function submitIdea() {
  const btn    = $('submitBtn');
  const msgEl  = $('submitMsg');
  const status = $('ideaFormStatus');

  const name   = ($('fName').value  || '').trim();
  const email  = ($('fEmail').value || '').trim().toLowerCase();
  const phone  = ($('fPhone').value || '').trim();
  const reason = $('fReason').value;
  const desc   = ($('fDesc').value  || '').trim();

  const setMsg = (type, text) => {
    if (!msgEl) return;
    msgEl.className  = 'f-msg' + (type ? ' ' + type : '');
    msgEl.textContent = text;
  };

  // Validation
  if (name.length < 2) {
    setMsg('err', 'Please enter your full name (min. 2 characters).');
    return;
  }
  if (!email || !email.includes('@')) {
    setMsg('err', 'Please enter a valid email address.');
    return;
  }
  if (!reason) {
    setMsg('err', 'Please select the stage your idea is at.');
    return;
  }
  if (desc.length < 10) {
    setMsg('err', 'Please describe your idea in more detail (min. 10 characters).');
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Sending…';
  setMsg('', '');

  // Hide any previous status banner
  if (status) {
    status.style.display = 'none';
    status.textContent = '';
    status.className = 'alert';
  }

  try {
    const session = getSession();
    const ctrl    = new AbortController();
    const timer   = setTimeout(() => ctrl.abort(), 15000);

    const res = await fetch(SUBMIT_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name:           name,
        email:               email,
        mobile_number:       phone || null,
        contact_reason:      reason,
        problem_description: desc,
        student_uuid:        session.uuid  || null,
        student_name:        session.name  || name,
        type:                'collab_idea',
        page:                window.location.pathname,
      }),
    });

    clearTimeout(timer);

    let data;
    try { data = await res.json(); } catch { data = {}; }

    if (!res.ok || data.ok === false || !data.success) {
      throw new Error(data.message || data.error || `Submission failed (${res.status}).`);
    }

    const shortId = (data.requestId || '').toString().slice(0, 8).toUpperCase();
    const successMsg = shortId
      ? `✓ Idea submitted! Reference: #${shortId} — We'll review your pitch and get back to you within 2–5 working days.`
      : '✓ Your idea has been submitted! We\'ll review your pitch and get back to you within 2–5 working days.';

    setMsg('ok', successMsg);

    if (status) {
      status.textContent = successMsg;
      status.className = 'alert';
      status.style.display = 'block';
      status.style.backgroundColor = 'rgba(16, 185, 129, 0.1)';
      status.style.color = '#10b981';
      status.style.border = '1px solid rgba(16, 185, 129, 0.25)';
    }

    showToast('Your product idea has been received!', 'ok', 'Submitted!');

    // Reset non-personal fields
    $('fReason').value = '';
    $('fDesc').value   = '';
    if ($('fPhone')) $('fPhone').value = '';
    if ($('descCount')) $('descCount').textContent = '0 / 2000';

    // Invalidate cache so My Pitches tab refreshes
    cacheClear(session.uuid);

    // Switch to status tab after short delay
    setTimeout(() => { switchTab('status'); }, 2800);

  } catch (err) {
    const errMsg = err.name === 'AbortError'
      ? 'Request timed out. Please check your connection and try again.'
      : (err.message || 'Submission failed. Please try again.');

    setMsg('err', errMsg);

    if (status) {
      status.textContent = errMsg;
      status.className = 'alert';
      status.style.display = 'block';
      status.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
      status.style.color = '#ef4444';
      status.style.border = '1px solid rgba(239, 68, 68, 0.2)';
    }

    showToast(errMsg, 'err', 'Error');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ─── NAV: SECURITY ───────────────────────────────────────────────────────── */
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (
    e.key === 'F12' ||
    (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key.toUpperCase())) ||
    (e.ctrlKey && e.key.toUpperCase() === 'U')
  ) e.preventDefault();
});

/* ─── INIT ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Pre-fill from session if logged in
  const s = getSession();
  if (s.name   && $('fName'))  $('fName').value  = s.name;
  if (s.email  && $('fEmail')) $('fEmail').value = s.email;
  if (s.mobile && $('fPhone')) $('fPhone').value = s.mobile;

  initDescCounter();

  // Start on submit tab
  switchTab('submit');
});
