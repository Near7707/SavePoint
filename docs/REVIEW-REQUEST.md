# 리뷰 요청 · v0.6.61 (v0.6.60 리뷰 반영 + 변경·저장 구조 점검)

- 범위: `41721c9`(v0.6.60) → 이 커밋(v0.6.61). `git diff 41721c9 HEAD`
- 바뀐 내용과 ★ 항목: [docs/REVIEW.md](REVIEW.md) 맨 위 v0.6.61
- 새 파일: `tests/browser/room-rule.cjs`(지난 리뷰의 재현)
- 검사: `node --test tests/*.test.mjs`(405개) + `for f in tests/browser/*.cjs; do node $f; done`(32묶음, Playwright). `settings-ui.cjs`의 탭 화살표 항목은 예전부터 가끔 실패하는 타이밍 문제.

## 이번에는 구조를 봐 주세요

SavePoint의 채팅 변경·저장 구조를 함께 검토해 주세요.
개별 함수에 검사를 추가하는 데 그치지 말고, 모든 변경 경로가 일관된 안전 조건을 따르는지 확인해 주세요.

최근 세 번의 리뷰는 같은 종류의 문제("미리 정해 두고, 차례가 왔을 때 아직 맞는지 안 봄")를 매번 다른 함수에서 찾았어요. 그래서 v0.6.61에서 공통 규칙을 하나 만들었어요. 이 규칙이 맞는지, 그리고 이 규칙을 따르지 않는 길이 남아 있는지가 가장 궁금해요.

**SavePoint가 의도하는 규칙** (채팅 파일 = 메시지 + 채팅 메타데이터, 실리태번이 통째로 다시 씀)

1. 방이 확인되기 전(`gateOpen()` 거짓)에는 화면의 메시지·메타데이터(SavePoint 기억 포함)를 아무것도 바꾸지 않는다.
2. 화면을 바꾸는 일과 파일에 쓰는 일은 모두 그 방의 대기열(`saveQueue`) 한 줄을 지난다(`transact` → `writeEntry`, 작은 저장은 `guardedSave`, QUICK은 `quickSaveChecked`).
3. 자기 차례에 서버 파일을 다시 읽어, 화면이 그 파일을 덮을 때만(`serverCovered`: `more`·`diff`·`meta`·`gone`·`mem`이 아님) 진행한다.
4. 질문·AI 응답·서버 읽기 뒤에 정해진 변경은 차례에 `still(pre)`로 "아직 유효한가"를 다시 보고, 결과는 그 차례의 `state()`로 계산한다.
5. 확인이 필요한 저장(`verify`)은 쓴 뒤 다시 읽어 `ok`·`failed`(되돌림)·`unsure`(멈추고 영수증 `proofOf`로 나중에 확인)로 나눈다.

**봐 줄 것**

1. 기억이나 메시지를 바꾸는 모든 경로를 찾아서, 각 경로가 위 1~5 중 무엇을 지키고 무엇을 빠뜨리는지. 특히 대기열 밖에서 직접 바꾸고 `persistSoon`·`saveChatSoon`으로 저장하는 것들: `noteAuto`·`recordAutoFail`, `summarize`의 `autoMark`·`autoHold`, `runCheck`의 진행·결과 상태, `reconcile`, `syncHide`, `repairKeep`, `announceReturns`, `roomOpened`의 지점 복사(`roomKey`), 설정 변경 때의 `syncHide`.
2. `still`을 안 들고 차례의 상태로 다시 계산하는 쪽(버튼 편집 `applyPaths`, 루팅 추가·삭제·실패 표시, 장면 닫기, `무시`·`고침`, 리셋)이 정말 안전한지, 아니면 `still`이 필요한지.
3. 이 규칙 자체에 구멍이 있는지(예: `still`과 적용 사이, 적용과 `persist` 사이에 끼어들 수 있는 것, 실리태번 자체 저장과의 순서, 대기열이 영영 비지 않는 경우).
4. 더 단순하게 같은 안전을 얻는 구조가 있으면 제안(예: 기억은 대기열 안에서만 바꿀 수 있게 하는 등).

## 지난 리뷰(v0.6.60)에서 고친 것

- P2 리셋을 기다리던 리와인드가 예전 대상 적용 → `still`(되돌릴 지점이 확인창 때 그대로), 되돌릴 내용은 차례에 계산
- P2 오래된 화면이 QUICK 교체 → `quickSaveChecked`(대기열 + 서버 확인), 막히거나 실패하면 QUICK 안 부름
- P2 기억만 불러오기가 그사이 루팅을 빼먹음 → 루팅 목록은 차례의 상태에서, 기억이 달라졌으면 멈춤
- P2 저장된 체크포인트가 확인 불가에서 안 풀림 → 저장마다 영수증(`wid`), 확인은 영수증과 기록으로(`proofOf`)
- P2 방 확인 중 기록 다시 확인 → `runCheck`는 방 확인 뒤 시작
- P3 중지한 번역·다시 고르기 저장 → `still`에 중지 확인

## 알고 있는 한계

- 서버를 읽은 직후~쓰기 사이에 다른 기기가 저장하는 틈은 확장에서 못 막음.
- 다른 기기에서 `/hide`만 바꾼 차이는 비교하지 않음.
- 실리태번이 메시지를 저장한 뒤 우리가 아직 읽지 않았을 때 다른 기기가 그 메시지를 지우면 `gone`으로 못 잡음. 여기서 지운 직후 다른 기기도 같은 자리를 지운 경우도 못 잡음.
- 버튼을 누른 뒤 표시가 서버 파일을 한 번 읽은 다음에 바뀜. 퀵세이브는 끝에 QUICK 확인으로 한 번 더 읽음.

## 모의 환경 메모 (`tests/browser/mock.js`)

`M.serverFiles`, `M.stSave()`, `M.serverEmpty`, `M.serverError`, `M.readFailAfterSave`, `M.swallowMeta`·`M.silentSaveFail`, `M.onPopup`, `M.characters`, `M.readDelayFor`(방별 읽기 지연 — 차례를 붙잡아 둘 때), `M.switchSame`, `M.readFailAfterNth`, `M.overlap`, `M.metaDelay`, `M.noStSave`, `__savePoint.persistSoon`. 지우기는 `M.chat.pop()` 뒤 `M.eventSource.emit('message_deleted', M.chat.length)`. QUICK은 `__savePoint.listSaves().find(x => x.quick)`.

결과는 P1/P2/P3로 나눠서, 재현 방법(가능하면 모의 환경 코드)과 함께 주세요. 구조 제안은 따로 묶어 주세요.
