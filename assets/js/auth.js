/**
 * 화면에서 쓰는 로그인 상태 helper.
 *
 * 실제 인증은 저장소가 담당합니다.
 *  - R2 모드    : 서버(Worker)가 비밀번호를 확인하고 HttpOnly 쿠키로 세션을 줍니다.
 *  - 그 밖의 모드: 서버가 없어 브라우저 안에서 흉내만 냅니다(시연용).
 *
 * 화면 코드는 이 모듈만 보면 되고, 어느 쪽인지는 신경 쓰지 않습니다.
 */
import { store } from './store/index.js';
import { leaderTeam } from './camp.js';

/** 로그인한 회원. 없으면 null. */
export function currentUser() {
  return store?.auth?.me() || null;
}

export function isSignedIn() { return Boolean(currentUser()); }

export function isAdmin() { return currentUser()?.role === 'admin'; }

/** 그룹장이 맡은 조 (1~8). 그룹장이 아니면 0 — assets/js/camp.js 참고. */
export function myLeaderTeam() { return leaderTeam(currentUser()); }

/**
 * 서버에 지금 내 권한을 다시 물어봅니다.
 *
 * 로그인 상태는 화면을 처음 열 때 한 번만 맞춰 둡니다. 그래서 관리자가 방금
 * **그룹장으로 올려 줘도** 그 사람의 브라우저는 새로고침 전까지 예전 권한을
 * 들고 있습니다(화면 안에서 주소만 바뀌면 다시 읽지 않습니다). 권한에 따라
 * 보이는 것이 달라지는 화면은 그리기 전에 이것을 한 번 부릅니다.
 *
 * 실패해도 던지지 않습니다 — 잠깐 네트워크가 끊겼다고 화면이 깨지는 것보다
 * 들고 있던 값으로 그리는 편이 낫습니다.
 */
export async function refreshRole() {
  const before = currentUser()?.role;
  try { await store?.auth?.refresh(); } catch { /* 들고 있던 값으로 그립니다 */ }
  if (currentUser()?.role !== before) announceAuthChange();
  return currentUser();
}

/** 조를 맡은 그룹장인지. 관리자는 그룹장이 아니어도 모든 조를 봅니다. */
export function isLeader() { return myLeaderTeam() > 0; }

/** 이 저장소에서 회원 기능을 쓸 수 있는지. */
export function authSupported() { return Boolean(store?.auth?.supported); }

/**
 * 서버 없이 브라우저에서만 흉내내는 인증인지.
 * true 면 화면에 "시연용" 이라고 알려 줍니다 — 진짜 보호가 아니기 때문입니다.
 */
export function isSimulated() { return Boolean(store?.auth?.simulated); }

/** 로그인 상태가 바뀌면 헤더 등 화면 곳곳이 함께 갱신되도록 알립니다. */
export function announceAuthChange() {
  window.dispatchEvent(new CustomEvent('ah:auth'));
}

export async function signup(payload) {
  const me = await store.auth.signup(payload);
  announceAuthChange();
  return me;
}

export async function login(email, password) {
  const me = await store.auth.login(email, password);
  announceAuthChange();
  return me;
}

export async function logout() {
  await store.auth.logout();
  announceAuthChange();
}

export function changePassword(current, next) {
  return store.auth.changePassword(current, next);
}

/**
 * "비밀번호를 잊었습니다" 접수. 방법이 두 가지입니다.
 *
 * @param {string} email
 * @param {'admin'|'code'} method
 *   'admin'(기본) — 관리자 화면에 처리 대기로 올라가고, 관리자가 재설정 링크나
 *     임시 비밀번호를 전달합니다. 계정이 없어도 조용히 성공한 척 끝냅니다.
 *   'code' — 숫자 6자리 임시 비밀번호를 그 자리에서 돌려받습니다(30분 유효).
 *     텔레그램이 멈췄을 때를 위한 예비 수단이라 없는 계정이면 오류를 냅니다.
 * @returns {Promise<{tempPassword?: string, expiresAt?: number, expiresInMin?: number}>}
 */
export function requestReset(email, method = 'admin') {
  return store.auth.requestReset(email, method);
}

/**
 * 재설정 링크(토큰)로 새 비밀번호 설정. 서버가 토큰을 검증하는 R2 모드에서만
 * 동작합니다 — 시연용 모드에는 링크를 만들어 줄 서버가 없습니다.
 */
export function confirmReset(token, password) {
  if (typeof store?.auth?.confirmReset !== 'function') {
    return Promise.reject(new Error('이 저장소 모드에서는 재설정 링크를 지원하지 않습니다.'));
  }
  return store.auth.confirmReset(token, password);
}

/** 세션이 서버에서 끊겼는지 다시 확인합니다(다른 기기에서 정지 처리 등). */
export function refreshSession() {
  return store?.auth?.refresh?.() ?? Promise.resolve(null);
}
