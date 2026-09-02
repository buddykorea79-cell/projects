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
 *   BUCKET               (필수) R2 버킷 바인딩
 *   ADMIN_EMAILS         (선택) 관리자 이메일. 쉼표 구분. 미설정 시 아래 기본값
 *   ALLOWED_ORIGINS      (선택) 쉼표 구분. 비우면 같은 오리진만 허용
 *   MAX_UPLOAD_MB        (선택) 기본 100
 *   ALLOWED_EXT          (선택) 쉼표 구분
 *   PBKDF2_ITERATIONS    (선택) 기본 15000 (무료 플랜 CPU 10ms 기준)
 *   TOKEN_SECRET         (선택) 세션 서명 키. 없으면 R2 에 자동 생성
 *   TELEGRAM_BOT_TOKEN       (선택) Hermes 알림용 봇 토큰 — shared/telegram.js
 *   TELEGRAM_CHAT_ID         (선택) 알림을 받을 채팅 ID
 *   TELEGRAM_WEBHOOK_SECRET  (선택) 텔레그램 웹훅 검증용 시크릿
 *   EMAIL_WEBHOOK_URL        (선택) 재설정 링크 메일 발송용 Apps Script URL — shared/email.js
 *   EMAIL_WEBHOOK_SECRET     (선택) 위 웹앱과 맞춰 둔 비밀 문자열
 *
 * 경로 (basePath 기본 '/api')
 *   GET    /health
 *   POST   /auth/signup | /auth/login | /auth/logout | /auth/password
 *   GET    /auth/me
 *   GET    /auth/members            (관리자)
 *   PATCH  /auth/members            (관리자) 역할·차단
 *   POST   /auth/members/reset      (관리자) 임시 비밀번호 발급
 *   POST   /auth/reset/confirm      (공개) 재설정 링크(토큰)로 새 비밀번호 설정
 *   POST   /telegram/webhook        (텔레그램) 재설정 버튼 콜백 — Hermes
 *   GET    /data/projects|materials (로그인)   PUT (관리자)
 *   GET    /submissions             (로그인, 권한에 따라 필터)
 *   POST   /submissions             (로그인)
 *   PATCH  /submissions/:id         (본인·관리자)
 *   DELETE /submissions/:id         (본인·관리자)
 *   POST   /upload                  (로그인)
 *   GET    /posts                   (로그인) 소통방 목록 — 공지가 맨 위
 *   POST   /posts                   (로그인) 글쓰기
 *   PATCH  /posts/:id               (본인 또는 관리자) — pinned 는 관리자만
 *   DELETE /posts/:id               (본인 또는 관리자)
 *   POST   /posts/:id/comments      (로그인) 댓글
 *   DELETE /posts/:id/comments/:cid (본인 또는 관리자)
 *   GET    /file/<key>              (로그인)
 *   DELETE /file/<key>              (관리자)
 */
import {
  SESSION_COOKIE, SESSION_TTL_MS,
  hashPassword, verifyPassword, issueTempPassword,
  newResetToken, resetPasswordWithToken, clearResetToken, validatePassword,
  signSession, readSession, cookieValue, sessionCookie, clearCookie,
  readMembers, updateMembers, findMember, publicMember,
  lockState, registerFailure, clearFailures, epochOf, bumpEpoch,
  validateSignup, normEmail, RESET_REQUEST_COOLDOWN_MS,
} from './auth.js';
import { notifySignup, notifySubmission, notifyResetRequest, handleTelegramWebhook } from './telegram.js';
import { sendResetEmail } from './email.js';

/** 이 이메일로 가입하면 자동으로 관리자 권한이 붙습니다. */
const DEFAULT_ADMIN_EMAILS = ['aireader@mois.go.kr'];

const DATA_NAMES = new Set(['projects', 'materials']);

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

export async function handleApi(request, env, { basePath = '/api', waitUntil } = {}) {
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
  if (!env.BUCKET) {
    return json({ message: 'R2 버킷 바인딩(BUCKET)이 설정되지 않았습니다.' }, 500, cors);
  }

  try {
    return await route(request, env, url, path, cors, waitUntil);
  } catch (e) {
    return json({ message: `서버 오류: ${e.message}` }, 500, cors);
  }
}

async function route(request, env, url, path, cors, waitUntil) {
  const method = request.method;

  if (path === '/health' && method === 'GET') {
    const me = await currentMember(request, env);
    return json({
      ok: true,
      mode: 'r2',
      members: true,
      maxUploadMB: maxUploadMB(env),
      // 재설정 링크 메일 발송이 설정돼 있는지 — 비밀번호 찾기 화면의 문구가 달라집니다.
      mailReset: Boolean(env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_SECRET),
      signedIn: Boolean(me),
      me: publicMember(me),
    }, 200, cors);
  }

  /* ------------------------------------------------------------ 인증 -- */

  if (path === '/auth/signup' && method === 'POST') return signup(request, env, url, cors, waitUntil);
  if (path === '/auth/login' && method === 'POST') return login(request, env, url, cors);
  if (path === '/auth/logout' && method === 'POST') {
    return json({ ok: true }, 200, { ...cors, 'Set-Cookie': clearCookie(url) });
  }
  if (path === '/auth/me' && method === 'GET') {
    const me = await currentMember(request, env);
    if (!me) return json({ message: '로그인이 필요합니다.' }, 401, cors);
    return json({ me: publicMember(me) }, 200, cors);
  }
  if (path === '/auth/password' && method === 'POST') return changePassword(request, env, url, cors);
  if (path === '/auth/forgot' && method === 'POST') return requestReset(request, env, cors, waitUntil);
  if (path === '/auth/reset/confirm' && method === 'POST') return confirmReset(request, env, cors);

  if (path === '/auth/members') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return json({ message: admin.error }, admin.status, cors);
    if (method === 'GET') {
      const { list } = await readMembers(env);
      return json({ data: list.map(publicMember) }, 200, cors);
    }
    if (method === 'PATCH') return patchMember(request, env, admin.member, cors);
    return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
  }
  if (path === '/auth/members/reset' && method === 'POST') {
    const admin = await requireAdmin(request, env);
    if (admin.error) return json({ message: admin.error }, admin.status, cors);
    return resetMemberPassword(request, env, cors);
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
      const me = await currentMember(request, env);
      if (!me) return json({ message: '로그인이 필요합니다.' }, 401, cors);
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

/** 관리자 이메일 목록에 있으면 저장된 역할과 무관하게 관리자로 봅니다. */
function withRole(member, env) {
  if (!member) return null;
  const role = adminEmails(env).has(normEmail(member.email)) ? 'admin' : (member.role || 'member');
  return { ...member, role };
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

async function signup(request, env, url, cors, waitUntil) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);

  const errors = validateSignup(body);
  if (Object.keys(errors).length) return json({ message: '입력을 확인하세요.', errors }, 400, cors);

  const email = normEmail(body.email);
  const passwordHash = await hashPassword(String(body.password), env);
  let created = null;

  const result = await updateMembers(env, (list) => {
    if (findMember(list, email)) return null;      // 이미 가입됨 → 저장하지 않음
    created = {
      email,
      name: String(body.name).trim().slice(0, 60),
      institution: String(body.institution).trim().slice(0, 80),
      passwordHash,
      role: adminEmails(env).has(email) ? 'admin' : 'member',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: null,
      failedAttempts: 0,
      lockedUntil: 0,
    };
    list.push(created);
    return list;
  });

  if (!result.ok) {
    return json({ message: '이미 가입된 이메일입니다. 로그인해 주세요.', errors: { email: '이미 가입된 이메일입니다.' } }, 409, cors);
  }

  notifySignup(env, waitUntil, created);

  const token = await issueToken(created, env);
  return json({ me: publicMember(withRole(created, env)) }, 200,
    { ...cors, 'Set-Cookie': sessionCookie(token, url) });
}

async function login(request, env, url, cors) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);
  const password = String(body?.password ?? '');

  const { list } = await readMembers(env);
  const member = findMember(list, email);

  // 계정이 없어도 같은 문구를 돌려줍니다 — 어떤 이메일이 가입돼 있는지 새지 않도록.
  const generic = { message: '이메일 또는 비밀번호가 올바르지 않습니다.' };
  if (!member) {
    // 존재 여부에 따라 응답 시간이 달라지지 않게 해시 계산을 한 번 돌립니다.
    await verifyPassword(password, 'pbkdf2$sha256$15000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    return json(generic, 401, cors);
  }

  if ((member.status || 'active') !== 'active') {
    return json({ message: '이용이 정지된 계정입니다. 관리자에게 문의하세요.' }, 403, cors);
  }

  const lock = lockState(member);
  if (lock.locked) {
    return json({
      message: `로그인 시도가 많아 잠시 잠겼습니다. ${Math.ceil(lock.retryAfterSec / 60)}분 후 다시 시도하세요.`,
    }, 429, cors);
  }

  const ok = await verifyPassword(password, member.passwordHash);
  if (!ok) {
    await updateMembers(env, (l) => {
      const m = findMember(l, email);
      if (m) registerFailure(m);
      return l;
    });
    return json(generic, 401, cors);
  }

  await updateMembers(env, (l) => {
    const m = findMember(l, email);
    if (m) { clearFailures(m); m.lastLoginAt = new Date().toISOString(); }
    return l;
  });

  const withRoles = withRole(member, env);
  const token = await issueToken(withRoles, env);
  return json({ me: publicMember(withRoles) }, 200,
    { ...cors, 'Set-Cookie': sessionCookie(token, url) });
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

async function changePassword(request, env, url, cors) {
  const got = await requireMember(request, env);
  if (got.error) return json({ message: got.error }, got.status, cors);

  const body = await request.json().catch(() => null);
  const current = String(body?.current ?? '');
  const next = String(body?.next ?? '');

  const pwIssue = validatePassword(next);
  if (pwIssue) {
    return json({ message: pwIssue }, 400, cors);
  }
  if (!(await verifyPassword(current, got.member.passwordHash))) {
    return json({ message: '현재 비밀번호가 올바르지 않습니다.' }, 401, cors);
  }

  const hash = await hashPassword(next, env);
  let updated = null;
  await updateMembers(env, (l) => {
    const m = findMember(l, got.member.email);
    if (m) {
      m.passwordHash = hash;
      m.mustChangePassword = false;
      m.updatedAt = new Date().toISOString();
      clearResetToken(m);     // 나가 있던 재설정 링크가 있었다면 무효화합니다
      bumpEpoch(m);           // 다른 기기에 남아 있던 세션을 끊습니다
      updated = m;
    }
    return l;
  });

  // 세대를 올렸으니 지금 쓰고 있는 브라우저에는 새 쿠키를 내려 줍니다.
  const token = await issueToken(withRole(updated || got.member, env), env);
  return json({ ok: true }, 200, { ...cors, 'Set-Cookie': sessionCookie(token, url) });
}

async function patchMember(request, env, admin, cors) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);
  if (!email) return json({ message: '대상 이메일이 필요합니다.' }, 400, cors);
  if (email === normEmail(admin.email)) {
    return json({ message: '자기 계정의 권한은 바꿀 수 없습니다.' }, 400, cors);
  }

  let updated = null;
  const result = await updateMembers(env, (l) => {
    const m = findMember(l, email);
    if (!m) return null;
    if (body.role === 'admin' || body.role === 'member') m.role = body.role;
    if (body.status === 'active' || body.status === 'blocked') {
      // 정지를 풀었을 때 예전 토큰이 되살아나지 않도록 세대를 올립니다.
      if (m.status !== body.status) bumpEpoch(m);
      m.status = body.status;
    }
    m.updatedAt = new Date().toISOString();
    updated = m;
    return l;
  });
  if (!result.ok) return json({ message: '해당 회원을 찾을 수 없습니다.' }, 404, cors);
  return json({ member: publicMember(withRole(updated, env)) }, 200, cors);
}

/**
 * "비밀번호를 잊었습니다" 접수.
 *
 * 메일을 보낼 수단이 없으므로, 본인이 남긴 요청을 관리자 화면에 대기 목록으로
 * 띄웁니다. 텔레그램(Hermes)을 설정했다면 신청자가 스스로 새 비밀번호를 정할 수
 * 있는 1회용 링크가 알림에 함께 나가고, 관리자가 그 링크를 본인에게 전달합니다.
 *
 * 응답은 계정이 있든 없든 **항상 같습니다.** 그러지 않으면 이 창구가
 * "이 이메일이 가입돼 있는지" 확인하는 도구가 됩니다.
 */
async function requestReset(request, env, cors, waitUntil) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);

  if (email) {
    // updateMembers 의 mutate 는 동기 함수라, 토큰 해시를 먼저 계산해 두고
    // 요청 접수와 한 번의 쓰기로 저장합니다.
    const fresh = await newResetToken();
    const result = await updateMembers(env, (l) => {
      const m = findMember(l, email);
      if (!m) return null;
      const last = m.resetRequestedAt ? Date.parse(m.resetRequestedAt) : 0;
      // 연타해도 대기 목록이 도배되지 않게 합니다.
      if (Number.isFinite(last) && Date.now() - last < RESET_REQUEST_COOLDOWN_MS) return null;
      m.resetRequestedAt = new Date().toISOString();
      fresh.apply(m);
      return l;
    });
    // 실제로 접수됐을 때만(계정이 있고 쿨다운에 걸리지 않았을 때만) 알립니다.
    // 응답은 아래에서 항상 { ok: true } 로 같으므로, 알림 여부가 계정 존재를 흘리지 않습니다.
    if (result.ok) {
      const m = findMember(result.list, email);
      if (m) {
        const resetUrl = `${new URL(request.url).origin}/#/reset?token=${fresh.token}`;
        notifyResetRequest(env, waitUntil, m, resetUrl);
        // 메일 발송이 설정돼 있으면(EMAIL_WEBHOOK_*) 신청자 본인에게도 링크를 보냅니다.
        sendResetEmail(env, waitUntil, m, resetUrl);
      }
    }
  }
  return json({ ok: true }, 200, cors);
}

/**
 * 재설정 링크로 새 비밀번호 설정 (공개 — 링크에 담긴 토큰이 곧 인증입니다).
 * 토큰은 무작위 256비트라 추측할 수 없고, 유효 시간이 지나거나 한 번 쓰면
 * 폐기됩니다. 새 비밀번호는 가입과 같은 정책(8자 이상, 문자·숫자·특수문자)을
 * 지나고, 저장은 언제나 PBKDF2 해시로만 합니다.
 */
async function confirmReset(request, env, cors) {
  const body = await request.json().catch(() => null);
  const token = String(body?.token ?? '');
  const password = String(body?.password ?? '');
  if (!token) return json({ message: '재설정 링크가 올바르지 않습니다.' }, 400, cors);

  const result = await resetPasswordWithToken(token, password, env);
  if (!result.ok) return json({ message: result.message }, 400, cors);
  return json({ ok: true }, 200, cors);
}

async function resetMemberPassword(request, env, cors) {
  const body = await request.json().catch(() => null);
  const email = normEmail(body?.email);
  if (!email) return json({ message: '대상 이메일이 필요합니다.' }, 400, cors);

  const result = await issueTempPassword(email, env);
  if (!result.ok) return json({ message: '해당 회원을 찾을 수 없습니다.' }, 404, cors);

  // 메일을 보낼 수단이 없으므로 관리자가 직접 전달합니다.
  return json({ tempPassword: result.tempPassword }, 200, cors);
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

  const publicIds = new Set(projects.filter((p) => p.visibility === 'public').map((p) => p.id));
  const visible = subs
    .filter((s) => normEmail(s.author?.email) === normEmail(me.email) || publicIds.has(s.projectId))
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

/** 남의 업로드 폴더를 가리키지 못하게 막습니다. */
function ownsFiles(files, prefix, isAdmin) {
  if (isAdmin) return true;
  return (files || []).every((f) => typeof f?.key === 'string' && f.key.startsWith(`uploads/${prefix}/`));
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
  const closed = checkProjectOpen(projects, body.projectId);
  if (closed) return json({ message: closed }, 400, cors);

  const prefix = await memberKey(me.email);
  if (!ownsFiles(body.files, prefix, me.role === 'admin')) {
    return json({ message: '첨부 파일 경로가 올바르지 않습니다.' }, 400, cors);
  }

  const now = new Date().toISOString();
  const rec = {
    id: uid('s_'),
    projectId: body.projectId,
    author: authorOf(me),
    title: String(body.title).trim().slice(0, 200),
    body: String(body.body).trim().slice(0, 20000),
    files: Array.isArray(body.files) ? body.files.slice(0, 20) : [],
    status: 'submitted',
    createdAt: now,
    updatedAt: now,
  };

  await mutateIndex(env, 'submissions', (list) => { list.push(rec); return list; });
  notifySubmission(env, waitUntil, rec, projects.find((p) => p.id === rec.projectId));
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

  if (me.role !== 'admin') {
    const { data: projects } = await readIndex(env, 'projects');
    const closed = checkProjectOpen(projects, existing.projectId);
    if (closed) return json({ message: closed }, 400, cors);
  }

  const prefix = await memberKey(existing.author?.email || me.email);
  if (body.files && !ownsFiles(body.files, prefix, me.role === 'admin')) {
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

/* ============================================================ 업로드 == */

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
