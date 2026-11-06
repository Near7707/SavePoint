# 리뷰 요청 · v0.6.62 ~ v0.6.64

- 범위: `82b2634`(v0.6.61) → 이 커밋(v0.6.64). 세 커밋으로 나뉨:
  - v0.6.62 `9c4fe56`: 저장 쪽 작은 수정(P2-1·2·4) — `git diff 82b2634 9c4fe56`
  - v0.6.63 `e7f3922`: 화면만(휴대폰 빠른 설정, 저장 전 STATUS) — `git diff 9c4fe56 e7f3922`
  - v0.6.64: **동작 변화 없음.** 기억 저장 분리(v0.7.0)를 위한 순수 규칙 `home.js` + 검사 + 모의 환경 — `git diff e7f3922 HEAD`
- 바뀐 내용과 ★ 항목: [docs/REVIEW.md](REVIEW.md) 맨 위 v0.6.64, v0.6.63, v0.6.62
- 새 파일: `home.js`, `tests/home.test.mjs`, `tests/browser/mock-home.cjs`, `tests/browser/room-apply.cjs`(v0.6.62)
- 검사: `node --test tests/*.test.mjs`(434개) + `for f in tests/browser/*.cjs; do node $f; done`(34묶음, Playwright). `settings-ui.cjs`의 탭 화살표 항목은 예전부터 가끔 실패하는 타이밍 문제.

## v0.6.64에서 봐 줄 것 (설계 검토)

v0.7.0에서 기억을 채팅 파일 밖(`user/files`)으로 옮김(계획: [PLAN-v0.7.md](PLAN-v0.7.md)). 실리태번이 자기 타이밍에 채팅 전체를 저장하는 것과의 경쟁(지난 구조 리뷰 P1·P2-3)을 기억 쪽에서 없애려는 것. 원칙: 서버와 화면이 다르거나 저장 여부가 불명확하면 쓰지 않고 멈춘 뒤, 방을 다시 열어 판단. 이번 버전은 그 판단 규칙만 순수 함수로 만들어 검사함.

1. `decideRoom`의 0~12번 줄(`home.js` 주석에 표): 순서 때문에 **잘못 연결**(다른 방 기억을 붙임)되거나 **기억이 둘로 갈라지는** 경우가 있는지. 특히 이름 바꾸기·분기·체크포인트·가져오기·다른 기기 이름 바꾸기·고유값 없는 옛 채팅.
2. REVIEW.md v0.6.64 ★의 9번 빈틈과 `savepoint-copy-<사본 해시>` 제안에 대한 의견.
3. `branchRestore`: 되감은 뒤 "기록된 지문 전부 일치"가 충분한 증명인지, 슬롯 대체(`pos.digest`)의 위험.
4. `writePlan`: 단계마다 멈춘 뒤 다시 해도 본체를 덮지 않는지, 이름표를 마지막에 쓰는 순서로 충분한지.
5. 두 기기 `(rev, wid)` 규칙: 읽기~쓰기 사이 틈은 서버가 막아 주지 않음(알려진 한계) — 그 밖에 놓친 것.
6. 모의 환경의 새 기능이 실제 실리태번과 다른 점(분기 메타데이터, 이름 바꾸기 알림 순서·이름, 가져오기).

## v0.6.62·63에서 고친 것 (v0.6.61 구조 리뷰)

- P2-1 불러오기 확인창 중 고친 기억이 덮임 → 비교할 기억 값을 확인창 **전에** 정함
- P2-2 기다리던 편집이 같은 id의 새 장면에 들어감 → 상태마다 `line`, 다르면 편집 취소
- P2-4 적용 중 오류가 화면에 남음 → 적용 오류면 화면도 되돌림, 프롬프트·화면 갱신 오류는 따로(`refreshView`)
- 휴대폰 빠른 설정(v0.6.63): 스킨별 모양, 열린 동안 다시 그려질 때 본문이 잠깐 보였다 숨는지, 닫은 뒤 스크롤 위치

P1·P2-3은 v0.7.0의 저장 분리로 다룸(다시 보고하지 않아도 돼요).

## 모의 환경 메모 (`tests/browser/mock.js`)

기존: `M.serverFiles`, `M.stSave()`, `M.readDelayFor`, `M.readFailAfterSave`, `M.onPopup`, `M.confirm`, `M.promptThrow`, `__savePoint.transact`·`commitEdit`·`persistSoon`. QUICK은 `__savePoint.listSaves().find(x => x.quick)`.
v0.6.64: `M.fileState`·`M.fileDelay`·`M.fileReads`, `M.beforeUpload`·`M.otherPut`·`M.otherDel`, `M.spSaves`·`M.stSaves`, `M.chatList()`, `M.openFile`, `M.renameChat`, `M.deleteChat`, `M.branchChat`, `M.checkpointChat`, `M.importChat`, `M.stIntegrity`.

결과는 P1/P2/P3로 나눠서, 재현 방법(가능하면 모의 환경 코드나 `home.js` 입력)과 함께 주세요.
