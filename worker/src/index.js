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

// 가맹점명 → 카테고리 자동 분류 (last-wins 룰 매칭)
function classifyCategory(merchant, rules, categories) {
  if (!merchant || !Array.isArray(rules)) return categories.includes('기타') ? '기타' : categories[0];
  const m = String(merchant).trim();
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r && r.pattern && m.includes(r.pattern)) return r.category;
  }
  return categories.includes('기타') ? '기타' : categories[0];
}

function genId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function isValidShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  // 최소: transactions 배열만 있으면 OK. 나머지는 클라이언트가 채움
  if (!Array.isArray(parsed.transactions)) return false;
  return true;
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
        return new Response(raw ?? 'null', {
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

    // 단축어/매크로 ingest 전용 — 거래 1건만 추가, INGEST_TOKEN 필요
    if (url.pathname === '/api/transactions' && req.method === 'POST') {
      const token = req.headers.get('X-Ingest-Token') || '';
      if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      let body;
      try { body = await req.json(); }
      catch { return json({ error: 'invalid_json' }, 400, cors); }

      // 필수: amount (양수). 나머지는 보정 가능.
      const amount = Math.round(Number(body.amount) || 0);
      if (amount <= 0) return json({ error: 'invalid_amount' }, 400, cors);

      const merchant = String(body.merchant || '').trim().slice(0, 80);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '')
        ? body.date
        : new Date().toISOString().slice(0, 10);
      const note = String(body.note || '').trim().slice(0, 200);
      const source = String(body.source || 'card-sms').slice(0, 32);

      // 현재 상태 read → 거래 추가 → write (atomic 아님 — 동시 ingest 시 last-wins.
      //  SMS 결제는 시간 분산되어 충돌 드뭄. 누락 시 사용자가 수동 추가)
      const raw = await env.HOUSEHOLD.get(KEY);
      let stateObj;
      try { stateObj = raw ? JSON.parse(raw) : null; } catch { stateObj = null; }
      if (!stateObj || !Array.isArray(stateObj.transactions)) {
        stateObj = {
          version: 1, transactions: [], incomes: [],
          categories: ['식비','교통비','학원비','의류구매비','기타'],
          budgets: {}, category_rules: [],
        };
      }

      // 카테고리: 클라이언트가 보낸 게 있으면 우선, 없으면 룰 매칭, 그래도 없으면 "기타"
      const requestedCat = String(body.category || '').trim();
      const category = (requestedCat && stateObj.categories.includes(requestedCat))
        ? requestedCat
        : classifyCategory(merchant, stateObj.category_rules, stateObj.categories);

      const txn = { id: genId(), date, amount, merchant, note, category, source };
      stateObj.transactions.push(txn);

      const newRaw = JSON.stringify(stateObj);
      if (newRaw.length > MAX_BYTES) {
        return json({ error: 'too_large', limit: MAX_BYTES, size: newRaw.length }, 413, cors);
      }
      await env.HOUSEHOLD.put(KEY, newRaw);
      return json({ ok: true, id: txn.id, category, date }, 200, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'household-account-book-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
