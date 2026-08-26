/**
 * 회원 인증 · 권한 테스트.
 * 메모리 R2 스텁 위에서 실제 shared/r2api.js + shared/auth.js 를 돌립니다.
 * 브라우저 없이 서버 규칙(누가 무엇을 할 수 있는가)을 확인합니다.
 */
import { MockBucket } from './mock-r2.mjs';
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
let env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000 };   // 테스트 속도를 위해 최소치

/** 브라우저처럼 쿠키를 들고 다니는 클라이언트. */
function client() {
  let cookie = '';
  const call = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await handleApi(new Request(`${ORIGIN}/api${path}`, init), env, { basePath: '/api' });
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const pair = set.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;   // Max-Age=0 이면 값이 비어 로그아웃
    }
    let data = null;
    const ct = res.headers.get('Content-Type') || '';
    if (ct.includes('json')) data = await res.json().catch(() => null);
    return { status: res.status, data, res, get cookie() { return cookie; } };
  };
  call.reset = () => { cookie = ''; };
  call.hasCookie = () => Boolean(cookie);
  return call;
}

const signup = (c, email, extra = {}) => c('/auth/signup', {
  method: 'POST',
  body: {
    email, password: 'hunter2!hunter2', name: '홍길동', institution: '한국디자인진흥원', ...extra,
  },
});

console.log('\n== 가입 ==');

const alice = client();
await t('누구나 즉시 가입 — 가입과 동시에 로그인', async () => {
  const r = await signup(alice, 'alice@example.com', { name: '앨리스' });
  eq(r.status, 200, 'status');
  eq(r.data.me.email, 'alice@example.com', 'email');
  eq(r.data.me.role, 'member', 'role');
  if (!alice.hasCookie()) throw new Error('세션 쿠키가 안 옴');
});

await t('응답에 비밀번호 해시가 절대 포함되지 않음', async () => {
  const r = await alice('/auth/me');
  const text = JSON.stringify(r.data);
  if (text.includes('pbkdf2')) throw new Error('해시가 새어나감');
  if ('passwordHash' in r.data.me) throw new Error('passwordHash 필드 노출');
});

await t('같은 이메일로 재가입 불가', async () => {
  const r = await signup(client(), 'alice@example.com');
  eq(r.status, 409, 'status');
});

await t('대소문자만 다른 이메일도 같은 계정으로 취급', async () => {
  const r = await signup(client(), 'Alice@Example.COM');
  eq(r.status, 409, 'status');
});

await t('짧은 비밀번호 거부', async () => {
  const r = await signup(client(), 'short@example.com', { password: 'abc' });
  eq(r.status, 400, 'status');
  if (!r.data.errors?.password) throw new Error('오류 안내 없음');
});

await t('필수 항목 누락 거부', async () => {
  const r = await signup(client(), 'x@example.com', { name: '', institution: '' });
  eq(r.status, 400, 'status');
  if (!r.data.errors?.name || !r.data.errors?.institution) throw new Error('오류 안내 부족');
});

console.log('\n== 로그인 ==');

await t('틀린 비밀번호 거부 — 계정 유무를 알려주지 않음', async () => {
  const a = await client()('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'wrong-password' } });
  const b = await client()('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong-password' } });
  eq(a.status, 401, '가입된 계정');
  eq(b.status, 401, '없는 계정');
  eq(a.data.message, b.data.message, '두 응답 문구가 같아야 함');
});

await t('맞는 비밀번호로 로그인', async () => {
  const c = client();
  const r = await c('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'hunter2!hunter2' } });
  eq(r.status, 200, 'status');
  if (!c.hasCookie()) throw new Error('쿠키 없음');
});

await t('세션 쿠키는 HttpOnly · SameSite 로 내려감', async () => {
  const res = await handleApi(new Request(`${ORIGIN}/api/auth/login`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'hunter2!hunter2' }),
  }), env, { basePath: '/api' });
  const set = res.headers.get('Set-Cookie') || '';
  if (!set.includes('HttpOnly')) throw new Error('HttpOnly 없음');
  if (!set.includes('SameSite=Lax')) throw new Error('SameSite 없음');
  if (!set.includes('Secure')) throw new Error('https 인데 Secure 없음');
});

await t('위조한 세션 쿠키는 거부', async () => {
  const r = await handleApi(new Request(`${ORIGIN}/api/auth/me`, {
    headers: { Origin: ORIGIN, Cookie: 'ah_session=eyJzdWIiOiJhbGljZUBleGFtcGxlLmNvbSJ9.fake' },
  }), env, { basePath: '/api' });
  eq(r.status, 401, 'status');
});

await t('로그아웃하면 세션이 끊김', async () => {
  const c = client();
  await c('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'hunter2!hunter2' } });
  eq((await c('/auth/me')).status, 200, '로그아웃 전');
  await c('/auth/logout', { method: 'POST' });
  eq((await c('/auth/me')).status, 401, '로그아웃 후');
});

await t('연속 실패 8회면 잠김', async () => {
  await signup(client(), 'lock@example.com');
  const c = client();
  let last;
  for (let i = 0; i < 8; i += 1) {
    last = await c('/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: 'nope-nope-nope' } });
  }
  eq(last.status, 401, '8회째까지는 401');
  // 이제 올바른 비밀번호여도 잠금 때문에 막혀야 합니다.
  const blocked = await c('/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: 'hunter2!hunter2' } });
  eq(blocked.status, 429, '잠금 상태');
});

console.log('\n== 권한 ==');

const admin = client();
await t('관리자 이메일로 가입하면 자동으로 관리자', async () => {
  const r = await signup(admin, ADMIN, { name: '관리자' });
  eq(r.status, 200, 'status');
  eq(r.data.me.role, 'admin', 'role');
});

await t('비로그인은 프로젝트 목록도 못 봄', async () => {
  const r = await client()('/data/projects');
  eq(r.status, 401, 'status');
});

await t('회원은 프로젝트를 읽을 수 있음', async () => {
  const r = await alice('/data/projects');
  eq(r.status, 200, 'status');
});

await t('회원은 프로젝트를 저장할 수 없음', async () => {
  const cur = await alice('/data/projects');
  const r = await alice('/data/projects', { method: 'PUT', body: { etag: cur.data.etag, data: [] } });
  eq(r.status, 403, 'status');
});

let projectId;
await t('관리자는 프로젝트를 개설할 수 있음', async () => {
  const cur = await admin('/data/projects');
  projectId = 'p_test1';
  const r = await admin('/data/projects', {
    method: 'PUT',
    body: {
      etag: cur.data.etag,
      data: [{ id: projectId, title: '1주차 · 분석', status: 'open', visibility: 'private', createdAt: new Date().toISOString() }],
    },
  });
  eq(r.status, 200, 'status');
});

await t('회원 명부는 /data 로 절대 나오지 않음', async () => {
  for (const name of ['members', 'member', 'session']) {
    eq((await admin(`/data/${name}`)).status, 404, `노출됨: ${name}`);
  }
});

await t('회원 목록은 관리자만 볼 수 있고 해시가 없음', async () => {
  eq((await alice('/auth/members')).status, 403, '회원 접근');
  const r = await admin('/auth/members');
  eq(r.status, 200, '관리자 접근');
  if (JSON.stringify(r.data).includes('pbkdf2')) throw new Error('해시 노출');
  if (!r.data.data.some((m) => m.email === 'alice@example.com')) throw new Error('목록 누락');
});

console.log('\n== 제출물 ==');

let aliceFileKey;
await t('회원 업로드는 자기 폴더로만 들어감', async () => {
  const r = await alice('/upload?name=%EC%8B%9C%EC%95%88.png', {
    method: 'POST', raw: new Uint8Array([137, 80, 78, 71]), headers: { 'X-File-Type': 'image/png' },
  });
  eq(r.status, 200, 'status');
  aliceFileKey = r.data.key;
  if (!/^uploads\/m_[0-9a-f]{16}\//.test(aliceFileKey)) throw new Error(`키: ${aliceFileKey}`);
});

await t('비로그인은 업로드 불가', async () => {
  const r = await client()('/upload?name=a.png', { method: 'POST', raw: new Uint8Array([1]) });
  eq(r.status, 401, 'status');
});

let aliceSubId;
await t('제출하면 작성자는 서버가 세션에서 채움', async () => {
  const r = await alice('/submissions', {
    method: 'POST',
    body: {
      projectId,
      title: '제출합니다',
      body: '내용입니다',
      files: [{ id: 'f1', name: '시안.png', size: 4, type: 'image/png', storage: 'r2', key: aliceFileKey }],
      // 남의 명의로 넣으려는 시도 — 무시돼야 합니다.
      author: { email: ADMIN, name: '관리자', institution: '위조' },
    },
  });
  eq(r.status, 200, 'status');
  aliceSubId = r.data.submission.id;
  eq(r.data.submission.author.email, 'alice@example.com', '작성자 이메일');
  eq(r.data.submission.author.name, '앨리스', '작성자 이름');
});

await t('남의 업로드 폴더를 첨부로 지정하면 거부', async () => {
  const bob = client();
  await signup(bob, 'bob@example.com', { name: '밥' });
  const r = await bob('/submissions', {
    method: 'POST',
    body: { projectId, title: '가로채기', body: '시도', files: [{ key: aliceFileKey, name: 'x.png' }] },
  });
  eq(r.status, 400, 'status');
});

await t('마감된 프로젝트에는 제출 불가', async () => {
  const cur = await admin('/data/projects');
  const closed = structuredClone(cur.data.data);
  closed.push({ id: 'p_closed', title: '마감됨', status: 'closed', visibility: 'private', createdAt: new Date().toISOString() });
  await admin('/data/projects', { method: 'PUT', body: { etag: cur.data.etag, data: closed } });

  const r = await alice('/submissions', {
    method: 'POST', body: { projectId: 'p_closed', title: 'x', body: 'y', files: [] },
  });
  eq(r.status, 400, 'status');
});

await t('본인 제출물은 수정 가능', async () => {
  const r = await alice(`/submissions/${aliceSubId}`, { method: 'PATCH', body: { title: '수정된 제목' } });
  eq(r.status, 200, 'status');
  eq(r.data.submission.title, '수정된 제목', '제목');
});

await t('남의 제출물은 수정 불가', async () => {
  const bob = client();
  await bob('/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'hunter2!hunter2' } });
  const r = await bob(`/submissions/${aliceSubId}`, { method: 'PATCH', body: { title: '가로채기' } });
  eq(r.status, 403, 'status');
});

await t('남의 제출물은 삭제 불가', async () => {
  const bob = client();
  await bob('/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'hunter2!hunter2' } });
  const r = await bob(`/submissions/${aliceSubId}`, { method: 'DELETE' });
  eq(r.status, 403, 'status');
  eq((await alice(`/submissions`)).data.data.some((s) => s.id === aliceSubId), true, '아직 살아있어야 함');
});

await t('비공개 프로젝트의 남의 제출물은 목록에 안 보임', async () => {
  const bob = client();
  await bob('/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'hunter2!hunter2' } });
  const r = await bob('/submissions');
  eq(r.status, 200, 'status');
  eq(r.data.data.some((s) => s.id === aliceSubId), false, '앨리스 제출물이 보임');
});

await t('공개 프로젝트면 보이되 이메일은 가려짐', async () => {
  const cur = await admin('/data/projects');
  const opened = structuredClone(cur.data.data).map((p) => (
    p.id === projectId ? { ...p, visibility: 'public' } : p));
  await admin('/data/projects', { method: 'PUT', body: { etag: cur.data.etag, data: opened } });

  const bob = client();
  await bob('/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'hunter2!hunter2' } });
  const seen = (await bob('/submissions')).data.data.find((s) => s.id === aliceSubId);
  if (!seen) throw new Error('공개인데 안 보임');
  eq(seen.author.name, '앨리스', '이름은 보임');
  if (seen.author.email) throw new Error('이메일이 노출됨');
});

await t('관리자는 전부 보고 이메일도 보임', async () => {
  const seen = (await admin('/submissions')).data.data.find((s) => s.id === aliceSubId);
  eq(seen.author.email, 'alice@example.com', '이메일');
});

await t('관리자는 남의 제출물도 삭제 가능 — 첨부까지 정리', async () => {
  const key = aliceFileKey;
  if (!bucket.objects.has(key)) throw new Error('사전 조건: 첨부가 있어야 함');
  const r = await admin(`/submissions/${aliceSubId}`, { method: 'DELETE' });
  eq(r.status, 200, 'status');
  if (bucket.objects.has(key)) throw new Error('첨부가 남음');
});

console.log('\n== 비밀번호 관리 ==');

await t('본인 비밀번호 변경', async () => {
  const c = client();
  await signup(c, 'pw@example.com');
  const bad = await c('/auth/password', { method: 'POST', body: { current: 'wrong-wrong', next: 'newpassword1' } });
  eq(bad.status, 401, '현재 비밀번호 틀림');

  const ok = await c('/auth/password', { method: 'POST', body: { current: 'hunter2!hunter2', next: 'newpassword1' } });
  eq(ok.status, 200, '변경 성공');

  const relog = client();
  eq((await relog('/auth/login', { method: 'POST', body: { email: 'pw@example.com', password: 'newpassword1' } })).status, 200, '새 비번으로 로그인');
  eq((await client()('/auth/login', { method: 'POST', body: { email: 'pw@example.com', password: 'hunter2!hunter2' } })).status, 401, '옛 비번은 막힘');
});

await t('관리자가 임시 비밀번호로 초기화', async () => {
  await signup(client(), 'reset@example.com');
  const r = await admin('/auth/members/reset', { method: 'POST', body: { email: 'reset@example.com' } });
  eq(r.status, 200, 'status');
  const temp = r.data.tempPassword;
  if (!temp || temp.length < 8) throw new Error('임시 비밀번호가 이상함');

  const c = client();
  const login = await c('/auth/login', { method: 'POST', body: { email: 'reset@example.com', password: temp } });
  eq(login.status, 200, '임시 비번 로그인');
  eq(login.data.me.mustChangePassword, true, '변경 안내 플래그');
});

await t('회원은 남의 비밀번호를 초기화할 수 없음', async () => {
  const r = await alice('/auth/members/reset', { method: 'POST', body: { email: 'bob@example.com' } });
  eq(r.status, 403, 'status');
});

console.log('\n== 계정 정지 ==');

await t('관리자가 정지하면 로그인·세션 모두 막힘', async () => {
  const c = client();
  await signup(c, 'banned@example.com');
  eq((await c('/auth/me')).status, 200, '정지 전 세션');

  const r = await admin('/auth/members', { method: 'PATCH', body: { email: 'banned@example.com', status: 'blocked' } });
  eq(r.status, 200, '정지 처리');

  eq((await c('/auth/me')).status, 401, '기존 세션 무효화');
  eq((await client()('/auth/login', { method: 'POST', body: { email: 'banned@example.com', password: 'hunter2!hunter2' } })).status, 403, '재로그인 차단');
});

await t('관리자가 자기 권한은 못 바꿈', async () => {
  const r = await admin('/auth/members', { method: 'PATCH', body: { email: ADMIN, role: 'member' } });
  eq(r.status, 400, 'status');
});

await t('회원을 관리자로 승격 가능', async () => {
  const r = await admin('/auth/members', { method: 'PATCH', body: { email: 'bob@example.com', role: 'admin' } });
  eq(r.status, 200, 'status');
  eq(r.data.member.role, 'admin', 'role');

  const bob = client();
  await bob('/auth/login', { method: 'POST', body: { email: 'bob@example.com', password: 'hunter2!hunter2' } });
  eq((await bob('/auth/members')).status, 200, '관리자 기능 사용 가능');
});

console.log('\n== 파일 접근 ==');

await t('비로그인은 파일을 받을 수 없음', async () => {
  const up = await alice('/upload?name=doc.pdf', {
    method: 'POST', raw: new Uint8Array([37, 80, 68, 70]), headers: { 'X-File-Type': 'application/pdf' },
  });
  const r = await client()(`/file/${encodeURI(up.data.key)}`);
  eq(r.status, 401, 'status');
});

await t('로그인하면 파일을 받을 수 있고 보안 헤더가 붙음', async () => {
  const up = await alice('/upload?name=doc2.pdf', {
    method: 'POST', raw: new Uint8Array([37, 80, 68, 70]), headers: { 'X-File-Type': 'application/pdf' },
  });
  const r = await alice(`/file/${encodeURI(up.data.key)}`);
  eq(r.status, 200, 'status');
  eq(r.res.headers.get('X-Content-Type-Options'), 'nosniff', 'nosniff');
  eq(r.res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox", 'CSP');
  if (!(r.res.headers.get('Cache-Control') || '').includes('private')) throw new Error('private 캐시 아님');
});

await t('회원은 파일을 지울 수 없고 관리자는 지울 수 있음', async () => {
  const up = await alice('/upload?name=doc3.pdf', {
    method: 'POST', raw: new Uint8Array([37, 80, 68, 70]), headers: { 'X-File-Type': 'application/pdf' },
  });
  eq((await alice(`/file/${encodeURI(up.data.key)}`, { method: 'DELETE' })).status, 403, '회원');
  eq((await admin(`/file/${encodeURI(up.data.key)}`, { method: 'DELETE' })).status, 200, '관리자');
  if (bucket.objects.has(up.data.key)) throw new Error('파일이 남음');
});

await t('회원은 강의자료 업로드 불가', async () => {
  const r = await alice('/upload?kind=material&materialId=m_abc&name=x.pdf', {
    method: 'POST', raw: new Uint8Array([37]), headers: { 'X-File-Type': 'application/pdf' },
  });
  eq(r.status, 403, 'status');
});

await t('관리자 강의자료 업로드는 materials 폴더로', async () => {
  const r = await admin('/upload?kind=material&materialId=m_abc123&name=1%EA%B0%95.pdf', {
    method: 'POST', raw: new Uint8Array([37, 80, 68, 70]), headers: { 'X-File-Type': 'application/pdf' },
  });
  eq(r.status, 200, 'status');
  if (!r.data.key.startsWith('uploads/materials/m_abc123/')) throw new Error(r.data.key);
});

console.log('\n== 소통방 ==');

// 밥은 앞에서 관리자로 승격됐으므로, 소통방에는 평범한 회원을 따로 하나 만듭니다.
const talker = client();
await t('소통방 시험용 회원 준비', async () => {
  const r = await signup(talker, 'talker@example.com', { name: '수다', institution: '한국정보화진흥원' });
  eq(r.status, 200, 'status');
  eq(r.data.me.role, 'member', '일반 회원이어야 함');
});

let postId;
await t('회원이 글을 남기면 글쓴이를 서버가 채움', async () => {
  const r = await alice('/posts', {
    method: 'POST',
    body: { title: '자료 요청', body: '1주차 슬라이드 다시 올려주세요.', author: { name: '해커' } },
  });
  eq(r.status, 200, 'status');
  eq(r.data.post.author.name, '앨리스', '글쓴이');
  eq(r.data.post.author.email, 'alice@example.com', '이메일');
  eq(r.data.post.pinned, false, '공지 아님');
  postId = r.data.post.id;
});

await t('비회원은 목록도 글쓰기도 막힘', async () => {
  eq((await client()('/posts')).status, 401, '목록');
  eq((await client()('/posts', { method: 'POST', body: { title: 'a', body: 'b' } })).status, 401, '글쓰기');
});

await t('제목이나 내용이 비면 거부', async () => {
  eq((await alice('/posts', { method: 'POST', body: { title: '', body: 'x' } })).status, 400, '제목 없음');
  eq((await alice('/posts', { method: 'POST', body: { title: 'x', body: '  ' } })).status, 400, '내용 없음');
});

await t('회원은 스스로 공지로 만들 수 없음', async () => {
  const made = await alice('/posts', { method: 'POST', body: { title: '가짜 공지', body: 'x', pinned: true } });
  eq(made.data.post.pinned, false, '생성 시');

  const patched = await alice(`/posts/${made.data.post.id}`, { method: 'PATCH', body: { pinned: true } });
  eq(patched.status, 200, '요청 자체는 성공');
  eq(patched.data.post.pinned, false, '수정 시');

  await alice(`/posts/${made.data.post.id}`, { method: 'DELETE' });
});

await t('관리자가 공지로 지정하면 목록 맨 위로', async () => {
  await alice('/posts', { method: 'POST', body: { title: '나중 글', body: '더 최근입니다.' } });

  const pin = await admin(`/posts/${postId}`, { method: 'PATCH', body: { pinned: true } });
  eq(pin.status, 200, 'status');
  eq(pin.data.post.pinned, true, 'pinned');

  const rows = (await alice('/posts')).data.data;
  eq(rows[0].id, postId, `맨 위가 공지여야 함 (${rows.map((p) => p.title).join(',')})`);
});

await t('남의 글은 수정·삭제 불가', async () => {
  eq((await talker(`/posts/${postId}`, { method: 'PATCH', body: { title: '가로채기' } })).status, 403, '수정');
  eq((await talker(`/posts/${postId}`, { method: 'DELETE' })).status, 403, '삭제');
});

await t('본인 글은 수정 가능', async () => {
  const r = await alice(`/posts/${postId}`, { method: 'PATCH', body: { body: '내용을 고쳤습니다.' } });
  eq(r.status, 200, 'status');
  eq(r.data.post.body, '내용을 고쳤습니다.', '내용');
  eq(r.data.post.pinned, true, '공지 상태는 유지');
});

let commentId;
await t('다른 회원이 댓글을 달 수 있음', async () => {
  const r = await talker(`/posts/${postId}/comments`, { method: 'POST', body: { body: '저도 필요합니다.' } });
  eq(r.status, 200, 'status');
  eq(r.data.post.comments.length, 1, '댓글 수');
  eq(r.data.post.comments[0].author.name, '수다', '댓글 글쓴이');
  commentId = r.data.post.comments[0].id;
});

await t('빈 댓글은 거부, 없는 글에는 댓글 불가', async () => {
  eq((await alice(`/posts/${postId}/comments`, { method: 'POST', body: { body: ' ' } })).status, 400, '빈 댓글');
  eq((await alice('/posts/b_nope/comments', { method: 'POST', body: { body: 'x' } })).status, 404, '없는 글');
});

await t('남의 댓글은 지울 수 없고 본인·관리자는 지울 수 있음', async () => {
  eq((await alice(`/posts/${postId}/comments/${commentId}`, { method: 'DELETE' })).status, 403, '남의 댓글');

  const r = await admin(`/posts/${postId}/comments/${commentId}`, { method: 'DELETE' });
  eq(r.status, 200, '관리자');
  eq(r.data.post.comments.length, 0, '삭제됨');
});

await t('남의 이메일은 목록에서 가려지고 관리자에게만 보임', async () => {
  const seen = (await talker('/posts')).data.data.find((p) => p.id === postId);
  eq(seen.author.name, '앨리스', '이름은 보임');
  if (seen.author.email) throw new Error('이메일이 노출됨');

  const asAdmin = (await admin('/posts')).data.data.find((p) => p.id === postId);
  eq(asAdmin.author.email, 'alice@example.com', '관리자에게는 보임');
});

await t('관리자는 남의 글도 삭제 가능', async () => {
  const r = await admin(`/posts/${postId}`, { method: 'DELETE' });
  eq(r.status, 200, 'status');
  eq((await alice('/posts')).data.data.some((p) => p.id === postId), false, '아직 남아 있음');
});

console.log('\n== 세션 무효화 ==');

await t('비밀번호를 바꾸면 다른 기기의 세션이 끊김', async () => {
  const phone = client();
  const laptop = client();
  await signup(phone, 'twodev@example.com');
  await laptop('/auth/login', { method: 'POST', body: { email: 'twodev@example.com', password: 'hunter2!hunter2' } });
  eq((await laptop('/auth/me')).status, 200, '사전 조건: 두 기기 모두 로그인');

  const ch = await phone('/auth/password', { method: 'POST', body: { current: 'hunter2!hunter2', next: 'newpassword9' } });
  eq(ch.status, 200, '변경 성공');

  eq((await laptop('/auth/me')).status, 401, '다른 기기 세션이 남음');
  eq((await phone('/auth/me')).status, 200, '바꾼 기기는 계속 로그인 유지');
});

await t('관리자가 초기화하면 그 계정의 세션이 모두 끊김', async () => {
  const victim = client();
  await signup(victim, 'stolen@example.com');
  eq((await victim('/auth/me')).status, 200, '사전 조건');

  await admin('/auth/members/reset', { method: 'POST', body: { email: 'stolen@example.com' } });
  eq((await victim('/auth/me')).status, 401, '세션이 남아 있음');
});

await t('정지를 풀어도 정지 전 세션은 되살아나지 않음', async () => {
  const c = client();
  await signup(c, 'blocked2@example.com');
  await admin('/auth/members', { method: 'PATCH', body: { email: 'blocked2@example.com', status: 'blocked' } });
  eq((await c('/auth/me')).status, 401, '정지 중');

  await admin('/auth/members', { method: 'PATCH', body: { email: 'blocked2@example.com', status: 'active' } });
  eq((await c('/auth/me')).status, 401, '예전 토큰이 되살아남');
});

console.log('\n== 백업 복원 ==');

await t('관리자만 제출물 색인을 복원할 수 있음', async () => {
  const r = await alice('/submissions', { method: 'PUT', body: { data: [] } });
  eq(r.status, 403, '일반 회원');
  eq((await client()('/submissions', { method: 'PUT', body: { data: [] } })).status, 401, '비회원');
});

await t('복원하면 제출물이 되살아나고 서버가 형태를 다듬음', async () => {
  const backup = [{
    id: 's_restored', projectId: 'p_x', title: '복원된 제출물', body: '내용',
    files: [{ id: 'f_1', name: 'a.png', key: 'uploads/m_zz/a.png' }, { nope: true }],
    author: { institution: '기관', name: '복원', email: 'RESTORE@Example.COM' },
    createdAt: '2026-01-01T00:00:00.000Z',
    role: 'admin',                      // 알 수 없는 필드는 버려야 합니다
  }, 'garbage', null];

  const r = await admin('/submissions', { method: 'PUT', body: { data: backup } });
  eq(r.status, 200, 'status');
  eq(r.data.count, 1, '쓸 수 있는 항목만');

  const rows = (await admin('/submissions')).data.data;
  const one = rows.find((x) => x.id === 's_restored');
  if (!one) throw new Error('복원되지 않음');
  eq(one.title, '복원된 제출물', '제목');
  eq(one.author.email, 'restore@example.com', '이메일 정규화');
  eq(one.files.length, 1, '망가진 파일 항목은 버림');
  eq(one.role, undefined, '알 수 없는 필드가 남음');
});

console.log('\n== 첫 가입 경쟁 ==');

await t('명부가 없을 때 동시 가입이 겹쳐도 계정이 사라지지 않음', async () => {
  const emails = ['race1@example.com', 'race2@example.com', 'race3@example.com'];

  // 그냥 Promise.all 로는 읽기와 쓰기가 알아서 어긋나 주지 않습니다.
  // 세 요청이 "아직 명부가 없다"를 똑같이 읽도록 첫 읽기에 관문을 겁니다 —
  // 조건부 쓰기가 없으면 마지막 쓰기가 앞선 두 계정을 덮어씁니다.
  const fresh = new MockBucket();
  const rawGet = fresh.get.bind(fresh);
  let waiting = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  fresh.get = async (key) => {
    if (key === 'data/members.json' && waiting < emails.length) {
      waiting += 1;
      if (waiting === emails.length) release();
      await gate;
    }
    return rawGet(key);
  };

  const saved = env;
  env = { BUCKET: fresh, PBKDF2_ITERATIONS: 1000 };
  try {
    const results = await Promise.all(emails.map((e) => signup(client(), e)));
    for (const r of results) eq(r.status, 200, '가입 응답');

    const stored = JSON.parse(new TextDecoder().decode(fresh.objects.get('data/members.json').bytes));
    eq(stored.length, 3, `명부에 남은 계정 수 (${stored.map((m) => m.email).join(',')})`);
  } finally {
    env = saved;
  }
});

console.log('\n== health ==');

await t('health 가 회원제 여부와 로그인 상태를 알려줌', async () => {
  const anon = await client()('/health');
  eq(anon.data.members, true, 'members');
  eq(anon.data.signedIn, false, '비로그인');

  const me = await alice('/health');
  eq(me.data.signedIn, true, '로그인');
  eq(me.data.me.email, 'alice@example.com', 'me');
});

console.log('\n================ 결과 ================');
console.log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
