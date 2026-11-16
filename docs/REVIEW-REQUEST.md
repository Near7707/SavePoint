# 코드 리뷰 요청 · v0.7.0-b3a2b (`closes` 본체 보관 · 5행 차단, 브랜치 `v0.7-b`)

- 범위: `git diff 493ea98 2a93e8c` — 커밋 하나.
  - `2a93e8c`: `home.js`(`memBody`·`nextMem`·`validMem`의 `closes`, `decideRoom` 5행·6행, `placeMemory` 새 본체, `relinkMemory`), `index.js`(`onChatChanged`의 떠난 방 보관, `onChatRenamed`의 기록 증거, `homeInput`, `actHome` relink, `renameHome`, 안내 문구), 버전, 검사(`room-gate.cjs` 7k·7l, `home-link.cjs`, `home.test.mjs`), 문서.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b3a2b. 기준은 지난번 받은 b3a2b 기준(PLAN "v0.7.0-b3 설계"의 b3a2 줄).
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(전체 58묶음: 한꺼번에 57 통과 + `status`만 알려진 `autoFail` null 오류 → 따로 통과, 검사 모드 오류 0. 고치기 전 코드에서 새 검사 5줄 FAIL, 망가뜨리기 5개 모두 잡힘).

## 고친 것
- 기억 본체에 `closes`(없음 = 모름, `[]` = 확인된 빈 목록). 첫 저장·이전·갈래·이름 변경 이동 때 적고 평소 저장이 이어 감. 이름표를 다시 만들 때(`relink`·이름 변경)는 본체 목록을 씀.
- 목록이 없는 옛 본체의 `relink`: 이 이름을 떠난 기록(`settled`·`closed` 포함, 떠난 이름 기록 포함)이 없을 때만 빈 목록으로 이름표, 아니면 쓰기 전에 보류(`closesUnknown`). 본체는 안 씀.
- 방 전환 직전 떠나는 방이 `linked`이고 확인된 영수증이 있으면 보관 → 바로 뒤 이름 변경 알림의 출발지·도착지(서버가 정리한 이름 포함)가 맞으면 기록에 `mem: { id, rev, wid }`.
- 5행: 본체 `closes`에 이번 기록이 있으면 건너뜀 · 본체가 이미 새 이름이고 `home.was`에 옛 이름이면 이동 없이 뒤 단계 · 그 밖엔 `mem`이 이름표의 기억 ID·본체 rev·wid와 정확히 같을 때만 옮김, 아니면 보류(`renameUnproven`).

## 특히 봐 줄 곳
1. 증거로 쓰는 떠난 방 조건(`linked` + 확인된 rev·wid, `unread`·`pending` 제외, `line.stop`은 허용). 그 방 저장이 진행 중이면 나중 영수증이 달라 보류(설계에서 동의한 ⚪).
2. 5행에서 증거가 안 맞으면 다음 기록을 보지 않고 바로 보류.
3. "이미 새 이름 + `home.was`" 분기는 증거 없이 통과(예전 버전이 옮긴 본체 포함).
4. 첫 저장이 끝나기 전 이름 변경은 증거가 없어 새 이름이 보류됨(`home-link` 50 기대가 "연결" → "보류, 기억은 옛 이름에"로 바뀜).
5. `home-link`의 목록 이름 변경 검사들은 그때의 기억을 기록에 붙이는 감싸기로 돌림(예전 규칙 검사 보존용). 목록 변경이 보류되는 건 `room-gate` 7l에서 확인.
