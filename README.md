# household-account-book

매장에서 카드/현금 쓸 때 바로 모바일로 기록하는 가계부 PWA. 본인+배우자 거래를 한 곳에 합치고, 월말에 카테고리별 사용·목표·초과를 본다.

## 구조

```
[사파리/크롬]
   │ 정적 PWA (GitHub Pages)
   ▼
[GitHub Pages]
   │ fetch
   ▼
[Cloudflare Worker]  GET /api/data · PUT /api/data (X-Edit-Token)
   │
   ▼
[Cloudflare KV]  key "household-data" → 전체 JSON
```

- 로드: 서버 우선 → localStorage fallback (오프라인 OK)
- 저장: localStorage 즉시 + 디바운스 PUT
- 인증: 편집 토큰 1회 입력 (헤더 "🔒 편집" 버튼)
- 토큰 없으면 읽기 전용 (모든 입력·삭제 UI 숨김)

## 데이터 모델 (KV 단일 키 JSON)

```json
{
  "version": 1,
  "transactions": [{ "id": "...", "date": "YYYY-MM-DD", "amount": 5000, "merchant": "...", "category": "식비", "note": "", "source": "manual" }],
  "incomes":      [{ "id": "...", "date": "YYYY-MM-DD", "source": "월급", "amount": 3000000 }],
  "categories":   ["식비", "교통비", "학원비", "의류구매비", "기타"],
  "budgets":      { "YYYY-MM": { "total": 0, "by_category": { "식비": 0 } } },
  "category_rules": [{ "pattern": "스타벅스", "category": "식비" }]
}
```

## 자동 카테고리 분류

가맹점명 substring 매칭 + last-wins 학습. 사용자가 카테고리를 바꾸면 그 가맹점→카테고리 룰 자동 갱신.

## 운영

### Worker 배포 (이미 1회만)

```
cd worker
npx wrangler kv namespace create HOUSEHOLD   # 한 번
echo "TOKEN" | npx wrangler secret put EDIT_TOKEN
npx wrangler deploy
```

### 사이트 배포

main 푸시 → GitHub Pages 자동 빌드. 따로 명령 없음.

```
git push
```

### 편집 토큰 잃었을 때

```
cd worker && echo "새토큰" | npx wrangler secret put EDIT_TOKEN
```

## 카드 결제 자동 연동 (Android · MacroDroid)

본인+배우자 각자 폰에 매크로 1개씩 설치 → 카드사 SMS 받으면 자동으로 가계부에 추가.

**SMS 본문 파싱은 서버에서 합니다** — 매크로는 본문 통째로 POST 만 하면 됨. 정규식 설정 불필요.

### 매크로 설정 (한 번, 약 3분)

1. **MacroDroid** 설치 ([Play Store](https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid), 무료. 매크로 5개 무제한)
2. 첫 실행 시 권한 허용 (SMS 읽기, 알림 접근)
3. **새 매크로 추가** → 다음과 같이 구성:

#### Trigger (트리거) — 2가지 옵션

**옵션 A. SMS 수신 (일반 SMS 받는 경우)**
- "Triggers" → "Messaging" → "SMS Received"
- "Sender" 비워두면 모든 발신자, 카드사 번호 (예: 하나카드 `1800-1111`) 만 좁히려면 입력
- 또는 "Message Content contains" → `원` 또는 `승인`

**옵션 B. 알림 수신 (RCS / 카드앱 푸시 받는 경우 — 권장)**
- "Triggers" → "Device Events" → "Notification" → "Notification Received"
- "Application" → Google Messages (또는 카드앱)
- "Text content contains" → `원` 또는 `승인`
- (Android 알림 접근 권한 필요 — 매크로 저장 시 안내)

#### Action (동작) — HTTP 요청

- "Actions" → "Connectivity" → "HTTP Request"
- **URL**: `https://household-account-book-api.junyoung-cha83.workers.dev/api/sms-ingest`
- **Method**: POST
- **Content-Type**: `application/json`
- **Custom Headers**:
  ```
  X-Ingest-Token: <INGEST_TOKEN 발급값>
  ```
- **Body** (raw, JSON):
  ```json
  {"body": "[sms]", "source": "card-sms-mine"}
  ```
  - `[sms]` 부분에 MacroDroid 변수 삽입 (옵션 A 면 `[sms=body]`, 옵션 B 면 `[notification_text]`. 매크로 UI 의 "Insert magic text" 메뉴에서 골라 넣음)
  - 배우자 폰에선 `"source": "card-sms-spouse"` 로 바꿈 (출처 구분 — 디버그용. 통계엔 영향 X)

### 동작 확인

1. 매크로 저장 → 카드로 작은 결제 1건 (편의점·자판기 등)
2. SMS 도착 → 매크로 자동 실행 → MacroDroid "Action log" 에서 200 OK 확인
3. 가계부 앱 열면 (또는 이미 켜져있으면 잠시 다른 앱 갔다 돌아오면) 새 거래 자동 표시
4. 카테고리는 서버 default 룰 (스타벅스·CU·메가커피·지하철·이마트·유니클로 등 18개) 또는 학습된 사용자 룰로 자동 분류. 분류 결과 마음에 안 들면 거래 클릭해서 카테고리 바꾸면 다음부터 학습됨.

### 파싱 실패 시

서버가 `parse_failed` 응답 (HTTP 422) — MacroDroid Action log 에서 확인 가능. 그 SMS 본문을 알려주시면 서버 정규식 보강 (`parseCardSms` in `worker/src/index.js`).

지원 패턴 (현재):
- 금액: `금액 X원` (RCS 카드 UI) · `X원 일시불/할부` (일반 SMS) · `승인 ... X원` · 첫 N자리 금액
- 가맹점: `사용처 ...` (RCS) · `가맹점 ...` · 시각 다음 줄 · 일시불/할부 다음 줄
- 날짜: `MM/DD HH:MM` 추출, 연도는 오늘 기준

### 토큰 관리

- `EDIT_TOKEN`: 가계부 앱에서 전체 데이터 수정 (앱 헤더 🔒 에 입력)
- `INGEST_TOKEN`: **매크로 전용** — 거래 *추가만* 가능 (수정·삭제 불가). 매크로에 박혀서 노출 위험이 있는데 영향 한정적.
- 토큰 재발급:
  ```
  cd worker
  echo "새토큰" | npx wrangler secret put INGEST_TOKEN
  ```

## API

| 엔드포인트 | 인증 | 용도 |
|---|---|---|
| `GET  /api/data` | (없음) | 전체 JSON 읽기 |
| `PUT  /api/data` | `X-Edit-Token` | 전체 덮어쓰기 (앱 동기화용) |
| `POST /api/transactions` | `X-Ingest-Token` | 거래 1건 추가 (구조화 데이터) |
| `POST /api/sms-ingest` | `X-Ingest-Token` | SMS 본문 통째로 → 서버 파싱 + 거래 추가 |
| `GET  /api/health` | (없음) | 헬스체크 |

POST body:
```json
{
  "amount": 12345,           // 필수, 양의 정수
  "merchant": "스타벅스 강남점",  // 선택 (가맹점)
  "date": "2026-05-24",      // 선택 (YYYY-MM-DD, 없으면 오늘)
  "note": "",                 // 선택
  "category": "식비",          // 선택 (생략 시 룰 매칭 → "기타")
  "source": "card-sms-mine"   // 선택 (구분용)
}
```

응답 200:
```json
{ "ok": true, "id": "t_...", "category": "식비", "date": "2026-05-24" }
```

### POST /api/sms-ingest body

```json
{
  "body": "<SMS 본문 통째로>",
  "source": "card-sms-mine"
}
```

응답 200: 거래 추가 성공. 422 `parse_failed`: 본문에서 금액 못 찾음.

## Out of scope (나중에)

- iOS 단축어 (둘 다 Android 이므로 일단 불필요)
- 영수증 사진 (R2)
- D1 마이그레이션 (거래 1만건+ 시)
- 다중 사용자 분리 + Auth
- 동시 쓰기 race (`source` 필드로 본인/배우자 분리 가능. 동시에 사용자가 PUT 하고 매크로가 POST 하면 last-wins 가능 — 자주 안 발생, 발생 시 visibility GET 으로 자동 복구 가능성 있음)
