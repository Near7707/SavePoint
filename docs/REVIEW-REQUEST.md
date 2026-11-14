# 코드 리뷰 요청 · v0.7.0-b1f (b1e 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 2866815 06af54a` — `index.js`(`writeChatFile`의 `landed` 분기 `guard`, `writeEntry`의 `homeStill(mine)` `relinked` 처리, `clearLeft`·`homeInput`의 `settled`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1f.
- 반영 범위: P1·P2-1·P2-2. P3(재전송이 파일을 쓴 뒤 500일 때의 알림)는 그대로(이유는 REVIEW.md). 200건 한도는 README 한계 그대로.
- 그대로 다음 조각: 다른 기기에서만 일어나는 리셋 경합(`homeStill()` 뒤 `stIdle()` 구간 포함)은 b2 검증 항목, 첫 저장 이름표만 실패는 b3, b1 리뷰 P1-5(H1 순서)는 b2, 이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~45 통과, 고치기 전 코드에선 43~45 실패. 전체 56묶음 결과는 REVIEW.md).

## 지난 리뷰(b1e 코드 리뷰) 처리
| 항목 | b1f |
|---|---|
| P1 | `landed` 분기에서 이미 보낸 사본으로 끝내기 전에 `guard({ sent: true })`: 영수증이 다르면 새 숨김을 되돌리고 다시 보냄. |
| P2-1 | `clearLeft`가 `renames`의 `from === addr` 기록에 `settled`(기록은 남김). `homeInput`의 `left`는 `settled`를 안 씀. |
| P2-2 | `homeStill(mine)`의 `relinked`도 새 숨김만 되돌리고, 남은 표시가 있으면 계속(없으면 지금 문구). |
| P3 | 그대로. |

## 특히 봐 줄 곳
1. P1: `guard`가 `landed` 분기와 요청 직전 두 번 불리는 것, 되돌린 뒤 `fileAllows(sentSnap)`·재전송·`unhidAfter` 판정.
2. P2-2: `relinked` 뒤 남은 표시를 보내는 경로(그 뒤 `stIdle` → `serverCovered` → `guard`)에서 다른 기억이 연결된 방에 🔖·숨김 해제를 쓰는 게 맞는지.
3. P2-1: `settled`가 붙은 기록이 `took`·`foreign`·6행·5행 판정에 주는 영향, 그 이름의 새 방이 다시 이름을 바꾸는 경우.
