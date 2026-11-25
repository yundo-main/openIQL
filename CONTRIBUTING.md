# Contributing to OpenIQL

## Clean-room 원칙
- 상용 이슈 트래커의 바이너리·디컴파일 코드·원본 문법 파일을 참조하거나 복제하지 않습니다.
- GPL 계열 카피레프트 코드를 포함하지 않습니다.
- 모든 구현은 `spec/grammar.ebnf`와 `docs/ARCHITECTURE.md`에 정의된 명세로부터 작성합니다.
- 법률 리스크 검토 기록은 `docs/LEGAL-NOTES.md`를 참조하세요.

## Spec-First
새 연산자/내장 함수는 (1) `spec/grammar.ebnf`, (2) `docs/ARCHITECTURE.md`를 먼저 갱신한 뒤 구현과 테스트를 작성합니다.

## DCO
모든 커밋은 `git commit -s`로 `Signed-off-by:` 를 포함해야 합니다. 서명은
[Developer Certificate of Origin 1.1](https://developercertificate.org/)에 동의함을 의미합니다.
`npm run check:dco`로 브랜치의 모든 커밋에 서명이 있는지 확인할 수 있습니다.

## 개발
```sh
npm install
npm run typecheck
npm test
```
