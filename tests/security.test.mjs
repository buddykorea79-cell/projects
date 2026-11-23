/**
 * 보안 보강 검증 테스트 — 비공개 파일 IDOR 차단 · 페스타 연계 파일 소유권 ·
 * 세션 토큰 purpose 분리 · 서버 MIME 결정 · JSON 크기 상한 ·
 * 프로필 미완성 쓰기 차단 · 인증 속도 제한 · CSV 수식 인젝션 방어.
 */
import { MockBucket, TEST_GOOGLE_ENV, mockGoogleLogin, applySetCookies } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import { signSession, SESSION_COOKIE, SESSION_TTL_MS } from '../shared/auth.js';
import { csvCell } from '../assets/js/utils.js';
import { buildCsv } from '../assets/js/sheet.js';

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

const bucket = new MockBucket();
const env = { BUCKET: bucket, ...TEST_GOOGLE_ENV, SIGNUP_POLICY: 'open' };

function makeClient() {
  const jar = new Map();
  const fn = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
    const h = { Origin: ORIGIN, ...headers };
    if (jar.size) h.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await handleApi(
      new Request(`${ORIGIN}/api${path}`, { method, headers: h, body: payload }),
      env,
      { basePath: '/api' },
    );
    applySetCookies(jar, res.headers);
    const ct = res.headers.get('Content-Type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : null;
    return { status: res.status, data, res };
  };
  fn.jar = jar;
  return fn;
}

const admin = makeClient();
const alice = makeClient();
const bob = makeClient();

console.log('\n== 준비 ==');
await t('관리자·앨리스·밥 로그인 및 비공개/공개 프로젝트 생성', async () => {
  eq((await mockGoogleLogin(admin, { email: ADMIN, name: '관리자', institution: '행정안전부' })).profile.status, 200, 'admin');
  eq((await mockGoogleLogin(alice, { email: 'alice@gmail.com', name: '앨리스', institution: '행정안전부' })).profile.status, 200, 'alice');
  eq((await mockGoogleLogin(bob, { email: 'bob@gmail.com', name: '밥', institution: '한국서부발전' })).profile.status, 200, 'bob');

  const cur = await admin('/data/projects');
  const put = await admin('/data/projects', {
    method: 'PUT',
    body: {
      etag: cur.data.etag,
      data: [
        { id: 'p_priv', title: '비공개 과제', status: 'open', visibility: 'private' },
        { id: 'p_pub', title: '공개 과제', status: 'open', visibility: 'public' },
      ],
    },
  });
  eq(put.status, 200, 'projects put');
});

console.log('\n== 1. 비공개 파일 인가(IDOR) 차단 ==');
let privKey = '';
let pubKey = '';
let matKey = '';

await t('비공개 과제 첨부파일은 본인·관리자만 열람 가능, 타 회원은 403 차단', async () => {
  const up = await alice('/upload?name=secret.pdf', {
    method: 'POST', raw: new Uint8Array([37, 80, 68, 70]), headers: { 'X-File-Type': 'application/pdf' },
  });
  eq(up.status, 200, 'upload');
  privKey = up.data.key;
  const sub = await alice('/submissions', {
    method: 'POST',
    body: { projectId: 'p_priv', title: '비공개 제출', body: '본문', files: [{ key: privKey, name: 'secret.pdf' }] },
  });
  eq(sub.status, 200, 'submit');

  eq((await alice(`/file/${encodeURI(privKey)}`)).status, 200, '본인 허용');
  eq((await admin(`/file/${encodeURI(privKey)}`)).status, 200, '관리자 허용');
  eq((await bob(`/file/${encodeURI(privKey)}`)).status, 403, '타 회원 차단');
  eq((await bob('/file/uploads/m_0000000000000000/nonexistent.pdf')).status, 403, '존재 여부 오라클 차단');
});

await t('공개 과제 첨부파일과 강의자료는 다른 로그인 회원도 열람 가능', async () => {
  const up = await alice('/upload?name=public.png', {
    method: 'POST', raw: new Uint8Array([137, 80, 78, 71]),
  });
  eq(up.status, 200, 'upload pub');
  pubKey = up.data.key;
  eq((await alice('/submissions', {
    method: 'POST',
    body: { projectId: 'p_pub', title: '공개 제출', body: '본문', files: [{ key: pubKey, name: 'public.png' }] },
  })).status, 200, 'submit pub');
  eq((await bob(`/file/${encodeURI(pubKey)}`)).status, 200, '공개 제출 첨부 허용');

  const mUp = await admin('/upload?kind=material&materialId=m_lec1&name=guide.pdf', {
    method: 'POST', raw: new Uint8Array([37, 80, 68, 70]),
  });
  eq(mUp.status, 200, 'upload mat');
  matKey = mUp.data.key;
  eq((await bob(`/file/${encodeURI(matKey)}`)).status, 200, '강의자료 허용');
});

await t('잘못된 퍼센트 인코딩 파일 경로는 500 대신 400 반환', async () => {
  eq((await alice('/file/%E0%A4%A')).status, 400, 'malformed percent encoding');
});

console.log('\n== 2. 페스타 기존 회원 연계 시 첨부파일 소유권 이관 ==');
await t('기존 이메일의 페스타 첨부파일이 Google 계정 병합 후에도 다운로드·수정 가능', async () => {
  // 기존 비-구글 회원(googleSub 없음)과 과거에 올린 페스타 작품·첨부파일을 R2에 시드합니다.
  const legacyCreatedAt = '2026-01-10T00:00:00.000Z';
  const legacyEmail = 'old.user@mois.go.kr';
  const mObj = await bucket.get('data/members.json');
  const mList = JSON.parse(await mObj.text());
  mList.push({
    email: legacyEmail, name: '김전환', institution: '행정안전부',
    role: 'member', status: 'active', createdAt: legacyCreatedAt, updatedAt: legacyCreatedAt,
  });
  await bucket.put('data/members.json', JSON.stringify(mList, null, 2));

  const fKey = 'festa/uploads/11111111-2222-3333-4444-555555555555.pdf';
  const pdfBytes = new Uint8Array([37, 80, 68, 70]);
  await bucket.put(fKey, pdfBytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      owner: legacyEmail,
      ownerCreatedAt: legacyCreatedAt,
      originalName: encodeURIComponent('demo.pdf'),
    },
  });
  const entryId = 'fe_legacy_test_1';
  await bucket.put('data/festa.json', JSON.stringify({
    version: 1,
    phase: 'open',
    deadline: '2027-12-07',
    entries: [{
      id: entryId,
      institution: '행정안전부',
      title: '이전 페스타 작품',
      description: '설명',
      localOnly: true,
      deployUrl: '',
      githubUrl: 'https://github.com/example/demo',
      files: [{ key: fKey, name: 'demo.pdf', size: pdfBytes.byteLength }],
      author: { email: legacyEmail, name: '김전환', institution: '행정안전부', memberCreatedAt: legacyCreatedAt },
      createdAt: legacyCreatedAt,
      updatedAt: legacyCreatedAt,
    }],
    scores: [],
    uploads: [{
      key: fKey, name: 'demo.pdf', size: pdfBytes.byteLength,
      owner: legacyEmail, ownerCreatedAt: legacyCreatedAt,
    }],
  }));

  const newGoogle = makeClient();
  eq((await mockGoogleLogin(newGoogle, {
    email: 'new.user@gmail.com', name: '김전환', institution: '행정안전부',
  })).profile.status, 200, 'new google login');

  const merged = await admin('/auth/members/link', {
    method: 'POST',
    body: { email: 'new.user@gmail.com', legacyEmail, action: 'approve' },
  });
  eq(merged.status, 200, 'merge');

  // 병합 시 권한·계정 상태가 바뀌므로 기존 세션 세대가 올라가고 재로그인 후 새 권한으로 접근합니다.
  await mockGoogleLogin(newGoogle, { email: 'new.user@gmail.com', completeProfile: false });

  const dl = await newGoogle(`/festa/file/${encodeURIComponent(fKey)}`);
  eq(dl.status, 200, '병합된 페스타 파일 다운로드 허용');

  const reSave = await newGoogle('/festa/entry', {
    method: 'POST',
    body: {
      id: entryId,
      institution: '행정안전부',
      title: '이전 페스타 작품 (수정)',
      description: '설명 수정',
      localOnly: true,
      githubUrl: 'https://github.com/example/demo',
      files: [{ key: fKey }],
    },
  });
  eq(reSave.status, 200, '병합된 페스타 파일 포함 재저장 허용');
});

console.log('\n== 3. 세션 토큰 purpose 분리 ==');
await t('비세션 purpose 토큰(google-onboard, festa-jury)을 ah_session 쿠키로 제시하면 401 차단', async () => {
  for (const purpose of ['google-onboard', 'google-oauth', 'festa-jury']) {
    const forged = await signSession({
      purpose,
      sub: 'alice@gmail.com',
      ep: 0,
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
    }, env);
    const res = await handleApi(
      new Request(`${ORIGIN}/api/auth/me`, {
        headers: { Origin: ORIGIN, Cookie: `${SESSION_COOKIE}=${forged}` },
      }),
      env,
      { basePath: '/api' },
    );
    eq(res.status, 401, `purpose=${purpose} 차단`);
  }
});

console.log('\n== 4. MIME 서버 결정 · JSON 크기 제한 · 프로필 미완성 차단 · 속도 제한 ==');
await t('업로드 시 클라이언트 X-File-Type 헤더를 무시하고 확장자 기준으로 MIME 결정', async () => {
  const up = await alice('/upload?name=note.txt', {
    method: 'POST',
    raw: new TextEncoder().encode('<script>alert(1)</script>'),
    headers: { 'X-File-Type': 'text/html' },
  });
  eq(up.status, 200, 'upload');
  eq(up.data.type, 'text/plain; charset=utf-8', '서버 지정 MIME');
  const dl = await alice(`/file/${encodeURI(up.data.key)}`);
  eq(dl.res.headers.get('Content-Type'), 'text/plain; charset=utf-8', '응답 Content-Type');
  if (!dl.res.headers.get('Content-Disposition').startsWith('attachment')) {
    throw new Error('txt 파일이 attachment 로 내려가지 않음');
  }
});

await t('512KB 초과 JSON 요청은 413 거부', async () => {
  const big = JSON.stringify({ title: 'x', body: 'a'.repeat(600 * 1024) });
  const res = await alice('/posts', { method: 'POST', body: big });
  eq(res.status, 413, 'oversized json');
});

await t('소속·성명 미입력 일반 회원은 글쓰기·업로드 403 차단, 등록 후 허용', async () => {
  const newcomer = makeClient();
  await mockGoogleLogin(newcomer, {
    email: 'incomplete@gmail.com', name: '미완성', completeProfile: false,
  });
  eq((await newcomer('/posts', { method: 'POST', body: { title: 't', body: 'b' } })).status, 403, '프로필 미완성 글쓰기 차단');
  eq((await newcomer('/upload?name=a.pdf', { method: 'POST', raw: new Uint8Array([1, 2]) })).status, 403, '프로필 미완성 업로드 차단');
  eq((await newcomer('/auth/profile', { method: 'POST', body: { name: '완성자', institution: '행정안전부' } })).status, 200, '프로필 등록');
  eq((await newcomer('/posts', { method: 'POST', body: { title: 't', body: 'b' } })).status, 200, '등록 후 글쓰기 허용');
});

await t('동일 IP에서 온보딩 POST 연타 시 429 속도 제한', async () => {
  let got429 = false;
  for (let i = 0; i < 20; i += 1) {
    const r = await handleApi(
      new Request(`${ORIGIN}/api/auth/onboard`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.99' },
        body: '{}',
      }),
      env,
      { basePath: '/api' },
    );
    if (r.status === 429) { got429 = true; break; }
  }
  if (!got429) throw new Error('429 속도 제한이 동작하지 않음');
});

console.log('\n== 5. CSV 수식 인젝션 방어 ==');
await t('csvCell · buildCsv 가 =, +, -, @, 탭 시작 수식을 작은따옴표로 무력화', async () => {
  eq(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)", '= 방어');
  eq(csvCell('+cmd|a'), "'+cmd|a", '+ 방어');
  eq(csvCell('-1+1'), "'-1+1", '- 수식 방어');
  eq(csvCell('@SUM(1,1)'), "\"'@SUM(1,1)\"", '@ 방어 (쉼표 포함 인용)');
  eq(csvCell('\t=1+1'), "'\t=1+1", '탭 시작 방어');
  eq(csvCell(-3.5), '-3.5', '숫자 음수 보존');
  eq(csvCell('010-1234-5678'), '010-1234-5678', '전화번호 보존');

  const blob = buildCsv([['기관', '성명'], ['=1+1', '홍길동']]);
  const text = await blob.text();
  if (!text.includes("'=1+1,홍길동")) throw new Error(`buildCsv 미방어: ${text}`);
});

console.log('\n================ 결과 ================');
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 보안 검사 통과');
