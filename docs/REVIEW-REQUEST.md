# 리뷰 요청 · v0.6.67 + v0.6.68 (v0.6.65 리뷰 반영)

- 범위: `de15e29`(v0.6.66) → 이 커밋(v0.6.68). 두 커밋으로 나뉨:
  - v0.6.67 `2143219`: **동작 변화 없음.** `home.js` 규칙 보강(P2 4건) — `git diff de15e29 2143219`
  - v0.6.68: 화면만(P3 탭 줄 되돌아감) — `git diff 2143219 HEAD`
- 바뀐 내용과 ★ 항목: [docs/REVIEW.md](REVIEW.md) 맨 위 v0.6.68, v0.6.67. 계획: [PLAN-v0.7.md](PLAN-v0.7.md)(v0.6.67 표시가 바뀐 곳)
- 검사: `node --test tests/*.test.mjs`(447개) + `for f in tests/browser/*.cjs; do node $f; done`(35묶음, Playwright).

## 지난 리뷰(v0.6.65)에서 고친 것

- P2 오래된 계획이 끝난 이전을 덮음 → `placeMemory`의 `writeMem`이 쓰기 직전에 다시 읽고, 있으면 쓰지 않음(같은 방·같은 사본이면 받아들임, 아니면 보류)
- P2 이름을 재사용한 새 방이 옛 기억에 붙음 → 6번: 고유값 없는 본체는 예전 사본 일치나 지문(1개 이상 전부) 일치가 있어야 연결, 아니면 보류
- P2 중복 이전 단서 무시 → `writePlan`·`writeCopy`에서 `copy-` 단서에 다른 방이 있으면 보류. 8번: 이름표 고유값이 지금도 같은 방만 후보, 이름표 없는 방은 그 방 본체가 있으면 후보
- P2 이력 없는 기억의 분기 복원 예외 → `noHistory`(되감기 불가) → 맞는 슬롯, 없으면 보류
- P3 탭 줄 → 고른 탭이 바뀌었을 때만 보이게 옮김, 숨겨진 동안은 다시 보일 때 한 번

## 특히 봐 줄 곳

1. 6번의 새 증명 조건이 정상 경로를 보류로 만드는지(고유값 없는 예전 방이 원문을 고친 뒤 이름표를 잃은 경우 등).
2. 8번에서 이름표 없는 단서 방의 본체를 읽는 새 길: 잘못된 후보·잘못된 보류, 읽기 실패 처리.
3. `writeMem` 직전 읽기와 `writeCopy` 보류 뒤에 남는 파일(본체·이전 완료 표시)이 다음 재시도를 영구 보류로 만들지.
4. v0.6.68: 탭을 바꾸는 길 중 `ui.tabShown` 규칙을 벗어나는 곳이 있는지, 휴대폰 빠른 설정·창 크기 변경과 함께.

## 모의 환경 메모 (`tests/browser/mock.js`)

v0.6.64~65 그대로: `M.fileState`·`M.fileDelay`·`M.fileReads`, `M.beforeUpload`·`M.otherPut`·`M.otherDel`, `M.spSaves`·`M.stSaves`, `M.chatList()`, `M.openFile`, `M.renameChat`, `M.deleteChat`, `M.branchChat`, `M.checkpointChat`, `M.importChat`, `M.stIntegrity`. Node 쪽 두 기기 검사는 `tests/home.test.mjs`의 `folder()`, v0.6.67부터 특정 쓰기 직후 다른 기기 동작을 끼워 넣는 `hooked()`.

결과는 P1/P2/P3로 나눠서, 재현 방법(가능하면 모의 환경 코드나 `home.js` 입력)과 함께 주세요.
