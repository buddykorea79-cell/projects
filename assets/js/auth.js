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

/** 로그인한 회원. 없으면 null. */
export function currentUser() {
  return store?.auth?.me() || null;
}

export function isSignedIn() { return Boolean(currentUser()); }

export function isAdmin() { return currentUser()?.role === 'admin'; }

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

/** 세션이 서버에서 끊겼는지 다시 확인합니다(다른 기기에서 정지 처리 등). */
export function refreshSession() {
  return store?.auth?.refresh?.() ?? Promise.resolve(null);
}
