# 코드 리뷰 요청 · v0.7.0-b3b1 (방 열 때 H2 판정과 멈춤, 브랜치 `v0.7-b`)

- 범위: `git diff 0887f18 68b6519` — 커밋 하나.
  - `68b6519`: `index.js`(`h2Of`·`h2Text`·`h2Here`, `linkRounds` 끝 판정, `homeOpen`·`homeMessage`·`homeAlert`·`roomOpened`, `recheckHome`의 따라가기 예외, `followHome`, `syncHide`의 `release`, `reconcileQueued`, `repairKeep`), 버전, 검사(새 `h2-open.cjs`, `b2b-race.cjs` 5b·5c, 준비만 바꾼 `home-link` 22·23 · `wait-room` 3 · `room-rule` 5 · `room-turn` 5), 문서.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b3b1. 기준은 PLAN "v0.7.0-b3 설계"의 b3b 줄과 b3b 설계 GPT 의견 1·2차(판정은 `again`·연결한 본체, H2는 `home`에, 예약 0회, `followHome`은 풀기만, 따라간 기억의 원문이 다르면 멈춤, 멈춘 방 이름 변경 증거 인정). b3b2(정상 방 열기의 채팅 저장 0회, 7e `NOTE`)는 다음 조각.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(전체 59묶음: 한꺼번에 55 통과 + 준비를 고친 4묶음 따로 통과, 검사 모드 오류 0. 고치기 전 코드에서 새 검사 13줄 FAIL, 망가뜨리기 6개 중 5개 잡힘 — 안 잡힌 1개는 겹 장치). Node 510/0/3.

## 바뀐 것
- 판정 `h2Of(st, msgs)`: 기록 범위(`st.hashes`) 안 원문이 서버 메시지와 다르거나 없으면 `source`(숨김 0개여도), 아니면 기억이 덮는 범위(`syncHide`와 같은 `floor`) 밖의 `is_system && savepointHidden`이면 `hides`. 표시 없는 숨김·보이는 원문·`savepointLive`는 안 봄.
- 자리: `linkRounds`에서 `actHome` 뒤, 멈춤 없는 `linked`일 때만, 마지막 서버 읽기(`again`)와 `h.st`로. 기존 보류·읽기 실패·`linkPart`·충돌·응답 없음이 먼저.
- 멈춤: `home.h2` → `homeOpen()` 거짓(저장·자동 기록·`guardedSave` 막힘). 안내와 `다시 확인`, 열 때 알림 한 번. `다시 확인`은 영수증이 같아도 다시 판정, 풀리면 `roomOpened()`.
- 예약 차단: `reconcileQueued` 예약 전·실행 전 `h2Here()`, `repairKeep`은 표시 바꾸기 전 `gateOpen()`.
- 따라가기: `followHome` = `syncHide({ release: true })` + `unhideOnServer()`(되감기 예약·새 숨김·수동 범위 예약 없음). `recheckHome`이 연결 전과 다른 기억(`id`·`rev`·`wid`)에 연결했고 판정이 `hides`면 멈추지 않고 따라감(b2b 복구), `source`면 멈춤.

## 특히 봐 줄 곳
1. 판정 근거가 서버 파일이라, 열어 둔 방에서 원문을 고친 직후(실리태번 저장은 끝, 되감기는 대기열) 그 방의 `다시 확인`이 돌면 방이 멈춰요(기다리던 되감기도 실행 전 확인에서 멈춤). 기억은 그대로라 안전한 쪽으로 보고 README 알려진 한계에 적었어요. 괜찮은지, 아니면 b3b2에서 "이 화면이 이미 아는 원문 변경(`liveState`가 되감기를 계산 중)이면 예외" 같은 걸 둘지.
2. `recheckHome`의 "다른 기억을 따라감" 판단(연결 전 `id`·영수증과 다르면). 충돌로 멈춘 줄(`MF_CONFLICT`)에서 다시 확인한 경우도 들어가요. 그때는 `!wasOpen`이라 `roomOpened()`(일반 `reconcile`·`syncHide`)가 돌아요 — b3b2에서 열기 처리를 바꿀 때 같이 볼 곳.
3. 멈춘 방에도 브리핑은 들어가요(`linkPart`와 같음, c에서 정함).
4. `reconcileQueued`의 `h2Here()` 두 곳은 망가뜨려도 안 잡힘: 부르는 곳이 모두 `gateOpen()`을 보고, 실행돼도 `transact`가 막아요. 그래도 둘지.
5. 기존 검사 준비 바뀜: 실리태번 저장으로만 원문을 고친 뒤 다시 연 방(`home-link` 22·23, `wait-room` 3)과 다른 메시지의 방에 넣은 기억(`room-rule` 5, `room-turn` 5)이 이제 열 때 멈춰서, 원문을 되돌리거나 기억을 만든 메시지로 방을 열게 했어요.
