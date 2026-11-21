/** Festa: 실제 API의 접수·마감·심사 경계와 회원별 소유권을 검증합니다. */
import assert from 'node:assert/strict';
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';
const bucket = new MockBucket();
const env = {
  BUCKET: bucket, PBKDF2_ITERATIONS: 1000, TOKEN_SECRET: 'festa-test-only-secret',
  FESTA_EMAIL: 'festa@example.com',
};
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.message}`); }
}

function session(sessionEnv = env) {
  let cookie = '';
  return async (path, { method = 'GET', body, form } = {}) => {
    const headers = { Origin: ORIGIN };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleApi(new Request(`${ORIGIN}/api${path}`, {
      method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)),
    }), sessionEnv, { basePath: '/api' });
    const set = response.headers.get('Set-Cookie');
    if (set) cookie = set.split(';')[0];
    const type = response.headers.get('Content-Type') || '';
    return {
      status: response.status, headers: response.headers,
      data: type.includes('json') ? await response.json() : null,
      response,
    };
  };
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

console.log('\n== Festa: 인증 및 접수 ==');
await test('관리자·일반회원·정지 대상 회원 가입', async () => {
  for (const [client, email, name] of [
    [admin, ADMIN, '운영자'], [alice, 'alice@example.com', '김교육'],
    [bob, 'bob@example.com', '이참여'], [carol, 'carol@example.com', '박심사'],
    [blocked, 'blocked@example.com', '정지회원'],
  ]) {
    const result = await post(client, '/auth/signup', {
      email, name, institution: '행정안전부', password: 'Festa-test-2026!',
    });
    assert.equal(result.status, 200, result.data?.message);
  }
});
await test('비회원은 목록·제출·단계변경·평가·업로드에 접근 불가', async () => {
  assert.equal((await anon('/festa')).status, 401);
  for (const [path, body] of [
    ['/festa/entry', entry()], ['/festa/phase', { phase: 'closed' }],
    ['/festa/contact', { email: 'help@example.com' }],
    ['/festa/score', { entryId: 'unknown', scores: [0, 0, 0, 0] }],
  ]) assert.equal((await post(anon, path, body)).status, 401, path);
  assert.equal((await upload(anon)).status, 401);
});
await test('최초 접수 상태와 빈 내 작품', async () => {
  const state = await get(alice);
  assert.equal(state.phase, 'open');
  assert.equal(state.mine, null);
  assert.deepEqual(state.entries, []);
  assert.equal(state.email, 'festa@example.com');
});
await test('문의 이메일은 관리자만 변경하며 유효한 단일 주소만 저장', async () => {
  assert.equal((await post(alice, '/festa/contact', { email: 'help@example.com' })).status, 403);
  for (const email of ['', 'not-email', 'a@example.com,b@example.com', 'a@example.com\r\nBcc: x@example.com']) {
    rejected(await post(admin, '/festa/contact', { email }), `invalid email ${email}`);
  }
  assert.equal((await post(admin, '/festa/contact', { email: 'help@example.com' })).status, 200);
  assert.equal((await get(alice)).email, 'help@example.com');
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
let bobId;
let adminId;
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
  const result = await post(alice, '/festa/entry', entry({
    title: '민원 안내 도우미 최종본', files: [aliceFile],
    author: { email: 'bob@example.com', name: '위조 작성자' }, id: 'forged-entry-id',
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
  const result = await post(bob, '/festa/entry', entry({
    title: '오프라인 문서 정리기', localOnly: true, deployUrl: '', id: aliceId,
  }));
  assert.equal(result.status, 200, result.data?.message);
  const mine = (await get(bob)).mine;
  bobId = mine.id;
  assert.notEqual(bobId, aliceId);
  assert.equal(mine.localOnly, true);
  assert.equal(mine.author.email, 'bob@example.com');
  assert.equal((await get(alice)).mine.title, '민원 안내 도우미 최종본');
});
await test('관리자도 자신의 작품을 접수할 수 있음', async () => {
  assert.equal((await post(admin, '/festa/entry', entry({ title: '운영자 예시 작품' }))).status, 200);
  adminId = (await get(admin)).mine.id;
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
await test('심사 개시 후 모든 회원이 작품을 보되 타인 이메일·미첨부 파일은 비공개', async () => {
  assert.equal((await post(admin, '/festa/phase', { phase: 'judging' })).status, 200);
  const state = await get(carol);
  assert.equal(state.phase, 'judging');
  assert.equal(state.entries.length, 3);
  assert.ok(state.entries.every((e) => !e.author.email));
  assert.equal(JSON.stringify(state).includes('alice@example.com'), false);
  assert.equal((await carol(filePath(aliceFile))).status, 200);
  rejected(await carol(filePath(bobDraftFile)), 'unattached draft privacy');
  assert.equal((await bob(filePath(bobDraftFile))).status, 200);
});
await test('심사 중에는 작품을 수정하거나 단계를 되돌릴 수 없음', async () => {
  for (const client of [alice, admin]) rejected(await post(client, '/festa/entry', entry()), 'immutable entry');
  for (const phase of ['open', 'closed', 'judging']) rejected(await post(admin, '/festa/phase', { phase }), phase);
  assert.equal((await get(admin)).phase, 'judging');
});
await test('본인 작품은 채점할 수 없고 존재하지 않는 작품도 거부', async () => {
  rejected(await post(alice, '/festa/score', { entryId: aliceId, scores: [40, 30, 20, 10] }), 'self score');
  rejected(await post(admin, '/festa/score', { entryId: adminId, scores: [40, 30, 20, 10] }), 'admin self score');
  assert.equal((await post(carol, '/festa/score', { entryId: 'fe_missing', scores: [0, 0, 0, 0] })).status, 404);
});
await test('점수는 정확히 네 개의 정수이며 각 문항 범위 밖 값을 거부', async () => {
  for (const scores of [
    [], [40, 30, 20], [40, 30, 20, 10, 0], [41, 30, 20, 10], [40, 31, 20, 10],
    [40, 30, 21, 10], [40, 30, 20, 11], [-1, 0, 0, 0], [0.5, 0, 0, 0],
    ['40', 30, 20, 10], [null, 0, 0, 0], [true, 0, 0, 0],
  ]) rejected(await post(carol, '/festa/score', { entryId: aliceId, scores }), JSON.stringify(scores));
  const all = (await get(admin)).entries;
  assert.equal(all.find((e) => e.id === aliceId).scoreCount, 0);
  assert.equal(all.find((e) => e.id === aliceId).average, null);
});
await test('일반회원과 관리자가 채점하면 100점 만점 평균과 참여 인원으로 집계', async () => {
  assert.equal((await post(bob, '/festa/score', { entryId: aliceId, scores: [40, 30, 20, 10] })).status, 200);
  assert.equal((await post(admin, '/festa/score', { entryId: aliceId, scores: [20, 15, 10, 5] })).status, 200);
  const result = (await get(admin)).entries.find((e) => e.id === aliceId);
  assert.equal(result.scoreCount, 2);
  assert.equal(result.average, 75);
  assert.deepEqual((await get(bob)).entries.find((e) => e.id === aliceId).myScores, [40, 30, 20, 10]);
  assert.equal((await get(carol)).entries.find((e) => e.id === aliceId).myScores, null);
});
await test('같은 심사자의 재채점은 한 표를 갱신하고 모든 항목 0점도 저장됨', async () => {
  assert.equal((await post(bob, '/festa/score', { entryId: aliceId, scores: [0, 0, 0, 0] })).status, 200);
  const result = (await get(admin)).entries.find((e) => e.id === aliceId);
  assert.equal(result.scoreCount, 2);
  assert.equal(result.average, 25);
  assert.deepEqual((await get(bob)).entries.find((e) => e.id === aliceId).myScores, [0, 0, 0, 0]);
});
await test('동시 재채점도 심사자 한 명당 한 표만 남김', async () => {
  const results = await Promise.all([
    post(carol, '/festa/score', { entryId: bobId, scores: [10, 10, 10, 10] }),
    post(carol, '/festa/score', { entryId: bobId, scores: [20, 20, 20, 10] }),
  ]);
  results.forEach((r) => assert.equal(r.status, 200, r.data?.message));
  const result = (await get(admin)).entries.find((e) => e.id === bobId);
  assert.equal(result.scoreCount, 1);
  assert.ok([40, 70].includes(result.average));
});
await test('정지된 회원은 기존 세션으로 목록·채점·첨부를 이용할 수 없음', async () => {
  assert.equal((await admin('/auth/members', {
    method: 'PATCH', body: { email: 'blocked@example.com', status: 'blocked' },
  })).status, 200);
  assert.equal((await blocked('/festa')).status, 401);
  assert.equal((await post(blocked, '/festa/score', { entryId: aliceId, scores: [0, 0, 0, 0] })).status, 401);
  assert.equal((await blocked(filePath(aliceFile))).status, 401);
});
await test('심사 종료는 관리자만 가능하고 모든 채점을 동결하며 결과는 유지', async () => {
  assert.equal((await post(alice, '/festa/phase', { phase: 'finished' })).status, 403);
  const before = (await get(admin)).entries.map((e) => [e.id, e.scoreCount, e.average]);
  assert.equal((await post(admin, '/festa/phase', { phase: 'finished' })).status, 200);
  for (const client of [bob, admin]) {
    rejected(await post(client, '/festa/score', { entryId: aliceId, scores: [40, 30, 20, 10] }), 'finished scores');
    rejected(await post(client, '/festa/entry', entry()), 'finished entry');
    rejected(await upload(client), 'finished upload');
  }
  const state = await get(admin);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(state.entries.map((e) => [e.id, e.scoreCount, e.average]), before);
  assert.equal((await get(carol)).entries.length, 3);
  assert.equal((await carol(filePath(aliceFile))).status, 200);
  for (const phase of ['open', 'closed', 'judging', 'finished']) {
    rejected(await post(admin, '/festa/phase', { phase }), `finished -> ${phase}`);
  }
});
await test('삭제된 이메일로 재가입해도 과거 작품·파일을 승계하거나 중복 출품하지 못함', async () => {
  const isolated = { ...env, BUCKET: new MockBucket(), TOKEN_SECRET: 'festa-new-account-fixture' };
  const boss = session(isolated);
  const original = session(isolated);
  const replacement = session(isolated);
  const register = (client, email) => post(client, '/auth/signup', {
    email, name: '테스트 회원', institution: '행정안전부', password: 'Festa-test-2026!',
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
await test('재가입해도 과거 본인 작품을 평가하거나 이전 평가를 중복·교체할 수 없음', async () => {
  const isolated = { ...env, BUCKET: new MockBucket(), TOKEN_SECRET: 'festa-recreated-judge-fixture' };
  const boss = session(isolated);
  const original = session(isolated);
  const other = session(isolated);
  const replacement = session(isolated);
  const register = (client, email) => post(client, '/auth/signup', {
    email, name: email.split('@')[0], institution: '행정안전부', password: 'Festa-test-2026!',
  });
  assert.equal((await register(boss, ADMIN)).status, 200);
  assert.equal((await register(original, 'judge-a@example.com')).status, 200);
  assert.equal((await register(other, 'entrant-b@example.com')).status, 200);
  assert.equal((await post(original, '/festa/entry', entry({ title: 'A의 과거 작품' }))).status, 200);
  assert.equal((await post(other, '/festa/entry', entry({ title: 'B의 작품' }))).status, 200);
  const oldEntryId = (await get(original)).mine.id;
  const otherEntryId = (await get(other)).mine.id;
  assert.equal((await post(boss, '/festa/phase', { phase: 'closed' })).status, 200);
  assert.equal((await post(boss, '/festa/phase', { phase: 'judging' })).status, 200);
  assert.equal((await post(original, '/festa/score', {
    entryId: otherEntryId, scores: [40, 30, 20, 10],
  })).status, 200);
  assert.deepEqual((await get(original)).entries.find((row) => row.id === otherEntryId).myScores,
    [40, 30, 20, 10], 'original member can see own saved score');
  assert.equal((await boss('/auth/members', {
    method: 'PATCH', body: { email: 'judge-a@example.com', status: 'blocked' },
  })).status, 200);
  assert.equal((await boss('/auth/members', {
    method: 'DELETE', body: { email: 'judge-a@example.com' },
  })).status, 200);
  assert.equal((await register(replacement, 'judge-a@example.com')).status, 200);
  const overview = await get(replacement);
  assert.equal(overview.mine, null, 'new account cannot edit previous entry');
  assert.equal(overview.entries.find((row) => row.id === oldEntryId).author.email, undefined,
    'previous member identity remains private');
  assert.equal(overview.entries.find((row) => row.id === otherEntryId).myScores, null,
    'previous account score is not disclosed to recreated account');
  const selfScore = await post(replacement, '/festa/score', {
    entryId: oldEntryId, scores: [40, 30, 20, 10],
  });
  const duplicateScore = await post(replacement, '/festa/score', {
    entryId: otherEntryId, scores: [0, 0, 0, 0],
  });
  rejected(selfScore, 'cannot score previous entry with same email');
  rejected(duplicateScore, 'cannot add or replace previous score with same email');
  const results = (await get(boss)).entries;
  assert.equal(results.find((row) => row.id === oldEntryId).scoreCount, 0);
  assert.equal(results.find((row) => row.id === oldEntryId).average, null);
  assert.equal(results.find((row) => row.id === otherEntryId).scoreCount, 1,
    'one score per email across account recreation');
  assert.equal(results.find((row) => row.id === otherEntryId).average, 100,
    'original score is preserved');
  assert.equal((await get(replacement)).entries.find((row) => row.id === otherEntryId).myScores, null);
});
await test('미첨부 업로드는 최근 20개만 보관하고 접수된 파일은 정리하지 않음', async () => {
  const isolated = { ...env, BUCKET: new MockBucket(), TOKEN_SECRET: 'festa-draft-cleanup-fixture' };
  const member = session(isolated);
  assert.equal((await post(member, '/auth/signup', {
    email: 'drafts@example.com', name: '첨부 시험', institution: '행정안전부', password: 'Festa-test-2026!',
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

console.log(`\nFesta API: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
