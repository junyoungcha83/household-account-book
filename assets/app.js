// household-account-book — 모바일 가계부 PWA
// 상태는 항상 JSON 한 덩어리로 보관 → localStorage 캐시 + 서버 KV 동기화.

const STORAGE_KEY = 'household-state-v1';
const TOKEN_KEY   = 'household-edit-token';
const LASTM_DISMISS_KEY = 'household-lastm-dismiss';
const API_BASE = 'https://household-account-book-api.junyoung-cha83.workers.dev';
const SAVE_DEBOUNCE_MS = 800;

const DEFAULT_STATE = {
  version: 2,
  entries: [],
  categories: ['식비', '교통비', '학원비', '의류구매비', '기타'],
  budgets: {},
  category_rules: [],
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));
let viewMonth = monthKey(new Date());   // "YYYY-MM" — 메인/통계가 보고있는 달
let activeTab = 'book';
let editTxnId = null;   // 입력 모달에서 편집 중인 거래 id (null이면 새 추가)

// ── 유틸 ──────────────────────────────────────────
function monthKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtMonth(mk) {
  const [y, m] = mk.split('-');
  return `${y}년 ${parseInt(m,10)}월`;
}
function fmtWon(n) {
  return '₩' + (n || 0).toLocaleString('ko-KR');
}
function fmtWonShort(n) {
  if (!n) return '₩0';
  if (n >= 1e8) return `₩${(n/1e8).toFixed(1)}억`;
  if (n >= 1e4) return `₩${Math.round(n/1e4).toLocaleString('ko-KR')}만`;
  return '₩' + n.toLocaleString('ko-KR');
}
function nextEntryId() {
  return 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
function shiftMonth(mk, delta) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

// 거래 → "YYYY-MM" 추출
function txnMonth(t) { return (t.date || '').slice(0, 7); }

// ── 영속화 / 동기화 ──────────────────────────────
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // v1 (transactions) 또는 v2 (entries) 둘 다 받음
    if (parsed && (Array.isArray(parsed.entries) || Array.isArray(parsed.transactions))) return parsed;
  } catch (e) {}
  return null;
}

// v1 (transactions + incomes) 또는 v2 (entries) → v2 통합. idempotent.
function migrate(loaded) {
  if (loaded && loaded.version === 2 && Array.isArray(loaded.entries)) {
    return {
      version: 2,
      entries: loaded.entries,
      categories: Array.isArray(loaded.categories) && loaded.categories.length ? loaded.categories : DEFAULT_STATE.categories.slice(),
      budgets: (loaded.budgets && typeof loaded.budgets === 'object') ? loaded.budgets : {},
      category_rules: Array.isArray(loaded.category_rules) ? loaded.category_rules : [],
    };
  }
  // v1 → v2
  const entries = [];
  for (const t of (Array.isArray(loaded.transactions) ? loaded.transactions : [])) {
    entries.push({
      id: t.id || nextEntryId(),
      type: 'expense',
      date: t.date || '',
      amount: Number(t.amount) || 0,
      merchant: t.merchant || '',
      category: t.category || '기타',
      note: t.note || '',
      source: t.source || 'manual',
    });
  }
  for (const i of (Array.isArray(loaded.incomes) ? loaded.incomes : [])) {
    entries.push({
      id: i.id || nextEntryId(),
      type: 'income',
      date: i.date || '',
      amount: Number(i.amount) || 0,
      source: i.source || '수입',
      note: i.note || '',
      ingest_source: 'manual',
    });
  }
  return {
    version: 2,
    entries,
    categories: Array.isArray(loaded.categories) && loaded.categories.length ? loaded.categories : DEFAULT_STATE.categories.slice(),
    budgets: (loaded.budgets && typeof loaded.budgets === 'object') ? loaded.budgets : {},
    category_rules: Array.isArray(loaded.category_rules) ? loaded.category_rules : [],
  };
}

let _saveTimer = null;
let _saveCtrl  = null;

function setSyncStatus(s) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    idle:        { text: '',          cls: '' },
    pending:     { text: '변경됨',    cls: 'pending' },
    saving:      { text: '저장중…',   cls: 'saving' },
    saved:       { text: '저장됨 ✓',  cls: 'saved' },
    error:       { text: '오프라인',  cls: 'error' },
    unauthorized:{ text: '토큰 오류', cls: 'error' },
    readonly:    { text: '읽기전용',  cls: 'readonly' },
  };
  const m = map[s] || map.idle;
  el.textContent = m.text;
  el.className   = 'sync-status ' + m.cls;
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { alert('localStorage 저장 실패 — 용량 초과 가능성'); }

  const token = getEditToken();
  if (!token) { setSyncStatus('readonly'); return; }

  setSyncStatus('pending');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(pushToServer, SAVE_DEBOUNCE_MS);
}

async function pushToServer() {
  const token = getEditToken();
  if (!token) return;
  if (_saveCtrl) _saveCtrl.abort();
  _saveCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state),
      signal: _saveCtrl.signal,
    });
    if (res.ok) setSyncStatus('saved');
    else if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      updateEditUI();
      setSyncStatus('unauthorized');
      alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.');
    }
    else if (res.status === 413) {
      setSyncStatus('error');
      alert('데이터 크기 초과 — 오래된 거래를 정리해 보세요.');
    }
    else setSyncStatus('error');
  } catch (e) {
    if (e.name !== 'AbortError') setSyncStatus('error');
  }
}

async function fetchFromServer() {
  try {
    const res = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    // 서버가 v1 → v2 자동 변환해서 보내지만 안전하게 양쪽 받음
    if (json && (Array.isArray(json.entries) || Array.isArray(json.transactions))) return json;
  } catch (e) {}
  return null;
}

async function loadInitial() {
  // 1) 서버 우선
  const remote = await fetchFromServer();
  if (remote) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(remote)); } catch (e) {}
    return migrate(remote);
  }
  // 2) localStorage 캐시
  const local = loadLocal();
  if (local) return migrate(local);
  // 3) 번들 기본값
  try {
    const res = await fetch('data/default.json?t=' + Date.now());
    if (res.ok) {
      const json = await res.json();
      if (json) return migrate(json);
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

// ── 편집 토큰 ─────────────────────────────────
function getEditToken() { return localStorage.getItem(TOKEN_KEY) || ''; }

function promptEditToken() {
  const cur = getEditToken();
  const v = prompt(cur ? '편집 비밀번호 (비우면 로그아웃):' : '편집 비밀번호를 입력하세요:', cur);
  if (v === null) return;
  if (v === '') localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, v.trim());
  updateEditUI();
  if (getEditToken()) pushToServer();
  else setSyncStatus('readonly');
}

function updateEditUI() {
  const has = !!getEditToken();
  document.body.classList.toggle('read-only', !has);
  const btn = document.getElementById('btnEdit');
  if (btn) btn.textContent = has ? '🔓' : '🔒';
  if (!has) setSyncStatus('readonly');
}

// ── 카테고리 룰 (자동 분류) ─────────────────────
function suggestCategory(merchant) {
  if (!merchant) return null;
  const m = merchant.trim();
  // 최근에 학습된 룰 우선 (배열 끝에 추가/갱신)
  for (let i = state.category_rules.length - 1; i >= 0; i--) {
    const r = state.category_rules[i];
    if (r && r.pattern && m.includes(r.pattern)) return r.category;
  }
  return null;
}

function learnCategory(merchant, category) {
  if (!merchant || !category) return;
  const pattern = merchant.trim();
  if (!pattern) return;
  // 기존 동일 pattern 제거 후 끝에 추가 (last-wins)
  state.category_rules = state.category_rules.filter(r => r.pattern !== pattern);
  state.category_rules.push({ pattern, category });
}

// ── 집계 (entries 기반) ─────────────────────────
function entriesOfMonth(mk) {
  return state.entries.filter(e => (e.date || '').slice(0, 7) === mk);
}
function expensesOfMonth(mk)     { return entriesOfMonth(mk).filter(e => e.type === 'expense'); }
function incomesOfMonth(mk)      { return entriesOfMonth(mk).filter(e => e.type === 'income'); }
function totalExpenseOfMonth(mk) { return expensesOfMonth(mk).reduce((s,e) => s + (Number(e.amount)||0), 0); }
function totalIncomeOfMonth(mk)  { return incomesOfMonth(mk).reduce((s,e) => s + (Number(e.amount)||0), 0); }
function byCategoryOfMonth(mk) {
  const out = {};
  for (const c of state.categories) out[c] = 0;
  for (const e of expensesOfMonth(mk)) {
    const c = state.categories.includes(e.category) ? e.category : '기타';
    out[c] = (out[c] || 0) + (Number(e.amount) || 0);
  }
  return out;
}
function budgetOf(mk) {
  return state.budgets[mk] || { total: 0, by_category: {} };
}

// ── 렌더 ─────────────────────────────────────
function render() {
  document.getElementById('monthLabel').textContent = fmtMonth(viewMonth);
  if (activeTab === 'book')     renderBook();
  if (activeTab === 'stats')    renderStats();
  if (activeTab === 'settings') renderSettings();
  renderLastMonthBanner();
}

function renderBook() {
  // 결산 카드 — 수입/지출/잔액 3줄
  const used   = totalExpenseOfMonth(viewMonth);
  const income = totalIncomeOfMonth(viewMonth);
  const balance = income - used;
  const bud  = budgetOf(viewMonth);
  const total = bud.total || 0;
  const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
  const over = total > 0 && used > total;
  const card = document.getElementById('monthSummary');
  card.className = 'summary-card' + (over ? ' over' : '');
  card.innerHTML = `
    <div class="summary-rows">
      <div class="srow income">
        <span class="srow-label">수입</span>
        <span class="srow-amount">+${fmtWon(income)}</span>
      </div>
      <div class="srow expense">
        <span class="srow-label">지출</span>
        <span class="srow-amount">−${fmtWon(used)}</span>
      </div>
      <div class="srow balance ${balance < 0 ? 'negative' : ''}">
        <span class="srow-label">잔액</span>
        <span class="srow-amount">${balance < 0 ? '−' : ''}${fmtWon(Math.abs(balance))}</span>
      </div>
    </div>
    ${total > 0 ? `
      <div class="budget-line">예산 ${fmtWon(total)} · ${pct}% ${over ? `(${fmtWon(used-total)} 초과)` : ''}</div>
      <div class="progress"><div class="progress-fill" style="width:${Math.min(100,pct)}%"></div></div>
    ` : `
      <div class="budget-line">예산 미설정 (설정에서 등록)</div>
    `}
  `;

  // 카테고리 진행
  const byCat = byCategoryOfMonth(viewMonth);
  const catList = document.getElementById('categoryList');
  catList.innerHTML = state.categories.map(cat => {
    const u = byCat[cat] || 0;
    const b = (bud.by_category && bud.by_category[cat]) || 0;
    const p = b > 0 ? Math.round(u / b * 100) : 0;
    let cls = 'safe', tag = '';
    if (b > 0) {
      if (u > b)      { cls = 'over'; tag = `₩${(u-b).toLocaleString('ko-KR')} 초과`; }
      else if (p >= 80) { cls = 'warn'; tag = `${p}%`; }
      else              { cls = 'safe'; tag = `${p}%`; }
    } else {
      cls = 'safe'; tag = '예산 X';
    }
    const fillPct = b > 0 ? Math.min(100, p) : 0;
    return `
      <div class="cat-row ${cls}">
        <span class="cat-name">${escapeHtml(cat)}</span>
        <span class="cat-amount"><span class="used">${fmtWonShort(u)}</span> / ${fmtWonShort(b)}</span>
        <span class="cat-bar-wrap"><span class="cat-bar-fill" style="width:${fillPct}%"></span></span>
        <span class="cat-status">${escapeHtml(tag)}</span>
      </div>
    `;
  }).join('');

  // 거래 리스트 (지출+수입 한 목록, 날짜 내림차순 + 같은 날 묶음)
  const entries = entriesOfMonth(viewMonth).slice().sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.id||'').localeCompare(a.id||''));
  document.getElementById('txnCount').textContent = entries.length ? `${entries.length}건` : '';
  const listEl = document.getElementById('txnList');
  if (!entries.length) {
    listEl.innerHTML = `<div class="empty-hint">${getEditToken() ? '아직 거래가 없습니다.<br>오른쪽 아래 + 버튼으로 추가하세요.' : '아직 거래가 없습니다.<br>편집 모드(🔒)로 들어가 추가하세요.'}</div>`;
    return;
  }
  let lastDay = '';
  const rows = entries.map(e => {
    const day = (e.date || '').slice(5);
    let dayHeader = '';
    if (day !== lastDay) {
      dayHeader = `<div class="day-header">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    if (e.type === 'income') {
      const sourceName = e.source || '수입';
      if (isSalarySource(sourceName)) {
        return dayHeader + `
          <div class="txn-row income salary-row" data-id="${escapeAttr(e.id)}" data-revealed="false">
            <div class="left">
              <div class="merchant">${escapeHtml(sourceName)}</div>
              ${e.note ? `<div class="note">${escapeHtml(e.note)}</div>` : ''}
            </div>
            <span class="category income-tag">수입</span>
            <span class="amount income-amount blurred">+${fmtWon(e.amount)}</span>
            <button type="button" class="btn-reveal" data-act="reveal-salary">보기</button>
          </div>
        `;
      }
      return dayHeader + `
        <div class="txn-row income" data-id="${escapeAttr(e.id)}">
          <div class="left">
            <div class="merchant">${escapeHtml(sourceName)}</div>
            ${e.note ? `<div class="note">${escapeHtml(e.note)}</div>` : ''}
          </div>
          <span class="category income-tag">수입</span>
          <span class="amount income-amount">+${fmtWon(e.amount)}</span>
        </div>
      `;
    }
    return dayHeader + `
      <div class="txn-row expense" data-id="${escapeAttr(e.id)}">
        <div class="left">
          <div class="merchant">${escapeHtml(e.merchant || '(이름 없음)')}</div>
          ${e.note ? `<div class="note">${escapeHtml(e.note)}</div>` : ''}
        </div>
        <span class="category">${escapeHtml(e.category || '기타')}</span>
        <span class="amount">${fmtWon(e.amount)}</span>
      </div>
    `;
  }).join('');
  listEl.innerHTML = rows;
  bindSalaryRevealButtons(listEl);
  listEl.querySelectorAll('.txn-row').forEach(el => {
    el.onclick = () => {
      if (!getEditToken()) return;
      openTxnDialog(el.dataset.id);
    };
  });
}

function renderStats() {
  const used = totalExpenseOfMonth(viewMonth);
  const bud  = budgetOf(viewMonth);
  const total = bud.total || 0;
  const income = totalIncomeOfMonth(viewMonth);
  const balance = income - used;
  const summary = document.getElementById('statsSummary');
  summary.innerHTML = `
    <div class="row"><span class="label">${escapeHtml(fmtMonth(viewMonth))} 사용</span><span class="value">${fmtWon(used)}</span></div>
    <div class="row"><span class="label">수입</span><span class="value">${fmtWon(income)}</span></div>
    <div class="row"><span class="label">잔액</span><span class="value ${balance < 0 ? 'over' : 'safe'}">${fmtWon(balance)}</span></div>
    ${total > 0 ? `
      <div class="row"><span class="label">예산 대비</span><span class="value ${used > total ? 'over' : 'safe'}">${used > total ? `₩${(used-total).toLocaleString('ko-KR')} 초과` : `₩${(total-used).toLocaleString('ko-KR')} 절약`}</span></div>
    ` : ''}
  `;

  const byCat = byCategoryOfMonth(viewMonth);
  const bars = document.getElementById('statsBars');
  const maxUsed = Math.max(1, ...state.categories.map(c => Math.max(byCat[c] || 0, (bud.by_category && bud.by_category[c]) || 0)));
  bars.innerHTML = state.categories.map(cat => {
    const u = byCat[cat] || 0;
    const b = (bud.by_category && bud.by_category[cat]) || 0;
    const fillPct = Math.min(100, u / maxUsed * 100);
    let cls = '', delta = '', deltaCls = '';
    if (b > 0) {
      if (u > b)      { cls = 'over'; delta = `${fmtWonShort(u-b)} 초과`; deltaCls = 'over'; }
      else if (u > b*0.8) { cls = 'warn'; delta = `${fmtWonShort(b-u)} 남음`; deltaCls = 'safe'; }
      else              { delta = `${fmtWonShort(b-u)} 절약`; deltaCls = 'safe'; }
    } else {
      delta = '예산 X';
    }
    return `
      <div class="bar-row ${cls}">
        <div class="name">
          <span>${escapeHtml(cat)}</span>
          <span>${fmtWon(u)}</span>
        </div>
        <div class="amounts">예산 ${fmtWonShort(b)} · <span class="delta ${deltaCls}">${escapeHtml(delta)}</span></div>
        <div class="bar"><div class="bar-fill" style="width:${fillPct}%"></div></div>
      </div>
    `;
  }).join('');

  const incomes = incomesOfMonth(viewMonth);
  const incBlock = document.getElementById('incomeBlock');
  if (!incomes.length) {
    incBlock.innerHTML = `<div class="muted">이번달 수입 없음 (설정에서 추가)</div>`;
  } else {
    incBlock.innerHTML = incomes.map(i => {
      const sourceName = (i.source || '').trim();
      if (isSalarySource(sourceName)) {
        return `
          <div class="income-row salary-row" data-revealed="false">
            <span class="source">${escapeHtml(sourceName)} · ${escapeHtml(i.date)}</span>
            <span class="amount-wrap">
              <span class="amount blurred">${fmtWon(i.amount)}</span>
              <button type="button" class="btn-reveal" data-act="reveal-salary">보기</button>
            </span>
          </div>
        `;
      }
      return `
        <div class="income-row">
          <span class="source">${escapeHtml(sourceName || '(이름 없음)')} · ${escapeHtml(i.date)}</span>
          <span class="amount">${fmtWon(i.amount)}</span>
        </div>
      `;
    }).join('');
    bindSalaryRevealButtons(incBlock);
  }
}

// "월급" 또는 "급여" 가 들어간 source 면 민감 항목으로 취급 (대소문자/공백 무관)
function isSalarySource(source) {
  if (!source) return false;
  const s = String(source).trim();
  return s.includes('월급') || s.includes('급여');
}

function bindSalaryRevealButtons(scopeEl) {
  scopeEl.querySelectorAll('[data-act="reveal-salary"]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();   // 부모 row 의 클릭(편집 다이얼로그) 차단
      const row = btn.closest('.salary-row');
      if (!row) return;
      const amount = row.querySelector('.amount');
      const revealed = row.dataset.revealed === 'true';
      if (revealed) {
        amount.classList.add('blurred');
        btn.textContent = '보기';
        row.dataset.revealed = 'false';
      } else {
        amount.classList.remove('blurred');
        btn.textContent = '숨기기';
        row.dataset.revealed = 'true';
      }
    };
  });
}

function renderSettings() {
  // 예산 폼
  const bud = budgetOf(viewMonth);
  const form = document.getElementById('budgetForm');
  form.innerHTML = `
    <label>
      <span class="label-text">전체</span>
      <input type="number" inputmode="numeric" data-cat="__total__" value="${bud.total || ''}" placeholder="0" />
    </label>
    ${state.categories.map(cat => `
      <label>
        <span class="label-text">${escapeHtml(cat)}</span>
        <input type="number" inputmode="numeric" data-cat="${escapeAttr(cat)}" value="${(bud.by_category && bud.by_category[cat]) || ''}" placeholder="0" />
      </label>
    `).join('')}
  `;
  form.querySelectorAll('input').forEach(inp => {
    inp.onchange = () => {
      if (!ensureEditable()) { inp.value = ''; return; }
      const v = parseInt(inp.value, 10) || 0;
      const c = inp.dataset.cat;
      if (!state.budgets[viewMonth]) state.budgets[viewMonth] = { total: 0, by_category: {} };
      if (c === '__total__') state.budgets[viewMonth].total = v;
      else                   state.budgets[viewMonth].by_category[c] = v;
      saveLocal();
    };
  });

  // (수입 입력 섹션은 메인 화면 FAB → "수입" 토글로 이동)

  // 카테고리 편집
  const catEdit = document.getElementById('categoryEdit');
  catEdit.innerHTML = state.categories.map((cat, idx) => `
    <div class="cat-edit-row">
      <input type="text" value="${escapeAttr(cat)}" data-idx="${idx}" />
      <button class="btn secondary" data-act="del" data-idx="${idx}">삭제</button>
    </div>
  `).join('');
  catEdit.querySelectorAll('input').forEach(inp => {
    inp.onchange = (e) => {
      if (!ensureEditable()) { e.target.value = state.categories[e.target.dataset.idx]; return; }
      const idx = parseInt(e.target.dataset.idx, 10);
      const newName = e.target.value.trim();
      if (!newName) { e.target.value = state.categories[idx]; return; }
      const oldName = state.categories[idx];
      state.categories[idx] = newName;
      // 기존 거래의 카테고리도 갱신
      for (const t of state.transactions) if (t.category === oldName) t.category = newName;
      // 예산 키 갱신
      for (const mk in state.budgets) {
        const bc = state.budgets[mk].by_category || {};
        if (bc[oldName] !== undefined) { bc[newName] = bc[oldName]; delete bc[oldName]; }
      }
      saveLocal();
      render();
    };
  });
  catEdit.querySelectorAll('[data-act="del"]').forEach(btn => {
    btn.onclick = (e) => {
      if (!ensureEditable()) return;
      const idx = parseInt(e.target.dataset.idx, 10);
      const cat = state.categories[idx];
      if (state.categories.length <= 1) { alert('마지막 카테고리는 삭제할 수 없습니다.'); return; }
      if (!confirm(`"${cat}" 카테고리를 삭제할까요?\n(이 카테고리 거래들은 "기타"로 이동)`)) return;
      // "기타" 보장
      if (!state.categories.includes('기타')) state.categories.push('기타');
      for (const t of state.transactions) if (t.category === cat) t.category = '기타';
      state.categories = state.categories.filter(c => c !== cat);
      // 룰에서도 제거
      state.category_rules = state.category_rules.filter(r => r.category !== cat);
      // 예산에서도 제거
      for (const mk in state.budgets) {
        if (state.budgets[mk].by_category) delete state.budgets[mk].by_category[cat];
      }
      saveLocal();
      render();
    };
  });

  // 자동분류 룰
  const rulesList = document.getElementById('rulesList');
  if (!state.category_rules.length) {
    rulesList.innerHTML = '<div class="muted">아직 학습된 룰 없음.</div>';
  } else {
    const sorted = state.category_rules.slice().reverse();
    rulesList.innerHTML = sorted.map((r, i) => `
      <div class="rule-row" data-pattern="${escapeAttr(r.pattern)}">
        <span><span class="pattern">${escapeHtml(r.pattern)}</span><span class="arrow">→</span><span class="cat">${escapeHtml(r.category)}</span></span>
        <button class="del">×</button>
      </div>
    `).join('');
    rulesList.querySelectorAll('.del').forEach(btn => {
      btn.onclick = (e) => {
        if (!ensureEditable()) return;
        const p = e.target.closest('[data-pattern]').dataset.pattern;
        state.category_rules = state.category_rules.filter(r => r.pattern !== p);
        saveLocal();
        render();
      };
    });
  }
}

function renderLastMonthBanner() {
  // 이번달의 1~7일 사이 + book 탭일 때, 지난달 결산 배너 노출 (사용자가 닫으면 그달 안 표시).
  const banner = document.getElementById('lastMonthBanner');
  banner.classList.add('hidden');
  if (activeTab !== 'book') return;
  const today = new Date();
  const todayMK = monthKey(today);
  if (viewMonth !== todayMK) return;
  if (today.getDate() > 7) return;
  const lastMK = shiftMonth(todayMK, -1);
  const dismissed = (localStorage.getItem(LASTM_DISMISS_KEY) || '') === todayMK;
  if (dismissed) return;
  const used = totalExpenseOfMonth(lastMK);
  if (used === 0) return;  // 지난달 데이터 없으면 안 띄움
  const bud = (state.budgets[lastMK] || {}).total || 0;
  let line;
  if (bud > 0) {
    if (used > bud) line = `<strong>${fmtWonShort(used-bud)}</strong> 초과 (예산 ${fmtWonShort(bud)})`;
    else            line = `<strong>${fmtWonShort(bud-used)}</strong> 절약 (예산 ${fmtWonShort(bud)})`;
  } else {
    line = `예산 미설정`;
  }
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <button class="close" aria-label="닫기">×</button>
    <strong>${escapeHtml(fmtMonth(lastMK))} 결산</strong> · 사용 ${fmtWon(used)} · ${line}
    &nbsp;<a href="#" id="bannerStatsLink">통계 보기</a>
  `;
  banner.querySelector('.close').onclick = () => {
    localStorage.setItem(LASTM_DISMISS_KEY, todayMK);
    banner.classList.add('hidden');
  };
  banner.querySelector('#bannerStatsLink').onclick = (e) => {
    e.preventDefault();
    viewMonth = lastMK;
    setActiveTab('stats');
  };
}

// ── 탭 전환 ──────────────────────────────────
function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tab !== tab));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  render();
}

// ── 거래 입력/편집 모달 ─────────────────────────
let amountStr = '0';
let pickedCategory = null;
let pickedType = 'expense';   // 'expense' | 'income'

function applyTypeMode() {
  // 입력 모달 form의 보임/숨김 전환 (지출 ↔ 수입)
  const expenseRows = document.querySelectorAll('.txn-form .for-expense');
  const incomeRows  = document.querySelectorAll('.txn-form .for-income');
  expenseRows.forEach(el => el.classList.toggle('hidden', pickedType !== 'expense'));
  incomeRows.forEach(el => el.classList.toggle('hidden', pickedType !== 'income'));
  document.querySelectorAll('.type-toggle .tt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === pickedType);
  });
}

function openTxnDialog(editId) {
  if (!ensureEditable()) return;
  editTxnId = editId || null;
  amountStr = '0';
  pickedCategory = null;
  pickedType = 'expense';
  const dlg = document.getElementById('txnDialog');
  const fMerchant = document.getElementById('fMerchant');
  const fSource   = document.getElementById('fSource');
  const fDate     = document.getElementById('fDate');
  const fNote     = document.getElementById('fNote');
  const footer    = dlg.querySelector('.dialog-footer');
  const title     = document.getElementById('txnDialogTitle');

  if (editTxnId) {
    const e = state.entries.find(x => x.id === editTxnId);
    if (!e) { editTxnId = null; return; }
    title.textContent = e.type === 'income' ? '수입 편집' : '지출 편집';
    amountStr = String(e.amount || 0);
    pickedType = e.type || 'expense';
    fMerchant.value = e.merchant || '';
    fSource.value   = e.source || '';
    fDate.value = e.date || todayStr();
    fNote.value = e.note || '';
    pickedCategory = e.category || null;
    footer.classList.remove('hidden');
  } else {
    title.textContent = '거래 추가';
    fMerchant.value = '';
    fSource.value   = '';
    fDate.value = todayStr();
    fNote.value = '';
    footer.classList.add('hidden');
  }

  applyTypeMode();
  updateAmountDisplay();
  renderCategoryChips();
  if (!dlg.open) dlg.showModal();
}

function closeTxnDialog() {
  const dlg = document.getElementById('txnDialog');
  if (dlg.open) dlg.close();
  editTxnId = null;
}

function updateAmountDisplay() {
  document.getElementById('amountDisplay').textContent = (parseInt(amountStr,10) || 0).toLocaleString('ko-KR');
}

function pressKey(k) {
  if (k === 'back') {
    amountStr = amountStr.length > 1 ? amountStr.slice(0,-1) : '0';
  } else if (k === '000') {
    if (amountStr === '0') return;
    amountStr += '000';
    if (amountStr.length > 12) amountStr = amountStr.slice(0,12);
  } else {
    if (amountStr === '0') amountStr = k;
    else amountStr += k;
    if (amountStr.length > 12) amountStr = amountStr.slice(0,12);
  }
  updateAmountDisplay();
}

function renderCategoryChips() {
  const wrap = document.getElementById('fCategoryChips');
  // 추천 적용: pickedCategory가 null이면 merchant로 추정
  if (!pickedCategory) {
    const m = document.getElementById('fMerchant').value;
    pickedCategory = suggestCategory(m) || (state.categories.includes('기타') ? '기타' : state.categories[0]);
  }
  wrap.innerHTML = state.categories.map(c => `
    <button type="button" class="cat-chip${c === pickedCategory ? ' active' : ''}" data-cat="${escapeAttr(c)}">${escapeHtml(c)}</button>
  `).join('');
  wrap.querySelectorAll('.cat-chip').forEach(chip => {
    chip.onclick = () => {
      pickedCategory = chip.dataset.cat;
      renderCategoryChips();
    };
  });
}

function saveTxn() {
  const amount = parseInt(amountStr, 10) || 0;
  if (amount <= 0) { alert('금액을 입력하세요.'); return; }
  const date = document.getElementById('fDate').value || todayStr();
  const note = document.getElementById('fNote').value.trim();

  if (pickedType === 'income') {
    const sourceName = document.getElementById('fSource').value.trim() || '수입';
    if (editTxnId) {
      const e = state.entries.find(x => x.id === editTxnId);
      if (!e) return;
      // type 도 바뀔 수 있음 (지출 → 수입). 필드 전체 재구성.
      const newE = { id: e.id, type: 'income', date, amount, source: sourceName, note, ingest_source: e.ingest_source || 'manual' };
      const idx = state.entries.indexOf(e);
      state.entries[idx] = newE;
    } else {
      state.entries.push({ id: nextEntryId(), type: 'income', date, amount, source: sourceName, note, ingest_source: 'manual' });
    }
  } else {
    const merchant = document.getElementById('fMerchant').value.trim();
    const category = pickedCategory || '기타';
    if (editTxnId) {
      const e = state.entries.find(x => x.id === editTxnId);
      if (!e) return;
      const prevCategory = e.category;
      const newE = { id: e.id, type: 'expense', date, amount, merchant, category, note, source: e.source || 'manual' };
      const idx = state.entries.indexOf(e);
      state.entries[idx] = newE;
      if (merchant && category !== prevCategory) learnCategory(merchant, category);
    } else {
      state.entries.push({ id: nextEntryId(), type: 'expense', date, amount, merchant, category, note, source: 'manual' });
      if (merchant) learnCategory(merchant, category);
    }
  }
  saveLocal();
  closeTxnDialog();
  render();
}

function deleteTxn() {
  if (!editTxnId) return;
  if (!confirm('이 거래를 삭제할까요?')) return;
  state.entries = state.entries.filter(e => e.id !== editTxnId);
  saveLocal();
  closeTxnDialog();
  render();
}

// ── 카테고리 추가 ─────────────────────────────
function addCategory() {
  if (!ensureEditable()) return;
  const inp = document.getElementById('catNewName');
  const name = inp.value.trim();
  if (!name) return;
  if (state.categories.includes(name)) { alert('이미 있는 카테고리'); return; }
  state.categories.push(name);
  inp.value = '';
  saveLocal();
  render();
}

// ── 데이터 내보내기/불러오기 ─────────────────────
function exportJson() {
  const json = JSON.stringify(state, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `household-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJsonFile(file) {
  if (!ensureEditable()) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!parsed || !(Array.isArray(parsed.entries) || Array.isArray(parsed.transactions))) {
        throw new Error('형식이 올바르지 않아요 (entries 또는 transactions 배열 필요)');
      }
      if (!confirm('현재 데이터를 덮어씁니다. 진행할까요?')) return;
      state = migrate(parsed);
      saveLocal();
      render();
    } catch (err) {
      alert('JSON 파싱 실패: ' + err.message);
    }
  };
  reader.readAsText(file);
}

async function refreshFromServer() {
  const remote = await fetchFromServer();
  if (!remote) { alert('서버에서 받지 못했어요 (오프라인이거나 서버 오류).'); return; }
  state = migrate(remote);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  render();
}

// ── 공통 ─────────────────────────────────────
function ensureEditable() {
  if (!getEditToken()) { alert('편집 비밀번호를 먼저 입력하세요 (헤더 🔒).'); return false; }
  return true;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── 부팅 ─────────────────────────────────────
(async function init() {
  state = await loadInitial();
  updateEditUI();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  render();

  // 헤더
  document.getElementById('btnPrevMonth').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); render(); };
  document.getElementById('btnNextMonth').onclick = () => { viewMonth = shiftMonth(viewMonth,  1); render(); };
  document.getElementById('monthLabel').onclick   = () => { viewMonth = monthKey(new Date()); render(); };
  document.getElementById('btnEdit').onclick      = promptEditToken;

  // 탭
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.onclick = () => setActiveTab(b.dataset.tab);
  });

  // FAB
  document.getElementById('btnAdd').onclick = () => openTxnDialog(null);

  // 입력 모달
  document.getElementById('txnCancel').onclick = closeTxnDialog;
  document.getElementById('txnDelete').onclick = deleteTxn;
  document.getElementById('txnForm').onsubmit = (e) => { e.preventDefault(); saveTxn(); };
  document.querySelectorAll('.keypad .key').forEach(k => {
    k.onclick = () => pressKey(k.dataset.k);
  });
  // merchant 변경 시 카테고리 자동 추천 재계산 (사용자가 직접 카테고리 안 골랐을 때만)
  document.getElementById('fMerchant').addEventListener('input', () => {
    // 사용자가 명시적으로 chip을 누른 적이 있으면 자동 변경 안 함 — 단순화: input 시 항상 추천 재계산
    const m = document.getElementById('fMerchant').value;
    const sug = suggestCategory(m);
    if (sug) {
      pickedCategory = sug;
      renderCategoryChips();
    }
  });

  // 설정
  document.getElementById('btnTokenEdit').onclick = promptEditToken;
  document.getElementById('btnCatAdd').onclick    = addCategory;

  // 입력 모달 type 토글
  document.querySelectorAll('.type-toggle .tt-btn').forEach(b => {
    b.onclick = () => { pickedType = b.dataset.type; applyTypeMode(); };
  });
  document.getElementById('btnExport').onclick    = exportJson;
  document.getElementById('btnRefresh').onclick   = refreshFromServer;
  document.getElementById('fileImport').onchange  = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJsonFile(f);
    e.target.value = '';
  };

  // ESC 로 모달 닫기는 dialog 기본 동작
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const dlg = document.getElementById('txnDialog');
      if (dlg.open) closeTxnDialog();
    }
  });

  // 페이지가 다시 보일 때 서버 최신 상태 자동 fetch — 매크로/다른 기기 거래 반영.
  // 단, 저장 펜딩 중이면 건너뜀 (사용자 입력 손실 방지).
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (_saveTimer || _saveCtrl) return;  // 펜딩 PUT 있으면 패스
    const dlg = document.getElementById('txnDialog');
    if (dlg && dlg.open) return;  // 입력 중이면 패스
    const remote = await fetchFromServer();
    if (!remote) return;
    // 변경 감지: entries 개수 + 마지막 id (가벼움)
    const rm = migrate(remote);
    const oldKey = state.entries.length + '|' + (state.entries[state.entries.length-1]?.id || '');
    const newKey = rm.entries.length + '|' + (rm.entries[rm.entries.length-1]?.id || '');
    if (oldKey === newKey) return;
    state = rm;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    setSyncStatus(getEditToken() ? 'saved' : 'readonly');
    render();
  });
})();
