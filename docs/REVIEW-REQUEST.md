# 리뷰 요청 · v0.6.60 (v0.6.59 리뷰 반영: 차례가 왔을 때 다시 확인)

- 범위: `9f3dcfe`(v0.6.59) → 이 커밋(v0.6.60). `git diff 9f3dcfe HEAD`
- 바뀐 내용과 ★ 항목: [docs/REVIEW.md](REVIEW.md) 맨 위 v0.6.60
- 새 파일: `tests/browser/room-turn.cjs`(지난 리뷰의 재현)
- 검사: `node --test tests/*.test.mjs`(405개) + `for f in tests/browser/*.cjs; do node $f; done`(31묶음, Playwright). `settings-ui.cjs`의 탭 화살표 항목은 예전부터 가끔 실패하는 타이밍 문제.

## 지난 리뷰(v0.6.59)에서 고친 것

- P1 이어하기 승인 뒤 고친 첫 메시지가 덮임 → 변경이 자기 차례의 서버 읽기(`pre`)를 받고, 적용 직전에 확인창 때 메시지·인사말 교체 조건을 다시 봄(`stillAsked`)
- P2 확인 불가 해제 뒤 지운 메시지 되살림 → 확인과 기준 채택을 나눔(쓴 내용과 비교해 덮을 때만 `seen`), 지운 메시지를 여기서 고친 경우는 실리태번 삭제 알림으로 기록한 `cut`으로 구분
- P2 방을 연 직후 다른 기기 기억 덮어쓰기 → 첫 확인에서도 파일 기억 ≠ 화면 기억이면 `mem`, 방 확인 전에 화면 기억을 바꾸던 길 정리(`by`, `addLootItems`)
- P2 퀵세이브가 고친 원문 전 기록 → 구간·루팅 보충 적용 직전 `assertStill`(기억 동일·원문 지문 동일)
- P3 예전 형식 기억 사본이 원본 공유 → 사본 전체 복사, `무시`·`고침`은 `markIssue`로 대기열

## 특히 봐 줄 곳

1. **`cut`과 `gone`(`guard.js` `covers`, `index.js` `onMessagesDeleted`·`setSeen`).** 실리태번이 지우기 알림 없이 메시지 수를 줄이는 길이 있는지(있으면 평소 동작이 막힘). `seen`을 바꿀 때 `cut`을 비우는 시점이 맞는지(읽기가 끝난 뒤 지우기 알림이 오는 순서 포함).
2. **첫 확인의 기억 비교(`foreignMemory`).** 방 확인 전에 화면의 SavePoint 기억을 바꾸는 길이 아직 남아 있는지(오탐이 됨). 실리태번의 지점 만들기·채팅 이름 바꾸기·새로고침 뒤 처음 열 때도 같아야 해요.
3. **`stillAsked`·`assertStill`.** 차례를 기다리는 동안 생길 수 있는 다른 변화(하이드, 🔖, 다른 확장의 메타데이터, 스와이프)를 지나치게 막거나 놓치지 않는지. 다른 작업(장면 닫기, 리셋, 리와인드, 번역, 주입 다시 고르기)에도 같은 확인이 필요한지.
4. **`confirmUnsure` 갈래.** 쓴 기억이 있고 화면이 덮으면 해제·기준 채택, `gone`이면 막고 안내, 그 밖의 차이면 `bad`(다음 쓰기 때 다시 확인).

## 알고 있는 한계

- 서버를 읽은 직후~쓰기 사이에 다른 기기가 저장하는 틈은 확장에서 못 막음.
- 다른 기기에서 `/hide`만 바꾼 차이는 비교하지 않음.
- 실리태번이 메시지를 저장한 뒤 우리가 아직 읽지 않았을 때 다른 기기가 그 메시지를 지우면 `gone`으로 못 잡음. 여기서 지운 직후 다른 기기도 같은 자리를 지운 경우도 못 잡음.
- 버튼을 누른 뒤 표시가 서버 파일을 한 번 읽은 다음에 바뀜(긴 방은 조금 늦을 수 있음).

## 모의 환경 메모 (`tests/browser/mock.js`)

`M.serverFiles`, `M.stSave()`, `M.serverEmpty`, `M.serverError`, `M.readFailAfterSave`, `M.swallowMeta`·`M.silentSaveFail`, `M.onPopup`, `M.characters`, `M.readDelayFor`(방별 읽기 지연), `M.switchSame`, `M.readFailAfterNth`, `M.overlap`, `M.metaDelay`(저장 지연 — 대기열을 붙잡아 둘 때), `M.noStSave`(화면만 바꾸기), `__savePoint.persistSoon`. 지우기는 `M.chat.pop()` 뒤 `M.eventSource.emit('message_deleted', M.chat.length)`.

결과는 P1/P2/P3로 나눠서, 재현 방법(가능하면 모의 환경 코드)과 함께 주세요.
