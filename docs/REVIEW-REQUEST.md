# 리뷰 요청 · v0.6.59 (v0.6.58 리뷰 반영: 방 이동·한 방 한 줄·비교 규칙)

- 범위: `77b22e4`(v0.6.58 + 요청서) → 이 커밋(v0.6.59). `git diff 77b22e4 HEAD`
- 바뀐 내용과 ★ 항목: [docs/REVIEW.md](REVIEW.md) 맨 위 v0.6.59
- 새 파일: `tests/browser/room-order.cjs`(지난 리뷰의 재현)
- 검사: `node --test tests/*.test.mjs`(404개) + `for f in tests/browser/*.cjs; do node $f; done`(30묶음, Playwright). `settings-ui.cjs`의 탭 화살표 항목은 예전부터 가끔 실패하는 타이밍 문제.

## 지난 리뷰(v0.6.58)에서 고친 것

- P1 A방 불러오기가 B방에 저장 → `roomReady()`가 물어본 방 기준으로 답하고, `loadSave`·`transact`는 기다리기 전에 방을 잡음
- P1 A방 이어하기 취소가 B방 #0을 지움 → 넣은 메시지 객체만 빼고, `tainted`는 그 방 메타데이터에만
- P2 다른 기기에서 지운 마지막 메시지가 되살아남 → 마지막으로 확인한 파일(`gate.seen`)과 비교(`gone`)
- P2 같은 rev면 다른 기기의 저장도 확인 → 쓴 기억 전체로 확인, 쓰기 전에는 다른 기기가 쓴 기억(`by`)을 막음(`mem`)
- P2 화면 변경·지연 저장이 앞 작업 확인을 기다리지 않음 → 한 방 한 줄(비교 → 적용 → 저장 → 확인), `guardedSave`도 같은 줄, 방 확인 전 `state()` 업그레이드 없음, `retryLoot`도 관문
- P2 루팅 보충 확인 불가인데 퀵세이브 완료 → `Unconfirmed`를 위로 넘김
- P2 예전 첨부 형식·작가 노트 `null` 오탐 → 실리태번과 같은 규칙으로 맞춘 뒤 비교
- P3 머리줄 없는 그룹 채팅의 성공 판정 → 기억이 파일에 보일 때만 `ok`

## 특히 봐 줄 곳

1. **한 방 한 줄(`transact` → `writeEntry`).** 변경이 자기 차례에 적용되도록 바꿨어요. 버튼 편집은 누른 때의 기억으로 계산한 바뀐 값(`diffPaths`)을 차례에 적용(`applyPaths`), 저장 실행·번역·다시 고르기는 시작 전에 대기열이 빌 때까지 기다림(`queueIdle`). 대기열을 기다리는 동안 생길 수 있는 문제(교착, 차례가 왔을 때 이미 다른 상태인 변경, 앞 저장이 실패했을 때 뒤 변경 처리)가 없는지. 대기열 밖에서 기억이나 하이드 표시를 바꾸는 길이 아직 있는지(`reconcile`·`syncHide`·`repairKeep`·`announceReturns` 등이 `persistSoon`으로 저장하는 경우).
2. **`gone` 판단.** 다른 곳에서 지운 메시지와 여기서 새로 만든 메시지를 `seen`과 내용으로 구분해요. 스와이프·다시 생성·여기서 지우기 같은 평소 동작이 잘못 막히지 않는지, `seen`을 언제 바꾸는 게 맞는지(지금: 덮는 게 확인된 읽기, verify 성공, 확인 불가 해제).
3. **`by`와 `mem` 판단.** 실리태번 자체 저장, 새로고침, 세이브 불러오기, 리와인드 뒤에도 내 기억을 남의 것으로 오인하지 않는지. 반대로 다른 기기의 기억을 놓치는 경우.
4. **`confirmUnsure`.** 쓴 기억 해시가 파일에 있으면 확인, 쓰기 전 해시면 "저장이 없어요". 그 사이 실리태번이 메시지를 더 저장한 경우도 맞게 판단하는지.
5. **첨부 정규화(`guard.js`의 `mediaShape`).** 실리태번 `ensureMessageMediaIsArray`(`public/script.js`)와 같은 결과인지. 스와이프 `extra`는 실리태번이 안 바꿔서 그대로 비교해요.
6. **방 확인 전 `state()`.** 예전 형식(`evidenceVersion` ≠ 1) 기억은 업그레이드한 사본을 돌려줘요. 그 사본이 쓰이는 동안 바뀌거나 저장되는 길이 없는지.

## 알고 있는 한계

- 서버를 읽은 직후~쓰기 사이에 다른 기기가 저장하는 틈은 확장에서 못 막음.
- 다른 기기에서 `/hide`만 바꾼 차이는 비교하지 않음.
- 실리태번이 메시지를 저장한 뒤 우리가 아직 읽지 않았을 때 다른 기기가 그 메시지를 지우면 `gone`으로 못 잡음.
- 버튼을 누른 뒤 표시가 서버 파일을 한 번 읽은 다음에 바뀜(긴 방은 조금 늦을 수 있음).

## 모의 환경 메모 (`tests/browser/mock.js`)

v0.6.58의 것(`M.serverFiles`, `M.stSave()`, `M.serverEmpty`, `M.serverError`, `M.readFailAfterSave`, `M.swallowMeta`·`M.silentSaveFail`, `M.onPopup`, `M.characters`)에 더해 `M.readDelayFor`(방별 읽기 지연), `M.switchSame`(같은 메시지 배열로 방 전환), `M.readFailAfterNth`(N번째 저장 뒤 읽기 실패), `M.overlap`(저장이 겹친 횟수), `__savePoint.persistSoon`.

결과는 P1/P2/P3로 나눠서, 재현 방법(가능하면 모의 환경 코드)과 함께 주세요.
