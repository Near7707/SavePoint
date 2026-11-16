# 코드 리뷰 요청 · v0.7.0-b3b1a (b3b1 리뷰 반영: 재확인 출처 · 따라갈 때 풀 범위, 브랜치 `v0.7-b`)

- 범위: `git diff b21daed 14ead7b` — 커밋 하나.
  - `14ead7b`: `index.js`(`recheckHome(by)`·`mergeAsk`·`userDuring`·`stoppedBefore`, `freeReleased`의 `'auto'`, `freeHome`이 출처를 넘김, `syncHide`의 `release`는 `state()`), 버전, 검사(`b2b-race.cjs` 5 기대 바뀜 + 5d~5h, `home-link.cjs` 46·47 기대 바뀜), 문서.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b3b1a. 기준은 b3b1 리뷰(P1 1, P2 2)와 2차 의견: P1·P2-1 반영, P2-2(멈춘 방의 저장 타이머)는 b3b2.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(전체 59묶음: 한꺼번에 58 통과 + 기대를 고친 `home-link` 따로 통과, 검사 모드 오류 0. 고치기 전 코드에서 새 검사 5줄 FAIL, 망가뜨리기 6개 모두 잡힘). Node 510/0/3.

## 바뀐 것
- `recheckHome(by = 'user')`: `'auto'`는 `freeReleased`(저장 중 읽은 채팅 파일에서 다른 곳의 숨김 해제를 알아챔)만. 버튼·이름 변경 알림 등은 `'user'`.
- 기억 쓰기 중이라 미룰 때 `recheckAfter = mergeAsk(...)`(하나라도 사용자면 `'user'`), `freeHome`이 그 출처로 실행. 판정 중(`linking`·`opening`)에 들어온 사용자 요청은 `userDuring`.
- `hides` 따라가기 예외는 `by === 'auto' && !userDuring && !stoppedBefore`(연결 전에 `h2`가 없었음)일 때만. 그 밖엔 멈춤 유지(쓰기 0).
- `syncHide({ release: true })`(따라가기)는 `state()`(확인된 본체)로 풀 범위를 계산. 화면에서만 고친 원문의 임시 되감기는 안 씀.

## 특히 봐 줄 곳
1. `'auto'`가 `freeReleased` 하나뿐. 이미 떠난 요청이 리셋 위에 도착한 장면(`b2b-race` 5)은 저장 흐름이 알아챌 계기가 없어 이제 버튼으로 다시 확인하면 멈춤(서버 숨김을 정리하면 이어짐, 맞추기는 b3c). `home-link` 46·47(b1g, 버튼이 리셋을 연결)도 같은 이유로 멈춤으로 바뀜 — 따라가며 서버를 푸는 저장은 5d가 지킴. 이 범위가 맞는지.
2. 판정 중에 들어온 자동 요청은 예전처럼 `again`으로만 남아, 이미 `linked`면 버려져요. 따로 다시 돌리지 않아요.
3. `userDuring`은 다음 실행 시작에 지워요. 미뤄 둔 요청(`recheckAfter`)과는 따로 보관.
4. `mergeAsk`의 "자동 다음 사용자 / 사용자 다음 자동" 합치기는 망가뜨리기로 따로 확인하지 못했어요(기억 쓰기 중에 `freeReleased`가 불리는 장면을 만들기 어려움). 5e(미뤄진 사용자 요청)·5h(자동 실행 중 사용자 요청)만.
5. P2-1에서 `state()`의 정리 예약(`tidyQueued`): 멈춘 방에선 `gateOpen()` 거짓이라 안 돌고, 따라가서 열린 방에선 평소 정리라 그대로 둠.
