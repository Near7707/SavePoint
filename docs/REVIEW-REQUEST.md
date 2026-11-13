# 리뷰 요청 · v0.7.0-a2 (v0.7.0-a1 리뷰 반영)

- 범위: `ced27c0`(v0.7.0-a1 요청서) → `fedbd89`(v0.7.0-a2). `git diff ced27c0 fedbd89`.
- 계획: [docs/PLAN-v0.7.md](PLAN-v0.7.md) "v0.7.0-a2" 줄(정한 것).
- 바뀐 것, ★ 항목, 망가뜨리기 결과: [docs/REVIEW.md](REVIEW.md) 맨 위 항목(v0.7.0-a2).
- 검사: `node --test tests/*.test.mjs`(506개) + `for f in tests/browser/*.cjs; do node $f; done`(55묶음, 검사 모드) 모두 통과. 새 묶음 `recheck.cjs`.

| 버전 | 커밋 | 영역 | 파일 |
|---|---|---|---|
| v0.7.0-a2 | `fedbd89` | 세이브 직전 원문 재확인·정리 사본·하이드 복원·배너(v0.7.0-a1 리뷰 P2·P3) | `index.js` |

## 지난 리뷰 항목 처리 (v0.7.0-a1 리뷰 → v0.7.0-a2)

| 항목 | 처리 |
|---|---|
| P2-1 시작 표시 저장 중 원문 수정 → 옛 기억 + 새 지문 | 시작 표시·정리 대기 뒤, 요청 직전에 원문 변경 재확인(`reconcileNow`). 방어로 `baseMatches`(기억의 지문 = 실행이 읽은 지문)를 `assertValid`·`assertStill`에. 검사 `recheck.cjs` 1. |
| P2-2 한국어 보기·주입 포인트의 정리 사본 거짓 완료 | `pageState()`(정리 먼저 저장, 안 되면 시작 안 함)를 `translate`·`rekeyScenes`·`retryLoot`에. 두 작업의 `still`에 화면 기억 확인. 검사 `recheck.cjs` 2·2b. |
| P3-1 원문을 되돌려도 수동 하이드가 풀린 채 | 기다리는 원문 변경 때문에 푼 메시지만 화면 메모리(`liveShown`)에 두고, 변경이 사라지면 수동 모드에서 그것만 다시 숨김. 검사 `recheck.cjs` 3. |
| P3-2 빈 체크포인트 배너가 다른 방에 | 메모 대기 뒤 `here()`. 검사 `recheck.cjs` 4. |
| (확인만) memfile.js 거절 목록 | 그대로. |

## 특히 봐 줄 곳

1. P2-1 재확인 뒤 `newRun`까지 기다림이 없는지, `baseMatches`가 정상 실행(일부 저장·되감기 뒤 다시 세이브·불러오기 뒤)에서 잘못 막는 경우가 없는지.
2. `pageState`가 필요한데 아직 `state()` 사본을 쥐고 AI 요청 뒤 고치는 곳이 남았는지.
3. `liveShown`: 다시 숨기는 조건(수동 모드, 범위 안, 보이는 상태, SavePoint 표시 없음)이 너무 넓거나 좁은지. 사용자가 그 사이 그 메시지를 직접 열었다 닫은 경우.
4. 이번에도 실제 실리태번에서는 돌려 보지 않았어요.

결과는 P1/P2/P3로 나눠서, 재현 방법과 함께 주세요.
