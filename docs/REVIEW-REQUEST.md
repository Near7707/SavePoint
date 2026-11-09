# 리뷰 요청 · v0.6.91 (v0.6.90 리뷰 결과 반영)

- 범위: `ee84c23`(지난 요청서) → `aa71c11`(v0.6.91). `git diff ee84c23 aa71c11`.
- 바뀐 것, ★ 항목, 재현·망가뜨리기 결과: [docs/REVIEW.md](REVIEW.md) 맨 위 항목(v0.6.91).
- **바뀐 기존 검사 기대: 0개.** 검사 준비 변경: 없음.
- 검사: `node --test tests/*.test.mjs`(482개) + `for f in tests/browser/*.cjs; do node $f; done`(49묶음, 새 `save-adopt.cjs`) 모두 통과.

## 지난 리뷰 항목 처리

| 항목 | 처리 |
|---|---|
| P1 (저장 중 13개 파일을 확인했는데 성공 응답이 없어 12개 `written`으로 돌아감 → 다른 탭이 지운 13번째 되살림) | `writeBase`: 저장 중 `fileAllows`가 기준으로 삼은 파일이 아직 `gate.seen`이고 이번 쓰기를 담고 있으면(영수증 또는 내용) 그 파일이 기준. 이번 쓰기가 없는 파일(지난 P1-2의 예전 12개)은 지금처럼 `written`. 막을 때 기준을 `written`으로 바꾸는 건 `written`이 기준이었을 때만. 두 순서 모두 `save-adopt.cjs` 1·1b와 `save-answered.cjs` 1·1b로 고정. |
| P2 (상태만 바꾼 백그라운드 저장 실패를 "저장했어요 + 다른 곳에서 지움"으로 오판) | `settleWrite`: 영수증은 이번 쓰기가 바꿨을 때만 증거. 상태만 바꾼 저장은 내용으로 판단하고, 파일에 없으면 미확인으로 두지 않고 거절만 알림(`save-adopt.cjs` 2·2b). |
| P2 (재전송 확인의 `busy`를 실패 확인이 `bad`로 바꿈) | `settleWrite`·`confirmUnsure`도 `genBusy`면 `busy`. `settleWrite`는 `pending`이 아니면 성공으로(`save-adopt.cjs` 3). |
| P2 (메시지 이벤트가 먼저 방을 열면 `held` 저장 0회) | `verifyRoom`이 방을 여는 순간 `held`를 보냄(`save-adopt.cjs` 4). |
| `busy` 중 실리태번 자체 저장 | README 알려진 한계에 기록(SavePoint 범위 밖). |

## 특히 봐 줄 곳

1. `writeBase`의 새 조건: "저장 중 읽은 파일이 이번 쓰기를 담고 있으면 `written`보다 새 기준"이 틀리는 순서. 특히 기억 없는 방(영수증 없음, 내용 `writeResult`로 판단)에서 다른 탭이 같은 표시를 만든 경우.
2. 상태만 바꾼 저장(`own === null`) 실패를 늘 `'revert'`(거절 알림)로 끝내는 것: 그 사이 실리태번 저장이 같은 화면을 이미 썼을 때 기준(`gate.seen`)이 그대로라 다음 확인에서 생길 수 있는 오판.
3. `verifyRoom`에서 `held`를 보내는 것: 방을 연 직후 `persistSoon`이 다른 작업과 겹치는 순서.

결과는 P1/P2/P3로 나눠서, 재현 방법과 함께 주세요. 아직 실제 실리태번에서는 돌려 보지 않았어요.
