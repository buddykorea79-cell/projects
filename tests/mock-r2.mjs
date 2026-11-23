/**
 * 테스트용 R2 스텁 + 정적 서버 + Google OAuth 목 IdP.
 *
 * 진짜 Cloudflare / Google 서버 없이 `shared/r2api.js` 와 `shared/google.js` 를
 * 실제 PKCE + state + nonce + 쿠키 흐름 그대로 돌리기 위한 것입니다.
 */
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize, sep } from 'path';
import { handleApi } from '../shared/r2api.js';

/* ------------------------------------------------------------- 버킷 스텁 -- */

export class MockBucket {
  constructor() { this.objects = new Map(); }

  static etagOf(bytes) { return createHash('md5').update(bytes).digest('hex'); }

  #toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new TextEncoder().encode(String(value));
  }

  async get(key) {
    const rec = this.objects.get(key);
    if (!rec) return null;
    return {
      key,
      etag: rec.etag,
      httpEtag: `"${rec.etag}"`,
      size: rec.bytes.length,
      httpMetadata: rec.httpMetadata,
      customMetadata: rec.customMetadata,
      body: rec.bytes,
      text: async () => new TextDecoder().decode(rec.bytes),
      arrayBuffer: async () => rec.bytes.buffer.slice(
        rec.bytes.byteOffset, rec.bytes.byteOffset + rec.bytes.byteLength),
    };
  }

  /** 조건이 어긋나면 R2 처럼 null 을 돌려줍니다. */
  async put(key, value, opts = {}) {
    const existing = this.objects.get(key);
    const cond = normalizeCondition(opts.onlyIf);

    if (cond?.etagMatches !== undefined) {
      if (cond.etagMatches === '*') { if (!existing) return null; }
      else if (!existing || existing.etag !== cond.etagMatches) return null;
    }
    if (cond?.etagDoesNotMatch !== undefined) {
      if (cond.etagDoesNotMatch === '*') { if (existing) return null; }
      else if (existing && existing.etag === cond.etagDoesNotMatch) return null;
    }

    const bytes = this.#toBytes(value);
    const rec = {
      bytes,
      etag: MockBucket.etagOf(bytes),
      httpMetadata: opts.httpMetadata || {},
      customMetadata: opts.customMetadata || {},
    };
    this.objects.set(key, rec);
    return { key, etag: rec.etag, httpEtag: `"${rec.etag}"`, size: bytes.length };
  }

  async delete(key) { this.objects.delete(key); }

  keys(prefix = '') {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

function normalizeCondition(onlyIf) {
  if (!onlyIf) return null;
  if (typeof onlyIf.get !== 'function') return onlyIf;
  const strip = (v) => (v === null ? undefined : String(v).replace(/^W\//, '').replace(/"/g, ''));
  const out = {};
  const match = strip(onlyIf.get('If-Match'));
  const none = strip(onlyIf.get('If-None-Match'));
  if (match !== undefined) out.etagMatches = match;
  if (none !== undefined) out.etagDoesNotMatch = none;
  return out;
}

/* ----------------------------------------------------- Google OAuth 목 -- */

export const TEST_GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
};

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function makeMockIdToken({
  email,
  name = '',
  sub,
  nonce,
  aud = TEST_GOOGLE_ENV.GOOGLE_CLIENT_ID,
  iss = 'https://accounts.google.com',
  email_verified = true,
  exp = Math.floor(Date.now() / 1000) + 3600,
}) {
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = b64urlJson({
    iss,
    aud,
    sub: sub || `google-sub-${createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16)}`,
    email,
    email_verified,
    name,
    nonce,
    exp,
  });
  return `${header}.${payload}.mock-signature`;
}

/**
 * 단위 테스트용 Google OAuth 로그인 헬퍼 (실제 PKCE + state + nonce + 쿠키 흐름 실행).
 * @param {Function} call  테스트 client()
 * @param {{email:string, name?:string, institution?:string, sub?:string, email_verified?:boolean, next?:string, completeProfile?:boolean, idTokenOverrides?:object}} opts
 */
export async function mockGoogleLogin(call, {
  email,
  name = '홍길동',
  institution = '한국디자인진흥원',
  sub,
  email_verified = true,
  next = '/',
  completeProfile = true,
  idTokenOverrides = {},
}) {
  const qs = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  const start = await call(`/auth/google/start${qs}`);
  if (start.status !== 302) return { start, callback: null, profile: null };

  const startRes = start.res || start.response;
  const loc = new URL(startRes.headers.get('Location'));
  if (!loc.href.startsWith('https://accounts.google.com/')) {
    return { start, callback: null, profile: null, redirectedTo: loc.href };
  }

  const state = loc.searchParams.get('state');
  const nonce = loc.searchParams.get('nonce');
  const codeChallenge = loc.searchParams.get('code_challenge');
  const clientId = loc.searchParams.get('client_id');
  const code = `mock-code-${randomBytes(8).toString('hex')}`;

  const realFetch = globalThis.fetch;
  let callback;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body || ''));
      const verifier = form.get('code_verifier') || '';
      const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
      if (form.get('code') !== code || expectedChallenge !== codeChallenge) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      const id_token = makeMockIdToken({
        email,
        name,
        sub,
        nonce,
        aud: clientId,
        email_verified,
        ...idTokenOverrides,
      });
      return new Response(JSON.stringify({ id_token, access_token: 'mock-access' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, init);
  };

  try {
    callback = await call(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  const cbRes = callback.res || callback.response;
  const callbackLoc = cbRes.headers.get('Location') || '';
  let profile = null;
  if (completeProfile && callbackLoc.includes('#/account?setup=1') && institution) {
    profile = await call('/auth/profile', {
      method: 'POST',
      body: { name: name || '홍길동', institution },
    });
  }
  return { start, callback, callbackLocation: callbackLoc, profile };
}

/** 여러 Set-Cookie 를 브라우저처럼 보존하는 공통 쿠키 적용 헬퍼. */
export function applySetCookies(jar, headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('Set-Cookie') ? [headers.get('Set-Cookie')] : []);
  for (const sc of list) {
    const pair = sc.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!v || /Max-Age=0\b/i.test(sc)) jar.delete(k);
    else jar.set(k, v);
  }
}

/**
 * Playwright 브라우저 테스트용 Google 로그인 헬퍼.
 * /#/login 화면에서 실제 Google 로그인 버튼을 누르고, 필요 시 최초 프로필 입력까지 완료합니다.
 */
export async function browserGoogleLogin(page, {
  origin,
  setNextGoogleUser,
  email,
  name = '홍길동',
  institution = '행정안전부',
  completeProfile = true,
  expectHash = null,
}) {
  setNextGoogleUser({ email, name });
  await page.goto(`${origin}/#/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#googleLoginBtn', { timeout: 8000 });
  await page.locator('#googleLoginBtn').click();

  if (completeProfile) {
    await page.waitForFunction(
      () => Boolean(document.querySelector('#profileForm')) || location.hash === '#/' || location.hash === '',
      { timeout: 12000 },
    );
    if (await page.locator('#profileForm').count()) {
      await page.fill('#profileForm [name="institution"]', institution);
      await page.fill('#profileForm [name="name"]', name);
      await page.check('#profileForm [name="agree"]');
      await page.locator('#profileForm button[type="submit"]').click();
      await page.waitForURL((u) => u.hash === (expectHash || '#/') || u.hash === '', { timeout: 12000 });
    }
  } else {
    await page.waitForURL((u) => !u.pathname.startsWith('/__mock_google'), { timeout: 12000 });
  }
}

/** Playwright APIRequestContext 용 Google 로그인 헬퍼 (302 리다이렉트 + 쿠키 자동 추적). */
export async function contextGoogleLogin(context, {
  origin,
  setNextGoogleUser,
  email,
  name = '홍길동',
  institution = '행정안전부',
}) {
  setNextGoogleUser({ email, name });
  await context.request.get(`${origin}/api/auth/google/start`);
  if (institution) {
    const res = await context.request.post(`${origin}/api/auth/profile`, {
      data: { name, institution },
    });
    if (res.status() !== 200 && res.status() !== 409) {
      throw new Error(`profile failed (${res.status()}): ${await res.text()}`);
    }
  }
}

/* ------------------------------------------------------- 정적 + API 서버 -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * 사이트와 /api 를 같은 오리진에서 서비스합니다 — 실제 Worker/Pages 배포와 같은 구조.
 * 로컬 테스트용 목 Google OAuth 엔드포인트를 함께 띄웁니다.
 * @param {{root: string, env?: object, port?: number}} opts
 */
export async function startServer({ root, env = {}, port = 0 }) {
  const bucket = new MockBucket();
  const fullEnv = {
    BUCKET: bucket,
    ...TEST_GOOGLE_ENV,
    SIGNUP_POLICY: 'open',
    ...env,
  };

  let nextGoogleUser = { email: 'test@example.com', name: '테스트' };
  const issuedCodes = new Map();
  let originRef = '';

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 로컬 테스트 전용 목 Google OAuth 엔드포인트 (프로덕션 코드에는 존재하지 않음)
    if (url.pathname === '/__mock_google/auth' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const codeChallenge = url.searchParams.get('code_challenge') || '';
      const clientId = url.searchParams.get('client_id') || '';
      const user = { ...nextGoogleUser };
      if (user.cancel) {
        res.writeHead(302, { Location: `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}` });
        res.end();
        return;
      }
      const code = `mock-${randomBytes(8).toString('hex')}`;
      issuedCodes.set(code, { user, nonce, codeChallenge, clientId, redirectUri });
      res.writeHead(302, { Location: `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
      res.end();
      return;
    }

    if (url.pathname === '/__mock_google/token' && req.method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      const form = new URLSearchParams(raw);
      const code = form.get('code') || '';
      const entry = issuedCodes.get(code);
      issuedCodes.delete(code);
      const verifier = form.get('code_verifier') || '';
      const expected = createHash('sha256').update(verifier).digest('base64url');
      if (
        !entry
        || form.get('client_id') !== entry.clientId
        || form.get('client_secret') !== fullEnv.GOOGLE_CLIENT_SECRET
        || form.get('redirect_uri') !== entry.redirectUri
        || expected !== entry.codeChallenge
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const id_token = makeMockIdToken({
        email: entry.user.email,
        name: entry.user.name || '',
        sub: entry.user.sub,
        email_verified: entry.user.email_verified ?? true,
        nonce: entry.nonce,
        aud: entry.clientId,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id_token, access_token: 'mock-access' }));
      return;
    }

    if (url.pathname.startsWith('/api')) {
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const request = new Request(url.href, {
        method: req.method,
        headers: req.headers,
        body,
        duplex: 'half',
      });
      const out = await handleApi(request, fullEnv, {
        basePath: '/api',
        googleEndpoints: {
          authUrl: `${originRef}/__mock_google/auth`,
          tokenUrl: `${originRef}/__mock_google/token`,
        },
      });
      const headers = {};
      for (const [k, v] of out.headers.entries()) {
        if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
      }
      const cookies = typeof out.headers.getSetCookie === 'function' ? out.headers.getSetCookie() : [];
      if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(out.status, headers);
      const buf = Buffer.from(await out.arrayBuffer());
      res.end(buf);
      return;
    }

    // 정적 파일
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const isRoot = rel === '/' || rel === sep || rel === '';
    const file = join(root, isRoot ? 'index.html' : rel);
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  const actual = server.address().port;
  originRef = `http://localhost:${actual}`;
  return {
    server,
    bucket,
    env: fullEnv,
    port: actual,
    origin: originRef,
    setNextGoogleUser: (user) => { nextGoogleUser = user; },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
