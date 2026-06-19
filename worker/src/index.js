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

// 카드앱 '요약 푸시' 파싱 — 예: "금화갈매기 / 신용(일시불,2*4*) / 06.19 20:06 / 누적이용금액 8,204,902원"
// 단건 금액은 없지만 카드별 '누적이용금액'을 줌 → 직전 누적과의 차이로 거래액 복구(상세 알림 미수신 대비).
function parseCardSummary(text) {
  if (!text) return null;
  const t = String(text).replace(/ /g, ' ');
  const cum = t.match(/누적\s*이용금액\s*([\d,]+)\s*원/);
  if (!cum) return null;
  const cumulative = parseInt(cum[1].replace(/,/g, ''), 10);
  if (!(cumulative > 0)) return null;
  const cardM = t.match(/\((?:[^,)]*,)?\s*([0-9][0-9*]+)\s*\)/);     // (일시불,2*4*) → 2*4*
  const card = cardM ? cardM[1] : '';
  const merM = t.match(/^\s*([^/\n]+?)\s*\/\s*(?:신용|체크|할부)/);    // 첫 세그먼트 = 가맹점
  const merchant = merM ? merM[1].trim() : '';
  let date = '', time = '';
  const today = new Date();
  const dm = t.match(/(\d{1,2})[.\/](\d{1,2})\s+(\d{1,2}):(\d{2})/);  // MM.DD HH:MM
  if (dm) {
    const mm = parseInt(dm[1], 10), dd = parseInt(dm[2], 10);
    let y = today.getFullYear();
    if (today.getMonth() === 0 && mm === 12) y -= 1;
    else if (today.getMonth() === 11 && mm === 1) y += 1;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)
      date = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    const hh = parseInt(dm[3], 10), mi = parseInt(dm[4], 10);
    if (hh >= 0 && hh < 24 && mi >= 0 && mi < 60)
      time = `${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }
  if (!date) date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return { merchant, card, date, time, cumulative };
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

// SMS 본문에서 카드사 이름 추출 (우리·신한·하나·삼성 등).
// "<카드사>카드/체크/페이/뱅크" 형태로만 매칭 → 가맹점명(삼성전자 등) 오인식 방지.
function detectCardIssuer(text) {
  const t = String(text || '');
  const ISSUERS = '우리|신한|하나|삼성|현대|롯데|KB국민|국민|KB|NH농협|농협|NH|비씨|BC|씨티|카카오뱅크|카카오|토스|케이뱅크|케이|수협|새마을|광주|전북|제주';
  const map = { 'KB국민': '국민', 'KB': '국민', 'NH농협': '농협', 'NH': '농협', 'BC': '비씨',
                '카카오뱅크': '카카오', '케이뱅크': '케이', '케이': '케이' };
  // 1순위: "<카드사>카드/체크/페이/뱅크" (가맹점명 '삼성전자' 등 오인식 방지)
  let m = t.match(new RegExp(`(${ISSUERS})\\s*(?:카드|체크카드|체크|페이|뱅크|은행|머니)`));
  if (m) return map[m[1]] || m[1];
  // 2순위: "코스트코현대 승인"처럼 승인 앞 한 단어에 카드사명이 들어간 제휴(PLCC) 카드 → 그 단어 전체를 카드명으로.
  m = t.match(/(?:^|[\n\r\]\s])([가-힣A-Za-z0-9]{2,15})\s*승인/);
  if (m && new RegExp(`(?:${ISSUERS})`).test(m[1])) return m[1];
  return '';
}

// 가맹점 후보가 그럴듯한지 — 금액·누적·날짜만 있는 줄 걸러냄.
function looksLikeMerchant(s) {
  const t = String(s || '').trim();
  if (t.length < 2) return false;
  if (!/[가-힣A-Za-z]{2}/.test(t)) return false;            // 한글/영문 2자 이상 포함
  if (/^[\d,\s]*원/.test(t)) return false;                   // 금액으로 시작
  if (/^(누적|총누적|잔액|잔여|한도|승인|취소|이용)/.test(t)) return false;
  return true;
}

// 한국 금융 SMS/RCS 본문 → type(expense/income) 자동 판단 + 필드 추출
// 카드 결제 (expense) · 은행 입금 (income) 모두 처리
// 반환: { type, amount, merchant|source, date } 또는 null (금액 못 찾으면)
function parseFinanceSms(body) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/ /g, ' ');

  // 카드 대금 자동이체(월 청구) 알림 — 예: "05월 결제금액 101,340원 05/26출금완료".
  // 개별 카드결제와 중복(이중 계산)되므로 가계부에 기록하지 않는다.
  if (/(?:월\s*)?결제\s*금액[\s\S]{0,40}출금\s*완료/.test(text)) return null;

  // 금액 추출용 텍스트 — 단건 결제가 아닌 누적·할인·예정·실적 등 부가 금액 라인 제거.
  // 표 형식 SMS(하나카드 등)의 들쭉날쭉한 공백(스페이스·탭·NBSP)을 \s 가 모두 흡수하도록.
  const amountText = text
    // 누적금액 / 누적사용액 / 누적이용금액 / 월누적 / 전월누적 / 당월누적 / 연누적 등
    // 누적 뒤 한글 라벨(이용금액·사용액 등)을 모두 흡수해 단건 금액으로 오인하지 않게.
    .replace(/(?:월|연|총|전월|당월|일)?\s*누적[가-힣]*\s*[:\s]*[\d,]+\s*원/g, '')
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
  // 우선순위 1 — '금액' 라벨 (표 형식: 금액 60,500원 / [Web발신] 금액 5,000,000원).
  // 금액 앞이 줄시작·공백·] 등이어야 매칭 → '누적금액·청구금액·이용금액'(앞이 한글)은 자연 차단.
  const labelOnly = amountText.match(/(?:^|[\n\r\]\s])금액[:\s]*([\d,]+)\s*원/);
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
      /(?:^|[\n\r\]\s(])([\d,]{3,})\s*원/,
    ];
    for (const p of fallbacks) {
      const m = amountText.match(p);
      if (m) {
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (n > 0) { amount = n; break; }
      }
    }
  }
  // USD 등 외화 — 원화 금액이 없을 때 (예: "금액 USD22.00", "$22.00", "22.00 달러").
  // 원화는 정수, 외화는 소수점 허용. 환산은 호출부(서버)에서 환율 적용.
  let foreign = null;
  if (!amount) {
    const fx = amountText.match(/(?:US\$|USD|\$)\s*([\d,]+(?:\.\d+)?)/i)
            || amountText.match(/([\d,]+(?:\.\d+)?)\s*(?:USD|달러|불)/i);
    if (fx) {
      const v = parseFloat(fx[1].replace(/,/g, ''));
      if (v > 0) foreign = { currency: 'USD', value: v };
    }
  }
  if (!amount && !foreign) return null;

  // 2) 날짜 + 시간 — '거래시간/승인시각' 라벨의 시각을 우선 사용.
  // (맨 앞에 전송시각 등 다른 날짜가 끼어들어도 실제 거래시각을 잡도록. 라벨 없으면 첫 날짜로 폴백.)
  const today = new Date();
  let date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let time = '';
  const dm = text.match(/(?:거래시간|승인시각|승인일시|이용일시|거래일시)\s*[:]?\s*(\d{1,2})[\/.\-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/)
          || text.match(/(\d{1,2})[\/.\-](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/);
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

  // 카드사 이름(우리·신한·하나·삼성 등) + 카드 라벨("카드 하나2*4*") 결합 → 표시용 card.
  // 현재 표시 구조(메타 줄 "시각 · card") 그대로 — card 문자열에 카드사명이 포함되게만 함.
  const issuer = detectCardIssuer(text);
  let cardLabel = '';
  const cardMatch = text.match(/(?:^|[\n\r])\s*카드\s*[:\s]+([^\n\r]+)/);
  if (cardMatch) {
    cardLabel = cardMatch[1].trim().replace(/\s{2,}/g, ' ').slice(0, 30);
  }
  let card = '';
  if (issuer && cardLabel) card = cardLabel.includes(issuer) ? cardLabel : `${issuer} ${cardLabel}`;
  else card = issuer || cardLabel;
  card = card.slice(0, 30);

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
    return { type: 'income', amount, source, date, time, card, ...(foreign && { foreign }) };
  }

  // 카드 결제 신호 게이트 — 뉴스·광고·SNS·기프티콘 등이 '숫자+원'만으로 지출로 오인되지 않게.
  // 결제 알림에 흔한 키워드(승인·일시불·할부·사용처·가맹점·카드사명·'금액 …원' 라벨)가 하나도
  // 없으면 카드 거래가 아니라고 보고 기록하지 않음.
  const cardSignal = issuer
    || /승인|일시불|할부|사용처|가맹점|체크승인|카드\s*[:\s]*\S/.test(text)
    || /(?:^|[\n\r\]\s])금액[:\s]*[\d,]+\s*원/.test(text);
  if (!cardSignal) return null;

  // 4) expense — 가맹점 추출. 카드사별 위치가 달라 라벨 → 카드사별 위치 순으로 시도.
  let merchant = '';
  const merchantPatterns = [
    // 해외승인 슬래시 형식 — "...해외승인/USD 22.00/ANTHROPIC* CLAUDE SU"
    /(?:USD|달러|불)\s*[\d,.]+\s*\/\s*([^\/\n\r]+)/i,
    // 라벨 기반(가장 신뢰) — 하나("사용처"), 공통("가맹점"/"이용가맹점")
    /사용처\s*[:\s]*([^\n\r]+)/,
    /이용가맹점\s*[:\s]*([^\n\r]+)/,
    /가맹점\s*[:\s]*([^\n\r]+)/,
    // 신한 — "MM/DD일 기준" 이후
    /\d{1,2}[\/.]\d{1,2}일?\s*기준\s*([^\n\r]+)/,
    // 우리 — "총누적 …원" 다음 줄
    /총누적[^\n\r]*원\s*[\n\r]+\s*([^\n\r]+)/,
    // 삼성 — "MM/DD HH:MM" 같은 줄 뒤에 바로
    /\d{1,2}[\/.]\d{1,2}\s+\d{1,2}:\d{1,2}\s+(\S[^\n\r]*)/,
    // 공통 — 날짜·시각 다음 줄
    /\d{1,2}[\/.]\d{1,2}\s+\d{1,2}:\d{1,2}\s*[\n\r]+\s*([^\n\r]+)/,
    // 공통 — 일시불/할부 다음 줄 (KB: "23,180원(일시불)\n쿠팡(쿠페이)" 처럼 닫는 괄호가 붙어도 매칭)
    /(?:일시불|할부)\)?\s*[\n\r]+\s*([^\n\r]+)/,
  ];
  for (const p of merchantPatterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const cand = m[1].trim()
        .replace(/\s*[\d,]+\s*원.*$/u, '')                                  // 뒤따르는 금액 이하 제거
        .replace(/(?:누적|잔여|잔액|한도|승인|취소|이용내역|거래시간).*$/u, '')   // 부가 라벨 이하 제거
        .trim();
      if (looksLikeMerchant(cand)) { merchant = cand.slice(0, 40); break; }
    }
  }
  return { type: 'expense', amount, merchant, date, time, card, ...(foreign && { foreign }) };
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

// USD→KRW 환율. stateObj.fx 에 하루 캐시. 조회 실패 시 env.USD_KRW_RATE → 기본값.
const DEFAULT_USD_KRW = 1400;
async function getUsdKrwRate(env, stateObj) {
  try {
    const fx = stateObj.fx;
    if (fx && fx.usd_krw > 0 && fx.at && (Date.now() - Date.parse(fx.at) < 24 * 3600 * 1000)) {
      return fx.usd_krw;
    }
  } catch {}
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    if (r.ok) {
      const j = await r.json();
      const rate = j && j.rates && j.rates.KRW;
      if (rate && rate > 0) {
        stateObj.fx = { usd_krw: rate, at: new Date().toISOString() };
        return rate;
      }
    }
  } catch {}
  const envRate = env.USD_KRW_RATE ? Number(env.USD_KRW_RATE) : 0;
  return (stateObj.fx && stateObj.fx.usd_krw) || (envRate > 0 ? envRate : DEFAULT_USD_KRW);
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

      // 광고 문자 — 무시(거래 아님). 한국 광고 SMS 는 '(광고)' 표기가 의무.
      if (/\(\s*광고\s*\)/.test(smsText) || /^\s*\[?\s*광고\s*\]?/.test(smsText)) {
        return finish(
          { result: 'ad_skipped', source: ingest_source, detail: '광고 문자 — 무시', preview: smsText },
          { ok: true, skipped: 'ad' }, 200);
      }

      const parsed = parseFinanceSms(smsText);
      console.log('[sms-ingest] parsed', JSON.stringify(parsed));
      if (!parsed) {
        // 카드사 앱 푸시 '요약 알림'(예: "OO점 / 신용(일시불,1*7*) / 06.11 17:54 / 누적이용금액 …원").
        // 단건 결제금액 없이 누적금액만 있어 파싱 불가하지만, 동일 거래의 정식 SMS가 따로 와서
        // 이미 기록되므로 '실패'가 아니라 조용히 건너뜀(로그 노이즈 방지).
        if (/\/\s*(?:신용|체크|할부)\s*\(/.test(smsText) || /누적\s*이용금액/.test(smsText)) {
          // 요약 푸시 — 카드별 누적이용금액 차분으로 거래액 복구(상세 알림 미수신 대비).
          const sm = parseCardSummary(smsText);
          if (!sm) {
            return finish(
              { result: 'card_push_skipped', source: ingest_source, detail: '카드앱 요약 알림(형식 불명) — 건너뜀', preview: smsText },
              { ok: true, skipped: 'card_push_summary' }, 200);
          }
          if (!stateObj.card_cumulative || typeof stateObj.card_cumulative !== 'object') stateObj.card_cumulative = {};
          const prev = stateObj.card_cumulative[sm.card];
          stateObj.card_cumulative[sm.card] = sm.cumulative;     // 항상 최신 누적 갱신
          stateObj.last_ingest_at = new Date().toISOString();
          const delta = (typeof prev === 'number') ? sm.cumulative - prev : null;
          if (delta === null || delta <= 0) {                    // 첫 관측 또는 월결산 리셋/취소 → 기록 안 함
            return finish(
              { result: 'summary_seen', source: ingest_source,
                detail: `요약 누적 ${sm.cumulative.toLocaleString()}원 저장(${sm.card || '?'})`, preview: smsText },
              { ok: true, summary: 'seen' }, 200);
          }
          // delta>0 = 거래액 후보. 같은 금액+카드 최근(≤1일) 미취소 지출 있으면 이미 기록된 것(중복 추가 금지).
          const within1d = (d) => { try { return Math.abs(new Date(sm.date + 'T00:00:00') - new Date(d + 'T00:00:00')) <= 24 * 3600 * 1000; } catch { return false; } };
          const matched = [...stateObj.entries].reverse().find(e =>
            e.type === 'expense' && !e.cancelled && e.amount === delta &&
            (sm.card ? (e.card || '').includes(sm.card) : true) && within1d(e.date || ''));
          if (matched) {
            return finish(
              { result: 'summary_matched', source: ingest_source,
                detail: `요약차분 ${delta.toLocaleString()}원 — 기존거래 확인(${matched.merchant})`, preview: smsText },
              { ok: true, summary: 'matched' }, 200);
          }
          // 복구 — 상세 미수신분을 신규 지출로 기록.
          const catR = classifyCategory(sm.merchant, stateObj.category_rules, stateObj.categories);
          stateObj.entries.push({
            id: genId(), type: 'expense', date: sm.date, amount: delta,
            merchant: sm.merchant || '(가맹점 미상)', category: catR, note: '요약 누적차분 복구',
            source: 'card-summary', ...(sm.time && { time: sm.time }), ...(sm.card && { card: '하나' + sm.card }),
          });
          return finish(
            { result: 'summary_recovered', source: ingest_source,
              detail: `복구 ${delta.toLocaleString()}원 · ${sm.merchant} (상세 미수신)`, preview: smsText },
            { ok: true, summary: 'recovered', amount: delta }, 200);
        }
        return finish(
          { result: 'parse_failed', source: ingest_source, detail: '금액(원) 패턴 못 찾음', preview: smsText },
          {
            error: 'parse_failed',
            hint: '금액(원) 패턴을 못 찾았습니다. SMS 본문을 확인하세요.',
            received_chars: smsText.length,
          }, 422);
      }

      // 외화(USD 등) — 원화로 환산해 기록하고, 원본 외화·적용 환율은 note 에 보존.
      if (parsed.foreign && !parsed.amount) {
        const rate = await getUsdKrwRate(env, stateObj);
        parsed.amount = Math.round(parsed.foreign.value * rate);
        const fxNote = `${parsed.foreign.currency} ${parsed.foreign.value.toFixed(2)} · 환율 ${Math.round(rate).toLocaleString('ko-KR')}`;
        note = note ? `${fxNote} · ${note}` : fxNote;
      }

      // 취소 처리 — 승인/취소는 본문 텍스트가 동일하고 헤더 이미지로만 구분되므로,
      // MacroDroid OCR이 본문에 '취소' 글자를 넣어준 경우에만 취소로 처리한다.
      // 같은 금액+카드(+가맹점)의 최근 '미취소 지출'을 찾아 취소 표시(합계 제외). 새 지출 추가 안 함.
      if (parsed.type === 'expense' && /취소/.test(smsText)) {
        const orig = [...stateObj.entries].reverse().find(e =>
          e.type === 'expense' && !e.cancelled && e.amount === parsed.amount &&
          (parsed.card ? (e.card || '') === parsed.card : true) &&
          (parsed.merchant ? ((e.merchant || '').includes(parsed.merchant) || parsed.merchant.includes(e.merchant || '')) : true)
        );
        if (orig) {
          orig.cancelled = true;
          orig.cancelled_at = parsed.date + (parsed.time ? ' ' + parsed.time : '');
          stateObj.last_ingest_at = new Date().toISOString();
          recordIngest(stateObj, { result: 'cancelled', source: ingest_source,
            detail: `취소 ${parsed.amount.toLocaleString()}원 · ${orig.merchant} → 원거래 취소처리`, preview: smsText });
        } else {
          // 원거래 미발견 — 취소 항목을 표시용으로 추가(합계 제외)
          const cat0 = classifyCategory(parsed.merchant, stateObj.category_rules, stateObj.categories);
          stateObj.entries.push({ id: genId(), type: 'expense', date: parsed.date, amount: parsed.amount,
            merchant: parsed.merchant || '(가맹점 미상)', category: cat0, note: '취소(원거래 미발견)',
            source: ingest_source, cancelled: true, ...(parsed.time && { time: parsed.time }), ...(parsed.card && { card: parsed.card }) });
          stateObj.last_ingest_at = new Date().toISOString();
          recordIngest(stateObj, { result: 'cancel_unmatched', source: ingest_source,
            detail: `취소 ${parsed.amount.toLocaleString()}원 · 원거래 미발견(표시만)`, preview: smsText });
        }
        const rawC = JSON.stringify(stateObj);
        if (rawC.length > MAX_BYTES) return json({ error: 'too_large', limit: MAX_BYTES, size: rawC.length }, 413, cors);
        await env.HOUSEHOLD.put(KEY, rawC);
        return json({ ok: true, cancel: true, matched: !!orig, amount: parsed.amount }, 200, cors);
      }

      // 중복 감지 — 같은 금액+카드+가맹점의 최근(1일 내) 미취소 지출이 이미 있으면,
      // 이번 건을 '취소'로 간주(승인/취소가 텍스트로 구분 안 되므로). 원거래를 취소 처리하고 새 지출은 추가 안 함.
      // 같은 금액을 같은 곳에서 실제로 두 번 결제한 경우 오인될 수 있어 '취소 추정'으로 표시(앱에서 해제 가능).
      if (parsed.type === 'expense') {
        const within1d = (d) => { try { return Math.abs(new Date(parsed.date + 'T00:00:00') - new Date(d + 'T00:00:00')) <= 24 * 3600 * 1000; } catch { return false; } };
        const dup = [...stateObj.entries].reverse().find(e =>
          e.type === 'expense' && !e.cancelled && e.amount === parsed.amount &&
          (e.merchant || '') === (parsed.merchant || '') &&
          (parsed.card ? (e.card || '') === parsed.card : true) &&
          within1d(e.date || ''));
        if (dup) {
          if (dup.source === 'card-summary') {
            // 요약 누적차분으로 먼저 복구된 동일거래에 상세 알림이 뒤늦게 도착 → 취소 아님.
            // 상세 정보로 승격(보강)하고 새 항목은 추가하지 않음(이중기록 방지).
            dup.source = ingest_source;
            if (parsed.merchant) dup.merchant = parsed.merchant;
            if (parsed.time) dup.time = parsed.time;
            if (note) dup.note = note;
            dup.category = classifyCategory(parsed.merchant, stateObj.category_rules, stateObj.categories);
            stateObj.last_ingest_at = new Date().toISOString();
            recordIngest(stateObj, { result: 'summary_confirmed', source: ingest_source,
              detail: `요약복구→상세확인 ${parsed.amount.toLocaleString()}원 · ${dup.merchant}`, preview: smsText });
            const rawU = JSON.stringify(stateObj);
            if (rawU.length > MAX_BYTES) return json({ error: 'too_large', limit: MAX_BYTES, size: rawU.length }, 413, cors);
            await env.HOUSEHOLD.put(KEY, rawU);
            return json({ ok: true, summary_confirmed: dup.id, amount: parsed.amount }, 200, cors);
          }
          dup.cancelled = true;
          dup.cancel_note = '중복감지(취소 추정)';
          dup.cancelled_at = parsed.date + (parsed.time ? ' ' + parsed.time : '');
          stateObj.last_ingest_at = new Date().toISOString();
          recordIngest(stateObj, { result: 'dup_cancelled', source: ingest_source,
            detail: `중복감지 ${parsed.amount.toLocaleString()}원 · ${dup.merchant} → 원거래 취소처리`, preview: smsText });
          const rawD = JSON.stringify(stateObj);
          if (rawD.length > MAX_BYTES) return json({ error: 'too_large', limit: MAX_BYTES, size: rawD.length }, 413, cors);
          await env.HOUSEHOLD.put(KEY, rawD);
          return json({ ok: true, dup_cancelled: dup.id, amount: parsed.amount }, 200, cors);
        }
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
