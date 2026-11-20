# 코드 리뷰 요청 · v0.7.4-a1 (떼어 둔 작업 ②: 보류된 방에 세이브 슬롯으로 기억 연결, 브랜치 `v0.7.4`)

- 범위: `git diff 983b726 <a1 커밋>`. `home.js`(`SLOT_HOLDS`·`slotPrint`·`slotFits`·`slotState`, `decideRoom` 감싸기 → 안은 `decideCore` 그대로), `index.js`(`actHome` 갈래 `from`, `linkRounds`, `slotLinkRoom` 등, 보류 안내·상세·세이브 카드), 검사 `tests/home.test.mjs`·`tests/browser/slot-link.cjs`, 문서.
- 하는 일: `연결 보류`된 방(채팅만 가져온 방 `traces`, 같은 고유값 `sameIntegrity`, 갈래 `parentGone`·`branchUnproven`)이 이 방 몫 이름표·기억 파일·이전 표시 없이 고유값이 있으면, 기록 위치가 이 방 원문과 정확히 맞는 슬롯(`lastIndex >= 0`)을 사용자가 골라 동의 → 다시 판정(슬롯 본문을 새로 읽어 동의한 저장본인지 확인) → 기존 갈래 쓰기(`placeMemory`)로 이 방의 새 기억. `from`에 슬롯 id + 저장본 지문.
- 설계: 요청서 `0fdf1cf`에 대한 GPT 설계 의견(P2 세 건 등)을 모두 반영했어요. 처리 표는 [REVIEW.md](REVIEW.md) 맨 위 v0.7.4-a1.
- 저장 쪽이라 결과는 P1/P2/P3로 주세요.
  - 고치기 전 코드에서 `slot-link` 10개 중 8개 FAIL. 망가뜨리기 결과는 REVIEW에(두 겹이라 안 잡히는 방어용 조건 하나 포함).
  - 검사 수는 REVIEW 해당 항목 끝에.

## 특히 봐 줄 곳
1. `decideRoom` 감싸기가 네 가지 보류 밖으로 새지 않는지, 판정마다 다시 보는 "없음" 조건(이름표·시작 표시·단서·제 몫 기억 파일·`left`·고유값)이 충분한지.
2. 동의한 저장본만 쓰이는지: 확인창 뒤 슬롯 덮어쓰기, 확인창 중 다른 기기가 먼저 연결(3행·6행으로 빠짐), 같은 슬롯의 다른 저장본(`otherOrigin`), 완료 안내 조건(`from.slot`·`from.print`).
3. `slotState`(`history: []`, `floor = lastIndex`, `branchState`)가 이후 저장·⏪·숨김(`h2Of`)과 맞는지.
4. 쓴 뒤 채팅 파일 다시 읽기를 복사 복구의 `rescueCheck`·`rescueLost`로 함께 쓰는 것.
