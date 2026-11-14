# 코드 리뷰 요청 · v0.7.0-b1g (b1f 코드 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 1b49a71 f21543d` — `index.js`(`recheckHome`·`homeMark`·`followHome`·`unhideOnServer`, `writeEntry`의 `relinked()`·`sameHome`·`Relinked`, 퀵세이브 실행의 `relinkedRun`, `firstWrite`·`closeLeft`·`reopenLeft`·`clearLeft(was)`, `homeInput`의 `!x.closed`), 검사.
- 처리 표와 자세한 내용: [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-b1g.
- 반영 범위: P1-1·P1-2·P2 전부. 반영 계획에 대한 2차 의견(완료 안내 바꾸기, 서버에만 남은 숨김 해제, 첫 저장 **시작 때** 있던 기록만 이름표 쓰기 전에 닫기, `took`·`leftSeen`도 시작 때 것만)을 그대로 따랐어요.
- 그대로 다음 조각: 다른 기기에서만 일어나는 리셋 경합(`homeStill()` 뒤 `stIdle()` 구간 포함)은 b2 검증 항목, 첫 저장 이름표만 실패는 b3, b1 리뷰 P1-5(H1 순서)는 b2, 이름 변경 중간 실패는 b3~b4, #0 이어하기는 b3.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌려요(`home-link.cjs` 1~51 통과, 고치기 전 코드에선 46·47·48·49·51 실패, 50은 회귀 방지용. 전체 56묶음 결과는 REVIEW.md).

## 지난 리뷰(b1f 코드 리뷰) 처리
| 항목 | b1g |
|---|---|
| P1-1 | `recheckHome`이 상태가 `linked` 그대로여도 기억(id·rev·wid)이 바뀌면 `followHome()`(숨김·브리핑, 안내 없음). `writeEntry`는 마지막 확인 뒤 `sameHome(mine)`이 아니면 `Relinked` 알림 한 번으로 끝냄(완료 안내·`autoMark`·AUTO 백업·체크포인트 메모 없음). |
| (2차) 4 | `followHome()` → `unhideOnServer()`: 대기열 차례에 서버 파일과 비교해 화면은 보이는데 서버는 SavePoint 숨김이면 채팅 저장. |
| P1-2 | 첫 저장 시작 때 있던 `from === A` 기록을 이름표 쓰기 전에 `closed`(5행 증거 아님). 성공 → 유지, 우리 이름표가 서버에 없다고 볼 수 있는 실패 → 다시 엶, 불확실 → 유지. |
| P2 | 첫 저장 확인 때 시작 때 있던 `took`(`to === A`)·`leftSeen`(`from === A`)만 정리. |

## 특히 봐 줄 곳
1. P1-1: `Relinked`(`Cancelled` 하위)가 퀵세이브·체크포인트·버튼 변경에서 거치는 경로. 바뀐 기억에 아무것도 쓰지 않게 막은 세 곳(`autoMark`, AUTO 백업, 체크포인트 메모)으로 충분한지.
2. P1-1: `followHome()`의 `reconcile()`이 진행 중 실행을 멈출 수 있는 것(방 열기와 같은 동작), `unhideOnServer()`가 실행 중인 변경 뒤에 서버를 읽는 순서.
3. P1-2: `placeFirst`가 돌려주는 `reopen` 조건(`placeMemory`가 끝나지 않음 + 응답 없는 요청 없음 + `writeTag` 쓰기 실패 아님)으로 우리 이름표가 서버에 없다고 봐도 되는지. `closed`가 설정에 남아 새로고침 뒤에도 유지되는 것.
4. P2: `took`을 지운 뒤 그 이름에 다른 방이 다시 들어오는 경우.
