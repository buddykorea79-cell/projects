/**
 * Google OAuth 2.0 + OIDC (Authorization Code + PKCE) 서버 측 구현.
 * ---------------------------------------------------------------------------
 * 외부 라이브러리 없이 Web Crypto API 만 사용합니다.
 *
 * 흐름
 *   1) GET /api/auth/google/start?next=/...
 *      - 무작위 state · PKCE code_verifier · OIDC nonce 생성
 *      - 서명된 HttpOnly 쿠키(ah_oauth, 10분 유효, Path=/api/auth/google)에 보관
 *      - Google 로그인 화면으로 302 리다이렉트
 *   2) GET /api/auth/google/callback?code=...&state=...
 *      - ah_oauth 쿠키 서명·만료·state 일치 검증 후 즉시 쿠키 폐기
 *      - code + code_verifier + client_secret 으로 Google 토큰 엔드포인트 교환
 *      - 반환된 id_token 의 iss · aud · exp · nonce · sub · email_verified 검증
 *      - 검증된 Google 사용자 정보({ sub, email, name, picture }) 반환
 *
 * 보안 원칙
 *   - email_verified !== true 인 계정은 거부합니다.
 *   - next 경로는 내부 SPA 경로만 허용해 Open Redirect 를 차단합니다.
 *   - OAuth 엔드포인트는 프로덕션에서 항상 Google 공식 HTTPS 주소로 고정됩니다.
 *     (테스트에서만 handleApi 옵션으로 로컬 목 엔드포인트를 주입할 수 있습니다.)
 */
import { signSession, readSession, safeEqual, normEmail } from './auth.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const OAUTH_COOKIE = 'ah_oauth';
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const ONBOARD_COOKIE = 'ah_onboard';
export const ONBOARD_TTL_MS = 30 * 60 * 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

function b64url(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 1) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  const padded = String(text || '').replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (String(text || '').length % 4)) % 4);
  const s = atob(padded);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) a[i] = s.charCodeAt(i);
  return a;
}

function randomUrl(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** 환경변수에 Google OAuth 클라이언트 정보가 모두 설정돼 있는지. */
export function googleConfigured(env) {
  return Boolean(String(env?.GOOGLE_CLIENT_ID || '').trim() && String(env?.GOOGLE_CLIENT_SECRET || '').trim());
}

/** 로그인 후 돌아갈 SPA 경로를 안전하게 정리합니다(Open Redirect 방지). */
export function sanitizeNext(raw) {
  const s = String(raw || '').trim();
  return /^\/[A-Za-z0-9/_-]*$/.test(s) ? s : '/';
}

/** OAuth 상태 쿠키. 콜백 경로에만 전송되도록 Path 를 좁힙니다. */
export function oauthCookie(token, url, basePath = '/api', maxAgeSec = OAUTH_TTL_MS / 1000) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const path = `${String(basePath || '').replace(/\/$/, '')}/auth/google` || '/auth/google';
  return `${OAUTH_COOKIE}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; SameSite=Lax`
    + `${secure}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export const clearOAuthCookie = (url, basePath = '/api') => oauthCookie('', url, basePath, 0);

/** 신규 승인 대기 사용자의 소속·성명·기존계정 연계 신청용 단기 서명 쿠키 (세션 권한 없음). */
export function onboardCookie(token, url, basePath = '/api', maxAgeSec = ONBOARD_TTL_MS / 1000) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const path = `${String(basePath || '').replace(/\/$/, '')}/auth` || '/auth';
  return `${ONBOARD_COOKIE}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; SameSite=Lax`
    + `${secure}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export const clearOnboardCookie = (url, basePath = '/api') => onboardCookie('', url, basePath, 0);

export function createOnboardToken({ sub, email, name }, env) {
  return signSession({
    sub: String(sub || ''),
    purpose: 'google-onboard',
    email: normEmail(email),
    name: String(name || '').trim().slice(0, 60),
    exp: Date.now() + ONBOARD_TTL_MS,
  }, env);
}

export async function readOnboardToken(token, env) {
  if (!token) return null;
  const payload = await readSession(token, env);
  if (!payload || payload.purpose !== 'google-onboard') return null;
  const sub = String(payload.sub || '').trim();
  const email = normEmail(payload.email);
  if (!sub || !email) return null;
  return { sub, email, name: String(payload.name || '').trim().slice(0, 60) };
}

/** OAuth 시작 시 state · PKCE verifier · nonce 를 만들고 서명된 쿠키 값을 반환합니다. */
export async function createOAuthChallenge(next, env) {
  const state = randomUrl(32);
  const codeVerifier = randomUrl(32);
  const codeChallenge = await pkceChallenge(codeVerifier);
  const nonce = randomUrl(16);
  const safeNext = sanitizeNext(next);
  const cookieToken = await signSession({
    sub: 'google-oauth',
    purpose: 'google-oauth',
    state,
    codeVerifier,
    nonce,
    next: safeNext,
    exp: Date.now() + OAUTH_TTL_MS,
  }, env);
  return { state, codeChallenge, nonce, next: safeNext, cookieToken };
}

/** 콜백에서 OAuth 상태 쿠키를 복호화·검증합니다. */
export async function verifyOAuthChallenge(cookieToken, returnedState, env) {
  if (!cookieToken || !returnedState) return null;
  const payload = await readSession(cookieToken, env);
  if (!payload || payload.purpose !== 'google-oauth') return null;
  if (!payload.state || !payload.codeVerifier || !payload.nonce) return null;
  if (!safeEqual(String(returnedState), String(payload.state))) return null;
  return {
    codeVerifier: String(payload.codeVerifier),
    nonce: String(payload.nonce),
    next: sanitizeNext(payload.next),
  };
}

/** Google 인증 URL 생성. */
export function buildGoogleAuthUrl({
  clientId, redirectUri, state, codeChallenge, nonce, authUrl = GOOGLE_AUTH_URL,
}) {
  const params = new URLSearchParams({
    client_id: String(clientId).trim(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${authUrl}?${params.toString()}`;
}

/**
 * id_token 의 페이로드를 파싱하고 OIDC 핵심 클레임을 검증합니다.
 * 토큰 엔드포인트(HTTPS + client_secret + PKCE)에서 직접 받은 응답이므로
 * iss · aud · exp · nonce · sub · email_verified 검증으로 무결성을 확인합니다.
 */
export function parseAndVerifyIdToken(idToken, { clientId, expectedNonce, nowMs = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'oauth_failed' };

  let payload;
  try {
    payload = JSON.parse(dec.decode(unb64url(parts[1])));
  } catch {
    return { ok: false, error: 'oauth_failed' };
  }

  if (!payload || typeof payload !== 'object') return { ok: false, error: 'oauth_failed' };
  if (!VALID_ISSUERS.has(String(payload.iss || ''))) return { ok: false, error: 'oauth_failed' };

  const aud = payload.aud;
  const expectedAud = String(clientId || '').trim();
  const audOk = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!audOk) return { ok: false, error: 'oauth_failed' };

  const expMs = Number(payload.exp || 0) * 1000;
  if (!Number.isFinite(expMs) || expMs <= nowMs - 60_000) return { ok: false, error: 'oauth_failed' };

  if (!expectedNonce || !payload.nonce || !safeEqual(String(payload.nonce), String(expectedNonce))) {
    return { ok: false, error: 'invalid_state' };
  }

  const sub = String(payload.sub || '').trim();
  const email = normEmail(payload.email);
  if (!sub || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, error: 'oauth_failed' };

  // Google 이 소유권을 검증하지 않은 이메일은 신뢰하지 않습니다.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    return { ok: false, error: 'unverified_email' };
  }

  return {
    ok: true,
    profile: {
      sub,
      email,
      name: String(payload.name || '').trim().slice(0, 60),
      picture: String(payload.picture || '').trim(),
    },
  };
}

/** 인가 코드를 Google 토큰 엔드포인트에서 교환해 검증된 사용자 정보를 돌려줍니다. */
export async function exchangeGoogleCode({
  code, codeVerifier, redirectUri, clientId, clientSecret, expectedNonce,
  tokenUrl = GOOGLE_TOKEN_URL,
}) {
  const form = new URLSearchParams({
    code: String(code || ''),
    client_id: String(clientId || '').trim(),
    client_secret: String(clientSecret || '').trim(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: String(codeVerifier || ''),
  });

  let res;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
  } catch {
    return { ok: false, error: 'oauth_failed' };
  }

  if (!res.ok) return { ok: false, error: 'oauth_failed' };

  const data = await res.json().catch(() => null);
  if (!data?.id_token) return { ok: false, error: 'oauth_failed' };

  return parseAndVerifyIdToken(data.id_token, { clientId, expectedNonce });
}
