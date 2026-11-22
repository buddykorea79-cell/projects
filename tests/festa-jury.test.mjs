/** 개별 위원 초대, 독립 심사 단계, PIN·파일·점수 권한과 CAS 경쟁을 검증합니다. */
import assert from 'node:assert/strict';
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'jury-admin@example.com';
const MOIS = '행정안전부';
const IWEST = '한국서부발전';
const baseline = Date.parse('2026-11-22T00:00:00Z');
const originalNow = Date.now;
let now = baseline;
Date.now = () => now;
const failures = [];
async function test(name, fn) {
  try { now = baseline; await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.stack}`); }
}

function client(env) {
  const cookies = new Map();
  return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const headers = { Origin: ORIGIN };
    if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await handleApi(new Request(`${ORIGIN}/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { basePath: '/api' });
    const set = response.headers.get('Set-Cookie');
    if (set) {
      const pair = set.split(';')[0];
      const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return { status: response.status, headers: response.headers,
      data: response.headers.get('Content-Type')?.includes('json') ? await response.json() : null, response };
  };
}
const ok = (response, expected = 200) => { assert.equal(response.status, expected, JSON.stringify(response.data)); return response.data; };
const entry = (index, institution = index < 3 ? MOIS : IWEST) => ({
  id: `fe_entry_${index}`, title: `작품 ${index}`, description: `작품 설명 ${index}`,
  institution, author: { name: `참가자 ${index}`, email: `author-${index}@example.com`, institution, memberCreatedAt: '2026-01-01T00:00:00Z' },
  localOnly: false, deployUrl: `https://example.com/entry-${index}`, githubUrl: 'https://github.com/example/repo',
  files: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});
async function fixture(options = {}) {
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, ADMIN_EMAILS: ADMIN, TOKEN_SECRET: 'isolated-jury-test-key', PBKDF2_ITERATIONS: 1000 };
  const admin = client(env);
  const member = client(env);
  const anonymous = client(env);
  for (const [call, email] of [[admin, ADMIN], [member, 'author-0@example.com']]) {
    ok(await call('/auth/signup', { email, name: '검증 회원', institution: MOIS, password: 'Jury-test-2026!' }));
  }
  const entries = options.entries || Array.from({ length: 6 }, (_, i) => entry(i));
  const file = { key: 'festa/uploads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.txt', name: '심사 자료.txt', size: 8 };
  entries[0].files = [file];
  await bucket.put(file.key, new TextEncoder().encode('contents'));
  await bucket.put('data/festa.json', JSON.stringify({ phase: options.phase || 'closed', entries,
    deadline: '2027-12-07', scores: [], uploads: [] }));
  return { bucket, env, admin, member, anonymous, entries, file };
}
async function configure(f, panel, entryIds) { return ok(await f.admin('/festa/jury/panel', { panel, entryIds })).panel; }
async function invite(f, panel, email, pin = '012345') {
  const judge = ok(await f.admin('/festa/jury/judge', { panel, name: email.split('@')[0], email })).judge;
  const invitation = ok(await f.admin('/festa/jury/invite', { panel, judgeId: judge.id, pin }));
  return { ...invitation, pin, judge };
}
const open = async (f, panel) => ok(await f.admin('/festa/jury/status', { panel, status: 'open' })).panel;
const authenticate = async (call, invitation, pin = invitation.pin) => ok(await call('/festa/jury/unlock', { token: invitation.token, pin }));
const session = async (call, invitation) => call(`/festa/jury/session?token=${invitation.token}`);
const score = async (call, invitation, entryId, scores = [40, 30, 20, 10]) => call('/festa/jury/score', { token: invitation.token, entryId, scores });
const filePath = (file, invitation) => `/festa/jury/file/${encodeURIComponent(file.key)}?token=${invitation.token}`;

await test('관리자 전용 작업은 일반회원·비회원이 사용할 수 없음', async () => {
  const f = await fixture();
  for (const [call, status] of [[f.member, 403], [f.anonymous, 401]]) {
    ok(await call('/festa/jury/admin'), status);
    for (const [path, body] of [
      ['panel', { panel: 'mois', entryIds: [] }], ['judge', { panel: 'mois', name: '위원', email: 'judge@example.com' }],
      ['judge/remove', { panel: 'mois', judgeId: 'invalid' }], ['invite', { panel: 'mois', judgeId: 'invalid', pin: '123456' }],
      ['revoke', { panel: 'mois', judgeId: 'invalid' }], ['status', { panel: 'mois', status: 'open' }],
    ]) ok(await call(`/festa/jury/${path}`, body), status);
  }
  const overview = ok(await f.admin('/festa/jury/admin'));
  assert.deepEqual(overview.panels.map((panel) => panel.key), ['mois', 'iwest', 'final']);
  assert.ok(overview.entries.every((row) => row.author.email));
});
await test('기관별 1차 심사 대상·중복 ID·프로토타입 키를 서버에서 검증', async () => {
  const f = await fixture();
  for (const panel of ['__proto__', 'constructor', '', null]) ok(await f.admin('/festa/jury/panel', { panel, entryIds: [] }), 400);
  ok(await f.admin('/festa/jury/panel', { panel: 'mois', entryIds: [f.entries[3].id] }), 400);
  ok(await f.admin('/festa/jury/panel', { panel: 'iwest', entryIds: [f.entries[0].id] }), 400);
  ok(await f.admin('/festa/jury/panel', { panel: 'mois', entryIds: [f.entries[0].id, f.entries[0].id] }), 400);
  ok(await f.admin('/festa/jury/panel', { panel: 'mois', entryIds: ['fe_missing'] }), 400);
  assert.deepEqual((await configure(f, 'mois', [f.entries[0].id])).entryIds, [f.entries[0].id]);
});
await test('초안에서 위원 추가·수정·삭제와 이메일 중복 방지를 지원', async () => {
  const f = await fixture();
  const a = await invite(f, 'mois', 'judge@example.com');
  ok(await f.admin('/festa/jury/judge', { panel: 'mois', name: '중복', email: 'JUDGE@example.com' }), 409);
  const modified = ok(await f.admin('/festa/jury/judge', { panel: 'mois', judgeId: a.judge.id,
    name: '수정 위원', email: 'replacement@example.com' })).judge;
  assert.equal(modified.hasInvite, false, 'identity edit invalidates old credential');
  ok(await f.anonymous(`/festa/jury/invitation?token=${a.token}`), 404);
  ok(await f.admin('/festa/jury/judge/remove', { panel: 'mois', judgeId: a.judge.id }));
  assert.equal(ok(await f.admin('/festa/jury/admin')).panels[0].judges.length, 0);
});
await test('PIN은 관리자가 지정한 6자리 문자열이며 초대·일반 응답에는 원문이 없음', async () => {
  const f = await fixture();
  const judge = ok(await f.admin('/festa/jury/judge', { panel: 'mois', name: '위원', email: 'judge@example.com' })).judge;
  for (const pin of [123456, '12345', '1234567', 'abcdef', '', null]) {
    ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: judge.id, pin }), 400);
  }
  const issued = ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: judge.id, pin: '012345' }));
  assert.match(issued.token, /^[a-f0-9]{64}$/);
  assert.equal(issued.pin, undefined);
  const invitation = ok(await f.anonymous(`/festa/jury/invitation?token=${issued.token}`));
  assert.deepEqual(Object.keys(invitation).sort(), ['expiresAt', 'judgeId', 'judgeName', 'label', 'panel', 'status']);
  const stored = await (await f.bucket.get('data/festa.json')).text();
  assert.equal(stored.includes(issued.token), false);
  assert.equal(stored.includes('012345'), false);
  const state = JSON.parse(stored);
  assert.match(state.juryPanels.mois.judges[0].pinHash, /^pbkdf2\$sha256\$/);
  const overview = JSON.stringify(ok(await f.admin('/festa/jury/admin')));
  assert.equal(overview.includes('pinHash'), false);
  assert.equal(overview.includes('tokenHash'), false);
  assert.equal(overview.includes(issued.token), false);
});
await test('수동 접수 마감·유효 초대·비본인 위원 없이는 개시할 수 없음', async () => {
  const f = await fixture({ phase: 'open' });
  await configure(f, 'mois', [f.entries[0].id]);
  const own = await invite(f, 'mois', 'author-0@example.com');
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'open' }), 409);
  ok(await f.admin('/festa/phase', { phase: 'closed' }));
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'open' }), 409);
  const outsider = ok(await f.admin('/festa/jury/judge', { panel: 'mois', name: '외부위원', email: 'outside@example.com' })).judge;
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'open' }), 409);
  const issued = ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: outsider.id, pin: '012345' }));
  await open(f, 'mois');
  const selfClient = client(f.env);
  await authenticate(selfClient, own);
  ok(await score(selfClient, own, f.entries[0].id), 403);
  assert.ok(ok(await session(selfClient, own)).entries[0].scoreBlocked);
  for (const [path, body] of [
    ['panel', { panel: 'mois', entryIds: [] }],
    ['judge', { panel: 'mois', name: '추가', email: 'new@example.com' }],
    ['judge', { panel: 'mois', judgeId: own.judge.id, name: '변경', email: 'change@example.com' }],
    ['judge/remove', { panel: 'mois', judgeId: own.judge.id }],
  ]) ok(await f.admin(`/festa/jury/${path}`, body), 409);
  assert.ok(issued.token);
});
await test('위원은 자기 초대의 작품·본인 점수만 보고 다른 위원의 점수·집계는 볼 수 없음', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id, f.entries[1].id]);
  const a = await invite(f, 'mois', 'judge-a@example.com');
  const b = await invite(f, 'mois', 'judge-b@example.com');
  await open(f, 'mois');
  const ca = client(f.env); const cb = client(f.env);
  const unlocked = await ca('/festa/jury/unlock', { token: a.token, pin: a.pin });
  ok(unlocked);
  assert.match(unlocked.headers.get('Set-Cookie'), /HttpOnly/);
  assert.match(unlocked.headers.get('Set-Cookie'), /SameSite=Lax/);
  assert.match(unlocked.headers.get('Set-Cookie'), /Secure/);
  assert.match(unlocked.headers.get('Set-Cookie'), /Path=\/api\/festa\/jury/);
  await authenticate(cb, b);
  ok(await score(ca, a, f.entries[0].id));
  const va = ok(await session(ca, a));
  const vb = ok(await session(cb, b));
  assert.deepEqual(va.entries[0].myScores, [40, 30, 20, 10]);
  assert.equal(vb.entries[0].myScores, null);
  for (const privateField of ['average', 'scoreCount', 'judges', 'pinHash', 'tokenHash', 'judge-a@example.com', 'author-0@example.com']) {
    assert.equal(JSON.stringify(vb).includes(privateField), false, privateField);
  }
  const admin = ok(await f.admin('/festa/jury/admin')).panels[0];
  assert.equal(admin.results[0].average, 100);
  assert.deepEqual(admin.scores[0], { judgeId: a.judge.id, entryId: f.entries[0].id, scores: [40, 30, 20, 10] });
});
await test('PIN 오류 5회와 동시 추측은 잠금을 적용하고 잠금 만료 후 정상 인증 가능', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'judge@example.com');
  await open(f, 'mois');
  const ca = client(f.env);
  const responses = await Promise.all(Array.from({ length: 6 }, () => ca('/festa/jury/unlock', { token: a.token, pin: '999999' })));
  assert.equal(responses.filter((response) => response.status === 403).length, 4);
  assert.ok(responses.every((response) => [403, 429].includes(response.status)));
  ok(await ca('/festa/jury/unlock', { token: a.token, pin: a.pin }), 429);
  now += 10 * 60 * 1000 + 1;
  await authenticate(ca, a);
  assert.equal(ok(await session(ca, a)).entries.length, 1);
});
await test('개별 초대와 세션은 만료·폐기·재발급 즉시 접근을 차단하고 표는 보존', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'judge@example.com');
  await open(f, 'mois');
  const ca = client(f.env);
  await authenticate(ca, a);
  ok(await score(ca, a, f.entries[0].id));
  const rotated = ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: a.judge.id, pin: '000001' }));
  ok(await session(ca, a), 404);
  ok(await session(ca, rotated), 401);
  await authenticate(ca, { ...rotated, pin: '000001' });
  assert.deepEqual(ok(await session(ca, rotated)).entries[0].myScores, [40, 30, 20, 10]);
  now += 8 * 3600 * 1000;
  ok(await session(ca, rotated), 401, 'session ends at exact expiry');
  await authenticate(ca, { ...rotated, pin: '000001' });
  ok(await f.admin('/festa/jury/revoke', { panel: 'mois', judgeId: a.judge.id }));
  ok(await session(ca, rotated), 410);
  const third = ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: a.judge.id, pin: '000002' }));
  now = third.expiresAt;
  ok(await f.anonymous(`/festa/jury/invitation?token=${third.token}`), 410);
  ok(await ca('/festa/jury/unlock', { token: third.token, pin: '000002' }), 410);
});
await test('다른 패널은 독립 쿠키이며 오래된 탭이 다른 위원이나 패널의 표를 덮어쓰지 못함', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  await configure(f, 'iwest', [f.entries[3].id]);
  const a = await invite(f, 'mois', 'judge-a@example.com');
  const b = await invite(f, 'mois', 'judge-b@example.com');
  const c = await invite(f, 'iwest', 'judge-a@example.com');
  await open(f, 'mois'); await open(f, 'iwest');
  const browser = client(f.env);
  await authenticate(browser, a); await authenticate(browser, c);
  assert.equal(ok(await session(browser, a)).panel, 'mois');
  assert.equal(ok(await session(browser, c)).panel, 'iwest');
  ok(await score(browser, c, f.entries[0].id), 403);
  ok(await score(browser, a, f.entries[3].id), 403);
  await authenticate(browser, b);
  ok(await session(browser, a), 401);
  ok(await score(browser, a, f.entries[0].id), 401);
  ok(await score(browser, b, f.entries[0].id));
  ok(await score(browser, c, f.entries[3].id));
});
await test('배정 파일 다운로드는 PIN 인증·초대 범위를 확인하고 일반 API로 우회할 수 없음', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  await configure(f, 'iwest', [f.entries[3].id]);
  const a = await invite(f, 'mois', 'judge@example.com');
  const b = await invite(f, 'iwest', 'other@example.com');
  await open(f, 'mois'); await open(f, 'iwest');
  const ca = client(f.env); const cb = client(f.env);
  ok(await ca(filePath(f.file, a)), 401);
  ok(await f.member(filePath(f.file, a)), 401, 'ordinary site login is not judge authentication');
  await authenticate(ca, a); await authenticate(cb, b);
  ok(await cb(filePath(f.file, b)), 403);
  const downloaded = await ca(filePath(f.file, a));
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.response.text(), 'contents');
  assert.equal(downloaded.headers.get('Cache-Control'), 'private, no-store');
  assert.match(downloaded.headers.get('Content-Disposition'), /^attachment/);
  assert.equal(downloaded.headers.get('X-Content-Type-Options'), 'nosniff');
  ok(await ca(`/file/${encodeURIComponent(f.file.key)}`), 401);
  ok(await ca(`/festa/file/${encodeURIComponent(f.file.key)}`), 401);
});
await test('동시 채점은 위원·작품당 한 표이며 마감은 전원 평가 완료 후에만 가능', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'judge-a@example.com');
  const b = await invite(f, 'mois', 'judge-b@example.com');
  await open(f, 'mois');
  const ca = client(f.env); const cb = client(f.env);
  await authenticate(ca, a); await authenticate(cb, b);
  for (const scores of [[41, 30, 20, 10], [1, 2, 3], [1.5, 0, 0, 0], ['1', 2, 3, 4], [-1, 0, 0, 0]]) {
    ok(await score(ca, a, f.entries[0].id, scores), 400);
  }
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'closed' }), 409);
  const saved = await Promise.all([score(ca, a, f.entries[0].id, [0, 0, 0, 0]), score(ca, a, f.entries[0].id, [40, 30, 20, 10])]);
  saved.forEach((row) => ok(row));
  let overview = ok(await f.admin('/festa/jury/admin')).panels[0];
  assert.equal(overview.scores.length, 1);
  assert.equal(overview.results[0].scoreCount, 1);
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'closed' }), 409);
  ok(await score(cb, b, f.entries[0].id, [0, 0, 0, 0]));
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'closed' }));
  ok(await score(ca, a, f.entries[0].id), 409);
  ok(await ca(filePath(f.file, a)), 409);
  assert.equal(ok(await session(ca, a)).status, 'closed');
  assert.deepEqual(ok(await session(ca, a)).entries, []);
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'open' }), 409);
  ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: a.judge.id, pin: '012345' }), 409);
  overview = ok(await f.admin('/festa/jury/admin')).panels[0];
  assert.equal(overview.scores.length, 2);
});
await test('본선은 기관별 예선과 독립 개시되며 서로 다른 6명·기관 최소 인원을 강제', async () => {
  const f = await fixture();
  await configure(f, 'final', f.entries.map((row) => row.id));
  const a = await invite(f, 'final', 'final-judge@example.com');
  await open(f, 'final');
  const overview = ok(await f.admin('/festa/jury/admin'));
  assert.equal(overview.panels[0].status, 'draft');
  assert.equal(overview.panels[1].status, 'draft');
  assert.equal(overview.panels[2].status, 'open');
  const ca = client(f.env);
  await authenticate(ca, a);
  assert.equal(ok(await session(ca, a)).entries.length, 6);

  const missing = await fixture({ entries: Array.from({ length: 6 }, (_, i) => entry(i, i === 0 ? MOIS : IWEST)) });
  await configure(missing, 'final', missing.entries.map((row) => row.id));
  await invite(missing, 'final', 'final-judge@example.com');
  ok(await missing.admin('/festa/jury/status', { panel: 'final', status: 'open' }), 409);
  const noIwest = await fixture({ entries: Array.from({ length: 6 }, (_, i) => entry(i, MOIS)) });
  await configure(noIwest, 'final', noIwest.entries.map((row) => row.id));
  await invite(noIwest, 'final', 'final-judge@example.com');
  ok(await noIwest.admin('/festa/jury/status', { panel: 'final', status: 'open' }), 409);

  const duplicateEntries = Array.from({ length: 6 }, (_, i) => entry(i));
  duplicateEntries[1].author.email = duplicateEntries[0].author.email.toUpperCase();
  const duplicate = await fixture({ entries: duplicateEntries });
  ok(await duplicate.admin('/festa/jury/panel', { panel: 'final', entryIds: duplicate.entries.map((row) => row.id) }), 400);
  const tooFew = await fixture();
  await configure(tooFew, 'final', tooFew.entries.slice(0, 5).map((row) => row.id));
  await invite(tooFew, 'final', 'final-judge@example.com');
  ok(await tooFew.admin('/festa/jury/status', { panel: 'final', status: 'open' }), 409);
});

Date.now = originalNow;
console.log(`\nFesta jury: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
