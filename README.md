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

본인+배우자 각자 폰에 매크로 1개씩 설치 → 카드사 SMS 받으면 자동 파싱 → 가계부에 즉시 추가.

### 매크로 설정 (한 번)

1. **MacroDroid** 설치 (Play Store, 무료. 광고 비활성은 결제). Tasker / Bixby Routines / Automate 등 다른 자동화 앱도 같은 패턴.
2. **새 매크로 추가**:

   **Trigger (트리거)**:
   - SMS 수신 → 발신자: `1599-*` 또는 카드사 번호 (카드사별로 다름 — 받은 SMS 발신자 그대로)
     - 신한카드 `1544-7000`, 삼성카드 `1588-8900`, 현대카드 `1577-6000`, KB국민 `1588-1688`, 우리 `1599-2030`, BC `1588-4000`, 롯데 `1588-8100`, 하나 `1800-1111`, NH농협 `1644-4000` (변경될 수 있음)
   - 또는 본문 포함: `원 일시불` / `원 할부` (카드사 무관, 약간 더 광범위)

   **Action (동작) — HTTP 요청**:
   - URL: `https://household-account-book-api.junyoung-cha83.workers.dev/api/transactions`
   - Method: `POST`
   - Content-Type: `application/json`
   - Custom header: `X-Ingest-Token: <위에서 발급한 INGEST_TOKEN>`
   - Body (MacroDroid 변수 사용):
     ```json
     {
       "amount": {sms_body 에서 추출한 금액},
       "merchant": "{sms_body 에서 추출한 가맹점}",
       "source": "card-sms-mine"
     }
     ```
   - (`source` 는 본인 폰은 `card-sms-mine`, 배우자 폰은 `card-sms-spouse` 등으로 구분 — 디버그용)

### SMS 본문 파싱 (정규식)

카드사별로 포맷이 살짝 다른데, 대부분 다음 형태:

```
[Web발신]
[XX카드]
승인 홍**
12,345원 일시불
05/24 14:23
스타벅스강남점
누적 ...
```

**MacroDroid 정규식 설정** (Macro 안에서 "변수 설정" → "정규식 그룹"):
- 금액: `([\d,]+)원\s*(?:일시불|할부)` → 첫 그룹 (콤마 제거 후 숫자)
- 가맹점: 마지막 한국어 단어 줄 — 카드사마다 다름. 가장 신뢰성: `\d{2}/\d{2}\s+\d{2}:\d{2}\s*[\r\n]+(.+)` 같이 시각 다음 줄
- 또는 단순: 본문 마지막에서 `누적`, `잔여한도` 같은 키워드 앞 부분

**카드사 1개를 받은 SMS 그대로 알려주시면 정확한 정규식을 제가 만들어 드릴 수 있습니다.**

### 동작 확인

1. 매크로 저장 → 카드로 작은 결제 1건 (1,000원 편의점 등)
2. SMS 도착 → 매크로 자동 실행 → 로그(MacroDroid 액션 로그)에서 200 OK 확인
3. 가계부 앱 열면 자동으로 새 거래 표시 (visibility 자동 새로고침)
4. 카테고리는 가맹점 룰로 자동 분류. 처음엔 "기타" 일 수 있고, 사용자가 한 번 바꾸면 다음부터 학습됨.

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
| `POST /api/transactions` | `X-Ingest-Token` | 거래 1건 추가 (매크로용) |
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

## Out of scope (나중에)

- iOS 단축어 (둘 다 Android 이므로 일단 불필요)
- 영수증 사진 (R2)
- D1 마이그레이션 (거래 1만건+ 시)
- 다중 사용자 분리 + Auth
- 동시 쓰기 race (`source` 필드로 본인/배우자 분리 가능. 동시에 사용자가 PUT 하고 매크로가 POST 하면 last-wins 가능 — 자주 안 발생, 발생 시 visibility GET 으로 자동 복구 가능성 있음)
