# 코드 리뷰 요청 · v0.7.0-b1b (b1a 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 36343f8 82ae85e` — `index.js`(`writeEntry`의 마지막 확인·지문 검사·`memSaved`, `guardedSave` 순서, `homeWrite`/`firstWrite`, `linkHome`·`recheckHome`의 `h.writing`, `onChatRenamed`·`onChatDeleted`), `home.js`(`cleanName`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1b.
- 여전히 다음 조각: b1 리뷰 P1-5(H1 순서)는 b2, P2-1(이름 변경 중간 실패)은 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~20 통과, 전체 56묶음은 b1과 같은 19 통과 / 37 실패, 검사 모드 오류 0).

## 지난 리뷰(b1a 코드 리뷰) 처리
| 항목 | b1b |
|---|---|
| P1-1 | `firstWrite`: `res.seen.wid !== st.wid`면 다시 읽기 전에 `CONFLICT`. |
| P1-2 | 첫 저장 동안 `h.writing`, 그동안 `linkHome`·`recheckHome`은 아무것도 안 함(한 대기열로 합치는 대신). |
| P1-3 | `guardedSave`: `homeStill()` → `stIdle()` → `serverCovered()` → 쓰기. |
| P1-4 | 원문 쪽: `entry.prints`(적용 직후 지문)와 마지막 확인 뒤 표시를 바꾼 메시지의 지문 비교. 기억 리셋 쪽: ⚪(이유는 REVIEW.md). |
| P1-5 | 기록이 방을 따라감(`to === from` → `to = 새 이름`), 삭제 알림으로 그 이름의 기록 지움. |
| P2-1·P2-2·P3 | `roomOpened()` 조건, `cleanName` 확장자, `memSaved`. |

## 특히 봐 줄 곳
1. P1-4 기억 리셋 쪽 ⚪: 틈을 "채팅 읽기 → 쓰기"에서 "기억 읽기 → 채팅 읽기"로 옮긴 판단과 그 결과(원문은 그대로, 숨김만 기억보다 앞섬, 다음 저장에서 그 방 멈춤)가 받아들일 만한지.
2. P1-4 지문 검사가 "이번 변경이 표시를 바꾼 메시지"만 보는 것으로 충분한지(다른 메시지의 원문 변경, 스와이프).
3. P1-2: `h.writing` 동안 버려지는 연결 요청(이름 변경 알림·다시 확인)이 첫 저장 실패(`REFUSED`·`READ_ERROR`, 방이 `new`로 남는 경우) 뒤에도 문제가 없는지.
4. P1-5: 기록 따라가기와 삭제 알림 처리(이름만으로, 모든 범위)에서 진짜 이름 변경을 놓치는 경우.
5. `guardedSave`에서 `homeStill()`이 먼저 오면서 생긴 새 틈(기억 확인 → 채팅 확인 사이의 다른 기기 기억 쓰기).
