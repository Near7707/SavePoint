# 코드 리뷰 요청 · v0.7.0-b1c (b1b 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 6249fd4 fff7a33` — `index.js`(`writeEntry`의 `homeSettled`·`takeHome`/`freeHome`·`dropStaleHides`·`sendGuard`·`stIdle` 순서·`saved()`, `applyEntry`/`restoreEntry`의 `entry.applied`, `writeChatFile`의 `sendGuard`, `recheckHome`, `homeWrite`, `onChatRenamed`의 `took`/`foreign`, `homeInput`의 `left`, `onChatDeleted`), `home.js`(`renameNotice` 이름 정리, `decideRoom`의 `left`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1c.
- 반영 범위는 지난 2차 의견대로: P1-1·P1-2·P1-4(+P2-2)·P2-3·P3. P1-3은 대기 순서만 당기고 b2 검증 항목, P2-1은 b3 후속.
- 여전히 다음 조각: b1 리뷰 P1-5(H1 순서)는 b2, 이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~29 통과, 전체 56묶음은 18 통과 / 38 실패, 검사 모드 오류 0 — b1b의 통과 19개 중 `keys`만 한꺼번에 돌릴 때 타이밍으로 실패, 따로 돌리면 통과).

## 지난 리뷰(b1b 코드 리뷰) 처리
| 항목 | b1c |
|---|---|
| P1-1 | 게이트 확인 전 `homeSettled`(진행 중인 판정 기다림), 적용 직전 `takeHome`(판정 중이면 적용 없이 취소, 아니면 `h.writing`을 기억 쓰기 결과 처리 끝까지), 그사이 `recheckHome`은 끝난 뒤 다시(`recheckAfter`). `homeWrite`도 판정 중이면 `linking`. `restoreEntry`는 `entry.applied`가 화면에 있을 때만 기억을 되돌림. |
| P1-2 | `dropStaleHides`: 적용 직후 순서·지문(`entry.order`·`entry.prints`)과 비교해 처음 바뀐 위치를 찾고, 그 위치나 뒤의 새 숨김만 화면에서 되돌림. 첫 요청 전과 재전송마다 요청 직전(`sendGuard`). 숨김 해제는 그대로 보냄. |
| P1-3 | `writeEntry`에서 `stIdle()`을 `homeStill()` 앞으로. 남은 틈은 b2 검증 항목. |
| P1-4 | 남이 떠난 이름을 가져간 기록에 `took`, 그 방의 다음 이름 변경 기록은 `foreign`(증거로 안 씀). 이 기기에서 그 이름을 떠난 방이 있으면 연결된 이름표도 보류(`left`). 삭제 알림은 받은 이름 그대로. |
| P2-2 | `renameNotice`가 새 이름을 `cleanName`으로 정리(기록·따라가기 모두 서버 이름). |
| P2-3 | `recheckHome`: `!wasOpen \|\| was !== h.status`면 `roomOpened()`. |
| P3 | 채팅 쓰기 뒤 오류 모두 `memSaved`. |
| P2-1 | b3(본체 저장됨·이름표 미완료 구분, 영수증 확인 뒤 연결 이어가기). |

## 특히 봐 줄 곳
1. P1-1: `takeHome`에서 판정 중이면 기다리지 않고 취소하는 것, `h.writing`을 잡는 범위(적용 → 기억 쓰기 결과 처리, 채팅 쓰기 단계는 밖)와 `recheckAfter`로 미룬 다시 확인이 겹치는 경우.
2. P1-2: 범위를 "#0부터 새로 숨기는 메시지까지"로 둔 것. 바뀐 메시지보다 앞의 새 숨김은 그대로 보내고(`home-link` 19의 기대가 바뀐 이유), 되돌린 뒤 남은 표시가 있으면 쓰기를 이어감. 재전송에서 `sendGuard`가 표시를 되돌린 뒤의 `writeResult`/`settleWrite` 판정.
3. P1-4 `took`/`foreign`/`left` 규칙이 진짜 이름 변경(같은 방 A → B → A, 여러 번 바꾼 방, 그룹 채팅)을 놓치는 경우, 그리고 `left` 기록이 남은 채로 같은 이름에 새로 만든 채팅(보류로 끝남)이 받아들일 만한지.
4. `renameNotice` 정리가 실리태번의 실제 저장 이름과 다를 때(규칙 변경 등) 어느 쪽으로 실패하는지.
5. P1-3 남은 틈을 b2 검증 항목으로 둔 범위가 맞는지.
