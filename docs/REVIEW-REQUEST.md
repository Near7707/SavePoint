# 코드 리뷰 요청 · v0.7.0-b1e (b1d 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 91c52f6 c33fe19` — `index.js`(`dropStaleHides`의 `all`, `writeEntry`의 `guard({ sent })`·`relinkedLate`·`unhidAfter`와 `persist` 실패 처리의 `nothingSent`, `writeChatFile`의 요청 생략 조건, `onChatRenamed`의 `foreign`), `home.js`(`decideRoom` 6행 `renamedAway`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1e.
- 반영 범위: P1-1·P1-2·P2·P3 전부. 200건 한도는 고치지 않고 README 알려진 한계에 적음.
- 그대로 다음 조각: 다른 기기에서만 일어나는 리셋 경합(b1b 리뷰 P1-3, `homeStill()` 뒤 `stIdle()` 구간 포함)은 b2 검증 항목, 첫 저장 이름표만 실패는 b3, b1 리뷰 P1-5(H1 순서)는 b2, 이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~42 통과, 고치기 전 코드에선 37·38·39·40·42 실패. 전체 56묶음은 19 통과 / 37 실패, 검사 모드 오류 0 — b1d와 같은 통과 묶음).

## 지난 리뷰(b1d 코드 리뷰) 처리
| 항목 | b1e |
|---|---|
| P1-1 | `guard`가 첫 요청·재전송 직전마다 지금 연결된 기억(`home`·`id`·`line.seen` rev/wid/missing, `pending`·`stop`)이 `mine`인지 확인. 아니면 `dropStaleHides(entry, { all: true })`로 새 숨김 전부 되돌림(다른 표시는 보냄). |
| P1-2 | `onChatRenamed`의 `foreign`에 `leftSeen().some(x => x.from === n.from && !x.foreign)` 추가(최근 20건 밖에서도). `decideRoom` 6행: 연결 복구 직전 `input.left`면 `hold(6, 'renamedAway')`. |
| P2 | 이미 보낸 뒤 `guard`가 숨김을 되돌렸으면(`unhidAfter`) 이후 실패는 `settleWrite`가 성공을 내도 알림으로 끝냄(방은 안 멈춤). |
| P3 | `guard()`가 남은 표시 유무를 돌려주고, 없음 + 아직 안 보냄 + 실리태번이 그사이 저장 안 함(`!landed`)이면 요청 생략. |

## 특히 봐 줄 곳
1. P1-1에서 새 숨김만 버리고 숨김 해제·🔶는 그대로 보내는 것(바깥 `homeStill(mine)`의 `relinked`는 표시 전체를 되돌림 — 둘이 달라도 되는지).
2. P1-2 `foreign`을 `leftSeen` 기준으로 넓힌 뒤 정상 흐름이 보류로 끝나는 경우(떠난 이름에 이 기기에서 들어온 다른 방이 이름을 다시 바꿈, 서버가 이름을 정리한 경우, 그룹 채팅). 넓힌 `took`은 `foreign`만으로 충분해서 넣지 않음.
3. P3에 `!landed`를 더한 판단: 실리태번이 그사이 저장했으면 새 숨김이 실렸을 수 있어 되돌린 사본을 보냄(검사 41).
4. P2 알림 뒤 방을 멈추지 않는 판단(화면은 숨김이 풀려 있어 실리태번 다음 저장이 맞춤, 그 전 새로고침이면 숨김이 남음). 재전송이 실패했지만 실제로는 파일에 들어간 경우에도 알림이 나가는 것(덜 위험한 쪽).
5. `relinkedLate`·`unhidAfter`가 한 저장 안에서 함께 생기는 경우의 문구와 판정.
