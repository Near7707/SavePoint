# 코드 리뷰 요청 · v0.7.0-b2c2a·b2c2b (b2c2 버그 고치기, 브랜치 `v0.7-b`)

- 범위: `git diff 131d7ff 774317e` — 커밋 두 개.
  - `b8a527a` (b2c2a, A·C·G 안내): `index.js`(`memBlocked`, `summarize` 시작 `catch`, `writeEntry` 채팅 쓰기 `catch` 문구, `awayUnsure`·`settleWrite`의 `away`·실행 `catch`의 `Unconfirmed` 알림 조건), 검사(`save-banner.cjs` 3 준비, `restore-scope.cjs` 2c 문구).
  - `774317e` (b2c2b, E·D, B는 검사만): `home.js` `placeMemory`(`checkMem` 보류에 `read`·`wrote`), `memfile.js` `writeMem`(`quiet`), `index.js`(`MEM_MISSING`·`FIRST_UNSURE`, `placeFirst` 새 분기, `homeWriteError`·`homeMessage`·`homeAlert`), 검사(`room-gate.cjs` 6·7c·7d, `run.cjs`, `loot-bar.cjs` 11·12).
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b2c2b, v0.7.0-b2c2a. 범위는 b2c2 1차의 버그 후보 중 사용자가 고른 것(E는 GPT 의견대로: 방 멈춤 → 다시 확인·다시 열기로 본체를 다시 쓰지 않고 연결).
- 다음 조각: `save-*` 다섯 묶음 옮기기, b2c3(scroll·전체 통과).
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(전체 58묶음: 통과 50 / 실패 8 = 안 옮긴 `save-*` 5(FAIL 수 고치기 전과 같음) + scroll + 가끔 실패하는 `inject-wait`·`status`(따로 통과), 검사 모드 오류 0. 고치기 전 코드에서 새 검사 실패, 망가뜨리기 7개 각각 잡힘).

## 고친 것
- A: 자동 체크포인트의 시작 표시가 기억 파일 저장 거절로 못 쓰이면 알림(전엔 콘솔만). 방 이동·판정 중·게이트 막힘은 지금처럼 조용히.
- C: 기억은 저장되고 채팅 파일만 실패하면 "채팅 파일에 남은 변경을 저장하지 못해서 그 부분만 되돌렸어요"(🔖·🔶도).
- G: 세이브·체크포인트 도중 방을 옮기면 떠날 때 안내만, "들어갔는지 확인하지 못했어요"는 새 방에 다시 안 띄움.
- E: 새 방 첫 본체를 쓴 직후 다시 읽기가 실패하면 화면 기억을 남기고 방 멈춤(전엔 "다른 곳에서 저장" + 화면 기억 버림 → 다음 세이브 충돌).
- D: 서버가 ok라 하고 안 쓴 경우(새 방: 파일 없음, 이어진 방: 파일 그대로)를 다른 기기 탓으로 말하지 않음.

## 특히 봐 줄 곳
1. E에서 멈춘 방을 `다시 확인`·다시 열기가 6행 `relink`로 잇는 것: 본체가 안 다시 써지는지(`resume`이면 `writeMem` 단계가 있으면 멈춤), 그사이 다른 기기가 같은 이름표·본체를 만들었을 때 기존 판정이 맞게 보류하는지.
2. E의 `reopen: true`와 `relink`의 `closes`·`clearLeft` 없음(b3 "이미 있는 이름표 재연결 ①"과 같은 한계로 봄) — 이번에 따로 막아야 하는지.
3. `checkMem` 뒤 단계(`writeClue`·`writeTag`)의 실패는 손대지 않음(본체는 써짐, 지금처럼 되돌림 → b1b 리뷰 P2-1·b3). 이번 범위에 넣어야 하는지.
4. G의 조건(세이브·체크포인트 실행 + 방 바뀜 + `away`)으로 정말 필요한 경고를 숨기는 길이 없는지(🔖 같은 버튼 변경은 그대로 경고).
5. A의 `memWrite`: `CONFLICT`·`READ_ERROR`도 알림 — 다른 안내와 겹치는 곳이 없는지.
