/**
 * 화면에서 쓰는 로그인 상태 helper (Google OAuth 전용).
 *
 * 실제 인증은 저장소가 담당합니다.
 *  - R2 모드    : 서버(Worker)가 Google OAuth(PKCE)로 본인 확인 후 HttpOnly 세션 쿠키 발급.
 *  - 그 밖의 모드: 서버가 없어 브라우저 안에서 시연용으로만 동작합니다.
 */
import { store } from './store/index.js';
import { leaderTeam } from './camp.js';

/** 로그인한 회원. 없으면 null. */
export function currentUser() {
  return store?.auth?.me() || null;
}

export function isSignedIn() { return Boolean(currentUser()); }

export function isAdmin() { return currentUser()?.role === 'admin'; }

/** 최초 Google 로그인 뒤 기관명·성명 입력이 필요한지. */
export function needsProfile() { return Boolean(currentUser()?.needsProfile); }

/** 그룹장이 맡은 조 (1~8). 그룹장이 아니면 0 — assets/js/camp.js 참고. */
export function myLeaderTeam() { return leaderTeam(currentUser()); }

/**
 * 서버에 지금 내 권한을 다시 물어봅니다.
 * 권한에 따라 보이는 것이 달라지는 화면은 그리기 전에 한 번 부릅니다.
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

/** 서버에 Google OAuth 환경변수가 설정돼 있는지. */
export function isGoogleEnabled() { return Boolean(store?.googleEnabled); }

/** 신규 Google 로그인 가입 정책('approval' | 'allowlist' | 'open'). */
export function signupPolicy() { return store?.signupPolicy || 'approval'; }

/**
 * 서버 없이 브라우저에서만 흉내내는 인증인지.
 * true 면 화면에 "시연용" 이라고 알려 줍니다 — 진짜 보호가 아니기 때문입니다.
 */
export function isSimulated() { return Boolean(store?.auth?.simulated); }

/** 로그인 상태가 바뀌면 헤더 등 화면 곳곳이 함께 갱신되도록 알립니다. */
export function announceAuthChange() {
  window.dispatchEvent(new CustomEvent('ah:auth'));
}

/** Google OAuth 시작 URL. */
export function googleLoginUrl(next = '/') {
  if (typeof store?.auth?.googleLoginUrl === 'function') {
    return store.auth.googleLoginUrl(next);
  }
  return '#/login';
}

/** 시연용 모드(브라우저 저장)에서만 쓰는 데모 로그인. */
export async function demoLogin(payload) {
  const me = await store.auth.demoLogin(payload);
  announceAuthChange();
  return me;
}

export async function getOnboardInfo() {
  return store.auth.getOnboardInfo();
}

export async function submitOnboard(payload) {
  return store.auth.submitOnboard(payload);
}

export async function completeProfile(payload) {
  const me = await store.auth.completeProfile(payload);
  announceAuthChange();
  return me;
}

export async function requestAccountLink(legacyEmail) {
  const me = await store.auth.requestAccountLink(legacyEmail);
  announceAuthChange();
  return me;
}

export async function inviteMembers(members) {
  return store.auth.inviteMembers(members);
}

export async function logout() {
  await store.auth.logout();
  announceAuthChange();
}

/** 세션이 서버에서 끊겼는지 다시 확인합니다(다른 기기에서 정지 처리 등). */
export function refreshSession() {
  return store?.auth?.refresh?.() ?? Promise.resolve(null);
}
