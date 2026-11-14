# 코드 리뷰 요청 · v0.7.0-b1h (b1g 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 41f1622 c11fd7c` — `home.js`(`tagBody`의 `closes`, `renameId`, `placeMemory`의 `closes`, `decideRoom` 5행), `index.js`(`placeFirst`의 `closes`, `homeInput`의 `renames[].id`, `writeEntry` 바깥 `catch`의 `Relinked` 통과, `reportError`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1h.
- 반영 범위(2차 의견대로): P1·P2-1·P3. P2-2(첫 저장 중 이름 변경 보류)는 보류하고 README 알려진 한계에 적었어요.
- 그대로 다음 조각: 다른 기기에서만 일어나는 리셋 경합(`homeStill()` 뒤 `stIdle()` 구간 포함)은 b2 검증 항목, 첫 저장 이름표만 실패는 b3, b1 리뷰 P1-5(H1 순서)는 b2, 이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~52·49b 통과, 고치기 전 코드에선 45·49b·52 실패. 전체 56묶음 결과는 REVIEW.md).

## 지난 리뷰(b1g 코드 리뷰) 처리
| 항목 | b1h |
|---|---|
| P1 | 첫 저장 시작 때 있던 `from === A` 기록 전체의 ID(`from|at`)를 새 이름표의 `closes`에 적음. 5행은 이름표가 그 기록을 막고 있으면 건너뜀. 설정이 새로고침으로 돌아가도 이름표와 함께 도착. |
| P2-1 | 바깥 `catch`에서 `Relinked`를 감싸지 않고 그대로 넘김 → `relinkedRun` 처리(실패 기록·`autoMark`·AUTO 백업 없음). |
| P2-2 | 보류(이름 변경 알림에 고유값이 없어 이 방의 기록인지 확인 불가). README 한계. |
| P3 | `reportError`가 `Relinked`만 안내로 표시. |

## 특히 봐 줄 곳
1. P1: `closes`가 `was.from` 전체(이미 `closed`였던 기록 포함)인 것, `renamedTag`가 `closes`를 그대로 이어 가는 것, 같은 `from|at` 기록이 둘인 경우(P2-4의 서버 정리 이름 기록).
2. P1: 이름표 쓰기 재시도(`sameLink`로 이미 있는 이름표를 그대로 둘 때)에는 `closes`가 새로 안 붙음 — 첫 시도가 쓴 이름표에 이미 들어 있는지.
3. P2-1: `Relinked`가 바깥 `catch`를 지날 때 `restoreMarks`·대기 취소를 건너뛰는 게 맞는지.
