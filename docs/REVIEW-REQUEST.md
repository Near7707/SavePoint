# 리뷰 요청 · v0.6.103 (v0.6.102 리뷰 결과 반영 + 장소 영어)

- 범위: `2968dda`(v0.6.102 요청서) → `COMMIT`(v0.6.103). `git diff 2968dda COMMIT`.
- 바뀐 것, ★ 항목, 망가뜨리기 결과: [docs/REVIEW.md](REVIEW.md) 맨 위 항목(v0.6.103).
- **바뀐 기존 검사 기대:** 없음. 검사 준비 변경: 없음.
- 검사: `node --test tests/*.test.mjs`(492개) + `for f in tests/browser/*.cjs; do node $f; done`(51묶음) 모두 통과.
  - 새 검사: `tests/browser/save-foreign.cjs` 8·9a·9b, `tests/request-flow.test.mjs` 장소 2개.

| 버전 | 커밋 | 영역 | 파일 |
|---|---|---|---|
| v0.6.103 | `COMMIT` | 저장·기록 지침 | `index.js`, `prompts.js` |

## 지난 리뷰 항목 처리 (v0.6.102 리뷰 → v0.6.103)

| 항목 | 처리 |
|---|---|
| P2 (두 번째 읽기가 실패하면 첫 읽기의 옛 값으로 덮어씀) | 두 번째 읽기 실패를 그대로 읽기 실패로 돌림(`readSettled`). |
| P3 (방을 옮긴 뒤 이전 방의 재전송 확인이 새 방의 기준에 개입) | `readSettled`가 첫 읽기 뒤·두 번째 읽기 뒤 같은 방인지 확인, 바뀌었으면 `moved`(두 번째 읽기 안 함, `setSeen` 전에 끝남). |

## 특히 봐 줄 곳

1. `readSettled` 밖에서 `readServerChat`을 직접 쓰는 곳에 같은 방 전환 틈이 남았는지.
2. 재요청 뒤 장소만 영어가 아닐 때 장소를 비우고 저장하는 처리(`extractPrompt`)가 다른 검사 결과를 가리는 경우가 있는지.

결과는 P1/P2/P3로 나눠서, 재현 방법과 함께 주세요. 아직 실제 실리태번에서는 돌려 보지 않았어요.
