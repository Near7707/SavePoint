# 리뷰 요청 · v0.6.100~101

- 범위: `5aee4e2`(v0.6.99 리뷰 메모) → `3656e2a`(v0.6.101). `git diff 5aee4e2 3656e2a`.
- 바뀐 것, ★ 항목, 망가뜨리기 결과: [docs/REVIEW.md](REVIEW.md) 맨 위 두 항목(v0.6.101, v0.6.100).
- **바뀐 기존 검사 기대(v0.6.101):** `tests/guard.test.mjs` 두 곳(다른 키·작가 노트 값 차이 → `meta`였던 것이 `ok`, 대신 `integrity`·`tainted` 차이는 `meta`), `tests/browser/room-gate.cjs` 5 "다른 확장의 메타데이터"(막힘 → 저장되고 파일 값 유지). 검사 준비 변경: `tests/gate-stub.mjs`에 `sendSnap`.
- 검사: `node --test tests/*.test.mjs`(490개) + `for f in tests/browser/*.cjs; do node $f; done`(51묶음) 모두 통과.
  - 새 검사: `tests/browser/save-foreign.cjs`, `tests/prompt-parts.test.mjs` 1개.

| 버전 | 커밋 | 영역 | 파일 |
|---|---|---|---|
| v0.6.100 | `8fc0834` | 장면 지침 | `prompts.js` |
| v0.6.101 | `3656e2a` | 저장 | `guard.js`, `index.js` |

## v0.6.101 설계 배경

구현 전에 물어본 설계 질문에 대한 답(SavePoint 것이 아닌 키는 SavePoint 요청에 서버 파일 값을 그대로 싣기, 보낸 사본을 `seen`·`ownCopy`의 사본으로)대로 했어요. 그 답에서 짚은 `writeBase`가 `written`으로 돌아가는 경로는, 이제 다른 키를 화면 값으로 쓰지 않으므로 생기지 않는다고 봤어요.

## 특히 봐 줄 곳

1. (v0.6.101) 파일을 읽은 뒤 실리태번이 화면 전체(확장의 새 값 포함)를 저장하고, 그 저장이 `stIdle` 검사 전에 끝나면 SavePoint 요청이 그 키를 옛 파일 값으로 되돌려요. 이 수정으로 **새로** 생긴 손실 경로인지, 기존 열린 문제(v0.6.76)와 같은 틈인지.
2. (v0.6.101) `PAGE_KEYS = ['integrity', 'tainted']` 말고 화면 값으로 보내야 할 키가 있는지. 실리태번 키(`main_chat`, 분기·체크포인트 관련 등)를 파일 값으로 보낼 때 문제 되는 순서가 있는지.
3. (v0.6.101) `lastFile`은 "이 방에서 마지막으로 끝난 읽기"예요. 두 읽기가 겹칠 때 더 오래된 값이 남는 순서가 의미 있는지.
4. (v0.6.101) 다른 확장 키 차이로만 드러나던 "다른 기기에서 이어진 방"을 이제 못 찾는데, 메시지·`integrity`·SavePoint 기억 검사만으로 충분한지.
5. (v0.6.100) 지침 문장이 장면을 너무 잘게 나누게 할 위험(밤새 같은 활동이 새벽까지 이어지는 경우).

결과는 P1/P2/P3로 나눠서, 재현 방법과 함께 주세요. 아직 실제 실리태번에서는 돌려 보지 않았어요.
