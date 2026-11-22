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

function client(env, source) {
  const cookies = new Map();
  return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const headers = { Origin: ORIGIN };
    if (source) headers['CF-Connecting-IP'] = source;
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
async function invite(f, panel, email, pin) {
  f.nextCode ??= {};
  pin ??= String(12345 + (f.nextCode[panel] || 0)).padStart(6, '0');
  f.nextCode[panel] = (f.nextCode[panel] || 0) + 1;
  const judge = ok(await f.admin('/festa/jury/judge', { panel, name: email.split('@')[0], email })).judge;
  const invitation = ok(await f.admin('/festa/jury/invite', { panel, judgeId: judge.id, pin }));
  return { ...invitation, pin, judge };
}
const open = async (f, panel) => ok(await f.admin('/festa/jury/status', { panel, status: 'open' })).panel;
const authenticate = async (call, invitation, pin = invitation.pin) => ok(await call('/festa/jury/unlock', { token: invitation.token, pin }));
const session = async (call, invitation) => call(`/festa/jury/session?token=${invitation.token}`);
const score = async (call, invitation, entryId, scores = [40, 30, 20, 10]) => call('/festa/jury/score', { token: invitation.token, entryId, scores });
const filePath = (file, invitation) => `/festa/jury/file/${encodeURIComponent(file.key)}?token=${invitation.token}`;
const commonUnlock = (call, invitation) => call('/festa/jury/unlock', { panel: invitation.panel, pin: invitation.pin });
const commonSession = (call, invitation) => call(`/festa/jury/session?panel=${invitation.panel}&judgeId=${invitation.judgeId}`);
const commonScore = (call, invitation, entryId, scores = [40, 30, 20, 10]) => call('/festa/jury/score', {
  panel: invitation.panel, judgeId: invitation.judgeId, entryId, scores,
});
const commonFile = (file, invitation) => `/festa/jury/file/${encodeURIComponent(file.key)}?panel=${invitation.panel}&judgeId=${invitation.judgeId}`;
const memberScore = (call, entryId, scores = [40, 30, 20, 10], extras = {}) => call('/festa/jury/member-score', { entryId, scores, ...extras });
const memberFile = (file) => `/festa/jury/member-file/${encodeURIComponent(file.key)}`;
async function memberClient(f, email = 'audience@example.com') {
  const call = client(f.env);
  ok(await call('/auth/signup', { email, name: '회원 평가자', institution: MOIS, password: 'Member-vote-2026!' }));
  return call;
}

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
  const issued = ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: outsider.id, pin: '012346' }));
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
  ok(await f.anonymous('/festa/jury/unlock', { token: a.token, pin: a.pin }), 409);
  assert.equal(ok(await f.member('/festa/jury/member-final')).entries.length, 6);

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

await test('공통 주소 안내는 명부를 노출하지 않고 1차 코드는 독립, 2차는 회원 로그인 안내', async () => {
  const f = await fixture();
  const browser = client(f.env, '198.51.100.1');
  const invitations = [];
  for (const [panel, ids] of [['mois', [f.entries[0].id]], ['iwest', [f.entries[3].id]], ['final', f.entries.map((row) => row.id)]]) {
    await configure(f, panel, ids);
    const invitation = await invite(f, panel, `${panel}@example.com`, '000007');
    invitations.push(invitation);
    await open(f, panel);
    const metadata = ok(await f.anonymous(`/festa/jury/invitation?panel=${panel}`));
    assert.deepEqual(Object.keys(metadata).sort(), ['label', 'panel', 'status']);
    assert.equal(metadata.panel, panel);
    if (panel === 'final') ok(await commonUnlock(browser, invitation), 409);
    else assert.equal(ok(await commonUnlock(browser, invitation)).judgeId, invitation.judgeId);
  }
  for (const invitation of invitations) {
    if (invitation.panel === 'final') { ok(await commonSession(browser, invitation), 409); continue; }
    const response = ok(await commonSession(browser, invitation));
    assert.equal(response.panel, invitation.panel);
    assert.equal(response.judgeId, invitation.judgeId);
    assert.equal(response.entries.length, 1);
  }
  const state = JSON.parse(await (await f.bucket.get('data/festa.json')).text());
  const selectors = invitations.map((invitation) => state.juryPanels[invitation.panel].judges[0].pinLookup);
  selectors.forEach((value) => assert.match(value, /^[a-f0-9]{64}$/));
  assert.equal(new Set(selectors).size, 3, 'selector is scoped to panel');
  for (const key of ['__proto__', 'constructor', 'other']) {
    ok(await browser(`/festa/jury/invitation?panel=${key}`), 400);
    ok(await browser('/festa/jury/unlock', { panel: key, pin: '000007' }), 400);
  }
});

await test('패널 안 코드 중복과 동시 중복 발급을 막고 재발급은 기존 접근만 폐기', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'a@example.com', '000001');
  const b = await invite(f, 'mois', 'b@example.com', '000002');
  ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: b.judgeId, pin: '000001' }), 409);
  const races = await Promise.all([a, b].map((invitation) => f.admin('/festa/jury/invite', {
    panel: 'mois', judgeId: invitation.judgeId, pin: '000003',
  })));
  assert.deepEqual(races.map((response) => response.status).sort(), [200, 409]);
  const winnerIndex = races.findIndex((response) => response.status === 200);
  const winner = { ...races[winnerIndex].data, pin: '000003' };
  const other = winnerIndex === 0 ? b : a;
  await open(f, 'mois');
  const browser = client(f.env, '198.51.100.2');
  ok(await commonUnlock(browser, winner));
  ok(await commonScore(browser, winner, f.entries[0].id));
  const rotated = { ...ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: winner.judgeId, pin: '000004' })), pin: '000004' };
  ok(await commonSession(browser, winner), 401);
  ok(await commonUnlock(browser, winner), 403);
  ok(await commonUnlock(browser, rotated));
  assert.deepEqual(ok(await commonSession(browser, rotated)).entries[0].myScores, [40, 30, 20, 10]);
  ok(await commonUnlock(client(f.env, '198.51.100.3'), other));
  ok(await f.admin('/festa/jury/revoke', { panel: 'mois', judgeId: rotated.judgeId }));
  ok(await commonSession(browser, rotated), 410);
  ok(await commonUnlock(browser, rotated), 403);
  const renewed = { ...ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: rotated.judgeId, pin: '000005' })), pin: '000005' };
  ok(await commonUnlock(browser, renewed));
  now += 8 * 3600 * 1000;
  ok(await commonSession(browser, renewed), 401);
  ok(await commonUnlock(browser, renewed));
  now = renewed.expiresAt;
  ok(await commonUnlock(browser, renewed), 403);
});

await test('공통 주소에서도 다른 탭의 위원 변경은 세션·채점·파일·로그아웃에 혼입되지 않음', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  await configure(f, 'iwest', [f.entries[3].id]);
  const a = await invite(f, 'mois', 'a@example.com');
  const b = await invite(f, 'mois', 'b@example.com');
  const c = await invite(f, 'iwest', 'c@example.com');
  await open(f, 'mois'); await open(f, 'iwest');
  const browser = client(f.env);
  ok(await commonSession(browser, a), 401);
  ok(await browser(commonFile(f.file, a)), 401);
  ok(await commonUnlock(browser, a)); ok(await commonUnlock(browser, c));
  assert.equal(ok(await browser('/festa/jury/session?panel=mois')).judgeId, a.judgeId);
  ok(await commonScore(browser, a, f.entries[3].id), 403);
  ok(await browser(commonFile(f.file, c)), 403);
  ok(await browser(`/festa/jury/file/${encodeURIComponent(f.file.key)}?panel=mois`), 401);
  ok(await browser('/festa/jury/score', { panel: 'mois', entryId: f.entries[0].id, scores: [1, 2, 3, 4] }), 401);
  const file = await browser(commonFile(f.file, a));
  assert.equal(file.status, 200); assert.equal(await file.response.text(), 'contents');
  ok(await commonUnlock(browser, b));
  ok(await commonSession(browser, a), 401);
  ok(await commonScore(browser, a, f.entries[0].id), 401);
  ok(await browser(commonFile(f.file, a)), 401);
  ok(await browser('/festa/jury/logout', { panel: 'mois', judgeId: a.judgeId }), 401);
  ok(await commonSession(browser, b));
  const saved = await Promise.all([commonScore(browser, b, f.entries[0].id), commonScore(browser, b, f.entries[0].id, [0, 0, 0, 0])]);
  saved.forEach((response) => ok(response));
  assert.equal(ok(await f.admin('/festa/jury/admin')).panels[0].scores.length, 1);
  const logout = await browser('/festa/jury/logout', { panel: 'mois', judgeId: b.judgeId });
  ok(logout); assert.match(logout.headers.get('Set-Cookie'), /^fj_mois=;/); assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  ok(await commonSession(browser, b), 401);
  ok(await commonSession(browser, c));
});

await test('공통 주소는 본인 평가와 타 위원 점수 접근을 막고 마감 후 파일·채점 차단', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const own = await invite(f, 'mois', 'author-0@example.com');
  const other = await invite(f, 'mois', 'other@example.com');
  await open(f, 'mois');
  const ca = client(f.env); const cb = client(f.env);
  ok(await commonUnlock(ca, own)); ok(await commonUnlock(cb, other));
  ok(await commonScore(ca, own, f.entries[0].id), 403);
  ok(await commonScore(cb, other, f.entries[0].id));
  const selfView = ok(await commonSession(ca, own));
  assert.equal(selfView.entries[0].myScores, null);
  assert.ok(selfView.entries[0].scoreBlocked);
  for (const field of ['average', 'scoreCount', 'judges', 'pinLookup', 'other@example.com']) assert.equal(JSON.stringify(selfView).includes(field), false);
  ok(await f.admin('/festa/jury/status', { panel: 'mois', status: 'closed' }));
  ok(await commonScore(cb, other, f.entries[0].id), 409);
  ok(await cb(commonFile(f.file, other)), 409);
  assert.deepEqual(ok(await commonSession(cb, other)).entries, []);
  ok(await commonUnlock(cb, other), 409);
});

await test('공유 IP의 정상 위원 8명이 동시에 입장해도 실패 카운터·상태 쓰기 없이 각자 인증', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const invitations = [];
  for (let i = 0; i < 8; i += 1) invitations.push(await invite(f, 'mois', `judge-${i}@example.com`));
  await open(f, 'mois');
  const put = f.bucket.put.bind(f.bucket);
  let writes = 0;
  f.bucket.put = (...args) => { writes += 1; return put(...args); };
  const derive = crypto.subtle.deriveBits;
  let derivations = 0;
  crypto.subtle.deriveBits = function (...args) { derivations += 1; return derive.apply(this, args); };
  try {
    const browsers = invitations.map(() => client(f.env, '198.51.100.10'));
    const results = await Promise.all(browsers.map((browser, i) => commonUnlock(browser, invitations[i])));
    results.forEach((response, i) => assert.equal(ok(response).judgeId, invitations[i].judgeId));
    assert.equal(derivations, 8, 'one PBKDF2 per selected judge, not one per roster member');
    assert.equal(writes, 0, 'successful shared-network sign-ins only read R2');
    for (let i = 0; i < browsers.length; i += 1) assert.equal(ok(await commonSession(browsers[i], invitations[i])).judgeId, invitations[i].judgeId);
  } finally { crypto.subtle.deriveBits = derive; f.bucket.put = put; }
});

await test('모르는 코드·형식 오류도 출처별 CAS 제한하며 명부 PBKDF 탐색과 IP 원문 저장이 없음', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'judge@example.com');
  await open(f, 'mois');
  const browser = client(f.env, '198.51.100.11');
  const derive = crypto.subtle.deriveBits;
  let derivations = 0;
  crypto.subtle.deriveBits = function (...args) { derivations += 1; return derive.apply(this, args); };
  try {
    const responses = await Promise.all(['999999', 'ABCDEF', 123456, '', '888888', '777777'].map((pin) => browser('/festa/jury/unlock', { panel: 'mois', pin })));
    assert.equal(responses.filter((response) => response.status === 403).length, 4);
    assert.ok(responses.every((response) => [403, 429].includes(response.status)));
    assert.equal(derivations, 0);
    ok(await commonUnlock(browser, a), 429);
    assert.equal(derivations, 0);
    const stored = await (await f.bucket.get('data/festa-jury-attempts-mois.json')).text();
    assert.equal(stored.includes('198.51.100.11'), false);
    assert.equal(stored.includes('999999'), false);
    const rate = JSON.parse(stored);
    assert.equal(rate.count, 5); assert.equal(rate.sources.length, 1); assert.equal(rate.sources[0].count, 5);
    ok(await commonUnlock(client(f.env, '198.51.100.12'), a));
    now += 10 * 60 * 1000;
    ok(await commonUnlock(browser, a));
  } finally { crypto.subtle.deriveBits = derive; }
});

await test('정상 인증은 이전 오류를 지우지 않고 분산 출처 추측도 패널 한도와 보관 상한 적용', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  await configure(f, 'iwest', [f.entries[3].id]);
  const a = await invite(f, 'mois', 'judge@example.com');
  const b = await invite(f, 'iwest', 'judge@example.com');
  await open(f, 'mois'); await open(f, 'iwest');
  const source = client(f.env, '198.51.100.20');
  for (let i = 0; i < 4; i += 1) ok(await source('/festa/jury/unlock', { panel: 'mois', pin: '999999' }), 403);
  ok(await commonUnlock(source, a));
  ok(await source('/festa/jury/unlock', { panel: 'mois', pin: '999999' }), 429);
  for (let i = 0; i < 95; i += 1) {
    ok(await client(f.env, `203.0.113.${i + 1}`)('/festa/jury/unlock', { panel: 'mois', pin: '999999' }), i === 94 ? 429 : 403);
  }
  ok(await commonUnlock(client(f.env, '192.0.2.1'), a), 429);
  ok(await commonUnlock(source, b));
  let rate = JSON.parse(await (await f.bucket.get('data/festa-jury-attempts-mois.json')).text());
  assert.equal(rate.count, 100); assert.ok(rate.sources.length <= 256);
  now += 10 * 60 * 1000;
  ok(await commonUnlock(source, a));
  ok(await source('/festa/jury/unlock', { panel: 'mois', pin: '999999' }), 403);
  rate = JSON.parse(await (await f.bucket.get('data/festa-jury-attempts-mois.json')).text());
  assert.equal(rate.count, 1); assert.equal(rate.sources.length, 1);
});

await test('기존 색인 없는 개별 초대는 유지하고 공통 주소는 재발급 뒤 사용하며 중복 이전 PIN도 차단', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'legacy-a@example.com', '012345');
  const b = await invite(f, 'mois', 'legacy-b@example.com', '012346');
  const state = JSON.parse(await (await f.bucket.get('data/festa.json')).text());
  delete state.juryPanels.mois.judges[0].pinLookup;
  delete state.juryPanels.mois.judges[1].pinLookup;
  state.juryPanels.mois.judges[1].pinHash = state.juryPanels.mois.judges[0].pinHash;
  await f.bucket.put('data/festa.json', JSON.stringify(state));
  await open(f, 'mois');
  assert.ok(ok(await f.admin('/festa/jury/admin')).panels[0].judges.every((judge) => judge.hasInvite && !judge.hasCommonCode));
  const ca = client(f.env); const cb = client(f.env);
  await authenticate(ca, a); await authenticate(cb, b, '012345');
  ok(await session(ca, a)); ok(await session(cb, b));
  ok(await commonUnlock(ca, a), 403);
  ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: a.judgeId, pin: '012345' }), 409);
  const next = { ...ok(await f.admin('/festa/jury/invite', { panel: 'mois', judgeId: a.judgeId, pin: '654321' })), pin: '654321' };
  ok(await commonUnlock(ca, next));
  ok(await ca(`/festa/jury/invitation?token=${a.token}`), 404);
  ok(await session(cb, b));
  assert.equal(ok(await f.admin('/festa/jury/admin')).panels[0].judges.find((judge) => judge.id === a.judgeId).hasCommonCode, true);
});

await test('인증 제한 상태 손상은 덮어쓰지 않고 차단하며 일반 데이터 API로 원본을 읽을 수 없음', async () => {
  const f = await fixture();
  await configure(f, 'mois', [f.entries[0].id]);
  const a = await invite(f, 'mois', 'judge@example.com');
  await open(f, 'mois');
  await f.bucket.put('data/festa-jury-attempts-mois.json', '{invalid');
  ok(await commonUnlock(f.anonymous, a), 503);
  assert.equal(await (await f.bucket.get('data/festa-jury-attempts-mois.json')).text(), '{invalid');
  ok(await f.member('/data/festa-jury-attempts-mois'), 404);
  ok(await f.member('/file/data%2Ffesta-jury-attempts-mois.json'), 400);
});

await test('2차는 PIN·지정위원 없이 활성 회원에게 열리고 비회원·정지 회원은 차단', async () => {
  const f = await fixture();
  await configure(f, 'final', f.entries.map((row) => row.id));
  assert.deepEqual(ok(await f.member('/festa/jury/member-final')).entries, []);
  ok(await memberScore(f.member, f.entries[1].id), 409);
  ok(await f.member(memberFile(f.file)), 409);
  await open(f, 'final');
  const overview = ok(await f.admin('/festa/jury/admin')).panels[2];
  assert.equal(overview.memberVoting, true); assert.equal(overview.judges.length, 0);
  const result = ok(await f.member('/festa/jury/member-final'));
  assert.equal(result.status, 'open'); assert.equal(result.entries.length, 6);
  assert.ok(result.entries[0].scoreBlocked); assert.match(result.judgeId, /^fm_[a-f0-9]{64}$/);
  ok(await f.anonymous('/festa/jury/member-final'), 401);
  ok(await memberScore(f.anonymous, f.entries[0].id), 401);
  ok(await f.anonymous(memberFile(f.file)), 401);
  const members = JSON.parse(await (await f.bucket.get('data/members.json')).text());
  members.find((row) => row.email === 'author-0@example.com').status = 'suspended';
  await f.bucket.put('data/members.json', JSON.stringify(members));
  ok(await f.member('/festa/jury/member-final'), 401);
  ok(await memberScore(f.member, f.entries[1].id), 401);
  ok(await f.member(memberFile(f.file)), 401);
});

await test('회원 신원은 본문으로 위조할 수 없고 자기평가·타인 점수 노출·동시 중복표를 차단', async () => {
  const f = await fixture();
  await configure(f, 'final', f.entries.map((row) => row.id)); await open(f, 'final');
  const audience = await memberClient(f);
  const spoof = { email: 'someone@example.com', memberId: 'fm_fake', judgeId: 'fj_fake', panel: 'mois' };
  ok(await memberScore(f.member, f.entries[0].id, [40, 30, 20, 10], spoof), 403);
  const results = await Promise.all([
    memberScore(audience, f.entries[0].id, [40, 30, 20, 10], spoof),
    memberScore(audience, f.entries[0].id, [0, 0, 0, 0], spoof),
  ]);
  results.forEach((response) => ok(response));
  const state = JSON.parse(await (await f.bucket.get('data/festa.json')).text());
  assert.equal(state.juryPanels.final.memberScores.length, 1);
  assert.equal(state.juryPanels.final.memberScores[0].email, 'audience@example.com');
  assert.match(state.juryPanels.final.memberScores[0].memberId, /^fm_[a-f0-9]{64}$/);
  const own = ok(await audience('/festa/jury/member-final'));
  assert.ok(Array.isArray(own.entries[0].myScores));
  const other = ok(await f.member('/festa/jury/member-final'));
  assert.equal(other.entries[0].myScores, null);
  ok(await memberScore(f.member, f.entries[1].id, [1, 2, 3, 4], { expectedMemberId: own.judgeId }), 409);
  assert.equal(ok(await f.member('/festa/jury/member-final')).entries[1].myScores, null);
  for (const privateField of ['average', 'scoreCount', 'participants', 'memberScores', 'audience@example.com', 'author-0@example.com']) {
    assert.equal(JSON.stringify(other).includes(privateField), false, privateField);
  }
  for (const values of [[41, 0, 0, 0], [1, 2, 3], [1.5, 0, 0, 0], ['1', 0, 0, 0]]) ok(await memberScore(audience, f.entries[1].id, values), 400);
  ok(await memberScore(audience, 'fe_not_final'), 403);
  const panel = ok(await f.admin('/festa/jury/admin')).panels[2];
  assert.equal(panel.results[0].scoreCount, 1); assert.equal(panel.participants.length, 1);
  assert.equal(panel.participants[0].email, 'audience@example.com');
});

await test('2차 회원 파일 다운로드는 회원 로그인·본선 배정·열린 평가만 허용', async () => {
  const entries = Array.from({ length: 7 }, (_, i) => entry(i));
  const foreign = { key: 'festa/uploads/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.txt', name: '비선정.txt', size: 7 };
  entries[6].files = [foreign];
  const f = await fixture({ entries });
  await f.bucket.put(foreign.key, 'outside');
  await configure(f, 'final', f.entries.slice(0, 6).map((row) => row.id)); await open(f, 'final');
  const audience = await memberClient(f);
  const downloaded = await audience(memberFile(f.file));
  assert.equal(downloaded.status, 200); assert.equal(await downloaded.response.text(), 'contents');
  assert.match(downloaded.headers.get('Content-Disposition'), /filename\*=UTF-8/);
  assert.equal(downloaded.headers.get('Cache-Control'), 'private, no-store');
  ok(await audience(memberFile(foreign)), 403);
  ok(await audience('/festa/jury/member-file/data%2Ffesta.json'), 400);
  ok(await audience(`/file/${encodeURIComponent(f.file.key)}`), 400);
  ok(await audience(`/festa/file/${encodeURIComponent(f.file.key)}`), 404);
});

await test('2차는 각 작품 한 표 이상이면 부분참여·미참여 회원이 있어도 마감하고 발표를 동결', async () => {
  const f = await fixture();
  await configure(f, 'final', f.entries.map((row) => row.id)); await open(f, 'final');
  const audience = await memberClient(f);
  await memberClient(f, 'not-voting@example.com');
  for (let i = 0; i < 5; i += 1) ok(await memberScore(audience, f.entries[i].id, [40 - i, 30, 20, 10]));
  ok(await f.admin('/festa/jury/status', { panel: 'final', status: 'closed' }), 409);
  // 참가자도 자기 작품 외의 한 작품만 평가할 수 있습니다. 나머지 전 작품 평가를 요구하지 않습니다.
  ok(await memberScore(f.member, f.entries[5].id, [35, 30, 20, 10]));
  ok(await f.admin('/festa/jury/status', { panel: 'final', status: 'closed' }));
  const published = ok(await f.anonymous('/festa/awards'));
  assert.equal(published.recipients.length, 6);
  assert.equal(/memberId|judgeId|scores|average|example.com/.test(JSON.stringify(published)), false);
  ok(await memberScore(audience, f.entries[0].id, [0, 0, 0, 0]), 409);
  ok(await audience(memberFile(f.file)), 409);
  assert.deepEqual(ok(await audience('/festa/jury/member-final')).entries, []);
  ok(await f.admin('/festa/jury/status', { panel: 'final', status: 'open' }), 409);
  assert.deepEqual(ok(await f.anonymous('/festa/awards')), published);
});

await test('이전 최종 위원 점수를 보존하고 같은 이메일 회원의 새 표로 대체하여 한 표만 집계', async () => {
  const f = await fixture();
  await configure(f, 'final', f.entries.map((row) => row.id));
  const previous = await invite(f, 'final', 'audience@example.com');
  await open(f, 'final');
  const state = JSON.parse(await (await f.bucket.get('data/festa.json')).text());
  state.juryPanels.final.scores = f.entries.map((entry, i) => ({ judgeId: previous.judgeId, entryId: entry.id, scores: [40 - i, 30, 20, 10] }));
  await f.bucket.put('data/festa.json', JSON.stringify(state));
  const audience = await memberClient(f);
  assert.equal(ok(await audience('/festa/jury/member-final')).entries[0].myScores, null, 'legacy credential does not prove member incarnation');
  ok(await commonUnlock(client(f.env), previous), 409);
  ok(await f.anonymous('/festa/jury/unlock', { token: previous.token, pin: previous.pin }), 409);
  ok(await memberScore(audience, f.entries[0].id, [0, 0, 0, 0]));
  const panel = ok(await f.admin('/festa/jury/admin')).panels[2];
  assert.equal(panel.results[0].average, 0); assert.equal(panel.results[0].scoreCount, 1);
  assert.equal(panel.results[1].average, 99); assert.equal(panel.results[1].scoreCount, 1);
  assert.equal(panel.scores.length, 6);
  assert.equal(panel.participants.length, 1); assert.equal(panel.participants[0].scoredCount, 6);
  assert.ok(panel.scores.every((row) => row.judgeId === panel.participants[0].id));
  assert.equal(JSON.parse(await (await f.bucket.get('data/festa.json')).text()).juryPanels.final.scores.length, 6, 'historical scores are retained');
});

await test('탈퇴 후 같은 이메일 재가입은 이전 표를 읽지 못하며 새 표가 기존 한 표를 교체', async () => {
  const f = await fixture();
  await configure(f, 'final', f.entries.map((row) => row.id)); await open(f, 'final');
  const audience = await memberClient(f);
  const members = JSON.parse(await (await f.bucket.get('data/members.json')).text());
  members.find((row) => row.email === 'audience@example.com').createdAt = '2025-01-01T00:00:00.000Z';
  await f.bucket.put('data/members.json', JSON.stringify(members));
  ok(await memberScore(audience, f.entries[0].id, [40, 30, 20, 10]));
  const oldId = ok(await audience('/festa/jury/member-final')).judgeId;
  await f.bucket.put('data/members.json', JSON.stringify(members.filter((row) => row.email !== 'audience@example.com')));
  ok(await audience('/festa/jury/member-final'), 401);
  const rejoined = await memberClient(f);
  const before = ok(await rejoined('/festa/jury/member-final'));
  assert.notEqual(before.judgeId, oldId); assert.equal(before.entries[0].myScores, null);
  ok(await memberScore(rejoined, f.entries[0].id, [0, 0, 0, 0]));
  const panel = ok(await f.admin('/festa/jury/admin')).panels[2];
  assert.equal(panel.results[0].scoreCount, 1); assert.equal(panel.results[0].average, 0);
  const state = JSON.parse(await (await f.bucket.get('data/festa.json')).text());
  assert.equal(state.juryPanels.final.memberScores.length, 1);
  assert.equal(state.juryPanels.final.memberScores[0].memberId, before.judgeId);
});

Date.now = originalNow;
console.log(`\nFesta jury: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
