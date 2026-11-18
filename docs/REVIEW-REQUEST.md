# 코드 리뷰 요청 · v0.7.0-c1 (일반 전송 답변 전 확인, 브랜치 `v0.7-b`)

- 범위: `git diff def63ab 53ae33f`, 커밋 하나예요.
  - `53ae33f`에 들어간 것: `index.js`("send guard (v0.7.0-c1)" 구역, `onGenerationStarted`, `onChatChanged`, 그룹 묶음 이벤트), `manifest.json`(버전 + `generate_interceptor: savePointSendGuard`), `README.md`, 검사(`send-guard.cjs` 새 묶음, `mock.js`, `home-link.cjs` 11), 문서.
- 설계는 PLAN "v0.7.0-c 설계" 줄(GPT 1·2차 의견 그대로)이고, 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-c1에 있어요.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌렸어요.
  - 62묶음 한꺼번에: 60 통과 + `inject-wait` 5·`status` 알려진 타이밍 실패 → 따로 둘 다 첫 번째에 통과. 검사 모드 오류 0(`send-guard` 25줄).
  - 망가뜨리기 7개 중 5개 잡힘(안 잡힌 2개는 그룹 이번만의 그룹 확인 두 곳 중 하나만 뺀 것, 겹 장치).
  - Node 513 통과 / 0 실패 / 3 건너뜀.

## 바뀐 것
- interceptor `sendGuard`: 일반 전송만. 들어온 순간의 SavePoint 숨김 목록 중 브리핑 기억(`liveState()`, `refreshInjection`과 같은 조건)의 기록 범위 밖이 있으면 확인창(`취소` / `이번만 그대로 답변 만들기`).
- 방 찾는 중이면 최대 5초 기다림. 기다리거나 묻는 사이 방·숨김 목록·기억·빠지는 구간이 바뀌면 `abort(true)` + 안내(자동 재시작 없음). 창 닫기·오류 = 취소.
- 그룹: 이번만은 `GROUP_WRAPPER_FINISHED`까지(구간 바뀌면 다시 물음), 멈출 때 `stopGeneration()`은 들어온 뒤 새 생성이 시작되지 않았을 때만.
- 방이 바뀌면 열린 확인창을 그 자리에서 거짓으로 끝내고, 늦게 닫혀도 무시.
- `GENERATION_STARTED`의 연결 전 경고는 일반 전송이 아닐 때만.

## 특히 봐 줄 곳
1. 실리태번 순서에 기대는 곳: interceptor에 들어온 순간의 화면 숨김 목록 = 생성용 사본이 뺀 것. 사본 생성과 interceptor 사이에 화면이 바뀔 틈이 실제로 있는지.
2. 방 이동 때 곧바로 `moved`로 끝내고 그때 그룹이면 `stopGeneration()`을 부르는 것(그 순간엔 새 생성이 없다고 봄). 실리태번의 방 이동이 이미 생성을 멈추는 경우 두 번 불러도 괜찮은지.
3. `callGenericPopup`의 넷째 인자로 버튼 이름(`okButton`·`cancelButton`)을 주고, 답이 `1`/`true`일 때만 진행. 실리태번 1.19의 결과 값이 맞는지.
4. 기다린 뒤 숨김 목록이 조금이라도 다르면 멈추는 것이 너무 엄격한지(방을 연 직후의 해제 정리로 바뀌는 경우).
5. 원문이 바뀐 방은 되감기가 체크포인트 단위라, 한 번에 기록한 장면이 통째로 빠지면 바뀐 곳 앞 숨김도 빠지는 구간으로 물어요(검사 5). 브리핑과 같은 기준이라 맞다고 봤어요.
