// household-account-book — 모바일 가계부 PWA
// 상태는 항상 JSON 한 덩어리로 보관 → localStorage 캐시 + 서버 KV 동기화.

const STORAGE_KEY = 'household-state-v1';
const TOKEN_KEY   = 'household-edit-token';
const LASTM_DISMISS_KEY = 'household-lastm-dismiss';
const API_BASE = 'https://household-account-book-api.junyoung-cha83.workers.dev';
const SAVE_DEBOUNCE_MS = 800;

const DEFAULT_STATE = {
  version: 1,
  transactions: [],
  incomes: [],
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
function nextTxnId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
function nextIncomeId() {
  return 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
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
    if (parsed && Array.isArray(parsed.transactions)) return parsed;
  } catch (e) {}
  return null;
}

function migrate(loaded) {
  return {
    version: 1,
    transactions: Array.isArray(loaded.transactions) ? loaded.transactions : [],
    incomes:      Array.isArray(loaded.incomes) ? loaded.incomes : [],
    categories:   Array.isArray(loaded.categories) && loaded.categories.length ? loaded.categories : DEFAULT_STATE.categories.slice(),
    budgets:      (loaded.budgets && typeof loaded.budgets === 'object') ? loaded.budgets : {},
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
    if (json && Array.isArray(json.transactions)) return json;
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

// ── 집계 ──────────────────────────────────────
function txnsOfMonth(mk) {
  return state.transactions.filter(t => txnMonth(t) === mk);
}
function totalOfMonth(mk) {
  return txnsOfMonth(mk).reduce((s, t) => s + (Number(t.amount) || 0), 0);
}
function byCategoryOfMonth(mk) {
  const out = {};
  for (const c of state.categories) out[c] = 0;
  for (const t of txnsOfMonth(mk)) {
    const c = state.categories.includes(t.category) ? t.category : '기타';
    out[c] = (out[c] || 0) + (Number(t.amount) || 0);
  }
  return out;
}
function budgetOf(mk) {
  return state.budgets[mk] || { total: 0, by_category: {} };
}
function incomesOfMonth(mk) {
  return state.incomes.filter(i => (i.date || '').slice(0, 7) === mk);
}
function totalIncomeOfMonth(mk) {
  return incomesOfMonth(mk).reduce((s, i) => s + (Number(i.amount) || 0), 0);
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
  // 결산 카드
  const used = totalOfMonth(viewMonth);
  const bud  = budgetOf(viewMonth);
  const total = bud.total || 0;
  const pct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
  const over = total > 0 && used > total;
  const card = document.getElementById('monthSummary');
  card.className = 'summary-card' + (over ? ' over' : '');
  card.innerHTML = `
    <div class="total-row">
      <span class="label">${escapeHtml(fmtMonth(viewMonth))} 사용</span>
      <span class="amount">${fmtWon(used)}</span>
    </div>
    ${total > 0 ? `
      <div class="budget-line">예산 ${fmtWon(total)} · ${pct}% ${over ? `(₩${(used-total).toLocaleString('ko-KR')} 초과)` : ''}</div>
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

  // 거래 리스트 (날짜 내림차순 + 같은 날 묶음)
  const txns = txnsOfMonth(viewMonth).slice().sort((a,b) => (b.date||'').localeCompare(a.date||'') || (b.id||'').localeCompare(a.id||''));
  document.getElementById('txnCount').textContent = txns.length ? `${txns.length}건` : '';
  const listEl = document.getElementById('txnList');
  if (!txns.length) {
    listEl.innerHTML = `<div class="empty-hint">${getEditToken() ? '아직 거래가 없습니다.<br>오른쪽 아래 + 버튼으로 추가하세요.' : '아직 거래가 없습니다.<br>편집 모드(🔒)로 들어가 추가하세요.'}</div>`;
    return;
  }
  let lastDay = '';
  const rows = txns.map(t => {
    const day = (t.date || '').slice(5);  // "MM-DD"
    let dayHeader = '';
    if (day !== lastDay) {
      dayHeader = `<div class="day-header">${escapeHtml(day)}</div>`;
      lastDay = day;
    }
    return dayHeader + `
      <div class="txn-row" data-id="${escapeAttr(t.id)}">
        <div class="left">
          <div class="merchant">${escapeHtml(t.merchant || '(이름 없음)')}</div>
          ${t.note ? `<div class="note">${escapeHtml(t.note)}</div>` : ''}
        </div>
        <span class="category">${escapeHtml(t.category || '기타')}</span>
        <span class="amount">${fmtWon(t.amount)}</span>
      </div>
    `;
  }).join('');
  listEl.innerHTML = rows;
  listEl.querySelectorAll('.txn-row').forEach(el => {
    el.onclick = () => {
      if (!getEditToken()) return;
      openTxnDialog(el.dataset.id);
    };
  });
}

function renderStats() {
  const used = totalOfMonth(viewMonth);
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
    incBlock.innerHTML = incomes.map(i => `
      <div class="income-row">
        <span class="source">${escapeHtml(i.source || '(이름 없음)')} · ${escapeHtml(i.date)}</span>
        <span class="amount">${fmtWon(i.amount)}</span>
      </div>
    `).join('');
  }
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

  // 수입 입력
  document.getElementById('incomeMonth').value = viewMonth;
  const incList = document.getElementById('incomeList');
  if (!state.incomes.length) {
    incList.innerHTML = '<div class="muted">아직 수입이 없습니다.</div>';
  } else {
    const sorted = state.incomes.slice().sort((a,b) => (b.date||'').localeCompare(a.date||''));
    incList.innerHTML = sorted.map(i => `
      <div class="income-row" data-id="${escapeAttr(i.id)}">
        <span class="source">${escapeHtml(i.date)} · ${escapeHtml(i.source)}</span>
        <span>
          <span class="amount" style="margin-right:8px">${fmtWon(i.amount)}</span>
          <button class="link-btn" data-act="del">삭제</button>
        </span>
      </div>
    `).join('');
    incList.querySelectorAll('[data-act="del"]').forEach(btn => {
      btn.onclick = (e) => {
        if (!ensureEditable()) return;
        const id = e.target.closest('[data-id]').dataset.id;
        state.incomes = state.incomes.filter(i => i.id !== id);
        saveLocal();
        render();
      };
    });
  }

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
  const used = totalOfMonth(lastMK);
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

function openTxnDialog(editId) {
  if (!ensureEditable()) return;
  editTxnId = editId || null;
  amountStr = '0';
  pickedCategory = null;
  const dlg = document.getElementById('txnDialog');
  const fMerchant = document.getElementById('fMerchant');
  const fDate     = document.getElementById('fDate');
  const fNote     = document.getElementById('fNote');
  const footer    = dlg.querySelector('.dialog-footer');
  const title     = document.getElementById('txnDialogTitle');

  if (editTxnId) {
    const t = state.transactions.find(x => x.id === editTxnId);
    if (!t) { editTxnId = null; return; }
    title.textContent = '거래 편집';
    amountStr = String(t.amount || 0);
    fMerchant.value = t.merchant || '';
    fDate.value = t.date || todayStr();
    fNote.value = t.note || '';
    pickedCategory = t.category || null;
    footer.classList.remove('hidden');
  } else {
    title.textContent = '거래 추가';
    fMerchant.value = '';
    fDate.value = todayStr();
    fNote.value = '';
    footer.classList.add('hidden');
  }

  updateAmountDisplay();
  renderCategoryChips();
  if (!dlg.open) dlg.showModal();
  // 모바일에서 키패드만으로 입력 가능 (가맹점 입력은 선택)
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
  const merchant = document.getElementById('fMerchant').value.trim();
  const date = document.getElementById('fDate').value || todayStr();
  const note = document.getElementById('fNote').value.trim();
  const category = pickedCategory || '기타';

  if (editTxnId) {
    const t = state.transactions.find(x => x.id === editTxnId);
    if (!t) return;
    const prevCategory = t.category;
    Object.assign(t, { date, amount, merchant, note, category });
    // 사용자가 자동 추천과 다른 카테고리를 골랐다면 룰 학습
    if (merchant && category !== prevCategory) learnCategory(merchant, category);
  } else {
    const t = { id: nextTxnId(), date, amount, merchant, note, category, source: 'manual' };
    state.transactions.push(t);
    // 학습: 새 입력 + 가맹점 있을 때 (자동 추천을 그대로 받은 경우도 룰을 강화)
    if (merchant) learnCategory(merchant, category);
  }
  saveLocal();
  closeTxnDialog();
  render();
}

function deleteTxn() {
  if (!editTxnId) return;
  if (!confirm('이 거래를 삭제할까요?')) return;
  state.transactions = state.transactions.filter(t => t.id !== editTxnId);
  saveLocal();
  closeTxnDialog();
  render();
}

// ── 수입 ────────────────────────────────────
function addIncome() {
  if (!ensureEditable()) return;
  const date = (document.getElementById('incomeMonth').value || viewMonth) + '-01';
  const source = document.getElementById('incomeSource').value.trim() || '수입';
  const amount = parseInt(document.getElementById('incomeAmount').value, 10) || 0;
  if (amount <= 0) { alert('금액을 입력하세요.'); return; }
  state.incomes.push({ id: nextIncomeId(), date, source, amount });
  document.getElementById('incomeSource').value = '';
  document.getElementById('incomeAmount').value = '';
  saveLocal();
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
      if (!parsed || !Array.isArray(parsed.transactions)) throw new Error('형식이 올바르지 않아요');
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
  document.getElementById('btnIncomeAdd').onclick = addIncome;
  document.getElementById('btnCatAdd').onclick    = addCategory;
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
    // 변경 감지: transactions 개수 또는 마지막 id 비교 (가벼움)
    const oldKey = state.transactions.length + '|' + (state.transactions[state.transactions.length-1]?.id || '');
    const newKey = remote.transactions.length + '|' + (remote.transactions[remote.transactions.length-1]?.id || '');
    if (oldKey === newKey) return;
    state = migrate(remote);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    setSyncStatus(getEditToken() ? 'saved' : 'readonly');
    render();
  });
})();
