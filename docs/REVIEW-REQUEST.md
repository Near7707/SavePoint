# 코드 리뷰 요청 · v0.7.1-a1 (창 맨 위 기억 상태 한 줄 + 짧은 이유, 브랜치 `v0.7.1`)

- 범위: `git diff 034f7e6 315678d`, 커밋 하나예요. `index.js`(`roomStatus`·`roomLineHtml`·`paintRoomLine`, `render`·`verifyRoom`·`markUnsure`에서 줄 갱신, 시험 손잡이 `gate`·`roomStatus`), `style.css`(`.sp-roomline`), 새 검사 `tests/browser/room-line.cjs`, 문서(README·PLAN·REVIEW·TEST-NOTES), 버전 `0.7.1-a1`.
- GPT 설계 + 2차 의견(겹치면 채팅 파일 문제가 먼저, 답변 대기는 `gate.status === 'busy'`만, 이유 줄은 이번에, 편집 중 갱신 확인)을 코드로 확인하고 반영했어요. 새 판정·새 버튼·저장은 없어요.
- 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.1-a1에 있어요. 결과는 P1/P2/P3로 주세요.
  - 고치기 전 코드(`034f7e6`)에서 새 묶음 FAIL. 망가뜨리기 7가지 중 7가지 잡힘.
  - Node 518개: 515 통과 / 0 실패 / 3 건너뜀. 브라우저 64묶음 한꺼번에 모두 통과, 검사 모드 오류 0.

## 특히 봐 줄 곳
1. `roomStatus()`의 순서가 `gateMessage`·`homeMessage`와 어긋나 실제 상태를 잘못 보여 주는 경우가 있는지(일부러 다르게 둔 곳은 REVIEW ★1).
2. 저장이 막혔는데 "기억 연결됨"으로 보이거나, 처음 연 방이 "확인 필요"로 보이는 경우가 있는지.
3. 상태가 바뀌었는데 줄이 바뀌지 않는 경로(다시 그리지 않는 곳)가 남았는지. 따로 넣은 곳은 편집 중 건너뛰기·`verifyRoom` 끝·`markUnsure`.
4. 이유 문구의 "잠시 뒤 다시"와 "방을 다시 열기", 최근 메시지 복사 안내가 기존 알림 문구 규칙과 맞는지.
