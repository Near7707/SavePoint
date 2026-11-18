# 코드 리뷰 요청 · v0.7.0-b4a (목록에서 바꾼 이름 이어서 연결, 브랜치 `v0.7-b`)

- 범위: `git diff a09e1ce 2e6a328`, 커밋 하나예요.
  - `2e6a328`에 들어간 것: `home.js`(`decideRoom` 5행의 `carryOf`·동의), `index.js`(이름 변경 기록 `direct`, `homeInput`, `linkRounds`, `renameHome`, 새 구역 "carrying on a rename made in the chat list", 버튼·문구), 버전, 검사(`tests/browser/carry.cjs` 새, `tests/home.test.mjs` 1개), 문서.
- b4 설계(GPT 1·2차 의견 + 사용자 동의)대로 구현했어요. 설계 요점과 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b4a에 있어요.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌렸어요.
  - 61묶음 한꺼번에: 60 통과 + `status` 알려진 `autoFail` null 오류 → 따로 첫 번째에 통과. 검사 모드 오류 0.
  - 고치기 전 코드(`a09e1ce`)에서 `carry.cjs` 18줄 FAIL.
  - 망가뜨리기: 이동 직전 목록 확인 빼기, 버튼 전 목록 확인 빼기, 동의의 rev·wid 비교 빼기, `delete x.direct`와 "하나뿐" 함께 빼기, `carryOf`의 자기 기억 본체·단서 항목 확인 빼기 — 모두 잡힘. 겹 장치라 하나만 빼면 안 잡히는 곳은 REVIEW.md에 적었어요.
  - Node 512 통과 / 0 실패 / 3 건너뜀.

## 바뀐 것
- 이름 변경 기록에 `direct`(한 알림의 A → B). 뒤 이름 변경이 도착지를 바꾸면 지움. `homeInput`은 그 이름으로 온 기록이 하나뿐이고 `took`이 없을 때만 `direct`를 넘겨요.
- `decideRoom` 5행: 증거(`mem`) 없는 기록이 `direct`이고, A 이름표가 `linked`, 본체가 A에 같은 고유값, B에 이름표·시작 표시·단서 항목·자기 기억 본체가 없고, 옛 사본·떠난 기록이 없으면 보류에 `carry`를 붙여요. 동의(`input.agreed`)가 그 기록·본체 ID·rev·wid와 같을 때만 `rename`(`agreed`).
- 열기에서 그 보류면 1:1 채팅 목록(`/api/characters/chats`, `simple: true`)을 읽어 A 없음·B 있음일 때만 버튼을 보여요. 실패·`{ error }`·빈 목록·이상한 답은 확인 불가.
- 버튼: 확인창(예전·지금 이름, #0–#N, 마지막 기록 시각) → 같은 방·후보 확인 → 목록 다시 → 동의로 `recheckHome` → `renameHome`이 본체 쓰기 직전 목록을 한 번 더 읽어요. 아니면 보류(`carryGone`·`carryList`), 쓰기 0. 이미 옮겨진 본체는 동의로 안 써요(`carryChanged`, 실제로는 "이미 옮겨짐" 분기가 먼저 보류).

## 특히 봐 줄 곳
1. 마지막 목록 읽기와 본체 업로드 사이에 A가 다시 생기는 틈은 남아요(서버에 비교 후 쓰기 없음).
2. "하나뿐"은 그 이름으로 온 기록 전체(`foreign`·`closed` 포함)로 셈해요. 너무 엄격하거나 빠진 경우가 있는지.
3. 확인창 중 다른 곳에서 기억을 저장하면 이번 동의로 옮기지 않고 새 영수증으로 다시 물어봐요(검사 6). 그대로 다시 묻는 게 맞는지.
4. 옮긴 뒤 A의 떠난 이름·A → B 기록은 남아요. 열어 둔 방 이름 변경과 같은 결과예요.
5. 그룹 채팅은 후보 표시만 남고 버튼과 목록 요청이 없어요.
