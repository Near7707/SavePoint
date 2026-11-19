# 코드 리뷰 요청 · v0.7.0-c1e (c1d 리뷰 반영, 브랜치 `v0.7-b`)

- 범위: `git diff 964efd9 1db269d`, 커밋 하나예요.
  - `1db269d`에 들어간 것: `index.js`(`sendTold` 한 함수), `manifest.json`(버전만), `README.md`, `docs/PLAN-v0.7.md`, `docs/REVIEW.md`, 검사(`send-guard.cjs` 18 새로).
- c1d 리뷰(P2 1·P3 1)와 2차 의견대로 고쳤어요. 자세한 내용은 [REVIEW.md](REVIEW.md) 맨 위 v0.7.0-c1e에 있어요.
- 결과는 P1/P2/P3로 주세요. 브라우저 묶음은 우리 쪽에서 돌렸어요.
  - 62묶음 한꺼번에 모두 통과. 검사 모드 오류 0(`send-guard` 67줄).
  - 고치기 전 코드(`6bdd4a9`)에서 18 첫 줄 FAIL(확인창·중단).
  - 망가뜨리기: 화면 그룹 조건 되돌림 → 잡힘, 방 키 비교 되돌림 → 잡힘. 회차 비교 빼기와 `sendEnd`의 `sendGroup` 지우기 빼기는 하나씩은 안 잡히고, 함께 빼면 18 셋째 줄이 잡아요(겹 장치).
  - Node 513 통과 / 0 실패 / 3 건너뜀.

## 바뀐 것
- **P2 `sendTold(type)`:** `sendTypeAsked(type) && !!sendGroup?.tell && sendGroup.epoch === roomEpoch`예요.
  - 화면의 그룹 여부(`ctx().groupId`)와 방 키 비교(`sendGroup.key === roomKey()`)를 뺐어요. 실리태번이 묶음 시작 전에 캐릭터 선택값을 비웠다가 멤버마다 다시 넣어서, 1:1 화면에서 이어진 재생성 묶음은 방 키가 달라요.
  - 그대로 둔 것: 방 이동(`sendEnd`)·묶음 끝(`onGroupFinished`)이 `sendGroup`을 지우는 처리, `sendGuard`의 `here()`(들어올 때 방 키·회차 비교), 알림 문구.
  - `sendAsked`는 안 바꿨어요. `sendGuard`가 `told`를 먼저 보고, 기억 연결 전 알림은 `!sendAsked && !sendTold`라서 `told`면 어차피 안 떠요.
- **P3:** 코드는 그대로이고 README 알려진 한계(v0.7.0-c1e)에만 적었어요.

## 특히 봐 줄 곳
1. **회차만으로 묶음을 이 방 것으로 봐요.** 방을 옮기면 `sendEnd`가 묶음을 지우고 회차도 올라가서 두 겹이에요. 같은 회차에서 알림 묶음이 끝나기 전에 이 화면에서 보낸 다른 일반 전송도 알림만이 되는데, 그룹 생성 중이라 보내기를 못 누르는 동안이라고 봤어요.
2. **모의 환경에서 캐릭터 선택값 비우기는 `M.characters = []`로 흉내 냈어요.** 실제 실리태번은 `this_chid`를 비워요. 실제 확인은 합치기 전 목록에 넣었어요.
