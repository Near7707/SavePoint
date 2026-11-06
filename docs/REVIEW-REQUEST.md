# 리뷰 요청 · v0.6.65 + v0.6.66 (v0.6.64 리뷰 반영)

- 범위: `4230fe0`(v0.6.64) → 이 커밋(v0.6.66). 두 커밋으로 나뉨:
  - v0.6.65 `ce4afe2`: **동작 변화 없음.** `home.js` 규칙 보강(P2 4건) + 이전 시작 표시 · `copy-` 단서 · 동시 이전(`placeMemory`) + 모의 환경 — `git diff 4230fe0 ce4afe2`
  - v0.6.66: 화면만(P3 휴대폰 빠른 설정 스크롤) — `git diff ce4afe2 HEAD`
- 바뀐 내용과 ★ 항목: [docs/REVIEW.md](REVIEW.md) 맨 위 v0.6.66, v0.6.65. 계획: [PLAN-v0.7.md](PLAN-v0.7.md)(v0.6.65 표시가 바뀐 곳)
- 새 파일: `tests/browser/qs-scroll.cjs`
- 검사: `node --test tests/*.test.mjs`(442개) + `for f in tests/browser/*.cjs; do node $f; done`(35묶음, Playwright). `settings-ui.cjs`의 탭 화살표 항목은 예전부터 가끔 실패하는 타이밍 문제.

## 지난 리뷰(v0.6.64)에서 고친 것

- P2 이름표 없을 때 구버전이 바꾼 사본 → 기억 파일에 `copy`, 6번에서 비교, 방 주소로 찾는 이전 시작 표시
- P2 연결된 분기 가져오기 → 판정 순서 6 → 8 → 7
- P2 첫 메시지부터 다른 분기 → 남은 기록 0개는 증명 아님, 맞는 슬롯 아니면 보류
- P2 느슨한 검사 → `validState` 강화, `homeOk`(주소·고유값)를 연결·재시도·다시 읽기에 공통
- P3 휴대폰 스크롤 → 숨기기 전에 읽음(탭 줄 가로 위치도 같은 원인이라 함께)
- 모의 환경: 서버가 정리한 이름, 체크포인트 `bookmark_link`·원래 방 저장

## 특히 봐 줄 곳

1. 동시 이전(`placeMemory`, `checkStart`, `checkMem`): 상대 본체를 받아들이는 세 조건(정상 · 같은 방 · 같은 원본 사본)이 충분한지, 보류해야 할 걸 받아들이는 길이 있는지. 한계(서로 확인 뒤 덮기)는 PLAN에 적었고, 검사 기준은 "충돌을 발견하면 보류".
2. 이전 시작 표시가 남는 경우들: 이전이 끝난 뒤에도 표시는 지우지 않음 — 6번에서 사본 비교에 계속 쓰임. 이게 다른 정상 경로(예: 사용자가 나중에 예전 사본을 정리, 같은 방 이름 재사용)를 영구 보류로 만들지.
3. 판정 순서 6 → 8 → 7로 바꾼 뒤 새로 생긴 잘못된 보류·잘못된 연결.
4. `writeCopy`·`writeClue`(읽고 고쳐 쓰기) 동시 쓰기에서 항목이 빠질 때의 영향.
5. v0.6.66: 휴대폰·PC에서 빠른 설정 열기/닫기, 열린 동안 다시 그려질 때(저장 결과 배너 등) 위치.

## 모의 환경 메모 (`tests/browser/mock.js`)

기존: `M.serverFiles`, `M.stSave()`, `M.readDelayFor`, `M.readFailAfterSave`, `M.onPopup`, `M.confirm`, `M.promptThrow`, `__savePoint.transact`·`commitEdit`·`persistSoon`.
v0.6.64~65: `M.fileState`·`M.fileDelay`·`M.fileReads`, `M.beforeUpload`·`M.otherPut`·`M.otherDel`, `M.spSaves`·`M.stSaves`, `M.chatList()`, `M.openFile`, `M.renameChat(이전, 입력한 이름, { saved })`, `M.deleteChat`, `M.branchChat`, `M.checkpointChat`, `M.importChat`, `M.stIntegrity`. Node 쪽 두 기기 검사는 `tests/home.test.mjs`의 `folder()`(읽기·쓰기 차례를 정해 끼워 넣음).

결과는 P1/P2/P3로 나눠서, 재현 방법(가능하면 모의 환경 코드나 `home.js` 입력)과 함께 주세요.
