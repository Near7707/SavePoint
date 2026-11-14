# 코드 리뷰 요청 · v0.7.0-b1a (b1 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff ebde69c 68c1e84` — `index.js`(`writeEntry`, "room home" 구역의 `linkHome`·`linkRounds`·`lineFor`·`recheckHome`·`homeWrite`·`onChatRenamed`, `loadSave`의 #0), `home.js`(`cleanName`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1a. 계획: [PLAN-v0.7.md](PLAN-v0.7.md)의 "v0.7.0-b1a" 줄.
- 이번에 하지 않은 것: P1-5(늘리는 숨김도 H1 순서로)는 b2, P2-1(이름 변경 중간 실패·A → B → A)은 b3~b4, P2-2는 그대로(이유는 REVIEW.md 표).
- 결과는 지난번처럼 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~15 통과, 전체 56묶음은 b1과 같은 19 통과 / 37 실패, 검사 모드 오류 0).

## 지난 리뷰(b1 코드 리뷰) 처리
| 항목 | b1a |
|---|---|
| P1-1 | 기억 쓰기 뒤·`homeStill()` 뒤 `moved()` 확인(표시만 되돌리고 취소). 채팅 쓰기 직전 `stIdle()` → `serverCovered()` 다시, 그 결과로 `written`·`marks`·`tick`을 다시 계산해 그 위에서만 씀. 재전송은 기존 `fileAllows`. |
| P1-2 | `h.linking`(첫 await 전에 잡음, `recheckHome`도), 겹친 요청은 `h.again`. `lineFor`: 새 `memLine`도 이전 줄의 `pending`을 이어받음. 판정 반복·배치·이름 변경 전에 `pending`이면 끝. |
| P1-3 | 새 방 첫 생성은 다시 읽은 본체 `wid === st.wid`일 때만 성공, 아니면 `CONFLICT`(통째로 되돌림 + 그 방 멈춤). |
| P1-4 | 추측 경로를 빼는 대신 좁힘: 지금 방 이름 === `cleanName(입력한 이름)`일 때만. |
| P2-3 | #0 이어하기를 b3까지 끔(기억만 불러오기 질문 한 번). |
| P3 | 7·11번 단언 추가. |

## 특히 봐 줄 곳
1. P1-1: `serverCovered()`를 쓰기 직전에 다시 부르면서 `pre`를 바꾼 것 — `settleWrite`·`markUnsure`가 받는 `pre`(snap·rev·proof)와 `written`·`marks`·`tick`이 서로 맞는지. 변경 전 확인(`entry.still`)은 다시 하지 않았는데 괜찮은지.
2. P1-2: `linkHome`/`linkRounds`/`recheckHome`의 잠금. `verifyRoom`의 `linkHome`이 잠금 때문에 바로 돌아간 경우 `roomOpened()`가 연결 전에 불리고, 연결은 `recheckHome`이 끝낼 때 `roomOpened()`를 다시 부르는 흐름이 빠짐없는지. 잠금이 풀리지 않는 길이 있는지.
3. P1-2: `pending`이 화면이 그 방을 연 동안 계속 남는 것(새 줄로 바뀌어도). 풀리는 건 방을 다시 열 때뿐인데, 막혀서 못 푸는 경우가 있는지.
4. P1-3: 다시 읽은 본체가 다른 영수증일 때 "덮임"(화면 기억 남김) 대신 "충돌"(통째로 되돌림)로 한 것. 이번 변경이 실제로 들어갔다가 덮인 경우도 같은 처리가 맞는지.
5. P1-4: `cleanName`(sanitize-filename 규칙 옮김)이 실리태번 서버와 다를 때 실패 방향(옮기지 않음)이 안전한지. 10초·같은 범위 조건은 그대로.
6. P2-3: 불러오기 경로에서 `insert`가 늘 거짓이 되며 남은 코드(`putCarried`·`undoMessage`·tainted)가 도달하지 않는지.
