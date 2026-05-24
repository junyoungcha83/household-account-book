// household-account-book 데이터 동기화 API
// - GET  /api/data  : 누구나 읽기 (전체 JSON 반환)
// - PUT  /api/data  : X-Edit-Token 헤더가 EDIT_TOKEN 과 일치할 때만 저장
//
// KV: HOUSEHOLD (단일 키 "household-data")
// Secret: EDIT_TOKEN (편집 비밀번호)

const KEY = 'household-data';
const MAX_BYTES = 8 * 1024 * 1024;  // 8MB — KV 값 한도(25MB) 내 안전 마진

const ALLOWED_ORIGINS = [
  'https://junyoungcha83.github.io',
  'http://localhost:8001',
  'http://localhost:8000',
  'http://127.0.0.1:8001',
];

function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, X-Ingest-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// 서버 측 default 룰 — 클라이언트 default.json 과 동일.
// KV state.category_rules 가 비어있을 때 SMS ingest 가 분류할 수 있게 백업으로 가짐.
const DEFAULT_RULES = [
  { pattern: '스타벅스', category: '식비' },
  { pattern: '이디야', category: '식비' },
  { pattern: '메가엠지씨', category: '식비' },
  { pattern: '메가커피', category: '식비' },
  { pattern: '컴포즈', category: '식비' },
  { pattern: '올리브영', category: '기타' },
  { pattern: '지하철', category: '교통비' },
  { pattern: '택시', category: '교통비' },
  { pattern: '버스', category: '교통비' },
  { pattern: '카카오T', category: '교통비' },
  { pattern: 'GS25', category: '식비' },
  { pattern: 'CU', category: '식비' },
  { pattern: '씨유', category: '식비' },
  { pattern: '세븐일레븐', category: '식비' },
  { pattern: '이마트', category: '식비' },
  { pattern: '홈플러스', category: '식비' },
  { pattern: '유니클로', category: '의류구매비' },
  { pattern: 'ZARA', category: '의류구매비' },
];

// 가맹점명 → 카테고리 자동 분류 (last-wins 룰 매칭)
// 사용자 룰 우선, 없으면 default 룰 백업
function classifyCategory(merchant, rules, categories) {
  if (!merchant) return categories.includes('기타') ? '기타' : categories[0];
  const m = String(merchant).trim();
  const userRules = Array.isArray(rules) ? rules : [];
  // 1) 사용자 학습 룰 우선 (last-wins)
  for (let i = userRules.length - 1; i >= 0; i--) {
    const r = userRules[i];
    if (r && r.pattern && m.includes(r.pattern) && categories.includes(r.category)) {
      return r.category;
    }
  }
  // 2) default 룰 백업
  for (let i = DEFAULT_RULES.length - 1; i >= 0; i--) {
    const r = DEFAULT_RULES[i];
    if (m.includes(r.pattern) && categories.includes(r.category)) return r.category;
  }
  return categories.includes('기타') ? '기타' : categories[0];
}

function genId() {
  return 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// v1 (transactions + incomes) → v2 (entries + type) 자동 마이그레이션. idempotent.
function migrateToV2(loaded) {
  if (!loaded || typeof loaded !== 'object') return null;
  if (loaded.version === 2 && Array.isArray(loaded.entries)) return loaded;
  const entries = [];
  for (const t of (Array.isArray(loaded.transactions) ? loaded.transactions : [])) {
    entries.push({
      id: t.id || genId(),
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
      id: i.id || genId(),
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
    categories: Array.isArray(loaded.categories) && loaded.categories.length
      ? loaded.categories
      : ['식비','교통비','학원비','의류구매비','기타'],
    budgets: (loaded.budgets && typeof loaded.budgets === 'object') ? loaded.budgets : {},
    category_rules: Array.isArray(loaded.category_rules) ? loaded.category_rules : [],
  };
}

// 한국 금융 SMS/RCS 본문 → type(expense/income) 자동 판단 + 필드 추출
// 카드 결제 (expense) · 은행 입금 (income) 모두 처리
// 반환: { type, amount, merchant|source, date } 또는 null (금액 못 찾으면)
function parseFinanceSms(body) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/ /g, ' ');

  // 1) 금액 (공통)
  let amount = 0;
  const amountPatterns = [
    /금액\s*[:\s\n]*\s*([\d,]+)\s*원/,
    /입금\s*[:\s\n]*\s*([\d,]+)\s*원/,
    /(?:입금|받음|수령|승인)[\s\S]{0,40}?([\d,]+)\s*원/,
    /([\d,]+)\s*원\s*(?:일시불|할부|입금|이체)/,
    /\b([\d,]{3,})\s*원\b/,
  ];
  for (const p of amountPatterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (n > 0) { amount = n; break; }
    }
  }
  if (!amount) return null;

  // 2) 날짜 (공통, MM/DD HH:MM 또는 MM-DD)
  const today = new Date();
  let date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const dm = text.match(/(\d{1,2})[\/.\-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/);
  if (dm) {
    const mm = parseInt(dm[1], 10);
    const dd = parseInt(dm[2], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      let y = today.getFullYear();
      if (today.getMonth() === 0 && mm === 12) y -= 1;
      else if (today.getMonth() === 11 && mm === 1) y += 1;
      date = `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    }
  }

  // 3) type 판정 (income 시그널 우선)
  const isIncome =
    /입금|받음|수령|급여|월급|이체\s*입금/.test(text) &&
    !/이체\s*출금|출금/.test(text);

  if (isIncome) {
    // 입금원/출처 추출 — 한국어/괄호/㈜ 로 시작하는 토큰만 (날짜·시간·금액 숫자 제외)
    const STOPWORDS = /^(?:입금|잔액|잔여|이체|승인|취소|발신|일시불|할부|급여|월급|확인된|받음|수령|적요)$/;
    const idx = text.search(/입금|급여|월급|받음|수령/);
    let source = '';
    if (idx >= 0) {
      // 입금 키워드 *이후* 200자 (은행명·`[Web발신]` 같은 앞쪽 토큰 무시)
      const ctx = text.slice(idx, idx + 200);
      const tokens = ctx.match(/[가-힣㈜()][가-힣A-Za-z0-9㈜()·\-_]{1,29}/g) || [];
      for (const t of tokens) {
        // 끝의 "님" 제거 (예: "김철수님" → "김철수")
        const trimmed = t.replace(/님$/u, '').trim();
        if (STOPWORDS.test(trimmed)) continue;
        if (trimmed.length < 2) continue;
        source = trimmed;
        break;
      }
    }
    if (!source) source = '수입';
    return { type: 'income', amount, source, date };
  }

  // 4) expense — 가맹점 추출
  let merchant = '';
  const merchantPatterns = [
    /사용처\s*[:\s\n]*\s*([^\n\r]+?)(?:\s*거래시간|[\n\r])/,
    /가맹점\s*[:\s\n]*\s*([^\n\r]+?)(?:[\n\r]|$)/,
    /\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{1,2}\s*[\n\r]+\s*([^\n\r]+)/,
    /(?:일시불|할부)\s*[\n\r]+\s*([^\n\r]+)/,
  ];
  for (const p of merchantPatterns) {
    const m = text.match(p);
    if (m && m[1]) {
      merchant = m[1].trim().replace(/(?:누적|잔여|승인|취소|이용내역).*$/u, '').trim();
      if (merchant) break;
    }
  }
  return { type: 'expense', amount, merchant, date };
}

// 하위 호환: 기존 호출 (지금은 sms-ingest 만 사용하지만 안전)
function parseCardSms(body) {
  const r = parseFinanceSms(body);
  if (!r || r.type !== 'expense') return null;
  return { amount: r.amount, merchant: r.merchant, date: r.date };
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// v1 (transactions/incomes) 또는 v2 (entries) 양쪽 받음
function isValidShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return Array.isArray(parsed.entries) || Array.isArray(parsed.transactions);
}

// state read + v2 보장 (없으면 빈 v2)
async function readStateV2(env) {
  const raw = await env.HOUSEHOLD.get(KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch {}
  const migrated = migrateToV2(parsed);
  return migrated || {
    version: 2, entries: [],
    categories: ['식비','교통비','학원비','의류구매비','기타'],
    budgets: {}, category_rules: [],
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        const raw = await env.HOUSEHOLD.get(KEY);
        // v1 데이터면 자동으로 v2 로 변환해서 반환 (KV 에는 아직 v1 그대로 — 다음 PUT 시 굳어짐)
        let out = 'null';
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            const migrated = migrateToV2(parsed);
            out = JSON.stringify(migrated);
          } catch { out = raw; }
        }
        return new Response(out, {
          headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      if (req.method === 'PUT') {
        const token = req.headers.get('X-Edit-Token') || '';
        if (!env.EDIT_TOKEN || token !== env.EDIT_TOKEN) {
          return json({ error: 'unauthorized' }, 401, cors);
        }
        const body = await req.text();
        if (body.length > MAX_BYTES) {
          return json({ error: 'too_large', limit: MAX_BYTES, size: body.length }, 413, cors);
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json({ error: 'invalid_json' }, 400, cors);
        }
        if (!isValidShape(parsed)) {
          return json({ error: 'invalid_shape' }, 400, cors);
        }
        await env.HOUSEHOLD.put(KEY, body);
        return json({ ok: true, bytes: body.length }, 200, cors);
      }

      return json({ error: 'method_not_allowed' }, 405, cors);
    }

    // 단축어/매크로 ingest 전용 — 거래 1건 추가 (구조화). INGEST_TOKEN 필요.
    // body.type === "income" 이면 수입 entry, 아니면 지출.
    if (url.pathname === '/api/transactions' && req.method === 'POST') {
      const token = req.headers.get('X-Ingest-Token') || '';
      if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400, cors); }

      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return json({ error: 'invalid_amount' }, 400, cors);

      const type = body.type === 'income' ? 'income' : 'expense';
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '')
        ? body.date
        : new Date().toISOString().slice(0, 10);
      const note = String(body.note || '').trim().slice(0, 200);
      const ingest_source = String(body.source || 'card-sms').slice(0, 32);

      const stateObj = await readStateV2(env);

      let entry;
      if (type === 'income') {
        const src = String(body.income_source || body.merchant || '수입').trim().slice(0, 60);
        entry = { id: genId(), type: 'income', date, amount, source: src, note, ingest_source };
      } else {
        const merchant = String(body.merchant || '').trim().slice(0, 80);
        const requestedCat = String(body.category || '').trim();
        const category = (requestedCat && stateObj.categories.includes(requestedCat))
          ? requestedCat
          : classifyCategory(merchant, stateObj.category_rules, stateObj.categories);
        entry = { id: genId(), type: 'expense', date, amount, merchant, category, note, source: ingest_source };
      }
      stateObj.entries.push(entry);

      const newRaw = JSON.stringify(stateObj);
      if (newRaw.length > MAX_BYTES) {
        return json({ error: 'too_large', limit: MAX_BYTES, size: newRaw.length }, 413, cors);
      }
      await env.HOUSEHOLD.put(KEY, newRaw);
      return json({ ok: true, id: entry.id, type, date, amount }, 200, cors);
    }

    // 매크로 전용 — SMS 본문 통째로 받아 서버에서 파싱 (income/expense 자동 판단)
    if (url.pathname === '/api/sms-ingest' && req.method === 'POST') {
      const token = req.headers.get('X-Ingest-Token') || '';
      if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400, cors); }

      const smsText = String(body.body || body.text || '').trim();
      if (!smsText) return json({ error: 'empty_body' }, 400, cors);

      const parsed = parseFinanceSms(smsText);
      if (!parsed) {
        return json({
          error: 'parse_failed',
          hint: '금액(원) 패턴을 못 찾았습니다. SMS 본문을 확인하세요.',
          received_chars: smsText.length,
        }, 422, cors);
      }

      const ingest_source = String(body.source || 'card-sms').slice(0, 32);
      const note = String(body.note || '').trim().slice(0, 200);

      const stateObj = await readStateV2(env);

      let entry;
      if (parsed.type === 'income') {
        entry = {
          id: genId(), type: 'income', date: parsed.date, amount: parsed.amount,
          source: parsed.source || '수입', note, ingest_source,
        };
      } else {
        const category = classifyCategory(parsed.merchant, stateObj.category_rules, stateObj.categories);
        entry = {
          id: genId(), type: 'expense', date: parsed.date, amount: parsed.amount,
          merchant: parsed.merchant || '(가맹점 미상)', category, note, source: ingest_source,
        };
      }
      stateObj.entries.push(entry);

      const newRaw = JSON.stringify(stateObj);
      if (newRaw.length > MAX_BYTES) {
        return json({ error: 'too_large', limit: MAX_BYTES, size: newRaw.length }, 413, cors);
      }
      await env.HOUSEHOLD.put(KEY, newRaw);
      return json({
        ok: true, id: entry.id, type: entry.type, amount: entry.amount,
        date: entry.date,
        ...(entry.type === 'expense' ? { merchant: entry.merchant, category: entry.category } : { source: entry.source }),
      }, 200, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'household-account-book-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
