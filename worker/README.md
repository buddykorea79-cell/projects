# worker/ — 선택 사항인 서버 조각들

현재 권장 구성(**Cloudflare Pages + R2**)에서는 이 폴더가 필요 없습니다.
`functions/api/[[path]].js` 가 사이트와 같은 도메인에서 저장소 API 를 서비스합니다.

| 파일 | 언제 필요한가 |
|---|---|
| `worker.js` + `wrangler.toml` | 저장소를 **GitHub 모드**로 쓰면서 교육생 제출까지 받을 때 |
| `r2-worker.js` + `wrangler.r2.toml` | 사이트는 Cloudflare 밖(예: GitHub Pages)에 두고 **파일만 R2** 에 넣을 때 |

---

## worker.js — GitHub 쓰기 프록시

교육생이 GitHub 토큰 없이 과제를 제출할 수 있게 해주는 조각입니다.
토큰은 이 워커의 시크릿으로만 존재하고 브라우저에는 절대 내려가지 않습니다.

배포 순서는 **[../docs/SETUP.md](../docs/SETUP.md) 구성 C** 에 단계별로 있습니다.
요약하면:

```bash
npm install -g wrangler
wrangler login
# wrangler.toml 의 REPO_OWNER / REPO_NAME / ALLOWED_ORIGINS 수정
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

## 이 워커가 하는 일

`POST /commit` 하나만 받습니다. `op` 는 셋 중 하나입니다.

| op | 하는 일 |
|---|---|
| `head` | 현재 파일의 blob SHA 를 돌려줍니다 (없으면 `null`) |
| `put` | 파일을 커밋합니다 |
| `delete` | 파일을 지웁니다 |

`head` 가 따로 있는 이유: 인증 없는 GitHub API 는 **IP 당 시간당 60회**뿐입니다.
교실처럼 여러 명이 같은 공인 IP 를 쓰면 금방 막히므로, SHA 조회도 워커의
토큰(시간당 5,000회)으로 대신 받아줍니다. 돌려받은 SHA 는 브라우저가 그대로
써서 동시 수정 충돌을 감지합니다 — 덮어쓰기 판단은 워커가 하지 않습니다.


```json
{ "op": "put", "path": "uploads/s_abc/f_1_시안.png",
  "content": "<base64>", "message": "feat(uploads): 시안.png", "sha": null }
```

받으면 아래를 검사한 뒤 GitHub Contents API 로 넘깁니다.

- 출처가 `ALLOWED_ORIGINS` 에 있는지
- 경로가 `data/` 또는 `uploads/` 로 시작하는지 (`..`, `//` 차단)
- 크기가 25MB 이하인지
- `TURNSTILE_SECRET` 이 설정돼 있으면 봇 방지 토큰이 유효한지

`GET /health` 로 살아있는지 확인할 수 있습니다.

## 보안에 대해

`TURNSTILE_SECRET` 없이는 **주소를 아는 누구나 정해진 경로에 커밋할 수 있습니다.**
출처 검사는 브라우저 규칙이라 `curl` 은 우회합니다. 교육 과정처럼 기간이 정해진
용도에는 대체로 충분하지만, 주소가 외부에 알려질 것 같으면:

1. `wrangler secret put TURNSTILE_SECRET` 으로 봇 방지를 켜세요
   (사이트 쪽 위젯 연결이 필요합니다 — 요청 주시면 붙여드립니다)
2. Cloudflare 대시보드에서 Rate limiting 규칙을 거세요
3. 과정이 끝나면 `wrangler delete` 로 워커를 내리세요

문제가 생겨도 피해는 이 레포의 `data/`·`uploads/` 에 한정되고,
git 히스토리가 있으니 언제든 되돌릴 수 있습니다.

---

## r2-worker.js — R2 저장소 API (독립 Worker)

`shared/r2api.js` 를 Pages 없이 단독으로 띄웁니다. Pages 를 쓴다면 필요 없습니다.

```bash
# wrangler.r2.toml 의 bucket_name 과 ALLOWED_ORIGINS 를 먼저 수정
wrangler deploy --config wrangler.r2.toml
```

그 다음 `assets/js/config.js` 에서:

```js
storage: 'r2',
r2: { apiBase: 'https://assignment-hub-r2.<계정>.workers.dev' },
```

사이트가 다른 도메인이므로 `ALLOWED_ORIGINS` 에 사이트 주소를 꼭 넣어야 합니다.
비워두면 같은 오리진만 허용되어 브라우저가 CORS 로 막힙니다.
