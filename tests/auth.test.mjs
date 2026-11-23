/**
 * Google OAuth 2.0 (PKCE) 회원 인증 · 승인 · 권한 · 보안 테스트.
 * 메모리 R2 스텁 위에서 실제 shared/r2api.js + shared/google.js + shared/auth.js 를 돌립니다.
 */
import { MockBucket, TEST_GOOGLE_ENV, mockGoogleLogin } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';

const fails = [];
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

let bucket = new MockBucket();
let env = { BUCKET: bucket, ...TEST_GOOGLE_ENV, SIGNUP_POLICY: 'approval' };

/** 브라우저처럼 여러 쿠키(ah_oauth, ah_session)를 들고 다니는 클라이언트. */
function client(useEnv = env) {
  const jar = new Map();
  const call = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (jar.size) {
      init.headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await handleApi(new Request(`${ORIGIN}/api${path}`, init), useEnv, { basePath: '/api' });
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie')] : []);
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (!v || /Max-Age=0\b/i.test(sc)) jar.delete(k);
      else jar.set(k, v);
    }
    let data = null;
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('json')) data = await res.json().catch(() => null);
    return { status: res.status, data, res, cookies: jar };
  };
  call.reset = () => jar.clear();
  call.hasSession = () => jar.has('ah_session');
  call.sessionCookie = () => (jar.has('ah_session') ? `ah_session=${jar.get('ah_session')}` : '');
  return call;
}

console.log('\n== 기존 비밀번호 API 차단 ==');

await t('비밀번호 가입·로그인·비밀번호 찾기(method:code 포함)·재설정 모두 410 차단', async () => {
  const c = client();
  for (const [path, body] of [
    ['/auth/signup', { email: 'x@example.com', password: 'Password1!', name: 'X', institution: 'Y' }],
    ['/auth/login', { email: ADMIN, password: 'Password1!' }],
    ['/auth/forgot', { email: ADMIN, method: 'code' }],
    ['/auth/forgot', { email: ADMIN }],
    ['/auth/reset/confirm', { token: 'abc', password: 'Password1!' }],
    ['/auth/password', { current: 'a', next: 'Password1!' }],
    ['/auth/members/reset', { email: ADMIN }],
  ]) {
    const r = await c(path, { method: 'POST', body });
    eq(r.status, 410, `blocked ${path}`);
  }
});

console.log('\n== Google OAuth 2.0 (PKCE · state · nonce · email_verified) ==');

const admin = client();
await t('관리자 Google 이메일로 로그인하면 즉시 활성화 + 관리자 권한 + 프로필 설정 안내', async () => {
  const res = await mockGoogleLogin(admin, {
    email: ADMIN, name: '관리자', institution: '행정안전부',
  });
  eq(res.start.status, 302, 'start 302');
  eq(res.callback.status, 302, 'callback 302');
  if (!res.callbackLocation.includes('#/account?setup=1')) {
    throw new Error(`예상 리다이렉트 아님: ${res.callbackLocation}`);
  }
  if (!admin.hasSession()) throw new Error('세션 쿠키가 안 옴');
  eq(res.profile.status, 200, 'profile 저장');
  eq(res.profile.data.me.role, 'admin', 'admin role');
  eq(res.profile.data.me.needsProfile, false, 'profile 완료');
});

await t('응답에 googleSub·passwordHash 같은 민감 필드가 절대 노출되지 않음', async () => {
  const r = await admin('/auth/me');
  eq(r.status, 200, 'me status');
  const raw = JSON.stringify(r.data);
  if (raw.includes('googleSub') || raw.includes('passwordHash')) {
    throw new Error(`민감 필드 노출: ${raw}`);
  }
  if (r.res.headers.get('Cache-Control') !== 'no-store') {
    throw new Error('Cache-Control: no-store 누락');
  }
});

await t('세션 쿠키는 HttpOnly · SameSite=Lax · Secure 로 내려감', async () => {
  const c = client();
  const res = await mockGoogleLogin(c, { email: ADMIN, completeProfile: false });
  const sets = res.callback.res.headers.getSetCookie();
  const sess = sets.find((s) => s.startsWith('ah_session='));
  if (!sess) throw new Error('ah_session 쿠키 없음');
  if (!sess.includes('HttpOnly') || !sess.includes('SameSite=Lax') || !sess.includes('Secure')) {
    throw new Error(`보안 속성 누락: ${sess}`);
  }
});

await t('state 불일치(Login CSRF)는 invalid_state 로 거부되고 세션 미발급', async () => {
  const c = client();
  await c('/auth/google/start');
  const cb = await c('/auth/google/callback?code=fake&state=wrong-state');
  eq(cb.status, 302, 'status');
  if (!cb.res.headers.get('Location').includes('error=invalid_state')) {
    throw new Error(cb.res.headers.get('Location'));
  }
  if (c.hasSession()) throw new Error('세션이 발급되면 안 됨');
});

await t('email_verified=false 인 Google 계정은 거부', async () => {
  const c = client();
  const res = await mockGoogleLogin(c, {
    email: 'unverified@example.com', email_verified: false, completeProfile: false,
  });
  if (!res.callbackLocation.includes('error=unverified_email')) {
    throw new Error(`예상 오류 아님: ${res.callbackLocation}`);
  }
  if (c.hasSession()) throw new Error('세션이 발급되면 안 됨');
});

await t('nonce 불일치 id_token 거부', async () => {
  const c = client();
  const res = await mockGoogleLogin(c, {
    email: ADMIN,
    completeProfile: false,
    idTokenOverrides: { nonce: 'tampered-nonce' },
  });
  if (!res.callbackLocation.includes('error=invalid_state')) {
    throw new Error(`예상 오류 아님: ${res.callbackLocation}`);
  }
  if (c.hasSession()) throw new Error('세션이 발급되면 안 됨');
});

await t('Open Redirect 차단: 외부 next URL 은 무시하고 내부 / 로 이동', async () => {
  const c = client();
  const res = await mockGoogleLogin(c, {
    email: ADMIN, next: 'https://evil.example/phish', completeProfile: false,
  });
  if (!res.callbackLocation.startsWith(`${ORIGIN}/#/`)) {
    throw new Error(`외부 리다이렉트 허용됨: ${res.callbackLocation}`);
  }
});

await t('이미 등록된 이메일에 다른 Google sub 로 로그인 시도하면 거부(계정 탈취 방지)', async () => {
  const c = client();
  const res = await mockGoogleLogin(c, {
    email: ADMIN, sub: 'different-attacker-sub', completeProfile: false,
  });
  if (!res.callbackLocation.includes('error=google_mismatch')) {
    throw new Error(`예상 오류 아님: ${res.callbackLocation}`);
  }
  if (c.hasSession()) throw new Error('세션이 발급되면 안 됨');
});

console.log('\n== 가입 통제 (승인제 · 사전 등록 · 허용 도메인 · allowlist) ==');

const pendingUser = client();
await t('approval 정책(기본): 사전 미등록 Google 계정은 pending 으로 대기하고 세션 미발급', async () => {
  const res = await mockGoogleLogin(pendingUser, {
    email: 'newbie@gmail.com', name: '신규교육생', completeProfile: false,
  });
  if (!res.callbackLocation.includes('error=pending')) {
    throw new Error(`pending 이 아님: ${res.callbackLocation}`);
  }
  if (pendingUser.hasSession()) throw new Error('미승인 사용자에게 세션이 발급됨');
  const me = await pendingUser('/auth/me');
  eq(me.status, 401, '비로그인 상태');
});

await t('관리자가 pending 회원을 승인하면 Google 로그인 성공 + 프로필 입력 가능', async () => {
  const patch = await admin('/auth/members', {
    method: 'PATCH', body: { email: 'newbie@gmail.com', status: 'active' },
  });
  eq(patch.status, 200, '승인 200');
  const res = await mockGoogleLogin(pendingUser, {
    email: 'newbie@gmail.com', name: '신규교육생', institution: '한국서부발전',
  });
  eq(res.profile.status, 200, '프로필 저장');
  eq(res.profile.data.me.institution, '한국서부발전', '기관명');
  if (!pendingUser.hasSession()) throw new Error('승인 후 세션 발급 실패');
});

const alice = client();
await t('관리자가 이메일을 사전 등록하면 승인 대기 없이 즉시 로그인', async () => {
  const inv = await admin('/auth/members/invite', {
    method: 'POST',
    body: {
      members: [
        { email: 'alice@gmail.com', name: '앨리스', institution: '행정안전부' },
        { email: 'bob@gmail.com', name: '밥', institution: '한국서부발전' },
      ],
    },
  });
  eq(inv.status, 200, 'invite 200');
  eq(inv.data.added, 2, '2명 등록');

  const res = await mockGoogleLogin(alice, {
    email: 'alice@gmail.com', name: 'Alice Google', completeProfile: false,
  });
  // 이미 성명·기관명이 사전 등록돼 있으므로 프로필 입력 화면을 건너뛰고 바로 홈으로 갑니다.
  eq(res.callbackLocation, `${ORIGIN}/#/`, '바로 홈 이동');
  const me = await alice('/auth/me');
  eq(me.data.me.name, '앨리스', '사전 등록 이름 유지');
  eq(me.data.me.institution, '행정안전부', '사전 등록 기관 유지');
  eq(me.data.me.needsProfile, false, 'needsProfile false');
});

await t('allowlist 정책: 미등록 이메일은 pending 도 만들지 않고 not_invited 로 거절', async () => {
  const strictEnv = { ...env, SIGNUP_POLICY: 'allowlist' };
  const c = client(strictEnv);
  const res = await mockGoogleLogin(c, {
    email: 'stranger@gmail.com', name: '외부인', completeProfile: false,
  });
  if (!res.callbackLocation.includes('error=not_invited')) {
    throw new Error(res.callbackLocation);
  }
  const list = await admin('/auth/members');
  if (list.data.data.some((m) => m.email === 'stranger@gmail.com')) {
    throw new Error('allowlist 에서 외부인 레코드가 생성됨');
  }
});

await t('ALLOWED_EMAIL_DOMAINS 에 포함된 도메인은 사전 등록 없이도 즉시 승인', async () => {
  const domEnv = { ...env, SIGNUP_POLICY: 'allowlist', ALLOWED_EMAIL_DOMAINS: 'mois.go.kr,korea.kr' };
  const c = client(domEnv);
  const res = await mockGoogleLogin(c, {
    email: 'officer@mois.go.kr', name: '주무관', institution: '행정안전부',
  });
  eq(res.profile.status, 200, '도메인 허용 로그인');
  if (!c.hasSession()) throw new Error('세션 없음');
});

console.log('\n== 로그아웃 서버 측 무효화 · CSRF · 세션 보호 ==');

await t('로그아웃하면 탈취된 이전 쿠키도 서버에서 즉시 무효화됨', async () => {
  const c = client();
  await mockGoogleLogin(c, { email: 'bob@gmail.com', completeProfile: false });
  const stolenCookie = c.sessionCookie();
  if (!stolenCookie) throw new Error('쿠키 없음');

  // 로그아웃 실행
  const out = await c('/auth/logout', { method: 'POST' });
  eq(out.status, 200, 'logout 200');

  // 복사해 둔 이전 쿠키로 재접속 시도 → 401 이어야 함
  const replay = await handleApi(new Request(`${ORIGIN}/api/auth/me`, {
    headers: { Origin: ORIGIN, Cookie: stolenCookie },
  }), env, { basePath: '/api' });
  eq(replay.status, 401, '로그아웃 후 탈취 쿠키 차단');
});

await t('위조한 세션 쿠키는 거부', async () => {
  const r = await handleApi(new Request(`${ORIGIN}/api/auth/me`, {
    headers: { Origin: ORIGIN, Cookie: 'ah_session=eyJzdWIiOiJhbGljZUBnbWFpbC5jb20ifQ.fake' },
  }), env, { basePath: '/api' });
  eq(r.status, 401, 'status');
});

await t('Sec-Fetch-Site: cross-site 상태 변경 요청(CSRF)은 403 차단', async () => {
  const r = await alice('/posts', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { title: 'CSRF', body: 'attack' },
  });
  eq(r.status, 403, 'CSRF 차단');
});

console.log('\n== 권한 · 제출물 · 회원 관리 ==');

await t('비로그인은 프로젝트 목록·파일 모두 막힘', async () => {
  eq((await client()('/data/projects')).status, 401, 'projects');
  eq((await client()('/file/uploads/x.pdf')).status, 401, 'file');
});

await t('회원은 프로젝트를 읽을 수 있지만 저장은 관리자만 가능', async () => {
  const cur = await alice('/data/projects');
  eq(cur.status, 200, '회원 읽기');
  eq((await alice('/data/projects', { method: 'PUT', body: { etag: cur.data.etag, data: [] } })).status, 403, '회원 쓰기 차단');
  const created = await admin('/data/projects', {
    method: 'PUT',
    body: {
      etag: cur.data.etag,
      data: [{ id: 'p_test1', title: '1주차 과제', description: '설명', status: 'open', visibility: 'private' }],
    },
  });
  eq(created.status, 200, '관리자 개설');
});

await t('제출물 생성·수정·삭제 권한 격리', async () => {
  const up = await alice('/upload?name=report.pdf', {
    method: 'POST', raw: new Uint8Array([1, 2, 3]), headers: { 'X-File-Type': 'application/pdf' },
  });
  eq(up.status, 200, '업로드');
  const sub = await alice('/submissions', {
    method: 'POST',
    body: { projectId: 'p_test1', title: '앨리스 과제', body: '내용', files: [{ key: up.data.key, name: 'report.pdf' }] },
  });
  eq(sub.status, 200, '제출');
  eq(sub.data.submission.author.email, 'alice@gmail.com', '서버 세션 작성자');

  const bob = client();
  await mockGoogleLogin(bob, { email: 'bob@gmail.com', completeProfile: false });
  eq((await bob(`/submissions/${sub.data.submission.id}`, { method: 'PATCH', body: { title: '변조' } })).status, 403, '남의 제출물 수정 차단');
  eq((await bob(`/submissions/${sub.data.submission.id}`, { method: 'DELETE' })).status, 403, '남의 제출물 삭제 차단');
});

await t('승인 대기(pending) 회원은 이용 정지 없이 바로 거절(삭제) 가능', async () => {
  const sp = client();
  await mockGoogleLogin(sp, { email: 'spammer@gmail.com', name: '스팸', completeProfile: false });
  const del = await admin('/auth/members', { method: 'DELETE', body: { email: 'spammer@gmail.com' } });
  eq(del.status, 200, 'pending 즉시 삭제');
});

await t('이용중(active) 회원은 먼저 정지해야 삭제 가능, 정지 시 기존 세션 즉시 무효화', async () => {
  const bob = client();
  await mockGoogleLogin(bob, { email: 'bob@gmail.com', completeProfile: false });
  eq((await admin('/auth/members', { method: 'DELETE', body: { email: 'bob@gmail.com' } })).status, 400, 'active 바로 삭제 불가');
  eq((await admin('/auth/members', { method: 'PATCH', body: { email: 'bob@gmail.com', status: 'blocked' } })).status, 200, '정지');
  eq((await bob('/auth/me')).status, 401, '정지 즉시 세션 차단');
  eq((await admin('/auth/members', { method: 'DELETE', body: { email: 'bob@gmail.com' } })).status, 200, '정지 후 삭제');
});

await t('health 가 Google 로그인 모드·설정 상태를 알려줌', async () => {
  const h = await admin('/health');
  eq(h.status, 200, 'health');
  eq(h.data.authMode, 'google', 'authMode');
  eq(h.data.googleEnabled, true, 'googleEnabled');
  eq(h.data.signupPolicy, 'approval', 'signupPolicy');
  eq(h.data.signedIn, true, 'signedIn');
});

console.log('\n================ 결과 ================');
if (fails.length) {
  console.log(`실패 ${fails.length}건:\n - ${fails.join('\n - ')}`);
  process.exit(1);
}
console.log('모든 검사 통과');
