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
await t('approval 정책(기본): 사전 미등록 Google 계정은 #/onboard 로 이동해 소속·성명 입력 후 pending 대기', async () => {
  const res = await mockGoogleLogin(pendingUser, {
    email: 'newbie@gmail.com', name: 'Newbie', completeProfile: false,
  });
  if (!res.callbackLocation.includes('#/onboard')) {
    throw new Error(`onboard 가 아님: ${res.callbackLocation}`);
  }
  if (pendingUser.hasSession()) throw new Error('미승인 사용자에게 세션이 발급됨');
  eq((await pendingUser('/auth/me')).status, 401, '온보딩 단계에서는 비로그인');

  const obInfo = await pendingUser('/auth/onboard');
  eq(obInfo.status, 200, '온보딩 정보 조회');
  eq(obInfo.data.email, 'newbie@gmail.com', '온보딩 이메일');

  // 소속·성명 누락은 거부
  eq((await pendingUser('/auth/onboard', { method: 'POST', body: { name: '', institution: '' } })).status, 400, '필수값 검증');

  const sub = await pendingUser('/auth/onboard', {
    method: 'POST', body: { name: '신규교육생', institution: '한국서부발전' },
  });
  eq(sub.status, 200, '온보딩 제출 200');
  eq(sub.data.status, 'pending', 'pending 상태');
  if (pendingUser.hasSession()) throw new Error('제출 후에도 세션이 발급되면 안 됨');

  // 제출 완료된 pending 사용자가 다시 로그인 시도하면 바로 error=pending 으로 이동
  const again = await mockGoogleLogin(pendingUser, {
    email: 'newbie@gmail.com', name: 'Newbie', completeProfile: false,
  });
  if (!again.callbackLocation.includes('error=pending')) {
    throw new Error(`재시도 시 pending 이어야 함: ${again.callbackLocation}`);
  }
});

await t('관리자가 pending 회원을 승인하면 입력해 둔 소속·성명 그대로 바로 홈 진입', async () => {
  const patch = await admin('/auth/members', {
    method: 'PATCH', body: { email: 'newbie@gmail.com', status: 'active' },
  });
  eq(patch.status, 200, '승인 200');
  const res = await mockGoogleLogin(pendingUser, {
    email: 'newbie@gmail.com', name: 'Newbie', completeProfile: false,
  });
  eq(res.callbackLocation, `${ORIGIN}/#/`, '이미 소속·성명이 있어 바로 홈 이동');
  const me = await pendingUser('/auth/me');
  eq(me.data.me.name, '신규교육생', '입력한 성명 유지');
  eq(me.data.me.institution, '한국서부발전', '입력한 소속 유지');
  if (!pendingUser.hasSession()) throw new Error('승인 후 세션 발급 실패');
});

await t('기존 비-구글 회원 연계(방식 A): 온보딩 연계 신청 → 관리자 승인 시 제출물·게시글·페스타·권한 일괄 이관', async () => {
  // 기존 비-구글 회원(hong@korea.kr)과 제출물·첨부·소통방·페스타 기록을 시드합니다.
  const rawMembers = JSON.parse(await (await bucket.get('data/members.json')).text());
  rawMembers.push({
    email: 'hong@korea.kr',
    name: '홍길동',
    institution: '행정안전부',
    passwordHash: 'legacy-hash',
    role: 'leader',
    team: 3,
    status: 'active',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
  });
  await bucket.put('data/members.json', JSON.stringify(rawMembers));

  // 기존 회원의 업로드 폴더 키 생성 (memberKey 규칙: sha256 앞 8바이트)
  const digestBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hong@korea.kr'));
  const legacyPrefix = `m_${Array.from(new Uint8Array(digestBuf).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const legacyFileKey = `uploads/${legacyPrefix}/f_old_report.pdf`;
  await bucket.put(legacyFileKey, new Uint8Array([1, 2, 3]));
  await bucket.put('data/projects.json', JSON.stringify([
    { id: 'p_legacy', title: '기존 과제', description: '설명', status: 'open', visibility: 'private' },
  ]));
  await bucket.put('data/submissions.json', JSON.stringify([{
    id: 's_legacy_1',
    projectId: 'p_legacy',
    author: { email: 'hong@korea.kr', name: '홍길동', institution: '행정안전부' },
    title: '기존 제출물',
    body: '내용',
    files: [{ id: 'f_old', key: legacyFileKey, name: 'report.pdf' }],
    status: 'submitted',
    createdAt: '2026-08-02T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
  }]));
  await bucket.put('data/posts.json', JSON.stringify([{
    id: 'b_legacy_1',
    author: { email: 'hong@korea.kr', name: '홍길동', institution: '행정안전부' },
    title: '기존 글',
    body: '본문',
    comments: [{ id: 'c_1', author: { email: 'hong@korea.kr', name: '홍길동', institution: '행정안전부' }, body: '댓글' }],
  }]));
  await bucket.put('data/festa.json', JSON.stringify({
    version: 1, phase: 'open', deadline: '2027-12-07',
    entries: [{
      id: 'fe_legacy_1', title: '기존 출품작', description: '설명', institution: '행정안전부',
      author: { email: 'hong@korea.kr', name: '홍길동', institution: '행정안전부', memberCreatedAt: '2026-08-01T00:00:00Z' },
      files: [],
    }],
    scores: [], uploads: [],
  }));

  // 1) 교육생이 새 Google 계정(hong.new@gmail.com)으로 로그인 → 온보딩에서 소속·성명 + 기존 이메일 신청
  const hong = client();
  const res = await mockGoogleLogin(hong, { email: 'hong.new@gmail.com', name: 'Gildong', completeProfile: false });
  if (!res.callbackLocation.includes('#/onboard')) throw new Error(res.callbackLocation);
  const ob = await hong('/auth/onboard', {
    method: 'POST',
    body: { name: '홍길동', institution: '행정안전부', legacyEmail: 'hong@korea.kr' },
  });
  eq(ob.status, 200, '연계 포함 온보딩 신청');
  eq(ob.data.status, 'pending', '승인 전에는 pending');

  // 2) 관리자가 승인 + 연계 실행
  const merged = await admin('/auth/members/link', {
    method: 'POST',
    body: { email: 'hong.new@gmail.com', action: 'approve' },
  });
  eq(merged.status, 200, `연계 승인: ${JSON.stringify(merged.data)}`);
  eq(merged.data.member.role, 'leader', '기존 그룹장 권한 승계');
  eq(merged.data.member.team, 3, '기존 3조 승계');
  eq(merged.data.migrated.submissions, 1, '제출물 1건 이관');
  eq(merged.data.migrated.posts, 2, '글+댓글 2건 이관');
  eq(merged.data.migrated.festa, 1, '페스타 1건 이관');

  // 3) 새 Google 계정으로 로그인하면 기존 제출물 조회·수정(기존 첨부 유지) 및 페스타 소유권까지 유지됨
  await mockGoogleLogin(hong, { email: 'hong.new@gmail.com', completeProfile: false });
  const subs = await hong('/submissions');
  eq(subs.status, 200, '내 제출물 조회');
  if (!subs.data.data.some((s) => s.id === 's_legacy_1')) throw new Error('기존 제출물 누락');

  const patchSub = await hong('/submissions/s_legacy_1', {
    method: 'PATCH',
    body: { title: '수정된 제출물', files: [{ id: 'f_old', key: legacyFileKey, name: 'report.pdf' }] },
  });
  eq(patchSub.status, 200, `기존 첨부 포함 제출물 수정: ${JSON.stringify(patchSub.data)}`);

  const festa = await hong('/festa');
  eq(festa.status, 200, '페스타 조회');
  if (!festa.data.mine || festa.data.mine.id !== 'fe_legacy_1') {
    throw new Error(`페스타 소유권 승계 실패: ${JSON.stringify(festa.data.mine)}`);
  }
});

await t('잘못된 기존 이메일로 연계 요청 시 관리자가 이메일 수정(update) 또는 수정 후 연계 승인 가능', async () => {
  const mObj = await bucket.get('data/members.json');
  const mList = JSON.parse(await mObj.text());
  mList.push({
    email: 'typo.real@mois.go.kr',
    name: '김오타',
    institution: '행정안전부',
    role: 'member',
    status: 'active',
    createdAt: '2026-08-05T00:00:00Z',
    updatedAt: '2026-08-05T00:00:00Z',
  });
  await bucket.put('data/members.json', JSON.stringify(mList, null, 2));

  const typoUser = client();
  await mockGoogleLogin(typoUser, { email: 'kim.ota@gmail.com', name: '김오타', completeProfile: false });
  eq((await typoUser('/auth/onboard', {
    method: 'POST',
    body: { name: '김오타', institution: '행정안전부', legacyEmail: 'typo.wrong@mois.go.kr' },
  })).status, 200, '잘못된 기존 이메일로 온보딩 요청');

  // 1) 잘못된 형식이나 자기 이메일로 수정 시 400 차단
  eq((await admin('/auth/members/link', {
    method: 'POST',
    body: { email: 'kim.ota@gmail.com', legacyEmail: 'not-an-email', action: 'update' },
  })).status, 400, '잘못된 이메일 형식 거부');
  eq((await admin('/auth/members/link', {
    method: 'POST',
    body: { email: 'kim.ota@gmail.com', legacyEmail: 'kim.ota@gmail.com', action: 'update' },
  })).status, 400, '동일 이메일 수정 거부');

  // 2) 관리자가 연계 요청 이메일만 올바른 주소로 수정 저장
  const updated = await admin('/auth/members/link', {
    method: 'POST',
    body: { email: 'kim.ota@gmail.com', legacyEmail: 'typo.real@mois.go.kr', action: 'update' },
  });
  eq(updated.status, 200, '이메일 수정 저장');
  eq(updated.data.member.linkRequestedEmail, 'typo.real@mois.go.kr', '수정된 연계 이메일 반영');
  eq(updated.data.member.status, 'pending', 'update 만 했을 때는 아직 pending 유지');

  // 3) 수정된 이메일로 바로 승인 + 연계 완료
  const approved = await admin('/auth/members/link', {
    method: 'POST',
    body: { email: 'kim.ota@gmail.com', legacyEmail: 'typo.real@mois.go.kr', action: 'approve' },
  });
  eq(approved.status, 200, '수정된 이메일로 연계 승인');
  eq(approved.data.member.status, 'active', '승인 완료');
  eq(approved.data.member.linkRequestedEmail, null, '요청 이메일 정리');
  if (!(approved.data.member.linkedFromEmails || []).includes('typo.real@mois.go.kr')) {
    throw new Error('linkedFromEmails 누락');
  }
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
  await sp('/auth/onboard', { method: 'POST', body: { name: '스팸', institution: '외부' } });
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
