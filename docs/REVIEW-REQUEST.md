# 코드 리뷰 요청 · v0.7.0-b1i (b1h 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 4bdc2b1 b5e8e6a` — `index.js`(`leftNow`, `closeLeft`, `homeInput`의 `was`·`closes`, `actHome`의 `migrate`·`branch`, `placed`의 반환값, `renameHome`의 `closes`·`sure`·`clearLeft`), 검사, 문서.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1i.
- 반영 범위(2차·3차 의견대로): 이름표를 새로 만드는 세 길(이름 변경 따라가기·예전 기억 이전·갈래)에 `closes`. 값은 방을 열 때 `renamesSeen()` 원본에서 뽑은 `from === A && to !== A` 기록 ID(`closed` 포함). 기억이 서버에서 확인된 뒤에만 열 때 잡아 둔 옛 기록을 `clearLeft`.
- b3로 넘김: 이름표 복구(`relinkMemory`)에서 처음 쓴 `closes` 복원, 이름표 응답을 잃었거나 `UNREAD`일 때 이미 올라간 이름표로 A 다시 연결(그때도 나중의 `A → C`는 무시하지 않음). README 알려진 한계.
- 그대로 다음 조각: 다른 기기에서만 일어나는 리셋 경합(`homeStill()` 뒤 `stIdle()` 구간 포함)은 b2 검증 항목, b1 리뷰 P1-5(H1 순서)는 b2, 첫 저장 이름표만 실패·이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3, 첫 저장 중 이름 변경 보류(`foreign`)는 그대로.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~57·49b 통과, 고치기 전 코드에선 53~57 실패. 전체 56묶음 결과는 REVIEW.md).

## 지난 리뷰(b1h 코드 리뷰) 처리
| 항목 | b1i |
|---|---|
| P1 | `renameHome`의 새 이름표, `migrate`·`branch`의 `placeMemory`에 `closes: input.closes`. 이전·갈래는 `placed()` 확인 성공 뒤, 이름 변경은 기억이 이미 A에 있었거나 `MEM_OK`이고 이름표 단계까지 끝났을 때 `clearLeft(input.was)`. `relink`는 그대로(b3). |

## 특히 봐 줄 곳
1. `closes`에 `closed`·`settled`·`foreign` 기록까지 넣는 것(막는 쪽으로만 작용). A → B → A로 돌아온 기록은 `onChatRenamed`가 `to`를 A로 바꿔 빠지는지.
2. `input.was`는 판정 때의 기록 객체: 그사이 설정이 다시 불러와지면 정리가 안 됨(보류 쪽). `placed()`가 `adopted`(다른 기기가 같은 이동을 끝냄)에서도 정리하는 게 맞는지.
3. `renameHome`의 `sure`: 판정 때 읽은 기억의 `home.addr === A`를 확인으로 보는 것, `UNREAD`·이름표 실패에서는 정리 안 하는 것.
