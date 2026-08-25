# 배포 가이드

세 가지 구성 중 상황에 맞는 것을 고르세요. 위에서 아래로 갈수록 설정이 늘고
대신 실제로 쓸 수 있는 범위가 넓어집니다.

---

## 구성 A — 화면만 확인 (설정 0단계)

1. 이 브랜치를 `main` 에 머지
2. **Settings → Pages → Source → GitHub Actions**
3. 배포 완료 후 접속

`config.js` 의 `storage` 가 `'local'` 이므로 데이터는 접속한 브라우저에만 저장됩니다.
시연·검수·화면 확인용입니다. **실제 제출은 받을 수 없습니다.**

---

## 구성 B — 관리자 혼자 쓰기 (토큰만)

관리자가 프로젝트를 개설하고 제출물을 관리할 수 있지만,
**교육생은 제출할 수 없습니다** (쓰기에 토큰이 필요하므로). 보통은 구성 C 로 갑니다.

### 1. 토큰 발급

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

| 항목 | 값 |
|---|---|
| Repository access | **Only select repositories** → 이 레포 |
| Permissions → Repository permissions → **Contents** | **Read and write** |
| Expiration | 과정 종료일 이후로 |

다른 권한은 주지 마세요. `Contents` 하나면 충분합니다.

### 2. config.js 수정

```js
storage: 'github',

github: {
  owner: 'buddykorea79-cell',
  repo: 'projects',
  branch: 'main',
  dataDir: 'data',
  uploadDir: 'uploads',
  proxyUrl: '',          // 구성 B 는 비워둡니다
},
```

### 3. 토큰 등록

배포된 사이트 → **관리자 로그인** → 대시보드 하단 **저장소** 패널 → 토큰 입력 → 저장.

토큰은 그 브라우저의 `localStorage` 에만 저장되고 레포에는 절대 커밋되지 않습니다.
공용 PC 에서는 사용 후 **토큰 삭제**를 눌러주세요.

---

## 구성 C — 교육생이 직접 제출 (권장)

토큰을 대신 쥐고 있어줄 작은 함수 하나를 띄웁니다. Cloudflare Workers 무료 티어면 충분합니다
(하루 10만 요청).

### 1. 사전 준비

- Cloudflare 계정 (무료)
- Node.js 18+
- 구성 B 의 **1단계**대로 발급한 fine-grained 토큰

### 2. 워커 배포

```bash
cd worker
npm install -g wrangler
wrangler login
```

`wrangler.toml` 을 자기 레포에 맞게 고칩니다.

```toml
[vars]
REPO_OWNER  = "buddykorea79-cell"
REPO_NAME   = "projects"
REPO_BRANCH = "main"
ALLOWED_ORIGINS = "https://buddykorea79-cell.github.io"
```

> `ALLOWED_ORIGINS` 는 **사이트 주소만** 적습니다. 경로(`/projects/`)는 빼고
> 스킴+호스트까지만. 여러 개면 쉼표로 구분합니다.

토큰을 시크릿으로 넣고 배포합니다. 토큰은 이 단계에서만 존재하고 코드에는 남지 않습니다.

```bash
wrangler secret put GITHUB_TOKEN     # 붙여넣기
wrangler deploy
```

출력된 주소(`https://assignment-hub-proxy.<계정>.workers.dev`)를 복사합니다.

### 3. 사이트 연결

`assets/js/config.js`:

```js
storage: 'github',

github: {
  owner: 'buddykorea79-cell',
  repo: 'projects',
  branch: 'main',
  dataDir: 'data',
  uploadDir: 'uploads',
  proxyUrl: 'https://assignment-hub-proxy.<계정>.workers.dev',   // ← 여기
},
```

커밋·푸시하면 Pages 가 재배포되고, 이제 교육생은 토큰 없이 제출할 수 있습니다.

### 4. 동작 확인

```bash
curl https://assignment-hub-proxy.<계정>.workers.dev/health
# {"ok":true,"repo":"buddykorea79-cell/projects"}
```

사이트에서 실제로 한 건 제출해 보고, 레포의 `data/submissions.json` 과
`uploads/` 에 커밋이 올라왔는지 확인하세요.

### 5. (권장) 봇 방지 켜기

프록시는 인증 없이 열려 있습니다. 주소가 알려지면 장난성 제출이 들어올 수 있습니다.
Cloudflare Turnstile 은 무료이고, 시크릿만 넣으면 워커가 자동으로 검증합니다.

```bash
wrangler secret put TURNSTILE_SECRET
```

넣는 순간부터 워커가 모든 요청에 Turnstile 토큰을 요구합니다.
사이트 쪽 위젯은 아직 붙여두지 않았으니, 켜기 전에 알려주시면 제출 폼에 추가해 드리겠습니다.

방어막이 하나 더 필요하면 Cloudflare 대시보드에서
**Security → WAF → Rate limiting rules** 로 IP당 분당 요청 수를 제한할 수 있습니다.

---

## 운영 팁

**과정 시작 전**
- 관리자 비밀번호와 강의자료 공용 비밀번호를 바꾸세요 (README 참고)
- 강의자료를 미리 등록하고, 수강생에게 공용 비밀번호를 안내하세요
- 프로젝트를 미리 개설하고 마감일시를 넣어두세요
- 첨부 정책(`upload.maxFileMB`, `allowedExt`)을 과제 성격에 맞게 조정하세요

**과정 중**
- 제출물이 늘면 `data/submissions.json` 이 커집니다. 수백 건까지는 문제없지만
  1,000건을 넘길 것 같으면 프로젝트별로 레포를 나누는 편이 낫습니다
- 마감하려면 프로젝트 편집에서 **접수 상태 → 마감**. 마감 후에는 교육생이
  수정·삭제할 수 없고 관리자만 가능합니다

**과정 종료 후**
- 관리자 대시보드에서 **CSV 내려받기** + **전체 백업 내려받기**
- 첨부 원본은 `uploads/` 폴더를 통째로 `git clone` 하거나 ZIP 으로 내려받으세요
- 개인정보를 지우려면 프로젝트를 삭제하면 제출물과 첨부가 함께 지워집니다

---

## 한계와 대안

정직하게 적어둡니다. 이 구조로 안 되는 것들입니다.

| 한계 | 왜 | 대안 |
|---|---|---|
| 관리자 인증이 서버측이 아님 | 정적 사이트에 검증할 서버가 없음 | Cloudflare Access(무료, Google 로그인 연동) 를 `#/admin` 앞에 걸면 진짜 인증이 됩니다 |
| 강의자료 비밀번호가 파일 접근을 막지는 못함 | 잠금은 화면만 가리고, 파일 자체는 raw URL 로 공개됨 | 자료를 외부에 완전히 숨겨야 하면 private 레포 + 프록시 경유 다운로드가 필요합니다 — 요청 주시면 붙여드립니다 |
| 이메일 자동 발송 없음 | 정적 사이트는 메일을 보낼 수 없음 | 워커에 Resend·SendGrid API 호출을 추가하면 제출 확인 메일을 보낼 수 있습니다 |
| 첨부 100MB 이상 | GitHub Contents API 제한 | 큰 영상은 YouTube·Vimeo 링크를 본문에 적게 하세요 |
| 실시간 동시 편집 | 파일 기반 저장 | 이 용도에는 과합니다. 필요하면 Supabase 무료 티어로 |
| 레포가 공개면 제출물도 공개 | raw URL 은 인증이 없음 | 민감한 과제라면 레포를 **private** 으로 두고 구성 C 를 쓰세요. 단 이때는 첨부 미리보기에 프록시 경유가 추가로 필요합니다 — 알려주시면 붙여드리겠습니다 |

> **레포를 private 으로 할 때 주의**: GitHub Pages 의 private 레포 호스팅은
> 유료 플랜(Pro/Team/Enterprise) 기능입니다. 무료 계정이라면 사이트 코드는 공개 레포에,
> 데이터는 별도 private 레포에 두고 워커가 그 사이를 잇는 구성이 됩니다.

---

## 문제가 생기면

| 증상 | 확인할 것 |
|---|---|
| 목록이 계속 비어 있음 | `data/*.json` 이 올바른 JSON 배열인지, `github.owner/repo/branch` 가 맞는지 |
| 제출 시 "쓰기 권한이 없습니다" | 구성 B면 토큰 등록 여부, 구성 C면 `proxyUrl` 오타 |
| 401 / 403 | 토큰 만료, 또는 `Contents: Read and write` 미부여 |
| CORS 오류 | 워커의 `ALLOWED_ORIGINS` 가 사이트 주소와 정확히 같은지 (경로 없이) |
| 제출은 됐는데 목록에 늦게 뜸 | raw URL 이 CDN 캐시를 탑니다. 최대 5분 정도 걸릴 수 있습니다 |
| Pages 가 배포 안 됨 | Settings → Pages → Source 가 **GitHub Actions** 인지 |
