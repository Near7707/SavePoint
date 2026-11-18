# 코드 리뷰 요청 · v0.7.0-c1c (c1b 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff b42b187 0672f18`, 커밋 하나예요.
  - `0672f18`에 들어간 것: `index.js`("send guard (v0.7.0-c1)" 구역의 `sendCuts`·`sendHasOf`·`extraCounts`·`extraShared`·`startHeld`·`sendAsked`·`sendTold`·`sendToldText`·`onGroupStarted`·`onSendDeleted`·`sendGuard`, `onGenerationStarted`의 `shared`·알림 조건), `manifest.json`(버전만), `README.md`, `docs/PLAN-v0.7.md`, `docs/REVIEW.md`, 검사(`send-guard.cjs` 9 순서, 12 기대 바뀜·새 줄, 14·15 새로).
- c1b 리뷰(P1 1·P2 1·P3 1)와 2차 의견대로 고쳤어요. 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-c1c에 있어요.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌렸어요.
  - 62묶음 한꺼번에: 60 통과 + `keys`·`status`(한꺼번에 돌릴 때 가끔 실패하던 묶음) → 따로 둘 다 첫 번째에 통과. 검사 모드 오류 0(`send-guard` 56줄).
  - 고치기 전 코드(`a04bef8`)에서 새 줄 8개 FAIL. 15는 `extra` 읽기 7,929,900회·147ms → 고친 뒤 17,860회·4ms.
  - 망가뜨리기 7개 중 6개 잡힘. 안 잡힌 하나는 아래 5예요.
  - Node 513 통과 / 0 실패 / 3 건너뜀.

## 바뀐 것
- **P1 삭제한 그룹 방은 새로고침까지 알림만:** 그룹 방의 `MESSAGE_DELETED`가 방 키를 `sendCuts`(Set)에 더해요. 이 표시는 어디서도 지우지 않아요(방 이동·다시 열기·묶음 끝 모두 그대로). 그래서 페이지 새로고침까지 유지돼요.
  - `onGroupStarted`: 지금 방에 표시가 있으면 후보를 버리고, 그 묶음을 `sendGroup = { key, epoch, tell: true, told: false }`로 둬요. 묶음 종류는 가리지 않아요.
  - `sendAsked`는 `tell` 묶음이면 거짓이에요. 새 `sendTold(type)`가 일반 전송 종류(`'normal'`·없음)의 그 묶음 답변을 골라요.
  - `sendGuard`의 `told` 길: `abort`·`stopGeneration`을 절대 부르지 않아요.
    - 시작 숨김이 풀렸으면(예전 `changed`) "빠졌을 수 있어요" 알림을 띄워요.
    - 아니면 빠진 숨김을 계산하고, 방을 찾는 중이면 기다려요. 방이 바뀌었으면 조용히 끝나요. 그다음 `sendGap` → `refreshInjection()` → 구간이 있을 때만 알림을 띄워요.
    - 알림은 묶음 객체의 `told`로 묶음마다 한 번이에요. `catch`도 기록만 해요.
  - 기억 연결 전 알림(`onGenerationStarted`, `ui.sendWarned`)에 `!sendTold(type)`를 넣어, 같은 답변에 두 알림이 겹치지 않게 했어요.
- **P2·P3 한 번 세기:** `sendHasOf(copy, n, key, epoch)`가 지금 채팅과 사본의 `extra`별 개수를 한 번씩 세어 판정 함수를 돌려줘요.
  - 생성 시작 때 둘 이상이 가진 `extra`(`sendStart.shared`)는 근거로 쓰지 않아요. 같은 생성의 시작 기록일 때만 적용돼요.
  - 시작 숨김 확인, 빠진 숨김 계산, 기다린 뒤 비교, 확인창 뒤 비교가 각 시점에 새로 만들어 써요.

## 특히 봐 줄 곳
1. **표시가 방 키라서 방 이름을 바꾸면 새 이름엔 안 이어져요.** 재생성이 멤버를 기다리는 바로 그 순간 이름을 바꿔야 문제가 돼서 README 한계에 적었어요. 더 넓게 "그룹 삭제가 한 번이라도 있으면 모든 그룹 방을 알림만"으로 할지 봐 주세요.
2. **`tell` 묶음은 종류를 가리지 않지만, 확인 단계는 일반 전송 종류만 봐요.** 그룹 스와이프 등은 예전처럼 기억 연결 전 알림만 떠요.
3. **`told` 묶음에서 방이 바뀌면 조용히 끝나요**(예전 `moved` 멈춤 대신). 멈추지 않는 게 맞는지 봐 주세요.
4. **시작 공유 제외는 같은 생성의 `sendStart`일 때만이에요.** 시작 기록이 없거나 다른 생성이면 예전처럼 지금 채팅·사본만으로 세요.
5. **검사 없는 곳:** 기억 연결 전 알림의 `!sendTold`를 빼도 안 잡혀요. 그 알림이 방마다 한 번이라 겹치는 장면이 검사에서 안 생겨요.
