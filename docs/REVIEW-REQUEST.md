# 코드 리뷰 요청 · v0.7.0-b1d (b1c 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 3002b35 8f4a2e6` — `index.js`(`writeChatFile`/`persist`의 `guard`와 반환값, `writeEntry`의 `mine`·`guard`·`written = last`, `homeStill(mine)`의 `relinked`, `leftSeen`/`clearLeft`와 `onChatRenamed`·`onChatDeleted`·`homeInput`·`firstWrite`, `restoreEntry`/`restoreMarks`의 `hideOnly`, `dropStaleHides`, `changedMarks`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1d.
- 반영 범위: P1-1·P1-2·P1-3·P2-1·P2-2·P3 전부.
- 그대로 다음 조각: b1b 리뷰 P1-3(두 기기 리셋 경합, `homeStill()` 뒤 `stIdle()` 구간 포함)은 b2 검증 항목, 첫 저장 이름표만 실패는 b3, b1 리뷰 P1-5(H1 순서)는 b2, 이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~36 통과, 고치기 전 코드에선 30~36 실패. 전체 56묶음은 19 통과 / 37 실패, 검사 모드 오류 0 — b1b·b1c와 같은 통과 묶음).

## 지난 리뷰(b1c 코드 리뷰) 처리
| 항목 | b1d |
|---|---|
| P1-1 | 전역 `sendGuard` 삭제. `persist(fileMeta, guard)` → `writeChatFile(fileMeta, guard)`, 요청 직전마다 그 저장의 `guard()`. |
| P1-2 | `homeWrite` 직후(`freeHome` 전) 이 저장이 쓴 기억 영수증 `mine = { box, id, rev, wid }`. `homeStill(mine)`: 서버 기억 파일이 그 영수증이 아니면 안 씀. 지금 연결된 기억과는 맞으면 방을 멈추지 않고 `relinked`. 다른 id로 연결돼도 `relinked`. |
| P1-3 | `settings().leftNames`(최대 200): 이름을 떠난 방 `{ from, to }`. 이름 변경을 따라가고 원래 이름으로 돌아오면 지움, 목적지 삭제는 `gone`(따라가기만 멈춤), 그 이름의 새 방 `firstWrite` 성공 때 `clearLeft`. `homeInput`의 `left`는 기존 기록 → 없으면 이 목록. |
| P2-1 | `writeChatFile`이 마지막 성공 사본(`sentSnap`)을 돌려주고 `written`으로 씀. 실패 판정은 `written` + `e.sents`. |
| P2-2 | `dropStaleHides` → `restoreMarks(…, { hideOnly: true })`: `is_system`·HIDE·VISIBLE·HELD만, 🔶(KEEP, 스와이프 포함)는 그대로. |
| P3 | `changedMarks`: 이번 변경이 남긴 값이 지금도 그대로인 표시만. `guard`가 하이드를 되돌리면 `marks`도 다시 셈. |

## 특히 봐 줄 곳
1. P1-2 `relinked`에서 방을 멈추지 않는 판단(파일 = 재확인이 연결한 기억이면 방은 정상, 이번 숨김만 버림 → 화면 표시는 되돌리고 `roomOpened()`가 새 기억 기준으로 맞춤). 같은 기억을 다시 연결한 경우(영수증 같음)는 그대로 통과.
2. P1-3 `leftNames`가 지워지는 경우가 "돌아옴"과 `firstWrite` 성공뿐이라, 떠난 이름에 새로 생긴 다른 방이 보류로 남는 기간이 길어짐(20 → 200, 삭제로도 안 지워짐). 서버가 이름을 정리한 경우 따라가는 규칙(열린 방 = 정리된 이름일 때만)과 그룹 채팅.
3. P1-3 기록이 20개 밖으로 밀리면 원래 방(새 이름)도 이름 변경 증거가 없어 보류(예전과 같음, 검사 33). 원본 기억을 사본이 쓰는 일만 막은 것으로 충분한지.
4. P3 `changedMarks` 규칙 변경이 `settleWrite`의 `marksInFile` 판정(그사이 사용자가 직접 바꾼 표시는 이제 빠짐)에 주는 영향.
5. P2-1에서 첫 요청은 응답 없음, 재전송은 성공한 경우처럼 사본이 섞일 때 `written`/`sents`/`unsure` 판정.
