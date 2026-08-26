/**
 * 회원 인증 (서버 측)
 * ---------------------------------------------------------------------------
 * 브라우저가 아니라 Worker 안에서만 도는 코드입니다. 비밀번호 해시와 세션 서명은
 * 전부 여기서 이뤄지고, 해시가 담긴 회원 명부는 어떤 경로로도 브라우저에
 * 내려가지 않습니다.
 *
 * 저장 위치 (R2)
 *   data/members.json      회원 명부 (비밀번호 해시 포함 — 절대 공개 금지)
 *   data/session-secret    세션 서명 키 (없으면 처음 한 번 자동 생성)
 *
 * 비밀번호는 PBKDF2-SHA256 으로 늘려 저장합니다. 반복 횟수는 해시 문자열 안에
 * 함께 적어두므로, 나중에 기본값을 올려도 기존 비밀번호가 그대로 동작합니다.
 */

const MEMBERS_KEY = 'data/members.json';
const SECRET_KEY = 'data/session-secret';

export const SESSION_COOKIE = 'ah_session';
export const SESSION_TTL_MS = 12 * 3600 * 1000;

/**
 * PBKDF2 기본 반복 횟수.
 *
 * Workers 무료 플랜은 요청당 CPU 10ms 입니다. 실측하면 1만 회가 약 2.5ms,
 * 2.5만 회가 약 5.4ms 라서, 나머지 처리에 쓸 여유를 두고 1.5만 회를 기본으로
 * 잡았습니다(약 3.8ms). 유료 플랜이라면 PBKDF2_ITERATIONS 환경변수로 올리세요.
 */
const DEFAULT_ITERATIONS = 15000;
const MAX_ITERATIONS = 600000;

/**
 * 같은 계정의 재설정 요청 간격. 짧게 연타해도 관리자 화면이 도배되지 않게 합니다.
 * (메일을 보내지 않으므로 발송 비용 문제는 없고, 순전히 화면 정리용입니다.)
 */
export const RESET_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;

/** 로그인 시도 제한 — 온라인 대입 공격을 막는 주 방어선입니다. */
const MAX_FAILED = 8;
const LOCK_MS = 10 * 60 * 1000;

export const MIN_PASSWORD = 8;

const enc = new TextEncoder();

/* ------------------------------------------------------------ 인코딩 -- */

function b64(bytes) {
  let s = '';
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 1) s += String.fromCharCode(a[i]);
  return btoa(s);
}

function unb64(text) {
  const s = atob(text);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) a[i] = s.charCodeAt(i);
  return a;
}

const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (text) => unb64(text.replace(/-/g, '+').replace(/_/g, '/'));

/** 길이가 달라도 시간이 새지 않도록 상수 시간 비교. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export const normEmail = (v) => String(v || '').trim().toLowerCase();

/* -------------------------------------------------------- 비밀번호 -- */

function iterationsFor(env) {
  const n = Number(env?.PBKDF2_ITERATIONS);
  if (!Number.isFinite(n) || n < 1000) return DEFAULT_ITERATIONS;
  return Math.min(Math.round(n), MAX_ITERATIONS);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return new Uint8Array(bits);
}

/** 저장 형식: pbkdf2$sha256$<반복>$<salt>$<hash> */
export async function hashPassword(password, env) {
  const iterations = iterationsFor(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > MAX_ITERATIONS) return false;
  try {
    const hash = await pbkdf2(password, unb64(parts[3]), iterations);
    return safeEqual(b64(hash), parts[4]);
  } catch {
    return false;
  }
}

/** 관리자가 초기화해 줄 때 쓰는, 사람이 받아적기 좋은 임시 비밀번호. */
export function tempPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/* ------------------------------------------------------------ 세션 -- */

let cachedSecret = null;

/**
 * 세션 서명 키. TOKEN_SECRET 이 있으면 그것을 쓰고, 없으면 처음 한 번
 * 무작위로 만들어 R2 에 넣어 둡니다. 덕분에 별도 환경변수 설정 없이도
 * 서명된 세션이 동작합니다. (키는 서버에만 존재합니다.)
 */
export async function sessionSecret(env) {
  if (env?.TOKEN_SECRET) return env.TOKEN_SECRET;
  if (cachedSecret) return cachedSecret;

  const existing = await env.BUCKET.get(SECRET_KEY);
  if (existing) {
    cachedSecret = await existing.text();
    return cachedSecret;
  }

  const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.BUCKET.put(SECRET_KEY, fresh, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  // 같은 순간에 두 요청이 만들었을 수 있으니, 최종 저장된 값을 다시 읽어 씁니다.
  const settled = await env.BUCKET.get(SECRET_KEY);
  cachedSecret = settled ? await settled.text() : fresh;
  return cachedSecret;
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function signSession(payload, env) {
  const secret = await sessionSecret(env);
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(body, secret));
  return `${body}.${sig}`;
}

export async function readSession(token, env) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const secret = await sessionSecret(env);
  const expected = b64url(await hmac(body, secret));
  if (!safeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
  } catch { return null; }

  if (!payload?.sub || !payload?.exp || payload.exp < Date.now()) return null;
  return payload;
}

export function cookieValue(header, name) {
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Set-Cookie 헤더 값. 로컬(http)에서는 Secure 를 빼야 쿠키가 저장됩니다. */
export function sessionCookie(token, url, maxAgeSec = SESSION_TTL_MS / 1000) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
    + `${secure}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export const clearCookie = (url) => sessionCookie('', url, 0);

/* -------------------------------------------------------- 회원 명부 -- */

export async function readMembers(env) {
  const obj = await env.BUCKET.get(MEMBERS_KEY);
  if (!obj) return { etag: null, list: [] };
  let list = [];
  try { list = JSON.parse(await obj.text()); } catch { list = []; }
  return { etag: obj.etag, list: Array.isArray(list) ? list : [] };
}

/**
 * 명부를 read-modify-write 합니다. 동시 가입이 겹쳐 etag 가 어긋나면
 * 최신본 위에 다시 적용해 재시도합니다.
 * @param {(list:Array)=>Array|null} mutate  null 을 돌려주면 저장하지 않습니다.
 */
export async function updateMembers(env, mutate) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { etag, list } = await readMembers(env);
    const next = mutate(structuredClone(list));
    if (next === null) return { ok: false, list };

    const put = await env.BUCKET.put(MEMBERS_KEY, JSON.stringify(next, null, 2), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      onlyIf: conditionFor(etag),
    });
    if (put) return { ok: true, list: next };

    await new Promise((r) => setTimeout(r, 80 * (attempt + 1) + Math.random() * 120));
  }
  throw new Error('회원 정보를 저장하지 못했습니다. 잠시 후 다시 시도하세요.');
}

/**
 * 조건부 쓰기 조건.
 *
 * 명부가 아직 없을 때(etag 가 null) 조건 없이 쓰면, 첫 가입이 동시에 몰릴 경우
 * 모두 성공해 버리고 마지막 요청이 앞선 계정을 지웁니다. `If-None-Match: *` 로
 * "없을 때만 만든다"를 걸어야 뒤늦은 요청이 실패하고 재시도 루프로 돌아옵니다.
 */
export function conditionFor(etag) {
  return etag ? { etagMatches: etag } : new Headers({ 'If-None-Match': '*' });
}

export function findMember(list, email) {
  const e = normEmail(email);
  return list.find((m) => normEmail(m.email) === e) || null;
}

/**
 * 세션 세대. 비밀번호 변경·초기화·이용 정지 때 올려서, 그 전에 발급된 토큰을
 * 만료 시각과 무관하게 무효로 만듭니다. (토큰 안에 같은 값이 들어갑니다.)
 */
export const epochOf = (member) => Number(member?.sessionEpoch || 0);

export function bumpEpoch(member) {
  member.sessionEpoch = Date.now();
  return member;
}

/** 브라우저로 내보내도 되는 필드만 남깁니다. 해시는 절대 포함하지 않습니다. */
export function publicMember(m) {
  if (!m) return null;
  return {
    email: m.email,
    name: m.name,
    institution: m.institution || '',
    role: m.role || 'member',
    status: m.status || 'active',
    createdAt: m.createdAt,
    lastLoginAt: m.lastLoginAt || null,
    mustChangePassword: Boolean(m.mustChangePassword),
    // 본인이 "비밀번호를 잊었다"고 알린 시각. 관리자 화면에서 처리 대기로 보입니다.
    resetRequestedAt: m.resetRequestedAt || null,
  };
}

/* ------------------------------------------------------ 시도 제한 -- */

export function lockState(member) {
  const until = Number(member?.lockedUntil || 0);
  if (until && until > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((until - Date.now()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

export function registerFailure(member) {
  const failed = Number(member.failedAttempts || 0) + 1;
  member.failedAttempts = failed;
  if (failed >= MAX_FAILED) {
    member.lockedUntil = Date.now() + LOCK_MS;
    member.failedAttempts = 0;
  }
  return member;
}

export function clearFailures(member) {
  member.failedAttempts = 0;
  member.lockedUntil = 0;
  return member;
}

/* ------------------------------------------------------------ 검증 -- */

export function validateSignup({ email, password, name, institution }) {
  const errors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normEmail(email))) {
    errors.email = '올바른 이메일 주소를 입력하세요.';
  }
  if (String(password || '').length < MIN_PASSWORD) {
    errors.password = `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`;
  }
  if (String(password || '').length > 200) {
    errors.password = '비밀번호가 너무 깁니다.';
  }
  if (!String(name || '').trim()) errors.name = '성명을 입력하세요.';
  if (!String(institution || '').trim()) errors.institution = '기관명을 입력하세요.';
  return errors;
}

/** 테스트에서 쓰는 상수 노출 */
export const AUTH_LIMITS = { MAX_FAILED, LOCK_MS, DEFAULT_ITERATIONS, MIN_PASSWORD };
