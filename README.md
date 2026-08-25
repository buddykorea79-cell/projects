# AI 리더스 아카데미 지원센터

교육 과정에서 **과제를 받고, 목록으로 보고, 제출자가 직접 수정·삭제하게** 하고
**강의자료를 배포**하는 정적 웹사이트입니다. 빌드 도구 없이 순수 HTML·CSS·ES 모듈로 되어 있고,
**GitHub Pages 에 그대로 올리면 동작**합니다.

디자인은 첨부해 주신 스타벅스 디자인 시스템 문서를 따랐습니다 —
따뜻한 크림 캔버스, 4단계 그린 체계, 50px 풀-필 버튼, 겹겹이 쌓은 옅은 그림자,
우하단에 떠 있는 원형 Frap 버튼.

---

## 무엇이 되나요

**교육생 (로그인 없음)**
- 프로젝트 목록에서 과제 선택 — 한 행에 2개씩 배치
- 2단계 제출 — ① 기관명·성명·이메일 ② 제목·설명·첨부파일
- 이미지·동영상·문서 드래그&드롭 업로드 (형식·크기·개수 자동 검증)
- 제출 완료 시 **수정코드** 발급 → 확인증 텍스트 파일로 저장 가능
- `내 제출물` 에서 **이메일 + 수정코드**로 인증하고 수정·삭제
- 코드 하나로 같은 이메일의 모든 제출물이 열립니다

**강의자료 다운로드 (공용 비밀번호)**
- 상단 메뉴 `강의자료` → 공용 비밀번호 입력 → 자료 목록
- 한 번 입력하면 12시간 유지, 관리자는 비밀번호 없이 열람
- 현재 비밀번호는 **`AI2026`** 입니다

**관리자 (하드코딩 계정)**
- 프로젝트 개설·편집·삭제 (마감일시, 접수 상태, 공개 범위, 기관명 필수 여부, 첨부 허용 여부)
- 강의자료 등록·편집·삭제 (PDF·PPT·ZIP, 자료당 10개까지, 개당 50MB)
- 전체 제출물 표 — 검색·정렬, 첨부 미리보기, 강제 삭제
- **CSV 내려받기** (엑셀에서 한글 안 깨지도록 BOM 포함)
- 전체 백업 JSON 내보내기 / 복원
- 저장소 모드 전환, GitHub 토큰 등록

현재 관리자 계정은 `aireader@mois.go.kr` / `dlrhd26` 입니다.
바꾸는 방법은 [비밀번호 바꾸기](#비밀번호-바꾸기)에 있습니다.

---

## 배포 — Cloudflare Pages + R2 (현재 구성)

1. 이 브랜치를 `main` 에 머지합니다.
2. Cloudflare 에서 **R2 버킷을 하나 만들고**, Pages 프로젝트에 `BUCKET` 이름으로 바인딩합니다.
3. 끝입니다. `functions/api/[[path]].js` 가 함께 배포되어 `/api` 가 살아납니다.

버튼 하나하나까지 적어둔 순서는 **[docs/SETUP.md](docs/SETUP.md)** 에 있습니다.

---

## 저장소 모드

정적 사이트에는 서버가 없으므로 "데이터를 어디에 쓸 것인가"를 골라야 합니다.
세 가지를 지원하고, 관리자 화면에서 언제든 전환할 수 있습니다.

| 모드 | 설정 | 여러 사람 제출 | 파일 한도 | 데이터 위치 |
|---|---|---|---|---|
| **Cloudflare R2** (기본·권장) | 버킷 바인딩 1개 | **✓** 토큰 불필요 | 100MB/파일 | R2 버킷 |
| GitHub 저장소 | 토큰 또는 프록시 | 프록시 있을 때만 | ~25MB/파일 | 이 레포 |
| 브라우저 저장 | 없음 | ✗ | — | 각자의 IndexedDB |

### 왜 R2 인가

브라우저는 R2 를 직접 만지지 않습니다. 같은 도메인의 `/api` 만 호출하고,
버킷 권한은 Cloudflare 바인딩으로만 존재합니다. 그래서

- **비밀값이 브라우저로 내려가지 않습니다.** 교육생에게 토큰을 나눠줄 필요가 없습니다.
- **CORS 설정이 없습니다.** 사이트와 API 가 같은 오리진입니다.
- **큰 파일이 올라갑니다.** GitHub Contents API 의 base64 인코딩(용량 +33%)과
  레포 비대화 문제가 사라집니다.
- **레포가 깨끗합니다.** 제출물이 커밋으로 쌓이지 않습니다.

---

## 데이터 구조

R2 모드에서 버킷 안은 이렇게 생겼습니다.

```
data/projects.json             프로젝트 배열
data/submissions.json          제출물 메타데이터 배열
data/materials.json            강의자료 메타데이터 배열
uploads/<제출ID>/<파일>         과제 첨부 원본
uploads/materials/<자료ID>/…   강의자료 원본
```

색인 파일은 **etag 기반 조건부 쓰기**로 갱신합니다. 동시에 제출이 겹쳐 etag 가
어긋나면 서버가 409 와 함께 최신본을 실어 보내고, 클라이언트가 그 위에 다시 적용해
최대 5회까지 재시도합니다. 그래서 동시 제출에서 한쪽이 조용히 사라지지 않습니다.

### 저장소 API (`/api`)

| 경로 | 하는 일 |
|---|---|
| `GET /api/health` | 상태 · 잠금 여부 · 업로드 한도 |
| `GET /api/data/:name` | 색인 읽기 (없으면 `[]` 로 만들어 줍니다) |
| `PUT /api/data/:name` | etag 조건부 색인 쓰기 |
| `POST /api/upload` | 파일 업로드 (키는 서버가 생성) |
| `GET /api/file/<key>` | 파일 스트리밍 |
| `DELETE /api/file/<key>` | 파일 삭제 |
| `POST /api/materials/token` | 강의자료 다운로드 서명 토큰 (잠금 켠 경우) |

업로드된 파일은 항상 `X-Content-Type-Options: nosniff` 와
`Content-Security-Policy: default-src 'none'; sandbox` 를 달고 나갑니다.
이미지·PDF·동영상만 인라인으로 열리고 나머지(SVG·HTML 포함)는 첨부로 강제되므로,
업로드된 파일이 우리 도메인에서 스크립트를 실행할 수 없습니다.

---

## 비밀번호 바꾸기

두 비밀번호 모두 원문이 아니라 SHA-256 해시로만 `config.js` 에 들어갑니다.
사이트 아무 화면에서나 개발자도구 콘솔을 열고 실행하세요.

**관리자 계정**

```js
await hashAdmin('my@email.com', '새-비밀번호')
```

출력된 해시를 `assets/js/config.js` 의 `admins` 에 붙여넣습니다.

**강의자료 공용 비밀번호** (수강생 전체가 함께 쓰는 암호)

```js
await hashMaterials('새-비밀번호')
```

출력된 해시를 `assets/js/config.js` 의 `materialsHash` 에 붙여넣습니다.

> **정직하게 말씀드리면**: 정적 사이트에는 인증을 검증할 서버가 없습니다.
> 이 로그인은 관리 화면을 가리는 잠금이지 서버측 인증이 아니고, 해시는 공개됩니다.
> 길고 추측 불가능한 비밀번호를 쓰세요. **실제 데이터 변경 권한은 저장소 계층
> (토큰·프록시)이 통제하므로**, 비밀번호가 새더라도 레포가 바로 훼손되지는 않습니다.
> 진짜 서버측 인증이 필요하면 [docs/SETUP.md](docs/SETUP.md) 의 "한계와 대안"을 보세요.

---

## 설정 바꾸기

거의 모든 운영 설정이 `assets/js/config.js` 한 곳에 모여 있습니다.

| 항목 | 설명 |
|---|---|
| `siteName`, `orgName` | 사이트·기관 이름 |
| `admins`, `passwordSalt` | 관리자 계정 (해시) |
| `adminSessionHours` | 로그인 유지 시간 |
| `materialsHash` | 강의자료 열람 비밀번호 (해시) |
| `materialsSessionHours` | 강의자료 열람 유지 시간 |
| `materials.*` | 강의자료 업로드 정책 (개수·용량·확장자) |
| `storage` | `'local'` 또는 `'github'` |
| `github.*` | 레포 정보, 데이터 경로, 프록시 주소 |
| `upload.maxFileMB` / `maxFiles` / `allowedExt` | 첨부 정책 |
| `editCodeLength` | 수정코드 자릿수 |

---

## 파일 구조

```
index.html                  SPA 껍데기 (헤더·푸터·Frap)
assets/css/styles.css       디자인 시스템 토큰 + 컴포넌트 전부
assets/js/
  config.js                 ← 운영 설정은 여기만 고치면 됩니다
  app.js                    진입점 · 라우트 등록 · 전역 크롬
  router.js                 해시 라우터
  auth.js                   관리자 인증 · 강의자료 잠금
  utils.js                  포맷·검증·해시·DOM 헬퍼
  ui.js                     토스트·모달·라이트박스·파일선택기
  store/
    index.js                저장소 선택 + 도메인 규칙
    r2.js                   Cloudflare R2 어댑터  ← 기본
    github.js               GitHub 레포 어댑터
    local.js                IndexedDB 어댑터
  views/
    home.js  project.js  my.js  materials.js  admin.js  guide.js
shared/r2api.js             R2 저장소 API 핸들러 (서버 측)
functions/api/[[path]].js   Cloudflare Pages Function — /api/* 진입점
data/, uploads/             GitHub 모드에서만 쓰는 폴더
worker/                     GitHub 모드용 쓰기 프록시 (선택)
tests/                      회귀 테스트 4묶음
docs/SETUP.md               단계별 배포 가이드
```

---

## 로컬에서 확인하기

`/api` 가 없는 환경에서는 R2 모드가 뜨지 않습니다. 두 가지 방법이 있습니다.

**① 실제 R2 로 (권장)** — Cloudflare 계정에 붙여 그대로 돌립니다.

```bash
npx wrangler pages dev . --r2=BUCKET
```

**② R2 없이 화면만** — 정적 서버를 띄운 뒤 브라우저 콘솔에서 모드를 바꿉니다.

```bash
python3 -m http.server 8000
# 접속 후 콘솔에서:  localStorage.setItem('ah.storageMode','local'); location.reload()
```

관리자 화면 하단 **저장소** 패널에서도 모드를 바꿀 수 있습니다.

---

## 접근성·호환성

- 키보드만으로 전체 흐름 사용 가능 (건너뛰기 링크, 포커스 트랩, `aria-*`)
- 폼 오류는 `aria-invalid` + 텍스트로 함께 안내
- `prefers-reduced-motion` 존중
- 375px 모바일에서 가로 스크롤 없음 · 넓은 표는 자체 스크롤
- 인쇄 시 네비게이션·버튼 숨김
- 320px~1600px 전 구간에서 가로 스크롤 없음 (테스트로 검증)
- 업로드 파일은 sandbox CSP + nosniff 로 제공 — 우리 도메인에서 스크립트 실행 불가
- Chrome·Edge·Safari·Firefox 최신 버전 기준
