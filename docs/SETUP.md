# 배포 가이드

현재 권장 구성은 **Cloudflare + R2** 입니다. 아래 A 만 따라 하시면 됩니다.
B·C 는 GitHub Pages 로 운영할 때의 대안이라 참고용으로 남겨둡니다.

> 이 문서의 대시보드 경로·한도·API 동작은 2026-08 기준 Cloudflare 공식 문서에서
> 확인한 값입니다. 출처는 각 항목에 적어두었습니다.

---

## 0. 먼저 — 내 프로젝트가 Pages 인가 Workers 인가

Cloudflare 는 2025년부터 신규 프로젝트에 **Workers + 정적 자산**을 권장하고 있어서,
언제 만들었느냐에 따라 둘 중 하나입니다. 설정 위치가 다르니 30초만 확인하세요.

대시보드 → **Workers & Pages** 목록에서 내 프로젝트 옆 라벨을 봅니다.

| 라벨 | 따라갈 곳 | 이 레포에서 쓰이는 파일 |
|---|---|---|
| **Pages** | A-1 → A-2 → A-3 | `functions/api/[[path]].js` |
| **Worker** | A-1 → A-2′ → A-3′ | `shared/worker-entry.js` |

둘 다 지원하도록 만들어 두었으니 코드를 고칠 필요는 없습니다.
바인딩을 어디에 넣느냐만 다릅니다.

---

## A. Cloudflare + R2 (권장)

브라우저는 R2 를 직접 만지지 않습니다. 사이트와 같은 도메인의 `/api` 만 호출하고,
버킷 권한은 Cloudflare 바인딩으로만 존재합니다. 그래서 교육생에게 나눠줄 토큰도,
CORS 설정도 없습니다.

### A-1. R2 버킷 만들기 (공통)

Cloudflare 대시보드 → **R2 Object Storage** → **Create bucket**

| 항목 | 값 |
|---|---|
| Bucket name | `assignment-hub` |
| Location | Automatic (또는 Asia-Pacific) |

버킷 이름 규칙 — **소문자·숫자·하이픈만**, 3~63자, 하이픈으로 시작/끝 불가.
(`대문자`, `밑줄`, `공백` 을 넣으면 거부됩니다.)

> **Public access 는 켜지 마세요.** 파일은 우리 `/api` 를 통해서만 나가야
> 보안 헤더와 강의자료 잠금이 걸립니다. 공개로 열면 둘 다 우회됩니다.

R2 는 저장 10GB/월까지 무료이고, 이 용도에서 제일 중요한 점은
**나가는 트래픽(egress) 요금이 0** 이라는 것입니다.

<sub>출처: [Create new buckets](https://developers.cloudflare.com/r2/buckets/create-buckets/)</sub>

### A-2. (Pages 인 경우) 버킷 바인딩

1. 대시보드 → **Workers & Pages**
2. 내 Pages 프로젝트 선택
3. **Settings** → **Bindings** → **Add** → **R2 bucket**
4. **Variable name** 에 **`BUCKET`** ← 이 이름 그대로여야 합니다
5. **R2 bucket** 에서 A-1 에서 만든 버킷 선택
6. 저장

**Production 과 Preview 양쪽 모두** 추가하세요. Preview 에 없으면 미리보기 배포에서만
API 가 500 을 냅니다.

> **바인딩은 저장만으로 반영되지 않습니다.** 공식 문서도
> "Redeploy your project for the binding to take effect" 라고 못박고 있습니다.
> 다만 아래 A-3 에서 브랜치를 머지하면 그 푸시가 자동 배포를 일으키므로,
> **바인딩을 먼저 넣고 나중에 머지하면 수동 재배포가 필요 없습니다.**
> 이미 머지를 끝냈다면 **Deployments** 탭 → 맨 위 배포의 점 세 개(⋯) 메뉴에서
> 한 번 다시 돌리세요.

<sub>출처: [Pages Functions — Bindings](https://developers.cloudflare.com/pages/functions/bindings/)</sub>

### A-2′. (Worker 인 경우) 버킷 바인딩

Worker 는 설정 파일이 기준입니다. 레포 루트의 `wrangler.jsonc`(또는 `.toml`)에
아래 두 가지를 추가하세요.

```jsonc
{
  // ...기존 설정 유지...
  "main": "shared/worker-entry.js",
  "assets": { "directory": "./", "binding": "ASSETS" },
  "r2_buckets": [
    { "binding": "BUCKET", "bucket_name": "assignment-hub" }
  ]
}
```

대시보드에서 넣고 싶다면 **Workers & Pages** → 내 Worker → **Settings** →
**Bindings** → **Add** → **R2 bucket**, Variable name 은 똑같이 `BUCKET` 입니다.

### A-3. 배포

이 브랜치를 `main` 에 머지하면 Cloudflare 가 자동으로 다시 빌드합니다.
Pages 라면 `functions/api/[[path]].js` 가, Worker 라면 `shared/worker-entry.js` 가
`/api` 를 처리합니다.

> 빌드 설정은 그대로 두세요. 빌드 명령 없음 / 출력 디렉터리 `/` 인 정적 사이트입니다.
>
> **순서가 중요합니다.** A-2(바인딩) → A-3(머지) 순으로 하면 머지가 일으키는 자동 배포가
> 바인딩까지 함께 반영해 줍니다. 반대로 하면 수동 재배포를 한 번 더 해야 합니다.

### A-4. 확인

```bash
curl https://<사이트주소>/api/health
# {"ok":true,"mode":"r2","materialsGate":false,"maxUploadMB":100}
```

이게 나오면 끝입니다. 사이트에서 과제를 한 건 제출해 보고, R2 대시보드의
**Objects** 에 `data/submissions.json` 과 `uploads/…` 가 생겼는지 확인하세요.

`{"message":"R2 버킷 바인딩(BUCKET)이 설정되지 않았습니다."}` 가 나오면 A-2 의
Variable name 이 정확히 `BUCKET` 인지, 저장 후 **재배포**했는지 확인하세요.

### A-5. (선택) 환경변수로 다듬기

Settings → **Variables and Secrets**(구버전은 *Environment variables*) 에서
조정할 수 있습니다. 전부 선택 사항입니다.

| 이름 | 기본값 | 설명 |
|---|---|---|
| `MAX_UPLOAD_MB` | `100` | 파일 1개당 한도 |
| `ALLOWED_EXT` | 내장 목록 | 쉼표 구분 확장자. 예: `pdf,png,jpg,mp4` |
| `ALLOWED_ORIGINS` | 없음 | 다른 도메인에서도 API 를 쓸 때만. 비워두면 같은 오리진만 허용 |

`MAX_UPLOAD_MB` 를 100 보다 크게 잡아도 소용없습니다. 요청 본문 한도는 Workers 요금제가
아니라 **Cloudflare 계정 요금제**를 따르며, Free·Pro 는 100MB, Business 200MB,
Enterprise 500MB 입니다. 넘으면 413 이 납니다.

<sub>출처: [Workers Platform limits](https://developers.cloudflare.com/workers/platform/limits/)</sub>

### A-6. (선택·권장) 강의자료 다운로드 잠그기

기본 상태에서 강의자료 잠금은 **화면만** 가립니다. 파일 주소를 아는 사람은
비밀번호 없이 받을 수 있습니다. 아래 두 값을 넣으면 **서버가 실제로 막습니다** —
서명된 토큰이 없으면 `/api/file/uploads/materials/…` 가 403 을 돌려줍니다.

Settings → **Variables and Secrets** → 타입을 **Secret** 으로 해서 추가:

| 이름 | 값 |
|---|---|
| `MATERIALS_PASSWORD` | `AI2026` (`config.js` 의 강의자료 비밀번호와 **같은 값**) |
| `TOKEN_SECRET` | 아무 긴 난수 문자열 |

`TOKEN_SECRET` 은 이런 식으로 만드세요.

```bash
openssl rand -hex 32
```

두 값을 넣고 재배포하면 앱이 `/api/health` 로 잠금 상태를 자동 감지해서,
강의자료 화면에서 받은 비밀번호로 6시간짜리 다운로드 토큰을 받아 링크에 붙입니다.

> 잠금을 켜면 **관리자도 비밀번호를 입력해야** 강의자료를 내려받을 수 있습니다.
> 파일을 내보내는 주체가 서버이고, 서버는 관리자 로그인을 알 방법이 없기 때문입니다.
> 자료 등록·편집은 잠금과 무관하게 관리자 화면에서 그대로 됩니다.
>
> `config.js` 의 `materialsHash` 와 `MATERIALS_PASSWORD` 가 다르면 화면은 열리는데
> 다운로드만 403 이 납니다. 두 값은 항상 같은 비밀번호를 가리켜야 합니다.

### A-7. 로컬에서 돌려보기

```bash
# Pages 인 경우
npx wrangler pages dev . --r2=BUCKET

# Worker 인 경우
npx wrangler dev
```

`--r2=BUCKET` 이 로컬 디스크에 가짜 버킷을 만들어 줍니다(데이터는 자동으로 로컬에 보존).
Cloudflare 계정 없이 화면만 볼 때는 브라우저 콘솔에서
`localStorage.setItem('ah.storageMode','local'); location.reload()` 를 실행하세요.

<sub>출처: [Pages Functions — Bindings / Interact with your R2 buckets locally](https://developers.cloudflare.com/pages/functions/bindings/)</sub>

---

## B. GitHub Pages + GitHub 저장소 (대안)

Cloudflare 를 쓰지 않을 때의 구성입니다. `config.js` 에서 `storage: 'github'` 로 바꾸고,
`github.owner` / `repo` / `branch` 를 채우세요.

**토큰만 쓰는 경우** — 관리자만 쓰기가 가능합니다. 교육생은 제출할 수 없습니다.

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
2. Repository access: **Only select repositories** → 이 레포
3. Permissions → Repository permissions → **Contents: Read and write** (다른 권한 불필요)
4. 사이트 → 관리자 로그인 → 대시보드 하단 **저장소** 패널에 토큰 등록

토큰은 그 브라우저의 `localStorage` 에만 저장되고 레포에는 커밋되지 않습니다.
공용 PC 라면 쓰고 나서 **토큰 삭제**를 누르세요.

**프록시를 쓰는 경우** — 교육생도 제출할 수 있습니다.

```bash
cd worker
npm install -g wrangler
wrangler login
# wrangler.toml 의 REPO_OWNER / REPO_NAME / ALLOWED_ORIGINS 수정
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

출력된 주소를 `config.js` 의 `github.proxyUrl` 에 넣습니다.
자세한 내용은 [`worker/README.md`](../worker/README.md) 에 있습니다.

---

## C. 브라우저 저장 (시연용)

설정이 전혀 필요 없고 즉시 동작하지만, 데이터가 접속한 브라우저에만 남습니다.
화면 검수용입니다. 실제 제출은 받을 수 없습니다.

---

## 운영 팁

**과정 시작 전**
- 관리자 비밀번호와 강의자료 공용 비밀번호를 바꾸세요 (README 참고)
- 강의자료 잠금(6번)을 켜고, `MATERIALS_PASSWORD` 를 `config.js` 값과 맞추세요
- 강의자료를 미리 등록하고, 수강생에게 공용 비밀번호를 안내하세요
- 프로젝트를 미리 개설하고 마감일시를 넣어두세요

**과정 중**
- 마감하려면 프로젝트 편집에서 **접수 상태 → 마감**. 마감 후에는 교육생이
  수정·삭제할 수 없고 관리자만 가능합니다
- 제출물이 늘면 `data/submissions.json` 이 커집니다. 수백 건까지는 문제없습니다

**과정 종료 후**
- 관리자 대시보드에서 **CSV 내려받기** + **전체 백업 내려받기**
- 첨부 원본은 R2 대시보드에서 직접 내려받거나
  `npx wrangler r2 object get` / `rclone` 으로 일괄 받으세요
- 개인정보를 지우려면 프로젝트를 삭제하면 제출물과 첨부가 함께 지워집니다

---

## 한계와 대안

정직하게 적어둡니다. 이 구조로 안 되는 것들입니다.

| 한계 | 왜 | 대안 |
|---|---|---|
| 관리자 인증이 서버측이 아님 | 정적 사이트에 검증할 서버가 없음 | Cloudflare Access(무료, Google 로그인 연동)를 `/#/admin` 앞에 걸면 진짜 인증이 됩니다 |
| 과제 첨부는 주소를 알면 받을 수 있음 | 키가 길고 무작위라 추측은 어렵지만 인증은 없음 | 강의자료처럼 토큰 방식으로 막을 수 있습니다 — 필요하면 붙여드립니다 |
| 파일 100MB 초과 | Workers 요청 본문 한도 | 큰 영상은 YouTube·Vimeo 링크를 본문에 적게 하세요. 정말 필요하면 R2 멀티파트 업로드로 확장 가능 |
| 이메일 자동 발송 없음 | 정적 사이트는 메일을 보낼 수 없음 | `/api` 핸들러에 Resend·SendGrid 호출을 추가하면 제출 확인 메일을 보낼 수 있습니다 |
| 실시간 동시 편집 | 파일 기반 색인 | 이 용도에는 과합니다. 필요하면 D1(무료 SQLite)로 |

---

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| `/api/health` 가 404 | Pages: `functions/` 가 배포에 포함됐는지, 출력 디렉터리가 `/` 인지. Worker: `main` 이 `shared/worker-entry.js` 인지 |
| `BUCKET 이 설정되지 않았습니다` | 바인딩 이름이 정확히 `BUCKET` 인지, 추가 후 **재배포**했는지 |
| 목록이 비어 있음 | R2 Objects 에 `data/*.json` 이 있는지. 처음이면 자동 생성됩니다 |
| 업로드 시 413 | `MAX_UPLOAD_MB` 와 `config.js` 의 `upload.maxFileMB` 를 함께 확인 |
| 업로드 시 415 | `config.js` 의 `allowedExt` 와 `ALLOWED_EXT` 환경변수가 어긋남 |
| 강의자료만 403 | `MATERIALS_PASSWORD` 와 `config.js` 의 `materialsHash` 가 다른 비밀번호를 가리킴 |
| Preview 에서만 실패 | Preview 환경에도 바인딩·환경변수를 따로 추가해야 합니다 |
| 저장 시 409 가 계속 | 동시 저장이 겹친 것. 5회 재시도 후에도 실패하면 잠시 뒤 다시 시도하세요 |
