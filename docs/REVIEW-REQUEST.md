# 코드 리뷰 요청 · v0.7.5-a19 (브랜치 `v0.7.5`)

- 범위: `git diff a8f9e1b ce73e39` (GPT 리뷰 a17+a18 P2 한 건).
  - `core.js`: `splitKeeps(…, { save })` → `savedStatesLost` → `savedStates`가 비교용 사본을 `applyResult(mem, data, chunk, { room, boxMode, questMode })`로 저장(실제 저장과 같은 설정). 저장 상태에 복귀 확인 유무(`!!returnNotice`, 시각 빼고)를 더함.
  - `index.js` `splitWhy`: `save: { room: run.key, boxMode: settings().boxMode, questMode: settings().questMode }`. 버전 `0.7.5-a19`.
- 처리 표와 망가뜨리기 결과: [REVIEW.md](REVIEW.md) 맨 위 v0.7.5-a19.
- 결과는 P1/P2/P3로 주세요.
  - 고치기 전 코드에서 새 검사(`day-break.test.mjs` 25) FAIL. Node 554개: 551 통과 / 0 실패 / 3 건너뜀. 브라우저 70묶음 한꺼번에 모두 통과, 검사 모드 오류 0.

## 특히 봐 줄 곳
1. 실제 저장 호출의 `applyResult` 옵션과 비교 쪽 `save`가 같은지, 그 밖에 사본 저장 결과를 실제와 다르게 만드는 입력(`close`는 장면 상태만 바꿔 안 넘김)이 남았는지.
2. 복귀 확인 유무를 상태에 넣어 맞는 답이 "빠짐"이 되는 경우(잠금 물건, `stored.by: 'story'`, 이미 안내가 있던 물건).
3. 이 수정 뒤에도 남는 a18 저장 결과 비교의 빈틈.

## 일부러 안 한 것
- ⚪ 복귀 확인 시각까지 비교 · ⚪ `back` 값만 따로 비교 · (이전 단계와 같음) ⚪ 여러 번 고친 답은 안 쓰기 · 🟡 a6 P3 · 🟡 a3 P3 · 🟡 날짜·시간 표기가 없는 방.
