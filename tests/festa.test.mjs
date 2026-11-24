/** Festa: 실제 API의 접수·마감·심사 경계와 회원별 소유권을 검증합니다. */
import assert from 'node:assert/strict';
import { MockBucket, TEST_GOOGLE_ENV, mockGoogleLogin, applySetCookies } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';

// 접수 기간 검증이 실행 날짜에 따라 달라지지 않도록 서버 시각을 고정합니다.
const realNow = Date.now;
const fixtureNow = () => Date.parse('2026-11-22T00:00:00Z');
Date.now = fixtureNow;

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';
const bucket = new MockBucket();
const env = {
  BUCKET: bucket, ...TEST_GOOGLE_ENV, SIGNUP_POLICY: 'open',
  TOKEN_SECRET: 'festa-test-only-secret',
  FESTA_EMAIL: 'festa@example.com',
};
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.message}`); }
}

function session(sessionEnv = env) {
  const jar = new Map();
  return async (path, { method = 'GET', body, form } = {}) => {
    const headers = { Origin: ORIGIN };
    if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleApi(new Request(`${ORIGIN}/api${path}`, {
      method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)),
    }), sessionEnv, { basePath: '/api' });
    applySetCookies(jar, response.headers);
    const type = response.headers.get('Content-Type') || '';
    return {
      status: response.status, headers: response.headers,
      data: type.includes('json') ? await response.json() : null,
      response,
    };
  };
}

async function googleSignup(client, { email, name = '페스타 테스트', institution = '행정안전부' }) {
  const r = await mockGoogleLogin(client, { email, name, institution });
  return { status: r.profile?.status || (r.callback?.status === 302 ? 200 : 400), data: r.profile?.data || null };
}
const anon = session();
const admin = session();
const alice = session();
const bob = session();
const carol = session();
const blocked = session();
const post = (client, path, body) => client(path, { method: 'POST', body });
const get = async (client) => {
  const result = await client('/festa');
  assert.equal(result.status, 200, result.data?.message);
  return result.data;
};
const entry = (over = {}) => ({
  institution: '행정안전부',
  title: '민원 안내 도우미', description: '기관의 자주 묻는 민원을 검색해 안내하는 서비스입니다.',
  localOnly: false, deployUrl: 'https://example.com/civil-service',
  githubUrl: 'https://github.com/example/civil-service', files: [], ...over,
});
async function upload(client, name = '설명서.txt', bytes = 'Festa 파일 내용') {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type: 'text/plain' }));
  return client('/festa/upload', { method: 'POST', form });
}
const filePath = (file) => `/festa/file/${encodeURIComponent(file.key)}`;
const rejected = (result, message) => {
  assert.ok(result.status >= 400 && result.status < 500,
    `${message}: expected 4xx, got ${result.status} ${JSON.stringify(result.data)}`);
};

async function isolatedFixture(tag, storage = new MockBucket()) {
  const localEnv = { ...env, BUCKET: storage, TOKEN_SECRET: `festa-${tag}-fixture` };
  const boss = session(localEnv);
  const owner = session(localEnv);
  const other = session(localEnv);
  for (const [client, email] of [[boss, ADMIN], [owner, `${tag}@example.com`], [other, `${tag}-other@example.com`]]) {
    const result = await googleSignup(client, {
      email, name: '페스타 테스트', institution: '테스트 기관',
    });
    assert.equal(result.status, 200, result.data?.message);
  }
  return { localEnv, boss, owner, other };
}

console.log('\n== Festa: 인증 및 접수 ==');
await test('관리자·일반회원·정지 대상 회원 가입', async () => {
  for (const [client, email, name] of [
    [admin, ADMIN, '운영자'], [alice, 'alice@example.com', '김교육'],
    [bob, 'bob@example.com', '이참여'], [carol, 'carol@example.com', '박심사'],
    [blocked, 'blocked@example.com', '정지회원'],
  ]) {
    const result = await googleSignup(client, {
      email, name, institution: '행정안전부',
    });
    assert.equal(result.status, 200, result.data?.message);
  }
});
await test('비회원은 목록·제출·단계변경·평가·업로드에 접근 불가', async () => {
  assert.equal((await anon('/festa')).status, 401);
  for (const [path, body] of [
    ['/festa/entry', entry()], ['/festa/phase', { phase: 'closed' }],
    ['/festa/contact', { email: 'help@example.com' }],
    ['/festa/deadline', { deadline: '2027-12-07' }],
    ['/festa/score', { entryId: 'unknown', scores: [0, 0, 0, 0] }],
  ]) assert.equal((await post(anon, path, body)).status, 401, path);
  assert.equal((await upload(anon)).status, 401);
});
await test('최초 접수 상태와 빈 내 작품', async () => {
  const state = await get(alice);
  assert.equal(state.phase, 'open');
  assert.equal(state.mine, null);
  assert.deepEqual(state.myEntries, []);
  assert.equal(state.deadline, '2027-12-07');
  assert.equal(state.deadlinePassed, false);
  assert.deepEqual(state.entries, []);
  assert.equal(state.email, 'festa@example.com');
  assert.deepEqual(state.emails, ['festa@example.com']);
});
await test('문의 이메일은 관리자만 변경하며 1~5개의 유효한 중복 없는 주소를 저장', async () => {
  assert.equal((await post(alice, '/festa/contact', { email: 'help@example.com' })).status, 403);
  assert.equal((await post(alice, '/festa/contact', { emails: ['help@example.com'] })).status, 403);
  for (const payload of [
    { email: '' },
    { email: 'not-email' },
    { email: 'a@example.com,' },
    { email: 'a@example.com, not-email' },
    { email: 'a@example.com, A@example.com' },
    { email: 'a@example.com\r\nBcc: x@example.com' },
    { emails: [] },
    { emails: [''] },
    { emails: ['a@example.com', 'A@example.com'] },
    { emails: ['a@example.com\r\nBcc: x@example.com'] },
    { emails: ['a1@example.com', 'a2@example.com', 'a3@example.com', 'a4@example.com', 'a5@example.com', 'a6@example.com'] },
  ]) {
    rejected(await post(admin, '/festa/contact', payload), `invalid contact ${JSON.stringify(payload)}`);
  }
  const two = await post(admin, '/festa/contact', { emails: ['first@example.com', 'Second@example.com'] });
  assert.equal(two.status, 200);
  assert.equal(two.data.email, 'first@example.com, second@example.com');
  assert.deepEqual(two.data.emails, ['first@example.com', 'second@example.com']);
  const stateTwo = await get(alice);
  assert.equal(stateTwo.email, 'first@example.com, second@example.com');
  assert.deepEqual(stateTwo.emails, ['first@example.com', 'second@example.com']);
  const semi = await post(admin, '/festa/contact', { email: 'a@example.com; b@example.com' });
  assert.equal(semi.status, 200);
  assert.deepEqual((await get(alice)).emails, ['a@example.com', 'b@example.com']);
  assert.equal((await post(admin, '/festa/contact', { email: 'help@example.com' })).status, 200);
  assert.equal((await get(alice)).email, 'help@example.com');
  assert.deepEqual((await get(alice)).emails, ['help@example.com']);
});
await test('기존 단일 email 저장본과 다중 FESTA_EMAIL 환경변수를 호환 읽기', async () => {
  const { localEnv, owner } = await isolatedFixture('legacy-contact');
  const multiEnv = { ...localEnv, FESTA_EMAIL: 'ops1@example.com, ops2@example.com' };
  const member = session(multiEnv);
  assert.equal((await googleSignup(member, { email: 'legacy-member@example.com', name: '호환', institution: '행정안전부' })).status, 200);
  const fromEnv = await get(member);
  assert.deepEqual(fromEnv.emails, ['ops1@example.com', 'ops2@example.com']);
  assert.equal(fromEnv.email, 'ops1@example.com, ops2@example.com');
  await localEnv.BUCKET.put('data/festa.json', JSON.stringify({
    version: 1, phase: 'open', deadline: '2027-12-07', email: 'legacy@example.com', entries: [], scores: [], uploads: [],
  }));
  const fromLegacy = await get(owner);
  assert.deepEqual(fromLegacy.emails, ['legacy@example.com']);
  assert.equal(fromLegacy.email, 'legacy@example.com');
});
await test('일반회원은 마감 권한이 없고 관리자는 단계를 건너뛸 수 없음', async () => {
  assert.equal((await post(alice, '/festa/phase', { phase: 'closed' })).status, 403);
  for (const phase of ['judging', 'finished', 'open', 'unknown', '', null]) {
    rejected(await post(admin, '/festa/phase', { phase }), `invalid phase ${phase}`);
    assert.equal((await get(admin)).phase, 'open');
  }
});
await test('필수 제목·설명·GitHub 주소·배포 주소를 서버가 검증', async () => {
  for (const over of [
    { title: '' }, { title: '   ' }, { description: '' },
    { githubUrl: '' }, { deployUrl: '' }, { deployUrl: 'javascript:alert(1)' },
    { githubUrl: 'https://github.com.evil.test/team/repo' },
    { githubUrl: 'https://example.com/team/repo' },
    { githubUrl: 'https://github.com/team' },
  ]) rejected(await post(alice, '/festa/entry', entry(over)), JSON.stringify(over));
  assert.equal((await get(alice)).mine, null, 'invalid entries must not be saved');
});
await test('로컬 실행을 선택해도 GitHub 주소는 필요', async () => {
  rejected(await post(alice, '/festa/entry', entry({ localOnly: true, deployUrl: '', githubUrl: '' })),
    'localOnly cannot bypass source repository');
});

let aliceFile;
let bobDraftFile;
let aliceId;
await test('업로드는 실제 파일 크기와 서버 생성 키를 반환', async () => {
  const result = await upload(alice);
  assert.equal(result.status, 200, result.data?.message);
  aliceFile = result.data.file;
  assert.match(aliceFile.key, /^festa\/uploads\//);
  assert.equal(aliceFile.name, '설명서.txt');
  assert.equal(aliceFile.size, new TextEncoder().encode('Festa 파일 내용').length);
  const other = await upload(bob, '아직-제출하지-않음.txt', 'unattached private file');
  assert.equal(other.status, 200);
  bobDraftFile = other.data.file;
});
await test('업로드 파일 한도 30 MiB는 경계에서 허용하고 초과는 거부', async () => {
  const exact = await upload(carol, 'exact-limit.txt', new Uint8Array(30 * 1024 * 1024));
  assert.equal(exact.status, 200, exact.data?.message);
  assert.equal(exact.data.file.size, 30 * 1024 * 1024);
  const over = await upload(carol, 'over-limit.txt', new Uint8Array(30 * 1024 * 1024 + 1));
  rejected(over, '30 MiB + 1 byte');
});
await test('남의 업로드·없는 파일·일반 과제 파일 경로를 첨부할 수 없음', async () => {
  for (const file of [
    bobDraftFile,
    { key: 'festa/uploads/does-not-exist.txt', name: '위조.txt', size: 1 },
    { key: 'uploads/materials/private.pdf', name: '강의.pdf', size: 1 },
  ]) rejected(await post(alice, '/festa/entry', entry({ files: [file] })), file.key);
});
await test('파일은 10개까지 허용하고 11개는 거부', async () => {
  const files = [aliceFile];
  for (let i = 1; i < 11; i += 1) {
    const result = await upload(alice, `첨부-${i}.txt`, `file ${i}`);
    assert.equal(result.status, 200);
    files.push(result.data.file);
  }
  rejected(await post(alice, '/festa/entry', entry({ files })), 'eleven attachments');
  const valid = await post(alice, '/festa/entry', entry({ files: files.slice(0, 10) }));
  assert.equal(valid.status, 200, valid.data?.message);
  assert.equal((await get(alice)).mine.files.length, 10);
});
await test('접수된 작품은 로그인 회원 소유이며 수정해도 한 작품으로 유지', async () => {
  const before = (await get(alice)).mine;
  aliceId = before.id;
  assert.equal(before.author.email, 'alice@example.com');
  rejected(await post(alice, '/festa/entry', entry({ id: 'forged-entry-id' })), 'invalid explicit entry id');
  const result = await post(alice, '/festa/entry', entry({
    title: '민원 안내 도우미 최종본', files: [aliceFile],
    author: { email: 'bob@example.com', name: '위조 작성자' }, id: aliceId,
  }));
  assert.equal(result.status, 200, result.data?.message);
  const state = await get(alice);
  assert.equal(state.mine.id, aliceId);
  assert.equal(state.mine.author.email, 'alice@example.com');
  assert.equal(state.mine.title, '민원 안내 도우미 최종본');
  assert.equal((await get(admin)).entries.filter((e) => e.id === aliceId).length, 1);
});
await test('첨부 메타데이터를 조작해도 실제 업로드 이름과 크기로 저장', async () => {
  const forged = { ...aliceFile, name: '다른-파일.html', size: 1 };
  const result = await post(alice, '/festa/entry', entry({
    title: '민원 안내 도우미 최종본', files: [forged],
  }));
  assert.equal(result.status, 200, result.data?.message);
  assert.deepEqual((await get(alice)).mine.files, [aliceFile]);
});
await test('로컬 실행 작품은 배포 URL 없이 접수되고 타인 작품은 덮어쓰지 않음', async () => {
  assert.equal((await post(bob, '/festa/entry', entry({ id: aliceId }))).status, 403);
  const result = await post(bob, '/festa/entry', entry({
    title: '오프라인 문서 정리기', localOnly: true, deployUrl: '', id: null,
  }));
  assert.equal(result.status, 200, result.data?.message);
  const mine = (await get(bob)).mine;
  assert.notEqual(mine.id, aliceId);
  assert.equal(mine.localOnly, true);
  assert.equal(mine.author.email, 'bob@example.com');
  assert.equal((await get(alice)).mine.title, '민원 안내 도우미 최종본');
});
await test('관리자도 자신의 작품을 접수할 수 있음', async () => {
  assert.equal((await post(admin, '/festa/entry', entry({ title: '운영자 예시 작품' }))).status, 200);
  assert.ok((await get(admin)).mine.id);
});
await test('접수 중에는 본인만 보이고 관리자만 전체를 확인', async () => {
  assert.deepEqual((await get(alice)).entries, []);
  assert.deepEqual((await get(carol)).entries, []);
  const all = (await get(admin)).entries;
  assert.equal(all.length, 3);
  assert.deepEqual(new Set(all.map((e) => e.author.email)), new Set(['alice@example.com', 'bob@example.com', ADMIN]));
});
await test('파일은 접수 중 본인·관리자만 열람하고 일반 파일 API로 우회 불가', async () => {
  assert.equal((await anon(filePath(aliceFile))).status, 401);
  assert.equal((await alice(filePath(aliceFile))).status, 200);
  assert.equal((await admin(filePath(aliceFile))).status, 200);
  rejected(await bob(filePath(aliceFile)), 'other member private download');
  rejected(await bob(`/file/${encodeURIComponent(aliceFile.key)}`), 'ordinary file endpoint bypass');
});
await test('심사 전에는 관리자도 채점 불가', async () => {
  for (const client of [bob, admin]) rejected(await post(client, '/festa/score', {
    entryId: aliceId, scores: [40, 30, 20, 10],
  }), 'scoring before judging');
});

console.log('\n== Festa: 마감과 심사 ==');
await test('관리자가 마감하면 신규·수정·업로드·채점이 모두 중단됨', async () => {
  assert.equal((await post(admin, '/festa/phase', { phase: 'closed' })).status, 200);
  assert.equal((await get(alice)).phase, 'closed');
  for (const client of [alice, carol, admin]) {
    rejected(await post(client, '/festa/entry', entry()), 'entry after closing');
    rejected(await upload(client), 'upload after closing');
    rejected(await post(client, '/festa/score', { entryId: aliceId, scores: [1, 1, 1, 1] }),
      'score while closed');
  }
  assert.equal((await get(alice)).mine.title, '민원 안내 도우미 최종본');
  assert.deepEqual((await get(bob)).entries, []);
  rejected(await bob(filePath(aliceFile)), 'closed remains private');
});
await test('마감 단계에서 재접수나 같은 단계로 돌아갈 수 없음', async () => {
  for (const phase of ['open', 'closed', 'finished']) rejected(await post(admin, '/festa/phase', { phase }), phase);
  assert.equal((await get(admin)).phase, 'closed');
});
await test('기존 심사 화면이나 API로 제3자 작품을 열거나 평가할 수 없음', async () => {
  for (const phase of ['closed', 'judging', 'finished']) {
    // 이전 버전이 이미 심사 또는 종료로 저장한 데이터도 새 공개 범위를 따릅니다.
    const item = await bucket.get('data/festa.json');
    const stored = JSON.parse(await item.text());
    stored.phase = phase;
    await bucket.put('data/festa.json', JSON.stringify(stored));
    assert.deepEqual((await get(carol)).entries, []);
    assert.equal((await carol(filePath(aliceFile))).status, 403);
    assert.equal((await post(carol, '/festa/score', { entryId: aliceId, scores: [40,30,20,10] })).status, 403);
    assert.equal((await alice(filePath(aliceFile))).status, 200);
    assert.ok((await get(admin)).entries.length >= 2);
  }
});
await test('정지된 회원은 기존 세션으로 목록·채점·첨부를 이용할 수 없음', async () => {
  assert.equal((await admin('/auth/members', {
    method: 'PATCH', body: { email: 'blocked@example.com', status: 'blocked' },
  })).status, 200);
  assert.equal((await blocked('/festa')).status, 401);
  assert.equal((await post(blocked, '/festa/score', { entryId: aliceId, scores: [0, 0, 0, 0] })).status, 401);
  assert.equal((await blocked(filePath(aliceFile))).status, 401);
});
await test('삭제된 이메일로 재가입해도 과거 작품·파일을 승계하거나 중복 출품하지 못함', async () => {
  const isolated = { ...env, BUCKET: new MockBucket(), TOKEN_SECRET: 'festa-new-account-fixture' };
  const boss = session(isolated);
  const original = session(isolated);
  const replacement = session(isolated);
  const register = (client, email) => googleSignup(client, {
    email, name: '테스트 회원', institution: '행정안전부',
  });
  assert.equal((await register(boss, ADMIN)).status, 200);
  assert.equal((await register(original, 'reused@example.com')).status, 200);
  const uploaded = await upload(original, '기존-회원.txt', '기존 회원만 볼 수 있는 자료');
  assert.equal(uploaded.status, 200);
  const file = uploaded.data.file;
  assert.equal((await post(original, '/festa/entry', entry({ files: [file] }))).status, 200);
  const originalId = (await get(original)).mine.id;
  assert.equal((await boss('/auth/members', {
    method: 'PATCH', body: { email: 'reused@example.com', status: 'blocked' },
  })).status, 200);
  assert.equal((await boss('/auth/members', {
    method: 'DELETE', body: { email: 'reused@example.com' },
  })).status, 200);
  assert.equal((await register(replacement, 'reused@example.com')).status, 200);
  assert.equal((await get(replacement)).mine, null);
  rejected(await replacement(filePath(file)), 'recreated account private download');
  rejected(await post(replacement, '/festa/entry', entry({ files: [file] })), 'recreated account attach');
  rejected(await post(replacement, '/festa/entry', entry({ title: '새 회원 작품' })), 'recreated account duplicate entry');
  rejected(await post(replacement, '/festa/entry', entry({ id: originalId, title: '과거 작품 변경 시도' })),
    'recreated account edit old entry');
  const rows = (await get(boss)).entries;
  assert.equal(rows.length, 1, 'one entry per email across account recreation');
  assert.equal((await get(replacement)).mine, null, 'new account has no ownership of old entry');
  const originalRow = rows.find((e) => e.id === originalId);
  assert.ok(originalRow, 'original entry remains inspectable by admin');
  assert.equal(originalRow.title, '민원 안내 도우미');
});
await test('선택한 기관을 기록하고 기존 작품의 기관을 판별하거나 관리자가 보정', async () => {
  const { localEnv, boss, owner, other } = await isolatedFixture('institution');
  for (const institution of [undefined, '', null, '다른 기관', ['행정안전부']]) {
    assert.equal((await post(owner, '/festa/entry', entry({ institution }))).status, 400);
  }
  const created = await post(owner, '/festa/entry', entry({ id: null, institution: '한국서부발전' }));
  assert.equal(created.data.entry.institution, '한국서부발전');
  const entryId = created.data.entry.id;
  const corrected = { entryId, institution: '행정안전부' };
  assert.equal((await post(other, '/festa/institution', corrected)).status, 403);
  assert.equal((await post(boss, '/festa/jury/panel', { panel: 'iwest', entryIds: [entryId] })).status, 200);
  assert.equal((await post(owner, '/festa/entry', entry({ id: entryId, institution: '행정안전부' }))).status, 200);
  const stored = JSON.parse(await (await localEnv.BUCKET.get('data/festa.json')).text());
  assert.deepEqual(stored.juryPanels.iwest.entryIds, []);
  const old = stored.entries[0];
  delete old.institution;
  old.author.institution = '행정안전부';
  await localEnv.BUCKET.put('data/festa.json', JSON.stringify(stored));
  assert.equal((await get(owner)).mine.institution, '행정안전부');
  old.author.institution = '기관 미상';
  await localEnv.BUCKET.put('data/festa.json', JSON.stringify(stored));
  assert.equal((await get(owner)).mine.institution, '');
  assert.equal((await post(boss, '/festa/institution', corrected)).status, 200);
  assert.equal((await get(owner)).mine.institution, '행정안전부');
  const fixed = JSON.parse(await (await localEnv.BUCKET.get('data/festa.json')).text());
  fixed.juryPanels = { mois: { status: 'open', entryIds: [entryId], judges: [], scores: [] } };
  await localEnv.BUCKET.put('data/festa.json', JSON.stringify(fixed));
  assert.equal((await post(boss, '/festa/institution', { entryId, institution: '한국서부발전' })).status, 409);
  assert.equal((await get(owner)).mine.institution, '행정안전부');
});
await test('미첨부 업로드는 최근 20개만 보관하고 접수된 파일은 정리하지 않음', async () => {
  const isolated = { ...env, BUCKET: new MockBucket(), TOKEN_SECRET: 'festa-draft-cleanup-fixture' };
  const member = session(isolated);
  assert.equal((await googleSignup(member, {
    email: 'drafts@example.com', name: '첨부 시험', institution: '행정안전부',
  })).status, 200);
  const submitted = await upload(member, '접수된-파일.txt', '반드시 보존');
  assert.equal(submitted.status, 200);
  const attached = submitted.data.file;
  assert.equal((await post(member, '/festa/entry', entry({ files: [attached] }))).status, 200);
  const drafts = [];
  for (let i = 0; i < 20; i += 1) {
    const result = await upload(member, `미첨부-${i}.txt`, `draft ${i}`);
    assert.equal(result.status, 200, result.data?.message);
    drafts.push(result.data.file);
  }
  assert.ok(await isolated.BUCKET.get(drafts[0].key), '20th draft keeps oldest within limit');
  assert.equal(isolated.BUCKET.keys('festa/uploads/').length, 21, 'one attached and twenty drafts');
  const last = await upload(member, '미첨부-20.txt', 'newest draft');
  assert.equal(last.status, 200, last.data?.message);
  assert.equal(await isolated.BUCKET.get(drafts[0].key), null, 'oldest unattached object deleted');
  assert.equal((await member(filePath(drafts[0]))).status, 404, 'deleted key cannot download');
  assert.ok(await isolated.BUCKET.get(drafts[1].key), 'next-oldest draft retained');
  assert.ok(await isolated.BUCKET.get(last.data.file.key), 'newest draft retained');
  assert.ok(await isolated.BUCKET.get(attached.key), 'attached object retained');
  assert.equal(isolated.BUCKET.keys('festa/uploads/').length, 21, 'storage remains bounded');
  assert.equal((await member(filePath(attached))).status, 200);
  assert.deepEqual((await get(member)).mine.files, [attached]);
});

console.log('\n== Festa: 두 작품 및 접수 마감일 ==');
await test('기존 한 작품을 보존하고 명시적 신규 접수로 두 작품까지 등록·수정', async () => {
  const { localEnv, owner, other, boss } = await isolatedFixture('two-entries');
  const first = await post(owner, '/festa/entry', entry({ title: '기존 작품' }));
  assert.equal(first.status, 200);
  const firstId = first.data.entry.id;
  const oldState = JSON.parse(await (await localEnv.BUCKET.get('data/festa.json')).text());
  delete oldState.deadline;
  await localEnv.BUCKET.put('data/festa.json', JSON.stringify(oldState));
  const before = await (await localEnv.BUCKET.get('data/festa.json')).text();
  assert.equal((await get(owner)).deadline, '2027-12-07', 'old state gets default deadline');
  assert.equal(await (await localEnv.BUCKET.get('data/festa.json')).text(), before, 'GET does not overwrite old state');
  const cachedEdit = await post(owner, '/festa/entry', entry({ title: '이전 화면에서 수정' }));
  assert.equal(cachedEdit.status, 200);
  assert.equal(cachedEdit.data.entry.id, firstId, 'legacy one-entry edit remains compatible');
  const second = await post(owner, '/festa/entry', entry({ id: null, title: '두 번째 작품' }));
  assert.equal(second.status, 200, second.data?.message);
  const secondId = second.data.entry.id;
  assert.notEqual(secondId, firstId);
  let state = await get(owner);
  assert.equal(state.myEntries.length, 2);
  assert.equal(state.mine.id, firstId, 'mine remains first-entry compatibility alias');
  assert.deepEqual(state.myEntries.map((row) => row.title), ['이전 화면에서 수정', '두 번째 작품']);
  assert.equal((await post(owner, '/festa/entry', entry({ title: '모호한 구형 수정' }))).status, 409);
  assert.equal((await post(owner, '/festa/entry', entry({ id: null, title: '세 번째 작품' }))).status, 409);
  assert.equal((await post(owner, '/festa/entry', entry({ id: 'fe_missing', title: '없는 작품' }))).status, 404);
  assert.equal((await post(owner, '/festa/entry', entry({ id: secondId, title: '두 번째만 수정' }))).status, 200);
  state = await get(owner);
  assert.deepEqual(state.myEntries.map((row) => row.title), ['이전 화면에서 수정', '두 번째만 수정']);
  assert.equal((await post(owner, '/festa/entry', entry({ id: firstId, title: '첫 번째만 수정' }))).status, 200);
  assert.deepEqual((await get(owner)).myEntries.map((row) => row.title), ['첫 번째만 수정', '두 번째만 수정']);
  const foreign = await post(other, '/festa/entry', entry({ id: null, title: '다른 회원 작품' }));
  assert.equal(foreign.status, 200);
  assert.equal((await post(owner, '/festa/entry', entry({ id: foreign.data.entry.id }))).status, 403);
  assert.equal((await post(boss, '/festa/entry', entry({ id: firstId }))).status, 403, 'admin cannot overwrite a member entry');
  assert.equal((await get(boss)).entries.length, 3);
});
await test('동시 신규 출품도 두 자리만 할당하고 형제 작품을 덮어쓰지 않음', async () => {
  const { owner } = await isolatedFixture('concurrent-create');
  const results = await Promise.all([0, 1, 2].map((i) => post(owner, '/festa/entry', entry({ id: null, title: `초안 ${i}` }))));
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 200, 409]);
  const state = await get(owner);
  assert.equal(state.myEntries.length, 2);
  assert.equal(new Set(state.myEntries.map((row) => row.id)).size, 2);
  assert.deepEqual(new Set(state.myEntries.map((row) => row.title)),
    new Set(results.filter((row) => row.status === 200).map((row) => row.data.entry.title)));
});
await test('같은 초안의 동시·반복 접수는 한 작품이며 뒤이은 수정을 되돌리지 않음', async () => {
  const { localEnv, owner, other } = await isolatedFixture('idempotent-create');
  const requestId = crypto.randomUUID();
  const payload = entry({ id: null, requestId, title: '응답 유실 가능 초안' });
  const results = await Promise.all([post(owner, '/festa/entry', payload), post(owner, '/festa/entry', payload)]);
  results.forEach((row) => assert.equal(row.status, 200, row.data?.message));
  const firstId = results[0].data.entry.id;
  assert.equal(results[1].data.entry.id, firstId);
  assert.equal((await get(owner)).myEntries.length, 1);
  const second = await post(owner, '/festa/entry', entry({ id: null, requestId: crypto.randomUUID(), title: '서로 다른 초안' }));
  assert.equal(second.status, 200);
  assert.notEqual(second.data.entry.id, firstId);
  assert.equal((await post(owner, '/festa/entry', entry({ id: firstId, title: '이미 수정한 최신본', requestId: crypto.randomUUID() }))).status, 200);
  const replay = await post(owner, '/festa/entry', payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.entry.id, firstId);
  assert.equal(replay.data.entry.title, '이미 수정한 최신본', 'replay never rolls back edits');
  assert.equal((await get(owner)).myEntries.length, 2);
  const saved = JSON.parse(await (await localEnv.BUCKET.get('data/festa.json')).text());
  assert.equal(saved.entries.find((row) => row.id === firstId).requestId, requestId, 'edit preserves original request id');
  assert.equal(JSON.stringify(await get(owner)).includes(requestId), false, 'request id remains private');
  assert.equal(JSON.stringify(replay.data).includes(requestId), false);
  const otherCreate = await post(other, '/festa/entry', payload);
  assert.equal(otherCreate.status, 200);
  assert.notEqual(otherCreate.data.entry.id, firstId, 'request id is scoped to member ownership');
  rejected(await post(other, '/festa/entry', entry({ id: null, requestId: '__proto__' })), 'invalid request id');
});
await test('로컬 실행은 이전 배포 URL이나 Local 표시 문자열을 저장하지 않음', async () => {
  const { owner } = await isolatedFixture('local-canonical');
  const first = await post(owner, '/festa/entry', entry({ id: null }));
  assert.equal(first.status, 200);
  const result = await post(owner, '/festa/entry', entry({ id: first.data.entry.id, localOnly: true, deployUrl: 'Local' }));
  assert.equal(result.status, 200, result.data?.message);
  assert.equal(result.data.entry.deployUrl, '');
  assert.equal(result.data.entry.localOnly, true);
  assert.equal((await get(owner)).myEntries[0].deployUrl, '');
});
await test('마감일은 관리자만 실제 달력 날짜로 변경하고 잘못된 날짜는 저장하지 않음', async () => {
  const { owner, boss } = await isolatedFixture('deadline-validation');
  assert.equal((await post(owner, '/festa/deadline', { deadline: '2028-12-07' })).status, 403);
  for (const deadline of ['', null, 20271207, '2027-2-07', '2027-02-29', '2027-04-31', '2027-13-01', '2027-12-07T23:59:59+09:00']) {
    assert.equal((await post(boss, '/festa/deadline', { deadline })).status, 400, String(deadline));
  }
  assert.equal((await get(owner)).deadline, '2027-12-07');
  const leap = await post(boss, '/festa/deadline', { deadline: '2028-02-29' });
  assert.equal(leap.status, 200);
  assert.deepEqual(leap.data, { deadline: '2028-02-29', deadlinePassed: false });
});
await test('한국 마감일 23:59:59.999까지 접수하고 자정부터 차단하며 수동 마감 전 연장 가능', async () => {
  let now = Date.parse('2027-12-07T14:59:59.999Z');
  Date.now = () => now;
  try {
    const { owner, other, boss } = await isolatedFixture('deadline-boundary');
    assert.equal((await get(owner)).deadlinePassed, false);
    const saved = await post(owner, '/festa/entry', entry({ id: null }));
    assert.equal(saved.status, 200, saved.data?.message);
    const uploadBefore = await upload(owner);
    assert.equal(uploadBefore.status, 200);
    now = Date.parse('2027-12-07T15:00:00Z');
    const expired = await get(owner);
    assert.equal(expired.deadlinePassed, true);
    assert.equal(expired.phase, 'open', 'calendar expiry does not start publication/judging');
    assert.equal(expired.myEntries.length, 1);
    for (const client of [owner, other, boss]) {
      assert.equal((await post(client, '/festa/entry', entry({ id: null }))).status, 409);
      assert.equal((await upload(client)).status, 409);
    }
    assert.equal((await post(owner, '/festa/entry', entry({ id: saved.data.entry.id }))).status, 409);
    assert.equal((await owner(filePath(uploadBefore.data.file))).status, 200, 'existing private files remain readable');
    assert.equal((await post(boss, '/festa/deadline', { deadline: '2027-12-08' })).status, 200);
    assert.equal((await get(owner)).deadlinePassed, false);
    assert.equal((await post(owner, '/festa/entry', entry({ id: null, title: '연장 후 두 번째 작품' }))).status, 200);
    assert.equal((await upload(owner)).status, 200);
    assert.equal((await post(boss, '/festa/deadline', { deadline: '2027-12-07' })).status, 200, 'admin may shorten before manual close');
    assert.equal((await post(boss, '/festa/phase', { phase: 'closed' })).status, 200);
    assert.equal((await post(boss, '/festa/deadline', { deadline: '2027-12-09' })).status, 409);
    assert.equal((await post(other, '/festa/score', { entryId: saved.data.entry.id, scores: [40, 30, 20, 10] })).status, 403);
  } finally { Date.now = fixtureNow; }
});
await test('두 작품 첨부 20개를 모두 보존하며 미첨부 파일은 최근 20개로 제한', async () => {
  const { localEnv, owner } = await isolatedFixture('two-attachment-sets');
  const files = [];
  for (let i = 0; i < 20; i += 1) {
    const result = await upload(owner, `작품-첨부-${i}.txt`, `attached ${i}`);
    assert.equal(result.status, 200);
    files.push(result.data.file);
  }
  const first = await post(owner, '/festa/entry', entry({ id: null, files: files.slice(0, 10) }));
  const second = await post(owner, '/festa/entry', entry({ id: null, title: '두 번째 첨부 작품', files: files.slice(10) }));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const drafts = [];
  for (let i = 0; i < 21; i += 1) {
    const result = await upload(owner, `초안-${i}.txt`, `pending ${i}`);
    assert.equal(result.status, 200);
    drafts.push(result.data.file);
  }
  assert.equal(localEnv.BUCKET.keys('festa/uploads/').length, 40, '20 attached + 20 pending');
  assert.equal(await localEnv.BUCKET.get(drafts[0].key), null);
  for (const file of files) assert.ok(await localEnv.BUCKET.get(file.key), `both works preserve ${file.name}`);
  assert.equal((await post(owner, '/festa/entry', entry({ id: first.data.entry.id, files: files.slice(0, 1) }))).status, 200);
  assert.equal(localEnv.BUCKET.keys('festa/uploads/').length, 31, 'save also prunes newly orphaned old attachments');
  for (const file of files.slice(1, 10)) assert.equal(await localEnv.BUCKET.get(file.key), null);
  for (const file of [files[0], ...files.slice(10)]) assert.ok(await localEnv.BUCKET.get(file.key));
  assert.deepEqual((await get(owner)).myEntries.find((row) => row.id === second.data.entry.id).files, files.slice(10));
});
await test('최신 수정으로 파일이 정리되어도 오래된 신규 접수 재시도가 작품을 복원하거나 복제하지 않음', async () => {
  const { localEnv, owner } = await isolatedFixture('replay-pruned-file');
  const oldFile = (await upload(owner)).data.file;
  const payload = entry({ id: null, requestId: crypto.randomUUID(), files: [oldFile] });
  const first = await post(owner, '/festa/entry', payload);
  assert.equal(first.status, 200);
  assert.equal((await post(owner, '/festa/entry', entry({ id: first.data.entry.id, title: '첨부를 제거한 최신본', files: [] }))).status, 200);
  for (let i = 0; i < 20; i += 1) assert.equal((await upload(owner, `새-초안-${i}.txt`, `draft ${i}`)).status, 200);
  assert.equal(await localEnv.BUCKET.get(oldFile.key), null);
  const replay = await post(owner, '/festa/entry', payload);
  assert.equal(replay.status, 200, replay.data?.message);
  assert.equal(replay.data.entry.id, first.data.entry.id);
  assert.equal(replay.data.entry.title, '첨부를 제거한 최신본');
  assert.deepEqual(replay.data.entry.files, []);
  assert.equal((await get(owner)).myEntries.length, 1);
});
await test('업로드 정리와 두 번째 작품 저장이 충돌해도 저장된 첨부를 삭제하지 않음', async () => {
  class RacingBucket extends MockBucket {
    race = false;
    waiting = null;
    async put(key, value, opts) {
      if (this.race && key === 'data/festa.json') {
        if (!this.waiting) await new Promise((resolve) => { this.waiting = resolve; });
        else { this.race = false; this.waiting(); }
      }
      return super.put(key, value, opts);
    }
  }
  const storage = new RacingBucket();
  const { owner } = await isolatedFixture('prune-race', storage);
  assert.equal((await post(owner, '/festa/entry', entry({ id: null }))).status, 200);
  const files = [];
  for (let i = 0; i < 20; i += 1) files.push((await upload(owner, `경쟁-${i}.txt`, `race ${i}`)).data.file);
  storage.race = true;
  const [saved, uploaded] = await Promise.all([
    post(owner, '/festa/entry', entry({ id: null, title: '동시 접수', files: [files[0]] })),
    upload(owner, '새로운-경쟁.txt', 'new draft'),
  ]);
  assert.equal(uploaded.status, 200, uploaded.data?.message);
  assert.ok([200, 403].includes(saved.status), saved.data?.message);
  const state = await get(owner);
  for (const work of state.myEntries) {
    for (const file of work.files) assert.ok(await storage.get(file.key), 'a successful save never references a deleted file');
  }
  if (saved.status === 200) assert.ok(await storage.get(files[0].key));
  else assert.equal(state.myEntries.length, 1, 'pruned file cannot be attached by a stale save');
});
await test('마감일 손상은 오류로 처리하고 저장 데이터를 초기화하지 않음', async () => {
  const { localEnv, owner, boss } = await isolatedFixture('corrupt-deadline');
  const corrupt = JSON.stringify({ phase: 'open', deadline: '2027-02-30', entries: [], scores: [], uploads: [] });
  await localEnv.BUCKET.put('data/festa.json', corrupt);
  assert.equal((await owner('/festa')).status, 503);
  assert.equal((await post(boss, '/festa/deadline', { deadline: '2027-12-07' })).status, 503);
  assert.equal(await (await localEnv.BUCKET.get('data/festa.json')).text(), corrupt);
});

Date.now = realNow;
console.log(`\nFesta API: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
