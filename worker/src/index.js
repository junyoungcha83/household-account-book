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

// 자동수신(ingest) 점검 로그 — 성공/실패 모두 KV 문서 안 링버퍼에 적재.
// 매크로→서버 경로가 어디서 끊기는지 앱 설정 탭에서 바로 보이게 하는 용도.
// 최근 INGEST_LOG_MAX 건만 유지. preview 는 80자로 잘라 노출면 최소화.
const INGEST_LOG_MAX = 20;
function recordIngest(stateObj, { result, source, detail, preview }) {
  if (!Array.isArray(stateObj.ingest_log)) stateObj.ingest_log = [];
  stateObj.ingest_log.push({
    at: new Date().toISOString(),
    source: String(source || '').slice(0, 32),
    result: String(result || '').slice(0, 32),
    ...(detail ? { detail: String(detail).slice(0, 120) } : {}),
    ...(preview ? { preview: String(preview).slice(0, 80) } : {}),
  });
  if (stateObj.ingest_log.length > INGEST_LOG_MAX) {
    stateObj.ingest_log = stateObj.ingest_log.slice(-INGEST_LOG_MAX);
  }
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

  // 금액 추출용 텍스트 — 단건 결제가 아닌 누적·할인·예정·실적 등 부가 금액 라인 제거.
  // 표 형식 SMS(하나카드 등)의 들쭉날쭉한 공백(스페이스·탭·NBSP)을 \s 가 모두 흡수하도록.
  const amountText = text
    // 누적금액 / 누적사용액 / 월누적 / 전월누적 / 당월누적 / 연누적 등
    .replace(/(?:월|연|총|전월|당월|일)?\s*누적(?:금액|사용액|이용액|결제액)?\s*[:\s]*[\d,]+\s*원/g, '')
    // 실적금액 / 전월실적 / 당월실적
    .replace(/(?:전월|당월|이번달|지난달)?\s*실적(?:금액)?\s*[:\s]*[\d,]+\s*원/g, '')
    // 할인예정 / 할인금액 / 적립예정 / 적립금
    .replace(/할인\s*(?:예정|금액)?\s*[:\s]*[\d,]+\s*원/g, '')
    .replace(/적립\s*(?:예정|금액|포인트)?\s*[:\s]*[\d,]+\s*원/g, '')
    // 청구예정 / 청구금액 / 결제예정 / 결제금액 (단건 '결제' 가 아니라 라벨)
    .replace(/(?:청구|결제)\s*(?:예정|금액)\s*[:\s]*[\d,]+\s*원/g, '')
    // 한도 / 잔여한도 / 잔액
    .replace(/(?:잔여\s*)?한도\s*[:\s]*[\d,]+\s*원/g, '')
    .replace(/잔액\s*[:\s]*[\d,]+\s*원/g, '');

  // 1) 금액 추출
  let amount = 0;
  // 우선순위 1 — '금액' 라벨이 단독으로 라인을 시작 (표 형식: 금액 60,500원).
  // 음수 lookbehind 로 누적금액·청구금액·할인금액·실적금액 등 합성 라벨 차단.
  const labelOnly = amountText.match(/(?:^|[\n\r])\s*금액\s*[:\s]+([\d,]+)\s*원/);
  if (labelOnly) {
    const n = parseInt(labelOnly[1].replace(/,/g, ''), 10);
    if (n > 0) amount = n;
  }
  // 우선순위 2 — 입금 라벨 (은행 입금 SMS)
  if (!amount) {
    const incomeLabel = amountText.match(/(?:^|[\n\r])\s*입금(?:액)?\s*[:\s]+([\d,]+)\s*원/);
    if (incomeLabel) {
      const n = parseInt(incomeLabel[1].replace(/,/g, ''), 10);
      if (n > 0) amount = n;
    }
  }
  // 우선순위 3~ — 라벨 형식 아닌 SMS (예: '60,500원 일시불') 폴백
  if (!amount) {
    const fallbacks = [
      /(?:입금|받음|수령|승인)[\s\S]{0,40}?([\d,]+)\s*원/,
      /([\d,]+)\s*원\s*(?:일시불|할부|입금|이체)/,
      /\b([\d,]{3,})\s*원\b/,
    ];
    for (const p of fallbacks) {
      const m = amountText.match(p);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (n > 0) { amount = n; break; }
      }
    }
  }
  if (!amount) return null;

  // 2) 날짜 + 시간 (공통, MM/DD HH:MM 또는 MM-DD)
  const today = new Date();
  let date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let time = '';
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
    if (dm[3] && dm[4]) {
      const hh = parseInt(dm[3], 10);
      const mi = parseInt(dm[4], 10);
      if (hh >= 0 && hh < 24 && mi >= 0 && mi < 60) {
        time = `${String(hh).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
      }
    }
  }

  // 카드명 — 카드사가 SMS 에 표기한 라벨 (예: "카드 하나2*4*") 그대로 추출
  let card = '';
  const cardMatch = text.match(/(?:^|[\n\r])\s*카드\s*[:\s]+([^\n\r]+)/);
  if (cardMatch) {
    card = cardMatch[1].trim().replace(/\s{2,}/g, ' ').slice(0, 30);
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
    return { type: 'income', amount, source, date, time, card };
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
  return { type: 'expense', amount, merchant, date, time, card };
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
      // 매크로가 직접 보내는 time / card 도 받음 (구조화 호출 — sms-ingest 가 아닐 때).
      const time = /^\d{1,2}:\d{2}$/.test(String(body.time || '')) ? String(body.time).padStart(5, '0') : '';
      const card = String(body.card || '').trim().slice(0, 30);

      const stateObj = await readStateV2(env);

      let entry;
      if (type === 'income') {
        const src = String(body.income_source || body.merchant || '수입').trim().slice(0, 60);
        entry = {
          id: genId(), type: 'income', date, amount, source: src, note, ingest_source,
          ...(time && { time }),
          ...(card && { card }),
        };
      } else {
        const merchant = String(body.merchant || '').trim().slice(0, 80);
        const requestedCat = String(body.category || '').trim();
        const category = (requestedCat && stateObj.categories.includes(requestedCat))
          ? requestedCat
          : classifyCategory(merchant, stateObj.category_rules, stateObj.categories);
        entry = {
          id: genId(), type: 'expense', date, amount, merchant, category, note, source: ingest_source,
          ...(time && { time }),
          ...(card && { card }),
        };
      }
      stateObj.entries.push(entry);
      // 자동 ingest heartbeat — 매크로가 살아있는지 프론트에서 가시화하기 위한 신호
      stateObj.last_ingest_at = new Date().toISOString();
      recordIngest(stateObj, {
        result: 'ok', source: ingest_source,
        detail: `${type === 'income' ? '수입' : '지출'} ${amount.toLocaleString()}원 (구조화 전송)`,
      });

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

      // 인증 통과 후엔 성공·실패 모두 KV 점검 로그(ingest_log)에 적재한다.
      // 매크로→서버 경로가 어디서 끊기는지 앱 설정 탭에서 바로 보이게 하기 위함.
      const stateObj = await readStateV2(env);
      const finish = async (logArgs, respBody, status) => {
        recordIngest(stateObj, logArgs);
        try { await env.HOUSEHOLD.put(KEY, JSON.stringify(stateObj)); } catch {}
        return json(respBody, status, cors);
      };

      // 본문은 JSON 또는 평문(plain-text) 둘 다 허용.
      // - JSON: {"body": "...", "source": "..."} — curl·기존 매크로 (하위호환)
      // - 평문: 매크로 Body 에 매직텍스트 하나만 (예: [알림 텍스트]) → JSON·따옴표·줄바꿈
      //   이스케이프 신경 안 써도 됨. source 는 URL 쿼리(?source=card-sms-mine)로.
      const raw = (await req.text()) || '';
      let smsText, ingest_source, note;
      let jsonBody = null;
      try { jsonBody = JSON.parse(raw); } catch {}
      if (jsonBody && typeof jsonBody === 'object' && !Array.isArray(jsonBody) && (jsonBody.body || jsonBody.text)) {
        smsText = String(jsonBody.body || jsonBody.text || '').trim();
        ingest_source = String(jsonBody.source || url.searchParams.get('source') || 'card-sms').slice(0, 32);
        note = String(jsonBody.note || '').trim().slice(0, 200);
      } else {
        // 평문 모드 — 받은 본문 전체가 곧 SMS/알림 본문
        smsText = raw.trim();
        ingest_source = String(url.searchParams.get('source') || 'card-sms').slice(0, 32);
        note = '';
      }

      if (!smsText) {
        return finish(
          { result: 'empty_body', source: ingest_source, detail: 'body 가 비어있음' },
          { error: 'empty_body' }, 400);
      }

      // 진단 로그 — wrangler tail 로 확인 가능. 금액 파싱 이슈 디버깅 용.
      console.log('[sms-ingest] received', JSON.stringify({ len: smsText.length, preview: smsText.slice(0, 400) }));

      // 매크로의 변수 치환 실패 케이스 — MacroDroid 가 {notification}·{sms_body}(중괄호)
      // 또는 [notification_text]·[알림 텍스트](대괄호)를 치환 못 하고 그대로 보내는 경우.
      // 한 줄짜리 단일 토큰만 매칭(여러 줄 실제 본문은 $ 로 자연 배제).
      if (/^[\[{][\w가-힣 ]{1,40}[\]}]$/.test(smsText)) {
        console.warn('[sms-ingest] unsubstituted placeholder', smsText);
        return finish(
          { result: 'unsubstituted_placeholder', source: ingest_source, detail: '매크로 변수 미치환', preview: smsText },
          {
            error: 'unsubstituted_placeholder',
            hint: `매크로의 HTTP body 가 변수 치환이 안 된 상태로 도착 ('${smsText}'). ` +
                  'Macrodroid 에서 매직 텍스트로 "알림 텍스트" 또는 "SMS 본문" 변수를 다시 삽입하세요.',
            received: smsText,
          }, 422);
      }
      // SMS·알림 본문은 보통 50자 이상. 너무 짧으면 변수 미치환 또는 잘림 의심.
      if (smsText.length < 30) {
        console.warn('[sms-ingest] suspicious short body', smsText);
        return finish(
          { result: 'body_too_short', source: ingest_source, detail: `본문 ${smsText.length}자 — 변수 미치환/잘림 의심`, preview: smsText },
          {
            error: 'body_too_short',
            hint: `본문이 너무 짧음 (${smsText.length}자). 매크로 변수 치환 또는 발송 설정을 확인하세요.`,
            received: smsText,
          }, 422);
      }

      const parsed = parseFinanceSms(smsText);
      console.log('[sms-ingest] parsed', JSON.stringify(parsed));
      if (!parsed) {
        return finish(
          { result: 'parse_failed', source: ingest_source, detail: '금액(원) 패턴 못 찾음', preview: smsText },
          {
            error: 'parse_failed',
            hint: '금액(원) 패턴을 못 찾았습니다. SMS 본문을 확인하세요.',
            received_chars: smsText.length,
          }, 422);
      }

      const time = parsed.time || '';
      const card = parsed.card || '';
      let entry;
      if (parsed.type === 'income') {
        entry = {
          id: genId(), type: 'income', date: parsed.date, amount: parsed.amount,
          source: parsed.source || '수입', note, ingest_source,
          ...(time && { time }),
          ...(card && { card }),
        };
      } else {
        const category = classifyCategory(parsed.merchant, stateObj.category_rules, stateObj.categories);
        entry = {
          id: genId(), type: 'expense', date: parsed.date, amount: parsed.amount,
          merchant: parsed.merchant || '(가맹점 미상)', category, note, source: ingest_source,
          ...(time && { time }),
          ...(card && { card }),
        };
      }
      stateObj.entries.push(entry);
      // 자동 ingest heartbeat — 매크로가 살아있는지 프론트에서 가시화하기 위한 신호
      stateObj.last_ingest_at = new Date().toISOString();
      recordIngest(stateObj, {
        result: 'ok', source: ingest_source,
        detail: entry.type === 'expense'
          ? `지출 ${entry.amount.toLocaleString()}원 · ${entry.merchant} (${entry.category})`
          : `수입 ${entry.amount.toLocaleString()}원 · ${entry.source}`,
        preview: smsText,
      });

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
