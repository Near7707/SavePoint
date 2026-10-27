# 단계별 코드 리뷰 인계

## 1단계 · 퀵세이브 메타데이터 복구

기준: v0.5.16. 변경: core.js normalizeResult/applyResult/cleanMem/dupState/sceneFull, prompts.js extractionRepairNote, index.js extractChunk/saveEdit.

검토 요청:
- 제목·개요만 누락된 응답에서 정상 포인트를 보존하고, 잘못된 msgs·인물 ID·장면 경계는 여전히 재요청하는지.
- 임시 제목을 다음 continue에서만 교체하고 직접 고친 제목은 유지하는지.
- 임시 개요가 중복 판정을 통해 선택 포인트를 누락시키지 않고, 주입 문자열에 같은 내용이 반복되지 않는지.
- 내보내기/불러오기·리와인드에서 titlePending/titleUser/outlinePending이 유지되는지.
- 재요청 번호 목록이 실제 chunk.indices와 일치하고 입력 한도를 지키는지.

검증: npm test. 추가 회귀 사례: tests/metadata-repair.test.mjs. 별도 임시 보관함과 경계 추측 병합은 도입하지 않음.
