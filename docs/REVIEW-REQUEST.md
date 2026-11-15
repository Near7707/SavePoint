# 코드 리뷰 요청 · v0.7.0-b2b1 (b2b 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff e805770 dce17b4` — `guard.js`(`snapshot.sys`), `index.js`(`releasedOf`의 `heldNow`·`{ m, user }`, `fitReleased`·`freeReleased`·`refitReleased`·`freedNow`, `writeEntry`의 `heldNow`·`finally`), 검사(`b2b-race.cjs` 6~9, `gate-stub.mjs`), 문서.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b2b1. P2는 2차 의견(보류, 화면 숨김 유지·표시만 떼기, 되돌린 뒤에 떼기)대로.
- 다음 조각: b2c(기존 브라우저 묶음 36개를 기억 파일 기준으로), b3 이후 그대로.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`b2b-race.cjs` 통과, 고치기 전 코드에선 6~9 실패. 전체 58묶음 결과는 REVIEW.md).

## 지난 리뷰(b2b 코드 리뷰) 처리
| 항목 | b2b1 |
|---|---|
| P1 다시 숨길 원문의 해제를 놓침 | `releasedOf`가 지금 차례의 새 숨김 목록(`heldNow`)도 봄. 마지막 확인·`writeChatFile` 두 곳 모두(검사 6·7). |
| P2 사용자가 서버에서 직접 건 하이드를 해제로 봄 | `sys`로 구분 → 화면 숨김 유지·SavePoint 표시만 뗌·보류, 되돌린 뒤 차례 끝에 다시 맞춤(검사 8·9). |
| P3 방을 나갔다 오면 보호가 사라짐 | 그대로, README 알려진 한계(v0.7.0-b2b1). |

## 특히 봐 줄 곳
1. 새 숨김 쪽 감지가 서버 쪽 원문(마지막으로 본 파일 = 지금 파일)만 비교하는 것이 충분한지, 잘못 잡는 경우가 보류 말고 다른 해를 끼치지 않는지.
2. `refitReleased`를 실패로 끝난 차례에서만 부르는 것: 되돌림 경로(`takeBack`·`undoAll`·바깥 `catch`·`settleWrite` 뒤)를 모두 덮는지, 성공한 차례가 다시 맞추기로 망가지지 않는지.
3. 차례 밖(`guardedSave` 등)에서 찾은 `user` 원문: 되돌림이 없으니 바로 맞춘 그대로인지, `freedNow`가 다음 차례 시작 때 비워지는 것이 안전한지.
4. `fitReleased`가 사용자 숨김에서 `VISIBLE_KEY`까지 지우는 것, 빈 `extra`를 남기는 것.
5. 안내 문구(`RELEASED_NOTE`)를 두 경우 공용으로 바꾼 것.
