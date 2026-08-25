# 테스트

사이트를 고친 뒤 깨진 곳이 없는지 확인하는 회귀 테스트입니다. 배포에는 필요 없습니다.

```bash
cd tests
npm install
```

## 1. 구문 검사 — `npm run test:parse`

`assets/js/` 와 `worker/` 의 모든 파일을 ES 모듈로 파싱합니다. 브라우저를 띄우지 않아
가장 빠르고, 오타 하나로 사이트가 하얗게 뜨는 사고를 막아줍니다.

## 2. GitHub 모드 통합 — `npm run test:github`

가짜 GitHub API 를 메모리에 만들고, **실제** `worker.js` 와 **실제** `store/github.js` 를
그 사이에 끼워 돌립니다. 브라우저도 네트워크도 필요 없습니다. 확인하는 것:

- 프로젝트·제출물 생성/수정/삭제가 올바른 경로에 커밋되는지
- 한글 제목과 파일명이 base64 왕복에서 깨지지 않는지
- 첨부 바이트가 그대로 보존되는지
- 동시 수정 충돌(409)이 나면 재시도로 복구되는지
- 프로젝트를 지우면 하위 제출물과 첨부까지 정리되는지
- 워커가 경로 탈출·허용 폴더 밖·과대 용량·낯선 출처를 막는지

## 3. 브라우저 종단간 — `npm run test:browser`

먼저 다른 터미널에서 사이트를 띄웁니다.

```bash
cd .. && python3 -m http.server 8899
```

그 다음 `npm run test:browser`. Chromium 을 띄워 실제 사람이 하는 순서대로
제출 → 수정코드 발급 → 조회 → 수정 → 관리자 로그인 → 프로젝트 개설까지 밟고,
폼 검증·404·아코디언·모바일 가로 스크롤·드로어까지 확인합니다.

> 이 환경에는 Chromium 이 `/opt/pw-browsers/` 에 이미 있어서 그 경로를 직접 씁니다.
> 다른 곳에서 돌린다면 `browser.test.mjs` 의 `executablePath` 를 지우고
> `npx playwright install chromium` 을 한 번 실행하세요.
