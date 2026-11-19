# 코드 리뷰 요청 · v0.7.0-c2a2 (c2a1 리뷰 반영: `중지 요청`을 키보드로도, 브랜치 `v0.7-b`)

- 범위: `git diff 4ae2b68 <코드 커밋>`, 커밋 하나예요. `index.js`(`sendPrepOpen`만, 버전), `manifest.json`(버전), `README.md`, `docs/PLAN-v0.7.md`, `docs/REVIEW.md`, 검사(`mock.js`, `send-guard.cjs` 22 기대 늘어남 · 29 새로).
- 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-c2a2에 있어요. 결과는 P1/P2/P3로 주세요.
  - 고치기 전 코드(`859f5c5`)에서 2줄 FAIL(22·29). 망가뜨리기 5개 중 4개 잡힘(안 잡힌 1개는 겹 장치).
  - Node 513 통과 / 0 실패 / 3 건너뜀. 브라우저 62묶음 중 61 통과, `status`가 가끔 실패하는데 고치기 전 코드도 같은 자리에서 실패해요(REVIEW.md).

## 바뀐 것
- **키보드(P2):** `중지 요청` 버튼에 `keydown` 처리기. Enter·Space면 `preventDefault`·`stopPropagation` 후 클릭과 같은 `stopAsk()`(누르고 있을 때 반복은 무시). 창의 Enter 처리기(버블)는 안 돌아요.
- **처음 포커스(만들다 찾음):** 실리태번 `setAutoFocus`는 숨긴 OK를 고르고, 숨긴 요소는 포커스를 못 받아 브라우저가 첫 포커스 가능한 요소인 `중지 요청`으로 가요. 그러면 이어서 치던 공백·Enter가 중지를 부를 수 있어서, 창 글에 `tabindex="-1" autofocus`를 줬어요. 겹 장치로 다음 틱에 버튼에 포커스가 있으면 글로 옮겨요. 버튼은 Tab으로 가요.

## 특히 봐 줄 곳
1. 실리태번 `setAutoFocus`가 내용 안의 `[autofocus]`(우리 글)를 먼저 고르는지.
2. 실제 Chrome의 `<dialog>` 포커스 순서에서 겹 장치가 필요한 경우가 있는지(모의 환경에선 `autofocus`로 해결).
3. 창 글이 `setAutoFocus`로 `tabIndex = 0`이 되면 Tab 순서가 글 → 버튼이 되는데, 문제없는지.
