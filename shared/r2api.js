/**
 * Assignment Hub — R2 저장소 + 회원 API
 * ---------------------------------------------------------------------------
 * Cloudflare Pages Functions 와 독립 Worker 가 함께 쓰는 핸들러입니다.
 * 브라우저는 이 API 만 호출하고, R2 버킷은 서버(바인딩)에서만 접근합니다.
 *
 * 인증은 서버에서 처리합니다. 비밀번호 해시가 담긴 회원 명부(data/members.json)는
 * 어떤 경로로도 브라우저에 내려가지 않고, 세션은 HttpOnly 쿠키로만 오갑니다.
 *
 * 제출물은 **서버가 소유**합니다. 브라우저가 색인 전체를 덮어쓸 수 없고,
 * 본인 제출물만 고치거나 지울 수 있습니다(관리자는 전부).
 *
 * 바인딩 / 환경변수
 *   BUCKET                 (필수) R2 버킷 바인딩
 *   GOOGLE_CLIENT_ID       (필수) Google OAuth 2.0 클라이언트 ID
 *   GOOGLE_CLIENT_SECRET   (필수) Google OAuth 2.0 클라이언트 보안 비밀번호
 *   ADMIN_EMAILS           (권장) 관리자 Google 이메일. 쉼표 구분. 미설정 시 아래 기본값
 *   SIGNUP_POLICY          (선택) 'approval'(기본·관리자 승인) | 'allowlist'(사전등록만) | 'open'
 *   ALLOWED_EMAIL_DOMAINS  (선택) 자동 승인할 이메일 도메인. 쉼표 구분 (예: mois.go.kr,korea.kr)
 *   ALLOWED_ORIGINS        (선택) 쉼표 구분. 비우면 같은 오리진만 허용
 *   MAX_UPLOAD_MB          (선택) 기본 100
 *   ALLOWED_EXT            (선택) 쉼표 구분
 *   TOKEN_SECRET           (권장) 세션·OAuth 서명 키. 없으면 R2 에 자동 생성
 *   TELEGRAM_BOT_TOKEN       (선택) Hermes 알림용 봇 토큰 — shared/telegram.js
 *   TELEGRAM_CHAT_ID         (선택) 알림을 받을 채팅 ID
 *   TELEGRAM_WEBHOOK_SECRET  (선택) 텔레그램 웹훅 검증용 시크릿
 *
 * 경로 (basePath 기본 '/api')
 *   GET    /health
 *   GET    /auth/google/start       Google OAuth 시작 (PKCE + state + nonce)
 *   GET    /auth/google/callback    Google OAuth 콜백 · 세션 발급
 *   POST   /auth/logout             로그아웃 (서버 세션 세대 무효화 + 쿠키 삭제)
 *   GET    /auth/me                 현재 세션 회원 정보
 *   POST   /auth/profile            최초 로그인 시 성명·기관명 등록
 *   GET    /auth/members            (관리자) 회원 목록
 *   POST   /auth/members/invite     (관리자) 교육생 이메일 사전 등록 (일괄 지원)
 *   PATCH  /auth/members            (관리자) 역할·조·상태(승인/정지)·이름/기관 변경
 *   DELETE /auth/members            (관리자) 정지 또는 승인 대기 회원 삭제
 *   POST   /telegram/webhook        (텔레그램) 가입 승인/거절 버튼 콜백 — Hermes
 *   GET    /data/projects|materials (로그인)   PUT (관리자)
 *   GET    /data/roster|attendance  (관리자)   PUT (관리자) — 수강 현황
 *   GET    /submissions             (로그인, 권한에 따라 필터)
 *   POST   /submissions             (로그인) — 마감 뒤에는 관리자만(late 표시).
 *                                   관리자는 authorEmail 로 다른 회원 이름으로 등록
 *   PATCH  /submissions/:id         (본인·관리자)
 *   DELETE /submissions/:id         (본인·관리자)
 *   POST   /upload                  (로그인)
 *   GET    /posts                   (로그인) 소통방 목록 — 공지가 맨 위
 *   POST   /posts                   (로그인) 글쓰기
 *   PATCH  /posts/:id               (본인 또는 관리자) — pinned 는 관리자만
 *   DELETE /posts/:id               (본인 또는 관리자)
 *   POST   /posts/:id/comments      (로그인) 댓글
 *   DELETE /posts/:id/comments/:cid (본인 또는 관리자)
 *   GET    /votes?projectId=…       (로그인) 상호 투표 집계 + 내가 넣은 표
 *   POST   /votes                   (로그인) 표 넣기·빼기
 *   POST   /presentation            (그룹장·관리자) 발표 과제 선정 — 조마다 하나
 *   GET    /scores?projectId=…      (로그인) 발표 평가 집계 + 내가 준 점수
 *   POST   /scores                  (로그인) 세 문항 점수 주기 (덮어쓰기)
 *   GET    /scores/rows?projectId=… (관리자) 누가 몇 점을 줬는지 원자료
 *   GET    /draw?projectId=…        (로그인) 발표 순서 + 조별 선정 진행 상황
 *   POST   /draw                    (관리자) 발표 순서 추첨 — 선정이 다 끝난 뒤
 *   GET    /file/<key>              (로그인)
 *   DELETE /file/<key>              (관리자)
 */
import {
  SESSION_COOKIE, SESSION_TTL_MS,
  signSession, readSession, cookieValue, sessionCookie, clearCookie,
  readMembers, updateMembers, findMember, findMemberByGoogleSub, publicMember,
  epochOf, bumpEpoch, normEmail, signupPolicyOf, isDomainAllowed,
  validateProfile, isValidEmail, mergeLegacyAccount,
} from './auth.js';
import {
  OAUTH_COOKIE, ONBOARD_COOKIE, googleConfigured, sanitizeNext,
  oauthCookie, clearOAuthCookie, onboardCookie, clearOnboardCookie,
  createOnboardToken, readOnboardToken,
  createOAuthChallenge, verifyOAuthChallenge,
  buildGoogleAuthUrl, exchangeGoogleCode,
} from './google.js';
import {
  notifySignup, notifySubmission, notifyApprovalRequest, notifyLinkRequest, handleTelegramWebhook,
} from './telegram.js';
import { handleFesta, FestaError, reply as festaReply } from './festa.js';
import { handleJury } from './festa-jury.js';
import { handleRehearsal } from './festa-rehearsal.js';
import { handleAwards } from './festa-awards.js';
import {
  normTeam, isCamp, normRole, leaderTeam, isNominee,
  presentationOf, presentationPhase, summarizeScores, normScore, scoreBlock, myTeamIn,
  nominateBlock, applyNominate, TEAM_MAX,
  nomineeProgress, drawBlock, shuffle, drawOf, drawStale,
} from './camp.js';

/** 이 이메일로 가입하면 자동으로 관리자 권한이 붙습니다. */
const DEFAULT_ADMIN_EMAILS = ['aireader@mois.go.kr'];

const DATA_NAMES = new Set(['projects', 'materials', 'roster', 'attendance']);

/**
 * 수강 현황(전체 명단·회차별 출결)은 교육생 전원의 이름과 소속이 한자리에 모인
 * 자료라 관리자만 **읽을** 수 있습니다. 프로젝트·강의자료는 회원이면 읽습니다.
 */
const ADMIN_READ_NAMES = new Set(['roster', 'attendance']);

const DEFAULT_EXT = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic',
  'mp4', 'webm', 'mov', 'm4v',
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'hwp', 'hwpx',
  'zip', 'txt', 'md', 'csv',
];

/**
 * 브라우저에서 바로 열어도 안전한 타입만 인라인으로 내보냅니다.
 * 나머지는 첨부(다운로드)로 강제합니다 — 같은 오리진에서 임의의 HTML/SVG 가
 * 실행되면 세션 쿠키를 노린 공격에 쓰일 수 있기 때문입니다.
 */
const SAFE_INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
]);

export async function handleApi(request, env, { basePath = '/api', waitUntil, googleEndpoints } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length) || '/'
    : url.pathname;

  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, url, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!originAllowed(origin, url, env)) {
    return json({ message: '허용되지 않은 출처입니다.' }, 403, cors);
  }
  // 상태 변경 요청의 교차 출처(CSRF) 방어. 텔레그램 웹훅은 서버 간 호출이라 제외합니다.
  if (path !== '/telegram/webhook' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const fetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
    if (fetchSite === 'cross-site' && !originList(env).includes(origin)) {
      return json({ message: '허용되지 않은 출처입니다.' }, 403, cors);
    }
  }
  if (!env.BUCKET) {
    return json({ message: 'R2 버킷 바인딩(BUCKET)이 설정되지 않았습니다.' }, 500, cors);
  }

  try {
    return await route(request, env, url, path, cors, waitUntil, basePath, googleEndpoints);
  } catch (e) {
    if (e instanceof FestaError) return festaReply({ message: e.message }, e.status, cors);
    return json({ message: `서버 오류: ${e.message}` }, 500, cors);
  }
}

async function route(request, env, url, path, cors, waitUntil, basePath, googleEndpoints) {
  const method = request.method;
  const noStore = { ...cors, 'Cache-Control': 'no-store' };

  if (path === '/health' && method === 'GET') {
    const me = await currentMember(request, env);
    return json({
      ok: true,
      mode: 'r2',
      members: true,
      authMode: 'google',
      googleEnabled: googleConfigured(env),
      signupPolicy: signupPolicyOf(env),
      maxUploadMB: maxUploadMB(env),
      signedIn: Boolean(me),
      me: publicMember(me),
    }, 200, noStore);
  }

  /* ------------------------------------------------------------ 인증 -- */

  if (path === '/auth/google/start' && method === 'GET') {
    return googleStart(request, env, url, basePath, googleEndpoints);
  }
  if (path === '/auth/google/callback' && method === 'GET') {
    return googleCallback(request, env, url, basePath, waitUntil, googleEndpoints);
  }
  if (path === '/auth/onboard' && method === 'GET') {
    return getOnboardInfo(request, env, noStore);
  }
  if (path === '/auth/onboard' && method === 'POST') {
    return submitOnboard(request, env, url, basePath, noStore, waitUntil);
  }
  if (path === '/auth/logout' && method === 'POST') {
    return logout(request, env, url, noStore);
  }
  if (path === '/auth/me' && method === 'GET') {
    const me = await currentMember(request, env);
    if (!me) return json({ message: '로그인이 필요합니다.' }, 401, noStore);
    return json({ me: publicMember(me) }, 200, noStore);
  }
  if (path === '/auth/profile' && method === 'POST') {
    return completeProfile(request, env, noStore, waitUntil);
  }
  if (path === '/auth/link-request' && method === 'POST') {
    return requestAccountLink(request, env, noStore, waitUntil);
  }

  // 기존 비밀번호 기반 인증 경로는 보안상 완전히 비활성화합니다.
  if (
    path === '/auth/signup' || path === '/auth/login' || path === '/auth/password'
    || path === '/auth/forgot' || path === '/auth/reset/confirm' || path === '/auth/members/reset'
  ) {
    return json(
      { message: '이 사이트는 Google 로그인 전용입니다. Google 계정으로 로그인해 주세요.' },
      410,
      noStore,
    );
  }

  if (path === '/auth/members') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return json({ message: admin.error }, admin.status, noStore);
    if (method === 'GET') {
      const { list } = await readMembers(env);
      return json({ data: list.map(publicMember) }, 200, noStore);
    }
    if (method === 'PATCH') return patchMember(request, env, admin.member, noStore);
    if (method === 'DELETE') return removeMember(request, env, admin.member, noStore);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, noStore);
  }
  if (path === '/auth/members/invite' && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return json({ message: admin.error }, admin.status, noStore);
    return inviteMembers(request, env, noStore);
  }
  if (path === '/auth/members/link' && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return json({ message: admin.error }, admin.status, noStore);
    return handleMemberLink(request, env, noStore);
  }

  /* --------------------------------------------------------- 텔레그램 -- */
  // 텔레그램 서버가 직접 호출합니다(로그인 세션 없음) — 웹훅 시크릿으로 인증합니다.
  if (path === '/telegram/webhook' && method === 'POST') {
    return handleTelegramWebhook(request, env);
  }

  /* ------------------------------------------- 프로젝트 · 강의자료 색인 -- */

  const dataMatch = path.match(/^\/data\/([a-z]+)$/);
  if (dataMatch) {
    const name = dataMatch[1];
    if (!DATA_NAMES.has(name)) return json({ message: '알 수 없는 데이터입니다.' }, 404, cors);

    if (method === 'GET') {
      if (ADMIN_READ_NAMES.has(name)) {
        const admin = await requireAdmin(request, env);
        if (admin.error) return json({ message: admin.error }, admin.status, cors);
      } else {
        const me = await currentMember(request, env);
        if (!me) return json({ message: '로그인이 필요합니다.' }, 401, cors);
      }
      const { etag, data } = await readIndex(env, name);
      return json({ etag, data }, 200, { ...cors, 'Cache-Control': 'no-store' });
    }
    if (method === 'PUT') {
      const admin = await requireAdmin(request, env);
      if (admin.error) return json({ message: admin.error }, admin.status, cors);
      return writeIndexRequest(request, env, name, cors);
    }
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }

  /* ------------------------------------------------------------ 제출물 -- */

  if (path === '/submissions') {
    if (method === 'GET') return listSubmissions(request, env, cors);
    if (method === 'POST') return createSubmission(request, env, cors, waitUntil);
    if (method === 'PUT') {
      const admin = await requireAdmin(request, env);
      if (admin.error) return json({ message: admin.error }, admin.status, cors);
      return restoreSubmissions(request, env, cors);
    }
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }
  const subMatch = path.match(/^\/submissions\/([A-Za-z0-9_-]{1,64})$/);
  if (subMatch) {
    if (method === 'PATCH') return patchSubmission(request, env, subMatch[1], cors);
    if (method === 'DELETE') return removeSubmission(request, env, subMatch[1], cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }

  /* ------------------------------------------------------------ 소통방 -- */

  if (path === '/posts') {
    if (method === 'GET') return listPosts(request, env, cors);
    if (method === 'POST') return createPost(request, env, cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }
  const postMatch = path.match(/^\/posts\/([A-Za-z0-9_-]{1,64})$/);
  if (postMatch) {
    if (method === 'PATCH') return patchPost(request, env, postMatch[1], cors);
    if (method === 'DELETE') return removePost(request, env, postMatch[1], cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }
  const commentMatch = path.match(/^\/posts\/([A-Za-z0-9_-]{1,64})\/comments$/);
  if (commentMatch && method === 'POST') {
    return createComment(request, env, commentMatch[1], cors);
  }
  const oneComment = path.match(/^\/posts\/([A-Za-z0-9_-]{1,64})\/comments\/([A-Za-z0-9_-]{1,64})$/);
  if (oneComment && method === 'DELETE') {
    return removeComment(request, env, oneComment[1], oneComment[2], cors);
  }

  /* -------------------------------------------------------------- 투표 -- */

  if (path === '/votes') {
    if (method === 'GET') return voteSummaryRequest(request, env, url, cors);
    if (method === 'POST') return castVote(request, env, cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }

  /* --------------------------------------------------------- 발표 평가 -- */

  if (path === '/presentation' && method === 'POST') {
    return nominatePresentation(request, env, cors);
  }
  if (path === '/scores') {
    if (method === 'GET') return scoreSummaryRequest(request, env, url, cors);
    if (method === 'POST') return castScore(request, env, cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }
  if (path === '/scores/rows' && method === 'GET') return listScores(request, env, url, cors);

  if (path === '/draw') {
    if (method === 'GET') return drawRequest(request, env, url, cors);
    if (method === 'POST') return runDraw(request, env, cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }

  /* ------------------------------------------------------- 개인 페스타 -- */

  if (path === '/festa' || path.startsWith('/festa/')) {
    const context = { path, member: await currentMember(request, env), cors };
    if (path.startsWith('/festa/rehearsal/')) return handleRehearsal(request, env, context);
    if (path.startsWith('/festa/jury/')) return handleJury(request, env, context);
    if (path === '/festa/awards' || path.startsWith('/festa/awards/')) return handleAwards(request, env, context);
    return handleFesta(request, env, context);
  }

  /* ------------------------------------------------------- 파일 -- */

  if (path === '/upload' && method === 'POST') return upload(request, env, url, cors);

  if (path.startsWith('/file/')) {
    const key = decodeURIComponent(path.slice('/file/'.length));
    if (method === 'GET') {
      const me = await currentMember(request, env);
      if (!me) return json({ message: '로그인이 필요합니다.' }, 401, cors);
      return serveFile(env, key, url, cors);
    }
    if (method === 'DELETE') {
      const admin = await requireAdmin(request, env);
      if (admin.error) return json({ message: admin.error }, admin.status, cors);
      return deleteFile(env, key, cors);
    }
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }

  return json({ message: 'Not found' }, 404, cors);
}

/* ====================================================== 세션 · 권한 == */

function adminEmails(env) {
  const raw = String(env?.ADMIN_EMAILS || '').trim();
  const list = raw ? raw.split(',') : DEFAULT_ADMIN_EMAILS;
  return new Set(list.map((s) => normEmail(s)).filter(Boolean));
}

/**
 * 관리자 이메일 목록에 있으면 저장된 역할과 무관하게 관리자로 봅니다.
 * 그 밖에는 저장된 역할(회원·그룹장·관리자)을 그대로 씁니다 — shared/camp.js.
 */
function withRole(member, env) {
  if (!member) return null;
  const role = adminEmails(env).has(normEmail(member.email))
    ? 'admin'
    : normRole(member.role);
  return { ...member, role, team: normTeam(member.team) };
}

export async function currentMember(request, env) {
  const token = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  const payload = await readSession(token, env);
  if (!payload) return null;

  const { list } = await readMembers(env);
  const member = findMember(list, payload.sub);
  if (!member) return null;
  if ((member.status || 'active') !== 'active') return null;
  // 비밀번호가 바뀌었거나 관리자가 정지시킨 뒤 발급 전이라면, 남은 토큰은 못 씁니다.
  if (Number(payload.ep || 0) !== epochOf(member)) return null;
  return withRole(member, env);
}

async function requireMember(request, env) {
  const member = await currentMember(request, env);
  if (!member) return { error: '로그인이 필요합니다.', status: 401 };
  return { member };
}

async function requireAdmin(request, env) {
  const got = await requireMember(request, env);
  if (got.error) return got;
  if (got.member.role !== 'admin') return { error: '관리자만 할 수 있습니다.', status: 403 };
  return got;
}

/* ========================================================= 회원 처리 == */

function redirectWithCookies(location, cookies = []) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  for (const c of cookies) {
    if (c) headers.append('Set-Cookie', c);
  }
  return new Response(null, { status: 302, headers });
}

function loginErrorRedirect(url, code, cookies = []) {
  return redirectWithCookies(`${url.origin}/#/login?error=${encodeURIComponent(code)}`, cookies);
}

/** Google OAuth 2.0 시작: PKCE · state · nonce 쿠키를 발급하고 Google 로 보냅니다. */
async function googleStart(request, env, url, basePath, googleEndpoints) {
  if (!googleConfigured(env)) {
    return loginErrorRedirect(url, 'not_configured');
  }

  const next = sanitizeNext(url.searchParams.get('next'));
  const challenge = await createOAuthChallenge(next, env);
  const redirectUri = `${url.origin}${String(basePath || '').replace(/\/$/, '')}/auth/google/callback`;
  const authUrl = buildGoogleAuthUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri,
    state: challenge.state,
    codeChallenge: challenge.codeChallenge,
    nonce: challenge.nonce,
    ...(googleEndpoints?.authUrl ? { authUrl: googleEndpoints.authUrl } : {}),
  });

  return redirectWithCookies(authUrl, [oauthCookie(challenge.cookieToken, url, basePath)]);
}

/** Google OAuth 2.0 콜백: 토큰 교환·검증 후 회원 상태에 따라 세션을 발급합니다. */
async function googleCallback(request, env, url, basePath, waitUntil, googleEndpoints) {
  const clearState = clearOAuthCookie(url, basePath);
  if (!googleConfigured(env)) {
    return loginErrorRedirect(url, 'not_configured', [clearState]);
  }

  const errParam = url.searchParams.get('error');
  if (errParam) {
    return loginErrorRedirect(url, errParam === 'access_denied' ? 'cancelled' : 'oauth_failed', [clearState]);
  }

  const code = String(url.searchParams.get('code') || '');
  const state = String(url.searchParams.get('state') || '');
  const stateToken = cookieValue(request.headers.get('Cookie'), OAUTH_COOKIE);
  const verified = await verifyOAuthChallenge(stateToken, state, env);
  if (!code || !verified) {
    return loginErrorRedirect(url, 'invalid_state', [clearState]);
  }

  const redirectUri = `${url.origin}${String(basePath || '').replace(/\/$/, '')}/auth/google/callback`;
  const exchanged = await exchangeGoogleCode({
    code,
    codeVerifier: verified.codeVerifier,
    redirectUri,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    expectedNonce: verified.nonce,
    ...(googleEndpoints?.tokenUrl ? { tokenUrl: googleEndpoints.tokenUrl } : {}),
  });

  if (!exchanged.ok) {
    return loginErrorRedirect(url, exchanged.error || 'oauth_failed', [clearState]);
  }

  const { sub, email, name } = exchanged.profile;
  const isAdminEmail = adminEmails(env).has(email);
  const domainAllowed = isDomainAllowed(email, env);
  const policy = signupPolicyOf(env);
  const now = new Date().toISOString();

  let outcome = null; // 'active' | 'onboard' | 'pending' | 'blocked' | 'not_invited' | 'google_mismatch'
  let memberRecord = null;
  let newlyCreatedActive = false;

  await updateMembers(env, (list) => {
    const bySub = findMemberByGoogleSub(list, sub);
    const byEmail = findMember(list, email);

    // 같은 이메일 계정이 이미 다른 Google sub 에 묶여 있으면 탈취 위험으로 거부합니다.
    if (byEmail && byEmail.googleSub && byEmail.googleSub !== sub) {
      outcome = 'google_mismatch';
      return null;
    }

    const existing = bySub || byEmail;
    if (existing) {
      // Google 계정 이메일이 바뀐 경우에도 다른 회원과 겹치지 않으면 최신 이메일로 맞춥니다.
      if (bySub && normEmail(bySub.email) !== email && byEmail && byEmail !== bySub) {
        outcome = 'google_mismatch';
        return null;
      }

      const status = existing.status || 'active';
      if (status === 'blocked') {
        outcome = 'blocked';
        return null;
      }
      if (status === 'pending' && !isAdminEmail && !domainAllowed) {
        existing.googleSub = sub;
        existing.authProvider = 'google';
        if (!existing.name && name) existing.name = name;
        existing.updatedAt = now;
        memberRecord = existing;
        // 소속·성명을 아직 입력하지 않은 대기 회원은 온보딩 입력 화면으로 보냅니다.
        outcome = (!String(existing.institution || '').trim() || !String(existing.name || '').trim())
          ? 'onboard' : 'pending';
        return list;
      }

      // 기존 active 회원(또는 사전 등록 회원, 레거시 마이그레이션 회원)을 Google 에 연결합니다.
      existing.email = email;
      existing.googleSub = sub;
      existing.authProvider = 'google';
      if (isAdminEmail) existing.role = 'admin';
      existing.status = 'active';
      if (!String(existing.name || '').trim() && name) existing.name = name;
      existing.lastLoginAt = now;
      existing.updatedAt = now;
      // 더 이상 쓰지 않는 예전 비밀번호·초기화 필드를 정리합니다.
      delete existing.passwordHash;
      delete existing.mustChangePassword;
      delete existing.tempPasswordUntil;
      delete existing.resetTokenHash;
      delete existing.resetTokenExpiresAt;
      delete existing.resetRequestedAt;
      delete existing.failedAttempts;
      delete existing.lockedUntil;
      memberRecord = existing;
      outcome = 'active';
      return list;
    }

    // 신규 Google 사용자
    if (isAdminEmail || domainAllowed || policy === 'open') {
      const created = {
        email,
        name: name || '',
        institution: '',
        googleSub: sub,
        authProvider: 'google',
        role: isAdminEmail ? 'admin' : 'member',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      };
      list.push(created);
      memberRecord = created;
      newlyCreatedActive = true;
      outcome = 'active';
      return list;
    }

    if (policy === 'approval') {
      // 바로 빈 대기 계정을 만들지 않고, 소속·성명·기존 이메일 입력 화면(#/onboard)으로 보냅니다.
      outcome = 'onboard';
      return null;
    }

    outcome = 'not_invited';
    return null;
  });

  if (outcome === 'onboard') {
    const obToken = await createOnboardToken({ sub, email, name }, env);
    return redirectWithCookies(`${url.origin}/#/onboard`, [
      clearState,
      onboardCookie(obToken, url, basePath),
    ]);
  }

  if (outcome !== 'active' || !memberRecord) {
    return loginErrorRedirect(url, outcome || 'oauth_failed', [clearState]);
  }

  if (newlyCreatedActive) {
    notifySignup(env, waitUntil, memberRecord);
  }

  const withRoles = withRole(memberRecord, env);
  const token = await issueToken(withRoles, env);
  const pub = publicMember(withRoles);

  const target = pub.needsProfile
    ? `${url.origin}/#/account?setup=1${verified.next !== '/' ? `&next=${encodeURIComponent(verified.next)}` : ''}`
    : `${url.origin}/#${verified.next}`;

  return redirectWithCookies(target, [clearState, sessionCookie(token, url)]);
}

function issueToken(member, env) {
  return signSession({
    sub: normEmail(member.email),
    role: member.role || 'member',
    ep: epochOf(member),
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  }, env);
}

/** 로그아웃: 쿠키를 비우고 서버 세션 세대도 올려 탈취된 쿠키를 즉시 무효화합니다. */
async function logout(request, env, url, cors) {
  const me = await currentMember(request, env);
  if (me) {
    await updateMembers(env, (list) => {
      const m = findMember(list, me.email);
      if (!m) return null;
      bumpEpoch(m);
      m.updatedAt = new Date().toISOString();
      return list;
    });
  }
  return json({ ok: true }, 200, { ...cors, 'Set-Cookie': clearCookie(url) });
}

/** 승인 대기 온보딩 쿠키에서 본인 Google 이메일·기본 이름을 돌려줍니다. */
async function getOnboardInfo(request, env, cors) {
  const token = cookieValue(request.headers.get('Cookie'), ONBOARD_COOKIE);
  const info = await readOnboardToken(token, env);
  if (!info) return json({ message: '온보딩 요청이 만료되었습니다. Google 로그인을 다시 진행해 주세요.' }, 401, cors);
  return json({ email: info.email, name: info.name }, 200, cors);
}

/**
 * 신규 Google 사용자의 가입 승인 요청 접수 (소속 · 성명 · 선택적 기존 계정 이메일).
 * 서명된 ah_onboard 쿠키가 있어야만 호출할 수 있고, 세션은 발급하지 않습니다.
 */
async function submitOnboard(request, env, url, basePath, cors, waitUntil) {
  const token = cookieValue(request.headers.get('Cookie'), ONBOARD_COOKIE);
  const info = await readOnboardToken(token, env);
  if (!info) return json({ message: '온보딩 요청이 만료되었습니다. Google 로그인을 다시 진행해 주세요.' }, 401, cors);

  const body = await request.json().catch(() => null);
  if (!body) return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);

  const errors = validateProfile(body);
  const rawLegacy = String(body.legacyEmail || '').trim();
  const legacyEmail = rawLegacy ? normEmail(rawLegacy) : '';
  if (legacyEmail) {
    if (!isValidEmail(legacyEmail)) errors.legacyEmail = '올바른 기존 이메일 주소를 입력하세요.';
    else if (legacyEmail === info.email) errors.legacyEmail = '현재 Google 이메일과 다른 기존 이메일을 입력하세요.';
  }
  if (Object.keys(errors).length) {
    return json({ message: '입력을 확인하세요.', errors }, 400, cors);
  }

  const name = String(body.name).trim().slice(0, 60);
  const institution = String(body.institution).trim().slice(0, 80);
  const now = new Date().toISOString();
  let saved = null;
  let blocked = false;
  let alreadyActive = false;

  await updateMembers(env, (list) => {
    const existing = findMemberByGoogleSub(list, info.sub) || findMember(list, info.email);
    if (existing) {
      if ((existing.status || 'active') === 'blocked') { blocked = true; return null; }
      if ((existing.status || 'active') === 'active') { alreadyActive = true; return null; }
      existing.name = name;
      existing.institution = institution;
      existing.googleSub = info.sub;
      existing.authProvider = 'google';
      existing.linkRequestedEmail = legacyEmail || null;
      existing.updatedAt = now;
      saved = existing;
      return list;
    }
    const created = {
      email: info.email,
      name,
      institution,
      googleSub: info.sub,
      authProvider: 'google',
      role: 'member',
      status: 'pending',
      linkRequestedEmail: legacyEmail || null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    list.push(created);
    saved = created;
    return list;
  });

  const clearOb = clearOnboardCookie(url, basePath);
  if (blocked) {
    return json({ message: '이용이 정지된 계정입니다. 관리자에게 문의하세요.' }, 403, { ...cors, 'Set-Cookie': clearOb });
  }
  if (alreadyActive) {
    return json({ ok: true, status: 'active' }, 200, { ...cors, 'Set-Cookie': clearOb });
  }
  if (saved) notifyApprovalRequest(env, waitUntil, saved);
  return json({ ok: true, status: 'pending' }, 200, { ...cors, 'Set-Cookie': clearOb });
}

/**
 * 최초 Google 로그인 후 성명·소속(기관명) 등록 + 선택적 기존 계정 연계 신청 (본인).
 */
async function completeProfile(request, env, cors, waitUntil) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const body = await request.json().catch(() => null);
  if (!body) return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);

  const errors = validateProfile(body);
  const rawLegacy = String(body.legacyEmail || '').trim();
  const legacyEmail = rawLegacy ? normEmail(rawLegacy) : '';
  if (legacyEmail) {
    if (!isValidEmail(legacyEmail)) errors.legacyEmail = '올바른 기존 이메일 주소를 입력하세요.';
    else if (legacyEmail === normEmail(got.member.email)) {
      errors.legacyEmail = '현재 Google 이메일과 다른 기존 이메일을 입력하세요.';
    }
  }
  if (Object.keys(errors).length) {
    return json({ message: '성명과 소속(기관명)을 모두 입력하세요.', errors }, 400, cors);
  }

  const name = String(body.name).trim().slice(0, 60);
  const institution = String(body.institution).trim().slice(0, 80);

  let updated = null;
  let alreadyComplete = false;
  let newLinkRequested = false;
  await updateMembers(env, (list) => {
    const m = findMember(list, got.member.email);
    if (!m) return null;
    if (String(m.name || '').trim() && String(m.institution || '').trim()) {
      alreadyComplete = true;
      return null;
    }
    m.name = name;
    m.institution = institution;
    if (legacyEmail) {
      m.linkRequestedEmail = legacyEmail;
      newLinkRequested = true;
    }
    m.updatedAt = new Date().toISOString();
    updated = m;
    return list;
  });

  if (alreadyComplete) {
    return json({ message: '이미 프로필이 등록되어 있습니다. 변경이 필요하면 담당자에게 문의하세요.' }, 409, cors);
  }
  if (!updated) return json({ message: '회원 정보를 찾을 수 없습니다.' }, 404, cors);

  if (newLinkRequested) notifyLinkRequest(env, waitUntil, updated);
  return json({ me: publicMember(withRole(updated, env)) }, 200, cors);
}

/**
 * 이미 로그인한 회원의 기존 비-구글 계정 연계 신청 또는 취소 (본인).
 * 실제 병합은 관리자가 확인 후 승인해야 실행됩니다.
 */
async function requestAccountLink(request, env, cors, waitUntil) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const body = await request.json().catch(() => null);
  const raw = String(body?.legacyEmail || '').trim();
  const legacyEmail = raw ? normEmail(raw) : '';

  if (legacyEmail) {
    if (!isValidEmail(legacyEmail)) {
      return json({ message: '올바른 기존 이메일 주소를 입력하세요.' }, 400, cors);
    }
    if (legacyEmail === normEmail(got.member.email)) {
      return json({ message: '현재 Google 이메일과 다른 기존 이메일을 입력하세요.' }, 400, cors);
    }
  }

  let updated = null;
  await updateMembers(env, (list) => {
    const m = findMember(list, got.member.email);
    if (!m) return null;
    m.linkRequestedEmail = legacyEmail || null;
    m.updatedAt = new Date().toISOString();
    updated = m;
    return list;
  });

  if (!updated) return json({ message: '회원 정보를 찾을 수 없습니다.' }, 404, cors);
  if (legacyEmail) notifyLinkRequest(env, waitUntil, updated);
  return json({ me: publicMember(withRole(updated, env)) }, 200, cors);
}

/**
 * 기존 비-구글 계정 연계 승인 또는 거절 (관리자).
 */
async function handleMemberLink(request, env, cors) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);
  const action = String(body?.action || 'approve');
  if (!email) return json({ message: '대상 Google 이메일이 필요합니다.' }, 400, cors);

  const { list } = await readMembers(env);
  const target = findMember(list, email);
  if (!target) return json({ message: '대상 회원을 찾을 수 없습니다.' }, 404, cors);

  if (action === 'reject') {
    let updated = null;
    await updateMembers(env, (l) => {
      const m = findMember(l, email);
      if (!m) return null;
      m.linkRequestedEmail = null;
      m.updatedAt = new Date().toISOString();
      updated = m;
      return l;
    });
    return json({ ok: true, member: publicMember(withRole(updated, env)) }, 200, cors);
  }

  const legacyEmail = normEmail(body?.legacyEmail || target.linkRequestedEmail || '');
  if (!legacyEmail) return json({ message: '연계할 기존 이메일이 없습니다.' }, 400, cors);

  const merged = await mergeLegacyAccount(env, { googleEmail: email, legacyEmail });
  if (!merged.ok) return json({ message: merged.message }, merged.status || 400, cors);

  return json({
    ok: true,
    member: publicMember(withRole(merged.member, env)),
    migrated: merged.migrated,
  }, 200, cors);
}

/**
 * 교육생 이메일 사전 등록 (관리자).
 * 미리 등록해 두면 해당 Google 계정으로 로그인할 때 승인 대기 없이 바로 이용합니다.
 * 이미 pending 상태인 이메일을 등록하면 즉시 승인(active)으로 전환합니다.
 */
async function inviteMembers(request, env, cors) {
  const body = await request.json().catch(() => null);
  const rawList = Array.isArray(body?.members) ? body.members : [];
  if (!rawList.length) return json({ message: '등록할 이메일을 입력하세요.' }, 400, cors);
  if (rawList.length > 500) return json({ message: '한 번에 최대 500명까지 등록할 수 있습니다.' }, 400, cors);

  const cleaned = [];
  const seen = new Set();
  for (const item of rawList) {
    const email = normEmail(typeof item === 'string' ? item : item?.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    const name = typeof item === 'object' ? String(item?.name || '').trim().slice(0, 60) : '';
    const institution = typeof item === 'object' ? String(item?.institution || '').trim().slice(0, 80) : '';
    const rawRole = typeof item === 'object' ? item?.role : 'member';
    const role = ['admin', 'member', 'leader'].includes(rawRole) ? rawRole : 'member';
    const team = role === 'leader' ? normTeam(item?.team) : 0;
    cleaned.push({ email, name, institution, role: (role === 'leader' && !team) ? 'member' : role, team });
  }

  if (!cleaned.length) {
    return json({ message: '올바른 이메일 주소가 없습니다.' }, 400, cors);
  }

  let added = 0;
  let activated = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  await updateMembers(env, (list) => {
    for (const item of cleaned) {
      const existing = findMember(list, item.email);
      if (existing) {
        let changed = false;
        if ((existing.status || 'active') === 'pending') {
          existing.status = 'active';
          bumpEpoch(existing);
          activated += 1;
          changed = true;
        } else {
          skipped += 1;
        }
        if (item.name && !String(existing.name || '').trim()) { existing.name = item.name; changed = true; }
        if (item.institution && !String(existing.institution || '').trim()) { existing.institution = item.institution; changed = true; }
        if (changed) existing.updatedAt = now;
        continue;
      }

      list.push({
        email: item.email,
        name: item.name,
        institution: item.institution,
        googleSub: null,
        authProvider: 'google',
        role: adminEmails(env).has(item.email) ? 'admin' : item.role,
        team: item.team,
        status: 'active',
        invitedAt: now,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      });
      added += 1;
    }
    return list;
  });

  return json({ ok: true, added, activated, skipped, total: cleaned.length }, 200, cors);
}

/**
 * 회원 권한·상태 바꾸기 (관리자).
 *
 * 권한은 **회원 · 그룹장 · 관리자** 셋입니다. 그룹장은 맡을 조가 있어야 뜻이
 * 있으므로 조(1~8)를 함께 받고, 그룹장을 내리면 조도 함께 비웁니다.
 * 그룹장이 하는 일은 shared/camp.js 의 canNominate 를 보세요.
 */
async function patchMember(request, env, admin, cors) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);
  if (!email) return json({ message: '대상 이메일이 필요합니다.' }, 400, cors);
  if (email === normEmail(admin.email)) {
    return json({ message: '자기 계정의 권한은 바꿀 수 없습니다.' }, 400, cors);
  }

  const wantsRole = ['admin', 'member', 'leader'].includes(body?.role) ? body.role : null;
  const wantsTeam = body?.team === undefined ? null : normTeam(body.team);
  if (body?.team !== undefined && !wantsTeam && Number(body.team) !== 0) {
    return json({ message: `조는 1조부터 ${TEAM_MAX}조까지입니다.` }, 400, cors);
  }

  let updated = null;
  const result = await updateMembers(env, (l) => {
    const m = findMember(l, email);
    if (!m) return null;
    if (wantsRole) {
      m.role = wantsRole;
      if (wantsRole !== 'leader') m.team = 0;
    }
    if (wantsTeam !== null) m.team = wantsTeam;
    // 조 없는 그룹장은 아무 조도 못 보는 빈 권한이라, 조가 없으면 회원으로 둡니다.
    if (normRole(m.role) === 'leader' && !normTeam(m.team)) m.role = 'member';
    if (normRole(m.role) !== 'leader') m.team = 0;

    if (body.status === 'active' || body.status === 'blocked' || body.status === 'pending') {
      // 상태를 바꾸면(정지·해제·승인) 예전 토큰이 되살아나지 않도록 세대를 올립니다.
      if (m.status !== body.status) bumpEpoch(m);
      m.status = body.status;
    }
    if (typeof body.name === 'string' && body.name.trim()) {
      m.name = body.name.trim().slice(0, 60);
    }
    if (typeof body.institution === 'string') {
      m.institution = body.institution.trim().slice(0, 80);
    }
    m.updatedAt = new Date().toISOString();
    updated = m;
    return l;
  });
  if (!result.ok) return json({ message: '해당 회원을 찾을 수 없습니다.' }, 404, cors);
  return json({ member: publicMember(withRole(updated, env)) }, 200, cors);
}

/**
 * 회원 삭제 (관리자).
 *
 * 실수로 지우는 사고를 막기 위해 **이용 정지(blocked) 또는 승인 대기(pending) 계정만**
 * 지울 수 있습니다. 자기 자신과 관리자 계정은 대상이 아닙니다 — 관리자를 지우려면
 * 먼저 권한을 해제하고 이용을 정지시켜야 합니다.
 *
 * 제출물은 기본적으로 남깁니다. `purgeSubmissions` 를 주면 제출물과 첨부 원본까지
 * 함께 지웁니다. 그 사람이 넣은 표·점수는 언제나 함께 지웁니다.
 */
async function removeMember(request, env, admin, cors) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);
  const purge = Boolean(body?.purgeSubmissions);
  if (!email) return json({ message: '대상 이메일이 필요합니다.' }, 400, cors);
  if (email === normEmail(admin.email)) {
    return json({ message: '자기 계정은 삭제할 수 없습니다.' }, 400, cors);
  }

  const { list } = await readMembers(env);
  const target = findMember(list, email);
  if (!target) return json({ message: '해당 회원을 찾을 수 없습니다.' }, 404, cors);
  if (withRole(target, env).role === 'admin') {
    return json({ message: '관리자 계정은 삭제할 수 없습니다. 관리자 권한을 먼저 해제하세요.' }, 400, cors);
  }
  const targetStatus = target.status || 'active';
  if (targetStatus !== 'blocked' && targetStatus !== 'pending') {
    return json({ message: '이용 정지 또는 승인 대기 중인 회원만 삭제할 수 있습니다. 먼저 이용을 정지하세요.' }, 400, cors);
  }

  const result = await updateMembers(env, (l) => (
    findMember(l, email) ? l.filter((m) => normEmail(m.email) !== email) : null
  ));
  if (!result.ok) return json({ message: '해당 회원을 찾을 수 없습니다.' }, 404, cors);

  let removedSubmissions = 0;
  if (purge) {
    const { data: subs } = await readIndex(env, 'submissions');
    const mine = subs.filter((s) => normEmail(s.author?.email) === email);
    removedSubmissions = mine.length;
    if (mine.length) {
      const ids = new Set(mine.map((s) => s.id));
      await mutateIndex(env, 'submissions', (l) => l.filter((s) => !ids.has(s.id)));
      for (const s of mine) {
        for (const f of s.files || []) {
          if (f.key) await env.BUCKET.delete(f.key).catch(() => {});
        }
      }
      // 사라진 제출물에 들어간 표·점수는 집계에 유령으로 남지 않도록 걷어냅니다.
      for (const name of ['votes', 'scores']) {
        await mutateIndex(env, name, (l) => {
          const kept = l.filter((v) => !ids.has(v.submissionId));
          return kept.length === l.length ? null : kept;
        });
      }
    }
  }

  // 계정이 없어졌으니 그 사람이 넣은 표·점수도 남겨둘 이유가 없습니다.
  for (const name of ['votes', 'scores']) {
    await mutateIndex(env, name, (l) => {
      const kept = l.filter((v) => normEmail(v.voter) !== email);
      return kept.length === l.length ? null : kept;
    });
  }

  return json({ ok: true, removedSubmissions }, 200, cors);
}

/* ====================================================== 색인 읽기/쓰기 == */

const dataKey = (name) => `data/${name}.json`;

async function readIndex(env, name) {
  const key = dataKey(name);
  let obj = await env.BUCKET.get(key);
  if (!obj) {
    await env.BUCKET.put(key, '[]', {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    obj = await env.BUCKET.get(key);
    if (!obj) return { etag: null, data: [] };
  }
  let data = [];
  try { data = JSON.parse(await obj.text()); } catch { data = []; }
  return { etag: obj.etag, data: Array.isArray(data) ? data : [] };
}

/** 서버 안에서 색인을 안전하게 갱신합니다(조건부 쓰기 + 재시도). */
async function mutateIndex(env, name, mutate) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { etag, data } = await readIndex(env, name);
    const next = mutate(structuredClone(data));
    if (next === null) return { ok: false, data };

    const opts = {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    };
    const put = await env.BUCKET.put(dataKey(name), JSON.stringify(next, null, 2), opts);
    if (put) return { ok: true, data: next };
    await new Promise((r) => setTimeout(r, 80 * (attempt + 1) + Math.random() * 120));
  }
  throw new Error('동시 수정이 겹쳐 저장하지 못했습니다. 잠시 후 다시 시도하세요.');
}

/** 관리자가 프로젝트·강의자료 색인을 통째로 저장할 때 (etag 조건부). */
async function writeIndexRequest(request, env, name, cors) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) {
    return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);
  }
  if (typeof body.etag !== 'string' || !body.etag) {
    return json({ message: 'etag 가 필요합니다. 먼저 GET 으로 읽으세요.' }, 428, cors);
  }

  const put = await env.BUCKET.put(dataKey(name), JSON.stringify(body.data, null, 2), {
    onlyIf: { etagMatches: body.etag },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  if (!put) {
    const { etag, data } = await readIndex(env, name);
    return json({ message: '동시 수정 충돌이 발생했습니다.', current: { etag, data } }, 409, cors);
  }

  // 프로젝트가 사라졌다면 그 프로젝트에 들어간 표·발표 점수도 갈 곳이 없습니다.
  if (name === 'projects') {
    const alive = new Set(body.data.map((p) => p?.id).filter(Boolean));
    for (const index of ['votes', 'scores', 'draws']) {
      await mutateIndex(env, index, (list) => {
        const kept = list.filter((v) => alive.has(v.projectId));
        return kept.length === list.length ? null : kept;
      });
    }
  }
  return json({ etag: put.etag }, 200, cors);
}

/* ========================================================= 제출물 == */

const uid = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 회원별 업로드 폴더 이름. 이메일에서 바로 유추되지 않도록 해시를 씁니다. */
async function memberKey(email) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normEmail(email)));
  return `m_${Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 다른 사람 몫으로 보이지 않도록 작성자 정보는 항상 서버가 채웁니다. */
function authorOf(member) {
  return { institution: member.institution || '', name: member.name, email: normEmail(member.email) };
}

/** 열람자에 따라 내보낼 필드를 줄입니다. */
function viewSubmission(sub, viewer) {
  const mine = normEmail(sub.author?.email) === normEmail(viewer.email);
  if (viewer.role === 'admin' || mine) return sub;
  return { ...sub, author: { ...sub.author, email: undefined } };
}

/**
 * 백업 복원 — 제출물 색인을 통째로 바꿉니다. 관리자만 할 수 있습니다.
 *
 * 평소 제출물은 서버가 소유해서 클라이언트가 색인을 통째로 쓰지 못하게 막지만,
 * 복원까지 막으면 백업에 든 제출물이 조용히 사라집니다. 그래서 이 경로만
 * 따로 열되, 저장 전에 서버가 형태를 다듬습니다.
 */
async function restoreSubmissions(request, env, cors) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) {
    return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);
  }

  const clean = body.data
    .filter((s) => s && typeof s === 'object' && typeof s.id === 'string')
    .map((s) => ({
      id: String(s.id).slice(0, 64),
      projectId: String(s.projectId || '').slice(0, 64),
      title: String(s.title || '').slice(0, 200),
      body: String(s.body || '').slice(0, 8000),
      files: Array.isArray(s.files) ? s.files.filter((f) => f && typeof f.key === 'string') : [],
      author: {
        institution: String(s.author?.institution || '').slice(0, 120),
        name: String(s.author?.name || '').slice(0, 60),
        email: normEmail(s.author?.email),
      },
      // 조·발표 선정·마감 뒤 표시는 백업에서 되살려야 Build Camp 집계가 맞습니다.
      ...(normTeam(s.team) ? { team: normTeam(s.team) } : {}),
      ...(s.presenting ? { presenting: true } : {}),
      ...(s.late ? { late: true } : {}),
      ...(normEmail(s.registeredBy) ? { registeredBy: normEmail(s.registeredBy) } : {}),
      createdAt: s.createdAt || new Date().toISOString(),
      updatedAt: s.updatedAt || s.createdAt || new Date().toISOString(),
    }));

  await mutateIndex(env, 'submissions', () => clean);
  return json({ ok: true, count: clean.length }, 200, cors);
}

async function listSubmissions(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const [{ data: subs }, { data: projects }] = await Promise.all([
    readIndex(env, 'submissions'), readIndex(env, 'projects'),
  ]);

  if (me.role === 'admin') return json({ data: subs }, 200, { ...cors, 'Cache-Control': 'no-store' });

  // 투표를 받는 프로젝트는 서로의 제출물을 봐야 표를 줄 수 있으므로 함께 열립니다.
  const openIds = new Set(projects
    .filter((p) => p.visibility === 'public' || votingOf(p))
    .map((p) => p.id));
  const byId = new Map(projects.map((p) => [p.id, p]));
  // 그룹장은 **자기 조가 낸 것**을 봅니다 — 그 중에서 발표 과제를 뽑기 때문입니다.
  const myTeam = leaderTeam(me);

  const visible = subs
    .filter((s) => {
      if (normEmail(s.author?.email) === normEmail(me.email)) return true;
      if (openIds.has(s.projectId)) return true;
      const project = byId.get(s.projectId);
      // 발표 과제로 뽑힌 제출물은 점수를 주려면 참여자 모두가 봐야 합니다.
      if (isNominee(s) && presentationOf(project)) return true;
      if (myTeam && isCamp(project) && normTeam(s.team) === myTeam) return true;
      return false;
    })
    .map((s) => viewSubmission(s, me));

  return json({ data: visible }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

function checkProjectOpen(projects, projectId) {
  const project = projects.find((p) => p.id === projectId);
  if (!project) return '프로젝트를 찾을 수 없습니다.';
  if (project.status !== 'open') return '관리자가 이 프로젝트의 제출을 마감했습니다.';
  if (project.dueAt && new Date(project.dueAt).getTime() < Date.now()) return '제출 마감일이 지났습니다.';
  return null;
}

/** 회원이 소유한 업로드 폴더 접두어 목록 (기존 계정에서 연계된 이메일 포함). */
async function memberPrefixes(member, extraEmail = '') {
  const emails = new Set([normEmail(member?.email)]);
  if (extraEmail) emails.add(normEmail(extraEmail));
  for (const e of member?.linkedFromEmails || []) emails.add(normEmail(e));
  emails.delete('');
  return Promise.all([...emails].map((e) => memberKey(e)));
}

/** 남의 업로드 폴더를 가리키지 못하게 막습니다. */
function ownsFiles(files, prefixes, isAdmin) {
  if (isAdmin) return true;
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  return (files || []).every(
    (f) => typeof f?.key === 'string' && list.some((p) => f.key.startsWith(`uploads/${p}/`)),
  );
}

async function createSubmission(request, env, cors, waitUntil) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  if (!body?.projectId || !String(body.title || '').trim() || !String(body.body || '').trim()) {
    return json({ message: '제목과 설명을 입력하세요.' }, 400, cors);
  }

  const { data: projects } = await readIndex(env, 'projects');
  const project = projects.find((p) => p.id === body.projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  /**
   * 마감된 과제에도 관리자는 등록할 수 있습니다 — 늦게 받은 과제를 대신 올리거나
   * 빠진 제출을 채워 넣어야 할 때가 있습니다. 대신 `late` 를 붙여 두고
   * 투표에서는 뺍니다(castVote). 교육생은 지금까지처럼 막힙니다.
   */
  const closed = checkProjectOpen(projects, body.projectId);
  if (closed && me.role !== 'admin') return json({ message: closed }, 400, cors);

  // AI Build Camp 과제는 조를 골라야 합니다 — 조별로 묶어 보고, 조마다 발표
  // 과제를 하나 뽑습니다(shared/camp.js). 일반 과제에서는 받지 않습니다.
  const team = isCamp(project) ? normTeam(body.team) : 0;
  if (isCamp(project) && !team) {
    return json({ message: `조를 선택하세요 (1조~${TEAM_MAX}조).` }, 400, cors);
  }

  const prefixes = await memberPrefixes(me);
  if (!ownsFiles(body.files, prefixes, me.role === 'admin')) {
    return json({ message: '첨부 파일 경로가 올바르지 않습니다.' }, 400, cors);
  }

  /**
   * 관리자는 **다른 회원 이름으로** 등록할 수 있습니다 — 메일로 받은 과제를
   * 대신 올리는 경우가 있습니다. 그 사람의 '내 제출물'·제출 현황에도 잡힙니다.
   * 지정한 이메일은 반드시 가입한 회원이어야 하고, 이름·기관은 명부에서
   * 가져옵니다(요청에 실린 값은 믿지 않습니다). 누가 대신 올렸는지도 남깁니다.
   */
  let author = authorOf(me);
  let registeredBy = null;
  const asEmail = normEmail(body.authorEmail || '');
  if (asEmail && asEmail !== normEmail(me.email)) {
    if (me.role !== 'admin') {
      return json({ message: '다른 사람 이름으로는 제출할 수 없습니다.' }, 403, cors);
    }
    const { list } = await readMembers(env);
    const target = findMember(list, asEmail);
    if (!target) return json({ message: '그 이메일로 가입한 회원이 없습니다.' }, 404, cors);
    author = authorOf(target);
    registeredBy = normEmail(me.email);
  }

  const now = new Date().toISOString();
  const rec = {
    id: uid('s_'),
    projectId: body.projectId,
    author,
    title: String(body.title).trim().slice(0, 200),
    body: String(body.body).trim().slice(0, 20000),
    files: Array.isArray(body.files) ? body.files.slice(0, 20) : [],
    status: 'submitted',
    ...(team ? { team } : {}),
    // 마감 뒤 등록이면 표시를 남깁니다. 나중에 마감일을 고쳐도 이 값은 그대로라
    // "등록 시점 기준"이라는 뜻이 흔들리지 않습니다.
    ...(closed ? { late: true } : {}),
    ...(registeredBy ? { registeredBy } : {}),
    createdAt: now,
    updatedAt: now,
  };

  await mutateIndex(env, 'submissions', (list) => { list.push(rec); return list; });
  notifySubmission(env, waitUntil, rec, project);
  return json({ submission: rec }, 200, cors);
}

async function patchSubmission(request, env, id, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  if (!body) return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);

  const { data: subs } = await readIndex(env, 'submissions');
  const existing = subs.find((s) => s.id === id);
  if (!existing) return json({ message: '제출물을 찾을 수 없습니다.' }, 404, cors);

  const mine = normEmail(existing.author?.email) === normEmail(me.email);
  if (!mine && me.role !== 'admin') {
    return json({ message: '본인 제출물만 수정할 수 있습니다.' }, 403, cors);
  }

  const { data: projects } = await readIndex(env, 'projects');
  if (me.role !== 'admin') {
    const closed = checkProjectOpen(projects, existing.projectId);
    if (closed) return json({ message: closed }, 400, cors);
  }

  // 조를 고쳐 보낼 수 있습니다(처음에 잘못 골랐을 때). Build Camp 과제에서는
  // 조가 비면 안 되므로 1~8 만 받습니다.
  const project = projects.find((x) => x.id === existing.projectId);
  let team = null;
  if (body.team !== undefined) {
    team = normTeam(body.team);
    if (isCamp(project) && !team) {
      return json({ message: `조는 1조부터 ${TEAM_MAX}조까지입니다.` }, 400, cors);
    }
    if (!isCamp(project)) team = 0;
  }

  const prefixes = await memberPrefixes(me, existing.author?.email || '');
  if (body.files && !ownsFiles(body.files, prefixes, me.role === 'admin')) {
    return json({ message: '첨부 파일 경로가 올바르지 않습니다.' }, 400, cors);
  }

  const keptKeys = new Set((body.files || existing.files || []).map((f) => f.key));
  const removed = (existing.files || []).filter((f) => f.key && !keptKeys.has(f.key));

  let updated = null;
  await mutateIndex(env, 'submissions', (list) => {
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    if (typeof body.title === 'string' && body.title.trim()) s.title = body.title.trim().slice(0, 200);
    if (typeof body.body === 'string' && body.body.trim()) s.body = body.body.trim().slice(0, 20000);
    if (Array.isArray(body.files)) s.files = body.files.slice(0, 20);
    // 이름·기관은 본인이 고칠 수 있게 두되, 이메일은 계정에 묶여 있으므로 고정입니다.
    if (typeof body.name === 'string' && body.name.trim()) s.author.name = body.name.trim().slice(0, 60);
    if (typeof body.institution === 'string') s.author.institution = body.institution.trim().slice(0, 80);
    if (team !== null) {
      if (team) s.team = team;
      else delete s.team;
    }
    s.updatedAt = new Date().toISOString();
    updated = s;
    return list;
  });

  // 색인에서 빠진 첨부는 버킷에서도 지웁니다.
  for (const f of removed) await env.BUCKET.delete(f.key).catch(() => {});

  return json({ submission: updated }, 200, cors);
}

async function removeSubmission(request, env, id, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const { data: subs } = await readIndex(env, 'submissions');
  const existing = subs.find((s) => s.id === id);
  if (!existing) return json({ ok: true }, 200, cors);

  const mine = normEmail(existing.author?.email) === normEmail(me.email);
  if (!mine && me.role !== 'admin') {
    return json({ message: '본인 제출물만 삭제할 수 있습니다.' }, 403, cors);
  }

  await mutateIndex(env, 'submissions', (list) => list.filter((s) => s.id !== id));
  // 지워진 제출물에 들어간 표도 함께 거둡니다 — 남겨두면 투표자의 표 수만 축냅니다.
  await mutateIndex(env, 'votes', (list) => {
    const kept = list.filter((v) => v.submissionId !== id);
    return kept.length === list.length ? null : kept;
  });
  // 발표 평가 점수도 마찬가지입니다 — 없는 발표의 점수는 평균만 흐립니다.
  await mutateIndex(env, 'scores', (list) => {
    const kept = list.filter((r) => r.submissionId !== id);
    return kept.length === list.length ? null : kept;
  });
  for (const f of existing.files || []) {
    if (f.key) await env.BUCKET.delete(f.key).catch(() => {});
  }
  return json({ ok: true }, 200, cors);
}

/* ========================================================== 소통방 == */

/**
 * 회원끼리 글을 남기고 댓글을 다는 게시판.
 *
 * 제출물과 같은 원칙입니다 — 색인은 서버만 고치고, 글쓴이는 세션에서 채우며,
 * 남의 글은 고치거나 지울 수 없습니다. 공지 지정(pinned)은 관리자만 합니다.
 * 이메일은 본인과 관리자에게만 보입니다.
 */
const POST_TITLE_MAX = 150;
const POST_BODY_MAX = 20000;
const COMMENT_MAX = 2000;

function viewPost(post, viewer) {
  const hide = (a) => (
    viewer.role === 'admin' || normEmail(a?.email) === normEmail(viewer.email)
      ? a : { ...a, email: undefined });
  return {
    ...post,
    author: hide(post.author),
    comments: (post.comments || []).map((c) => ({ ...c, author: hide(c.author) })),
  };
}

/** 공지를 맨 위로, 그 안에서는 최신순. */
function sortPosts(list) {
  return [...list].sort((a, b) => {
    if (Boolean(b.pinned) !== Boolean(a.pinned)) return b.pinned ? 1 : -1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

const canEditPost = (post, me) => (
  me.role === 'admin' || normEmail(post.author?.email) === normEmail(me.email));

async function listPosts(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const { data } = await readIndex(env, 'posts');
  const rows = sortPosts(data).map((p) => viewPost(p, got.member));
  return json({ data: rows }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

async function createPost(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  const title = String(body?.title || '').trim();
  const text = String(body?.body || '').trim();
  if (!title || !text) return json({ message: '제목과 내용을 입력하세요.' }, 400, cors);

  const now = new Date().toISOString();
  const rec = {
    id: uid('b_'),
    author: authorOf(me),
    title: title.slice(0, POST_TITLE_MAX),
    body: text.slice(0, POST_BODY_MAX),
    // 공지는 관리자만 지정할 수 있습니다. 일반 회원이 보내도 무시합니다.
    pinned: me.role === 'admin' ? Boolean(body?.pinned) : false,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };

  await mutateIndex(env, 'posts', (list) => { list.push(rec); return list; });
  return json({ post: viewPost(rec, me) }, 200, cors);
}

async function patchPost(request, env, id, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  if (!body) return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);

  let denied = null;
  let updated = null;
  const result = await mutateIndex(env, 'posts', (list) => {
    const p = list.find((x) => x.id === id);
    if (!p) return null;
    if (!canEditPost(p, me)) { denied = { message: '본인 글만 수정할 수 있습니다.', status: 403 }; return null; }

    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) { denied = { message: '제목을 입력하세요.', status: 400 }; return null; }
      p.title = t.slice(0, POST_TITLE_MAX);
    }
    if (body.body !== undefined) {
      const t = String(body.body).trim();
      if (!t) { denied = { message: '내용을 입력하세요.', status: 400 }; return null; }
      p.body = t.slice(0, POST_BODY_MAX);
    }
    // 공지 지정은 관리자만. 회원이 보낸 pinned 는 조용히 무시합니다.
    if (body.pinned !== undefined && me.role === 'admin') p.pinned = Boolean(body.pinned);

    p.updatedAt = new Date().toISOString();
    updated = p;
    return list;
  });

  if (denied) return json({ message: denied.message }, denied.status, cors);
  if (!result.ok) return json({ message: '글을 찾을 수 없습니다.' }, 404, cors);
  return json({ post: viewPost(updated, me) }, 200, cors);
}

async function removePost(request, env, id, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  let denied = null;
  const result = await mutateIndex(env, 'posts', (list) => {
    const p = list.find((x) => x.id === id);
    if (!p) return null;
    if (!canEditPost(p, me)) { denied = '본인 글만 삭제할 수 있습니다.'; return null; }
    return list.filter((x) => x.id !== id);
  });

  if (denied) return json({ message: denied }, 403, cors);
  if (!result.ok) return json({ message: '글을 찾을 수 없습니다.' }, 404, cors);
  return json({ ok: true }, 200, cors);
}

async function createComment(request, env, postId, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  const text = String(body?.body || '').trim();
  if (!text) return json({ message: '댓글 내용을 입력하세요.' }, 400, cors);

  let updated = null;
  const result = await mutateIndex(env, 'posts', (list) => {
    const p = list.find((x) => x.id === postId);
    if (!p) return null;
    if (!Array.isArray(p.comments)) p.comments = [];
    p.comments.push({
      id: uid('c_'),
      author: authorOf(me),
      body: text.slice(0, COMMENT_MAX),
      createdAt: new Date().toISOString(),
    });
    updated = p;
    return list;
  });

  if (!result.ok) return json({ message: '글을 찾을 수 없습니다.' }, 404, cors);
  return json({ post: viewPost(updated, me) }, 200, cors);
}

async function removeComment(request, env, postId, commentId, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  let denied = null;
  let updated = null;
  const result = await mutateIndex(env, 'posts', (list) => {
    const p = list.find((x) => x.id === postId);
    if (!p) return null;
    const c = (p.comments || []).find((x) => x.id === commentId);
    if (!c) return null;
    // 댓글은 쓴 사람과 관리자가 지울 수 있습니다.
    if (me.role !== 'admin' && normEmail(c.author?.email) !== normEmail(me.email)) {
      denied = '본인 댓글만 삭제할 수 있습니다.';
      return null;
    }
    p.comments = p.comments.filter((x) => x.id !== commentId);
    updated = p;
    return list;
  });

  if (denied) return json({ message: denied }, 403, cors);
  if (!result.ok) return json({ message: '댓글을 찾을 수 없습니다.' }, 404, cors);
  return json({ post: viewPost(updated, me) }, 200, cors);
}

/* ============================================================ 투표 == */

/**
 * 회원 상호 투표.
 *
 * 표는 `data/votes.json` 에 한 줄씩 쌓입니다 — {projectId, submissionId, voter}.
 * **누가 어디에 넣었는지는 서버만 압니다.** 브라우저로는 집계와 "내가 넣은 표"만
 * 내려가고, 남의 표는 어떤 경로로도 나가지 않습니다.
 * 기간·1인당 표 수·본인 제출물 허용 여부는 프로젝트의 voting 설정을 따릅니다.
 *
 * (화면용 사본은 assets/js/store/index.js 의 votingOf·votingPhase — 함께 고치세요.)
 */
const VOTE_MAX_PER_MEMBER = 50;
const VOTE_DEFAULT_PER_MEMBER = 3;

/** 프로젝트의 투표 설정을 정규화합니다. 투표를 안 받으면 null. */
function votingOf(project) {
  const v = project?.voting;
  if (!v || typeof v !== 'object' || !v.enabled) return null;
  const per = Math.round(Number(v.perMember));
  return {
    enabled: true,
    startAt: v.startAt || null,
    endAt: v.endAt || null,
    perMember: Number.isFinite(per)
      ? Math.min(Math.max(per, 1), VOTE_MAX_PER_MEMBER)
      : VOTE_DEFAULT_PER_MEMBER,
    allowSelf: Boolean(v.allowSelf),
    showCounts: v.showCounts !== false,
  };
}

/** 'off'(투표 없음) | 'before'(시작 전) | 'open'(진행중) | 'closed'(마감) */
function votingPhase(project, now = Date.now()) {
  const cfg = votingOf(project);
  if (!cfg) return 'off';
  const start = cfg.startAt ? new Date(cfg.startAt).getTime() : null;
  const end = cfg.endAt ? new Date(cfg.endAt).getTime() : null;
  if (Number.isFinite(start) && start > now) return 'before';
  if (Number.isFinite(end) && end < now) return 'closed';
  return 'open';
}

/**
 * 브라우저로 내려보낼 집계. 득표수를 숨기도록 설정했다면 투표가 끝나기 전까지
 * counts 를 아예 내리지 않습니다 — 화면에서 가리는 것으로는 부족하기 때문입니다.
 */
function voteSummary(project, votes, me) {
  const cfg = votingOf(project);
  const phase = votingPhase(project);
  const rows = votes.filter((v) => v.projectId === project.id);
  const mine = rows
    .filter((v) => normEmail(v.voter) === normEmail(me.email))
    .map((v) => v.submissionId);

  const showCounts = me.role === 'admin'
    || phase === 'closed' || phase === 'off'
    || (phase === 'open' && cfg?.showCounts !== false);

  const counts = {};
  if (showCounts) for (const v of rows) counts[v.submissionId] = (counts[v.submissionId] || 0) + 1;

  return {
    projectId: project.id,
    phase,
    limit: cfg ? cfg.perMember : 0,
    allowSelf: Boolean(cfg?.allowSelf),
    startAt: cfg?.startAt || null,
    endAt: cfg?.endAt || null,
    // 지금 집계를 볼 수 있는지. 설정값이 아니라 "이 사람에게 지금 보이는가" 입니다.
    showCounts,
    used: mine.length,
    mine,
    counts: showCounts ? counts : null,
    voters: showCounts ? new Set(rows.map((v) => normEmail(v.voter))).size : null,
    total: showCounts ? rows.length : null,
  };
}

async function voteSummaryRequest(request, env, url, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const projectId = String(url.searchParams.get('projectId') || '');
  const { data: projects } = await readIndex(env, 'projects');
  const project = projects.find((p) => p.id === projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  const { data: votes } = await readIndex(env, 'votes');
  return json({ summary: voteSummary(project, votes, got.member) }, 200,
    { ...cors, 'Cache-Control': 'no-store' });
}

/** 표 넣기(on:true) · 빼기(on:false). 같은 요청을 두 번 보내도 결과는 같습니다. */
async function castVote(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  const submissionId = String(body?.submissionId || '');
  const on = body?.on !== false;
  if (!submissionId) return json({ message: '대상 제출물이 필요합니다.' }, 400, cors);

  const [{ data: projects }, { data: subs }] = await Promise.all([
    readIndex(env, 'projects'), readIndex(env, 'submissions'),
  ]);
  const sub = subs.find((x) => x.id === submissionId);
  if (!sub) return json({ message: '제출물을 찾을 수 없습니다.' }, 404, cors);
  const project = projects.find((p) => p.id === sub.projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  const cfg = votingOf(project);
  if (!cfg) return json({ message: '이 프로젝트는 투표를 받지 않습니다.' }, 400, cors);

  // 관리자도 마감 뒤에는 넣지 못합니다 — 집계가 나중에 바뀌면 결과를 믿을 수 없습니다.
  const phase = votingPhase(project);
  if (phase !== 'open') {
    return json({
      message: phase === 'before' ? '아직 투표 기간이 아닙니다.' : '투표가 마감되었습니다.',
    }, 400, cors);
  }
  // 마감 뒤에 들어온 제출물은 같은 조건에서 겨룬 것이 아니므로 표를 받지 않습니다.
  if (on && sub.late) {
    return json({ message: '마감 뒤에 등록된 제출물은 투표 대상이 아닙니다.' }, 400, cors);
  }
  if (on && !cfg.allowSelf && normEmail(sub.author?.email) === normEmail(me.email)) {
    return json({ message: '본인 제출물에는 투표할 수 없습니다.' }, 400, cors);
  }

  let denied = null;
  // 표 수 확인과 저장을 같은 mutator 안에서 합니다 — 겹쳐 들어와도 한도를 넘지 않습니다.
  const result = await mutateIndex(env, 'votes', (list) => {
    const mineHere = list.filter((v) => v.projectId === project.id
      && normEmail(v.voter) === normEmail(me.email));
    const already = mineHere.find((v) => v.submissionId === submissionId);

    if (!on) {
      if (!already) return null;                 // 이미 없음 — 저장할 것이 없습니다
      return list.filter((v) => v !== already);
    }
    if (already) return null;                    // 이미 넣은 표 — 그대로 둡니다
    if (mineHere.length >= cfg.perMember) {
      denied = `투표는 1인당 ${cfg.perMember}표까지 할 수 있습니다.`;
      return null;
    }
    list.push({
      id: uid('v_'),
      projectId: project.id,
      submissionId,
      voter: normEmail(me.email),
      createdAt: new Date().toISOString(),
    });
    return list;
  });

  if (denied) return json({ message: denied }, 400, cors);
  return json({ summary: voteSummary(project, result.data, me) }, 200, cors);
}

/* ====================================================== 발표 평가 == */

/**
 * AI Build Camp 발표 — 조마다 발표 과제를 하나 뽑고, 참여자가 세 문항으로
 * 점수를 줍니다(목표 타당성 20점 · 창의성 10점 · 완성도 10점 = 40점).
 *
 * 규칙은 `shared/camp.js` 에 모아 두었고, 화면용 사본이
 * `assets/js/camp.js` 에 있습니다 — 함께 고치세요.
 */

/**
 * 발표 과제 선정 — 그룹장이 **자기 조에서** 하나를 뽑습니다(관리자는 모든 조).
 *
 * 한 조의 발표 과제는 하나입니다. 다른 것을 뽑으면 먼저 올라가 있던 것이
 * 자동으로 내려갑니다 — 두 개가 같이 올라가 점수가 갈리지 않게 합니다.
 * 내려간 발표에 들어와 있던 점수는 함께 지웁니다. 선정되지 않은 제출물에
 * 점수가 남아 있으면 집계를 믿을 수 없기 때문입니다.
 */
async function nominatePresentation(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  const submissionId = String(body?.submissionId || '');
  const on = body?.on !== false;
  if (!submissionId) return json({ message: '대상 제출물이 필요합니다.' }, 400, cors);

  const [{ data: projects }, { data: subs }] = await Promise.all([
    readIndex(env, 'projects'), readIndex(env, 'submissions'),
  ]);
  const sub = subs.find((x) => x.id === submissionId);
  if (!sub) return json({ message: '제출물을 찾을 수 없습니다.' }, 404, cors);
  const project = projects.find((p) => p.id === sub.projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  const blocked = nominateBlock(project, sub, me, on);
  // 남의 조를 건드리려 한 것만 권한 문제이고, 나머지는 요청 내용 문제입니다.
  if (blocked) return json({ message: blocked }, blocked.includes('자기 조') ? 403 : 400, cors);

  const dropped = [];
  await mutateIndex(env, 'submissions', (list) => {
    const target = list.find((x) => x.id === submissionId);
    if (!target) return null;
    const touched = applyNominate(list, target, on);
    if (!touched.length) return null;                    // 이미 그 상태입니다
    for (const x of touched) if (!x.presenting) dropped.push(x.id);
    return list;
  });

  if (dropped.length) {
    await mutateIndex(env, 'scores', (list) => {
      const kept = list.filter((r) => !dropped.includes(r.submissionId));
      return kept.length === list.length ? null : kept;
    });
  }

  return json({ ok: true, submissionId, presenting: on, dropped }, 200, cors);
}

async function scoreSummaryRequest(request, env, url, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const projectId = String(url.searchParams.get('projectId') || '');
  const { data: projects } = await readIndex(env, 'projects');
  const project = projects.find((p) => p.id === projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  const { data: scores } = await readIndex(env, 'scores');
  return json({ summary: summarizeScores(project, scores, got.member) }, 200,
    { ...cors, 'Cache-Control': 'no-store' });
}

/**
 * 발표에 점수 주기. 한 사람이 한 발표에 한 번이고, 다시 보내면 **덮어씁니다**
 * (잘못 누른 점수를 고칠 수 있어야 하기 때문입니다).
 */
async function castScore(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  const submissionId = String(body?.submissionId || '');
  if (!submissionId) return json({ message: '대상 발표가 필요합니다.' }, 400, cors);

  const [{ data: projects }, { data: subs }] = await Promise.all([
    readIndex(env, 'projects'), readIndex(env, 'submissions'),
  ]);
  const sub = subs.find((x) => x.id === submissionId);
  if (!sub) return json({ message: '제출물을 찾을 수 없습니다.' }, 404, cors);
  const project = projects.find((p) => p.id === sub.projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  // "자기 조"는 계정이 아니라 이 과제에 낸 자기 제출물의 조로 판단합니다.
  const mineHere = subs.filter((x) => x.projectId === project.id);
  const blocked = scoreBlock(project, sub, me, myTeamIn(mineHere, me));
  if (blocked) return json({ message: blocked }, 400, cors);

  const score = normScore(body);
  const now = new Date().toISOString();
  const result = await mutateIndex(env, 'scores', (list) => {
    const at = list.findIndex((r) => r.projectId === project.id
      && r.submissionId === submissionId
      && normEmail(r.voter) === normEmail(me.email));
    if (at >= 0) list[at] = { ...list[at], ...score, updatedAt: now };
    else {
      list.push({
        id: uid('sc_'),
        projectId: project.id,
        submissionId,
        voter: normEmail(me.email),
        ...score,
        createdAt: now,
        updatedAt: now,
      });
    }
    return list;
  });

  return json({ summary: summarizeScores(project, result.data, me) }, 200, cors);
}

/**
 * 관리자용 원자료 — 누가 어느 발표에 몇 점을 줬는지 한 줄씩.
 * 집계만으로는 "한 사람이 몰아줬는지"를 볼 수 없어 따로 엽니다.
 */
async function listScores(request, env, url, cors) {
  const admin = await requireAdmin(request, env);
  if (admin.error) return json({ message: admin.error }, admin.status, cors);

  const projectId = String(url.searchParams.get('projectId') || '');
  const { data: scores } = await readIndex(env, 'scores');
  const rows = projectId ? scores.filter((r) => r.projectId === projectId) : scores;
  return json({ data: rows }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

/* ====================================================== 발표 순서 추첨 == */

/**
 * 조마다 발표 과제가 다 정해지면 **발표 순서를 뽑습니다.**
 *
 * 순서는 한 과제에 하나뿐이고 모두가 같은 것을 봐야 하므로, 서버가 섞어서
 * 저장하고 브라우저는 그 결과를 받아 보여주기만 합니다. 브라우저에서 섞으면
 * 마음에 드는 결과가 나올 때까지 다시 돌려볼 수 있습니다.
 */

/** 이 과제의 추첨 한 줄. 없으면 null. */
function findDraw(list, projectId) {
  return list.find((d) => d.projectId === projectId) || null;
}

async function drawRequest(request, env, url, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const projectId = String(url.searchParams.get('projectId') || '');
  const [{ data: projects }, { data: subs }, { data: draws }] = await Promise.all([
    readIndex(env, 'projects'), readIndex(env, 'submissions'), readIndex(env, 'draws'),
  ]);
  const project = projects.find((p) => p.id === projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  const here = subs.filter((s) => s.projectId === projectId);
  const draw = drawOf(findDraw(draws, projectId));
  const p = nomineeProgress(here);

  return json({
    draw,
    // 진행 상황은 모두가 봅니다 — "몇 개 조가 남았나"가 이 화면의 핵심입니다.
    progress: { teams: p.teams, picked: p.picked, missing: p.missing },
    stale: drawStale(draw, here),
  }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

/**
 * 발표 순서 추첨 (관리자).
 *
 * 이미 뽑아 둔 순서가 있으면 **다시 뽑습니다.** 막지는 않되 몇 번째 추첨인지를
 * 세어 두고 화면에 그대로 보여줍니다 — 조용히 다시 뽑는 것보다 "두 번 뽑았다"가
 * 보이는 편이 낫습니다.
 */
async function runDraw(request, env, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const body = await request.json().catch(() => null);
  const projectId = String(body?.projectId || '');
  if (!projectId) return json({ message: '대상 과제가 필요합니다.' }, 400, cors);

  const [{ data: projects }, { data: subs }] = await Promise.all([
    readIndex(env, 'projects'), readIndex(env, 'submissions'),
  ]);
  const project = projects.find((p) => p.id === projectId);
  if (!project) return json({ message: '프로젝트를 찾을 수 없습니다.' }, 404, cors);

  const here = subs.filter((s) => s.projectId === projectId);
  const blocked = drawBlock(project, here, me);
  // 권한이 없는 것만 403 이고, 아직 준비가 안 된 것은 요청 내용 문제입니다.
  if (blocked) return json({ message: blocked }, blocked.includes('관리자만') ? 403 : 400, cors);

  const order = shuffle(nomineeProgress(here).nominees.map((s) => s.id));
  const now = new Date().toISOString();

  let saved = null;
  await mutateIndex(env, 'draws', (list) => {
    const at = list.findIndex((d) => d.projectId === projectId);
    const seq = at >= 0 ? Math.max(1, Math.round(Number(list[at].seq)) || 1) + 1 : 1;
    const row = {
      id: at >= 0 ? list[at].id : uid('dr_'),
      projectId,
      order,
      seq,
      drawnAt: now,
      drawnBy: normEmail(me.email),
    };
    if (at >= 0) list[at] = row; else list.push(row);
    saved = row;
    return list;
  });

  return json({ draw: drawOf(saved) }, 200, cors);
}

/* ============================================================== 업로드 == */

function maxUploadMB(env) {
  const n = Number(env.MAX_UPLOAD_MB);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function allowedExt(env) {
  const raw = String(env.ALLOWED_EXT || '').trim();
  if (!raw) return new Set(DEFAULT_EXT);
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** 저장소 키에 쓸 수 있게 파일명을 정리합니다. 한글은 유지합니다. */
function safeName(name) {
  const cleaned = String(name || 'file')
    .replace(/[\\/:*?"<>|#%&{}$!'`+=@]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120);
  return cleaned || 'file';
}

async function upload(request, env, url, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);
  const me = got.member;

  const name = String(url.searchParams.get('name') || '').trim();
  const kind = String(url.searchParams.get('kind') || 'submission');
  if (!name) return json({ message: '파일명이 없습니다.' }, 400, cors);

  // 저장 위치는 서버가 정합니다. 회원은 자기 폴더 밖에 파일을 둘 수 없습니다.
  let dir;
  if (kind === 'material') {
    if (me.role !== 'admin') return json({ message: '관리자만 할 수 있습니다.' }, 403, cors);
    const mid = String(url.searchParams.get('materialId') || '').trim();
    if (!/^m_[A-Za-z0-9]{1,60}$/.test(mid)) {
      return json({ message: '잘못된 자료 번호입니다.' }, 400, cors);
    }
    dir = `materials/${mid}`;
  } else {
    dir = await memberKey(me.email);
  }

  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (!allowedExt(env).has(ext)) {
    return json({ message: `허용되지 않는 형식입니다: .${ext || '?'}` }, 415, cors);
  }

  const limit = maxUploadMB(env) * 1024 * 1024;
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) {
    return json({ message: `파일이 너무 큽니다. 최대 ${maxUploadMB(env)}MB.` }, 413, cors);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ message: '빈 파일입니다.' }, 400, cors);
  if (bytes.length > limit) {
    return json({ message: `파일이 너무 큽니다. 최대 ${maxUploadMB(env)}MB.` }, 413, cors);
  }

  const fid = `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const key = `uploads/${dir}/${fid}_${safeName(name)}`;
  const type = request.headers.get('X-File-Type') || 'application/octet-stream';

  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: type },
    customMetadata: { originalName: encodeURIComponent(name), owner: normEmail(me.email) },
  });

  return json({ key, size: bytes.length, type }, 200, cors);
}

/* ======================================================== 파일 제공 == */

function keyAllowed(key) {
  if (!key || key.length > 400) return false;
  if (key.includes('..') || key.includes('//')) return false;
  return key.startsWith('uploads/');
}

async function serveFile(env, key, url, cors) {
  if (!keyAllowed(key)) return json({ message: '잘못된 경로입니다.' }, 400, cors);

  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ message: '파일을 찾을 수 없습니다.' }, 404, cors);

  const type = obj.httpMetadata?.contentType || 'application/octet-stream';
  const original = obj.customMetadata?.originalName
    ? decodeURIComponent(obj.customMetadata.originalName)
    : key.split('/').pop();

  const wantsDownload = url.searchParams.get('download') === '1';
  const inline = !wantsDownload && SAFE_INLINE.has(type);
  const disposition = inline ? 'inline' : 'attachment';

  const headers = new Headers(cors);
  headers.set('Content-Type', type);
  headers.set('Content-Length', String(obj.size));
  headers.set('ETag', obj.httpEtag);
  // 로그인한 회원에게만 나가므로 공용 캐시에 남지 않게 private 로 둡니다.
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  // 업로드된 SVG·HTML 이 우리 오리진에서 스크립트를 실행하지 못하게 막습니다.
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(original)}`,
  );

  return new Response(obj.body, { status: 200, headers });
}

async function deleteFile(env, key, cors) {
  if (!keyAllowed(key)) return json({ message: '잘못된 경로입니다.' }, 400, cors);
  await env.BUCKET.delete(key);
  return json({ ok: true }, 200, cors);
}

/* ============================================================== CORS == */

function originList(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** 같은 오리진 요청은 항상 허용하고, 다른 오리진은 목록에 있을 때만 허용합니다. */
function originAllowed(origin, url, env) {
  if (!origin) return true;
  if (origin === url.origin) return true;
  const list = originList(env);
  return list.length ? list.includes(origin) : false;
}

function corsHeaders(origin, url, env) {
  const list = originList(env);
  const ok = origin === url.origin || (list.length > 0 && list.includes(origin));
  return {
    'Access-Control-Allow-Origin': ok ? (origin || url.origin) : url.origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
