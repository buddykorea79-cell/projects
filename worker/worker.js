/**
 * Assignment Hub — 쓰기 프록시 (Cloudflare Workers)
 * ---------------------------------------------------------------------------
 * GitHub Pages 는 정적 파일만 내보내므로, 토큰이 없는 교육생이 직접 레포에
 * 커밋할 방법이 없습니다. 이 워커가 그 한 조각을 채웁니다. 토큰은 워커의
 * 시크릿으로만 존재하고 브라우저에는 절대 내려가지 않습니다.
 *
 * 배포 (worker/README.md 에 단계별 설명):
 *   wrangler secret put GITHUB_TOKEN
 *   wrangler deploy
 *
 * 필수 환경변수 (wrangler.toml [vars] 또는 대시보드):
 *   REPO_OWNER, REPO_NAME, ALLOWED_ORIGINS
 * 시크릿:
 *   GITHUB_TOKEN          contents: read & write 권한의 fine-grained token
 *   TURNSTILE_SECRET      (선택) Cloudflare Turnstile 사용 시
 */

const MAX_BYTES = 25 * 1024 * 1024;   // base64 디코딩 전 기준, 파일 1개당
const ALLOWED_PREFIXES = ['data/', 'uploads/'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!isAllowedOrigin(origin, env)) {
      return json({ message: '허용되지 않은 출처입니다.' }, 403, cors);
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, repo: `${env.REPO_OWNER}/${env.REPO_NAME}` }, 200, cors);
    }
    if (request.method !== 'POST' || url.pathname !== '/commit') {
      return json({ message: 'Not found' }, 404, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);
    }

    const { op, path, content, message, sha, branch, turnstileToken } = body;

    // ---- 검증 -------------------------------------------------------------
    if (op !== 'put' && op !== 'delete' && op !== 'head') {
      return json({ message: '지원하지 않는 작업입니다.' }, 400, cors);
    }
    if (typeof path !== 'string' || !ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      return json({ message: '허용되지 않은 경로입니다.' }, 400, cors);
    }
    if (path.includes('..') || path.includes('//') || path.length > 400) {
      return json({ message: '잘못된 경로입니다.' }, 400, cors);
    }
    if (op === 'put') {
      if (typeof content !== 'string') {
        return json({ message: '내용이 없습니다.' }, 400, cors);
      }
      if (content.length > MAX_BYTES * 1.4) {
        return json({ message: '파일이 너무 큽니다.' }, 413, cors);
      }
    }

    // ---- Turnstile (설정된 경우에만) ---------------------------------------
    if (env.TURNSTILE_SECRET) {
      const ok = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET,
        request.headers.get('CF-Connecting-IP'));
      if (!ok) return json({ message: '봇 방지 확인에 실패했습니다.' }, 403, cors);
    }

    // ---- GitHub 호출 ------------------------------------------------------
    const api = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/contents/`
      + path.split('/').map(encodeURIComponent).join('/');
    const ref = branch || env.REPO_BRANCH || 'main';

    // head — 현재 blob SHA 만 돌려줍니다. 브라우저가 인증 없이 GitHub API 를
    // 두드리면 IP 당 시간당 60회에 걸리므로, 이 조회를 워커가 대신 받아줍니다.
    if (op === 'head') {
      const look = await fetch(`${api}?ref=${encodeURIComponent(ref)}`, {
        headers: ghHeaders(env),
      });
      if (look.status === 404) return json({ sha: null }, 200, cors);
      if (!look.ok) return json({ message: `SHA 조회 실패 (${look.status})` }, look.status, cors);
      const meta = await look.json();
      return json({ sha: meta.sha || null }, 200, cors);
    }

    const payload = {
      message: String(message || 'chore: update').slice(0, 200),
      branch: ref,
      ...(sha ? { sha } : {}),
      ...(op === 'put' ? { content } : {}),
    };

    const res = await fetch(api, {
      method: op === 'put' ? 'PUT' : 'DELETE',
      headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
      // GitHub 오류 본문을 그대로 흘리지 않고 필요한 부분만 전달합니다.
      let detail = '';
      try { detail = JSON.parse(text)?.message || ''; } catch { /* ignore */ }
      return json({ message: detail || `GitHub 요청 실패 (${res.status})` }, res.status, cors);
    }

    return new Response(text, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};

/* ------------------------------------------------------------------ 헬퍼 -- */

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'assignment-hub-proxy',
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin, env) {
  const list = allowedOrigins(env);
  if (!list.length) return true;            // 미설정 시 제한하지 않음 (개발용)
  return list.includes(origin);
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  const allow = !list.length ? '*' : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function verifyTurnstile(token, secret, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body: form });
    return (await res.json())?.success === true;
  } catch {
    return false;
  }
}
