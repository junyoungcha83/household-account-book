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
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 한국 카드사 결제 SMS/RCS 본문 파싱 — 하나/신한/삼성/현대/KB/우리/롯데/NH 등 공통 패턴 커버
// 반환: { amount, merchant, date } 또는 null
function parseCardSms(body) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/ /g, ' ');  // NBSP → space

  // 1) 금액 추출 — 우선순위: "금액 X원" (RCS) → "X원 일시불/할부" (SMS) → 첫 N원
  let amount = 0;
  const amountPatterns = [
    /금액\s*[:\s\n]*\s*([\d,]+)\s*원/,           // RCS 카드 UI
    /승인[\s\S]{0,40}?([\d,]+)\s*원/,             // "승인 ... X원"
    /([\d,]+)\s*원\s*(?:일시불|할부)/,            // "X원 일시불/할부"
    /\b([\d,]{3,})\s*원\b/,                        // 백업: 첫 X원 (3자리+ 콤마 또는 숫자)
  ];
  for (const p of amountPatterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (n > 0) { amount = n; break; }
    }
  }
  if (!amount) return null;

  // 2) 가맹점 추출
  let merchant = '';
  const merchantPatterns = [
    /사용처\s*[:\s\n]*\s*([^\n\r]+?)(?:\s*거래시간|[\n\r])/,        // RCS
    /가맹점\s*[:\s\n]*\s*([^\n\r]+?)(?:[\n\r]|$)/,                  // 일부 카드
    /\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{1,2}\s*[\n\r]+\s*([^\n\r]+)/,    // 시각 다음 줄
    /(?:일시불|할부)\s*[\n\r]+\s*([^\n\r]+)/,                       // 일시불/할부 다음 줄
  ];
  for (const p of merchantPatterns) {
    const m = text.match(p);
    if (m && m[1]) {
      merchant = m[1].trim();
      // 흔한 잡음 단어 컷
      merchant = merchant.replace(/(?:누적|잔여|승인|취소|이용내역).*$/u, '').trim();
      if (merchant) break;
    }
  }

  // 3) 날짜 (MM/DD HH:MM 패턴, 연도는 오늘 기준 — 연말/연초 경계 보정)
  const today = new Date();
  let date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const dm = text.match(/(\d{1,2})[\/.\-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/);
  if (dm) {
    const mm = parseInt(dm[1], 10);
    const dd = parseInt(dm[2], 10);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      let y = today.getFullYear();
      // 1월에 12월 SMS 받으면 작년
      if (today.getMonth() === 0 && mm === 12) y -= 1;
      // 12월에 1월 SMS 받으면 (해 넘기는 일정 등) 내년 — 드물지만 보정
      else if (today.getMonth() === 11 && mm === 1) y += 1;
      date = `${y}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    }
  }

  return { amount, merchant, date };
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

    // 매크로 전용 — SMS 본문을 통째로 받아 서버에서 파싱
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

      const parsed = parseCardSms(smsText);
      if (!parsed) {
        return json({
          error: 'parse_failed',
          hint: '금액(원) 패턴을 못 찾았습니다. SMS 본문을 확인하세요.',
          received_chars: smsText.length,
        }, 422, cors);
      }

      const source = String(body.source || 'card-sms').slice(0, 32);
      const note = String(body.note || '').trim().slice(0, 200);

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

      const category = classifyCategory(parsed.merchant, stateObj.category_rules, stateObj.categories);
      const txn = {
        id: genId(),
        date: parsed.date,
        amount: parsed.amount,
        merchant: parsed.merchant || '(가맹점 미상)',
        note, category, source,
      };
      stateObj.transactions.push(txn);

      const newRaw = JSON.stringify(stateObj);
      if (newRaw.length > MAX_BYTES) {
        return json({ error: 'too_large', limit: MAX_BYTES, size: newRaw.length }, 413, cors);
      }
      await env.HOUSEHOLD.put(KEY, newRaw);
      return json({ ok: true, id: txn.id, amount: txn.amount, merchant: txn.merchant, category: txn.category, date: txn.date }, 200, cors);
    }

    if (url.pathname === '/' || url.pathname === '/api/health') {
      return json({ ok: true, service: 'household-account-book-api' }, 200, cors);
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};
