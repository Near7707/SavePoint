# 코드 리뷰 요청 · v0.7.0-c4 (복사 복구 `이 방에 기억 복사해 복구` · `답변 만들기` Esc 안내, 브랜치 `v0.7-b`)

- 범위: `git diff 078430e 87a946c`, 커밋 하나예요. `home.js`(`decideRoom` 8행 + `rescueOffer`·`sameRescue`), `index.js`(`linkRounds` 동의 전달·제안, 새 구역 "a copy of another room's memory, made by hand", `homeMessage`·`homeAlert`·`handle`, `sendRetryRun`·`sendPrepOpen`의 Esc 구분, 버전), `manifest.json`(버전), `README.md`, `docs/PLAN-v0.7.md`, `docs/REVIEW.md`, `docs/CHECKLIST-v0.7.0.md`, 검사(`tests/browser/rescue.cjs` 새로, `send-guard.cjs` 31, `tests/home.test.mjs` 2개).
- 설계는 GPT 1·2·3차 의견대로예요(독립 사본, 원래 기억·이름표 보존, 후보 하나·같은 범위·고유값·기록 범위 원문 전체 일치, 동의는 후보와 대상 방 모두에 묶음, 갈래 쓰기·재개 재사용, 이름표 응답 없음은 `linkLate`대로, Esc는 멈춤 신호 + 멈춤 오류일 때만).
- 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-c4에 있어요. 결과는 P1/P2/P3로 주세요.
  - 고치기 전 코드(`078430e`)에서 `rescue` 11줄·`send-guard` 31 두 줄 FAIL. 망가뜨리기 7개 모두 잡힘.
  - Node 518개: 515 통과 / 0 실패 / 3 건너뜀. 브라우저 63묶음 한꺼번에 모두 통과, 검사 모드 오류 0.

## 특히 봐 줄 곳
1. 동의 뒤 판정은 `다시 확인`이 두 파일과 이 방 채팅을 새로 읽어 다시 함 → 그 뒤 `placeMemory` 쓰기까지의 짧은 틈은 갈래와 같음. 연결 뒤 H2 판정이 기록 범위 원문 차이를 잡는 것으로 충분한지.
2. 채팅 속 예전 사본이 있는 복제본에서, 원래 방이 그 사본에서 이전된 방이어도(`moved` 표시·사본 힌트가 원래 방을 가리킴) 갈래 쓰기·다시 열기(6행이 자기 기억을 먼저 찾음)에 문제가 없는지.
3. `AbortError`도 멈춤 오류로 보는 것(우리 `중지 요청`·일반 요청 중단)이 너무 넓은지.
4. 망가뜨리기로 못 지킨 곳: `rescueReady`의 제안 ID 비교, 동의의 열기 회차 비교(방을 옮기면 `home`이 새로 만들어지는 겹 장치).
