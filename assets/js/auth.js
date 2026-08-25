/**
 * 관리자 인증.
 *
 * ⚠ 정적 사이트라 서버 검증이 없습니다. 이 로그인은 관리 화면을 가리는 잠금이며,
 *   실제 데이터 쓰기 권한은 저장소 계층(GitHub 토큰 또는 프록시)이 통제합니다.
 *   따라서 비밀번호가 새더라도 토큰이 없으면 레포는 변경되지 않습니다.
 */
import { CONFIG } from './config.js';
import { sha256, normEmail } from './utils.js';

const SESSION_KEY = 'ah.admin';
const MATERIALS_KEY = 'ah.materials';

/** 콘솔에서 새 비밀번호 해시를 만들 때 쓰는 헬퍼. window 에도 노출됩니다. */
export async function hashAdmin(email, password) {
  const h = await sha256(`${normEmail(email)}:${password}:${CONFIG.passwordSalt}`);
  console.log(`email: ${normEmail(email)}\nhash : ${h}`);
  return h;
}

export async function login(email, password) {
  const e = normEmail(email);
  const admin = CONFIG.admins.find((a) => normEmail(a.email) === e);
  const given = await sha256(`${e}:${password}:${CONFIG.passwordSalt}`);

  // 사용자 존재 여부가 응답 속도로 새지 않도록 항상 비교를 수행합니다.
  const expected = admin?.hash || '0'.repeat(64);
  if (!admin || !timingSafeEqual(given, expected)) {
    throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
  }

  const session = {
    email: e,
    name: admin.name || '관리자',
    expiresAt: Date.now() + CONFIG.adminSessionHours * 3600 * 1000,
  };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
  return session;
}

export function logout() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

export function session() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.expiresAt || s.expiresAt < Date.now()) { logout(); return null; }
    return s;
  } catch { return null; }
}

export function isAdmin() { return Boolean(session()); }

/* ------------------------------------------------- 강의자료 공용 비밀번호 -- */

/** 콘솔에서 새 강의자료 비밀번호 해시를 만들 때 쓰는 헬퍼. */
export async function hashMaterials(password) {
  const h = await sha256(`materials:${password}:${CONFIG.passwordSalt}`);
  console.log(`materialsHash: ${h}`);
  return h;
}

/**
 * 강의자료 열람 비밀번호를 확인하고 통과하면 세션에 기록합니다.
 * 수강생 전체가 공유하는 암호라 개인 인증이 아니라 외부인 차단용입니다.
 */
export async function unlockMaterials(password) {
  const given = await sha256(`materials:${password}:${CONFIG.passwordSalt}`);
  if (!timingSafeEqual(given, CONFIG.materialsHash || '0'.repeat(64))) {
    throw new Error('비밀번호가 올바르지 않습니다.');
  }
  const until = Date.now() + (CONFIG.materialsSessionHours || 12) * 3600 * 1000;
  try { sessionStorage.setItem(MATERIALS_KEY, String(until)); } catch { /* ignore */ }
  return true;
}

export function lockMaterials() {
  try { sessionStorage.removeItem(MATERIALS_KEY); } catch { /* ignore */ }
}

/** 관리자는 비밀번호 없이 항상 열람할 수 있습니다. */
export function materialsUnlocked() {
  if (isAdmin()) return true;
  try {
    const until = Number(sessionStorage.getItem(MATERIALS_KEY) || 0);
    if (!until || until < Date.now()) { lockMaterials(); return false; }
    return true;
  } catch { return false; }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
