# 코드 리뷰 요청 · v0.7.0-b3b1b (b3b1a 리뷰 반영: 재확인 출처를 읽기 시작점에서 · 따라가기 저장 한 번, 브랜치 `v0.7-b`)

- 범위: `git diff badd3ab 2aff007` — 커밋 하나.
  - `2aff007`: `index.js`(`freeReleased(list, by)` 기본 `'user'`, `serverCovered(…, { by })`·`persist → writeChatFile → fileAllows`에 `by`, `writeEntry`·`releaseFirst`만 `'auto'`, `recheckHome`이 자기 읽기에 출처를 넘김, `syncHide({ release: true })`는 저장 예약 없음, `unhideOnServer`는 확인된 기억이 못 덮는 숨김만 보고 저장), 버전, 검사(`b2b-race.cjs` 5i~5l), 문서.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b3b1b. 기준은 b3b1a 리뷰(P1 1, P2 1)와 2차 의견: 둘 다 반영.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(전체 59묶음 한꺼번에 모두 통과, 검사 모드 오류 0. 고치기 전 코드에서 새 검사 4줄 FAIL, 망가뜨리기 7개 중 4개 잡힘 — 나머지 3개는 아래 ★). Node 510/0/3.

## 바뀐 것
- 출처(`by`)는 채팅 파일을 읽은 곳이 넘겨요. `'auto'`는 `writeEntry`(변경 전 확인·마지막 확인·채팅 저장)·`releaseFirst`(채팅 확인·풀기 저장)뿐. 백그라운드 저장·QUICK 백업 전 확인·불러오기 사전 확인·방 열기·버튼은 `'user'`. 자동 재확인은 자기 읽기에도 `'auto'`.
- 따라가기: `syncHide({ release: true })`는 화면만 맞추고, 채팅 저장은 `unhideOnServer`가 한 번 정해요. 조건은 "확인된 기억이 못 덮는(`i > lastIndex`) SavePoint 숨김이 서버에 남고 화면에선 풀림". 섞이면 범위 안 해제도 함께 감(다음 하이드 차례에 다시 숨김).

## 특히 봐 줄 곳
1. `recheckHome('auto')`가 자기 읽기에 `'auto'`를 넘겨요. 그 읽기에서 또 알아챈 해제는 예전처럼 `again`만 남아요. 이걸 `'user'`로 망가뜨려도 안 잡혔어요(장면을 못 만듦).
2. 백그라운드 저장의 재전송 검사(`writeChatFile` → `fileAllows`)는 `'user'`로 내려가지만 검사로는 못 지켜요(`persist` 기본 `'auto'` 망가뜨리기 통과). 그 경로는 실리태번 저장을 기다린 뒤라 바로 앞 `homeStill()`이 기억 변경을 먼저 막아요.
3. 따라가기 때 화면에서만 바뀐 다른 표시(🔖 정리·사용자 해제 표시·`HELD` 떼기)는 그 자리에서 저장하지 않고 다음 저장에 실려요.
4. `home-link` 46~51(b1g "서버에만 남은 숨김 정리")은 기대 변경 없이 통과했어요.
