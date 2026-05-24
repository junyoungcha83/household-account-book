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

## Out of scope (나중에)

- 카드 결제 푸시 알림 자동 연동 (iOS 단축어 → POST /api/transactions)
- 영수증 사진 (R2)
- D1 마이그레이션 (거래 1만건+ 시)
- 다중 사용자 분리 + Auth
