/** 운영 Festa/Camp 데이터 불변, 실행 격리, 선택 작품/첨부 공개 범위 회귀. */
import assert from 'node:assert/strict';
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import { REHEARSAL_KEY, rehearsalEnvironment, createRehearsal } from '../shared/festa-rehearsal.js';

const ORIGIN = 'https://site.test';
const BASE = '/festa/rehearsal';
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); }
  catch (error) { failures.push(name); console.error('  FAIL  ' + name + ' — ' + error.message); }
}
function session(env) {
  let cookie = '';
  return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await handleApi(new Request(ORIGIN + '/api' + path, {
      method, headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { basePath: '/api' });
    const set = response.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    return { status: response.status, headers: response.headers,
      body: response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text() };
  };
}
class OnceBucket extends MockBucket {
  async get(key) {
    const object = await super.get(key);
    if (!object) return object;
    let used = false;
    return { ...object, text: async () => {
      if (used) throw new TypeError('Body has already been used');
      used = true; return object.text();
    } };
  }
}
const snapshot = (bucket) => new Map([...bucket.objects.entries()].filter(([key]) => key !== REHEARSAL_KEY)
  .map(([key, record]) => [key, { bytes: Array.from(record.bytes), httpMetadata: record.httpMetadata, customMetadata: record.customMetadata }]));
async function setup({ count = 7, bucket = new MockBucket() } = {}) {
  const env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000, TOKEN_SECRET: 'isolated-rehearsal-test-secret' };
  const admin = session(env); const member = session(env); const owner = session(env); const guest = session(env);
  for (const [client, email] of [[admin, 'aireader@mois.go.kr'], [member, 'member@example.test'], [owner, 'writer0@example.test']]) {
    const response = await client('/auth/signup', { email, name: '테스트 회원', institution: '행정안전부', password: 'Rehearsal-2026!' });
    assert.equal(response.status, 200);
  }
  await bucket.put('data/festa.json', JSON.stringify({ version: 1, phase: 'open', entries: [], scores: [], uploads: [], email: 'live@example.test' }));
  await bucket.put('data/projects.json', JSON.stringify([
    { id: 'p_camp', title: '실제 빌드캠프', track: 'buildcamp', visibility: 'private' },
    { id: 'p_general', title: '일반 과제', track: 'general', visibility: 'public' },
  ]));
  const works = Array.from({ length: count }, (_, i) => ({
    id: 's_' + i, projectId: 'p_camp', title: '원본 작품 ' + i,
    body: i === 0 ? '실행: https://demo.example.test/app). 저장소: https://github.com/example/project). 원문 보존'
      : i === 1 ? '' : '비공개 원본 설명 ' + i,
    author: { name: '작성자 ' + i, email: 'writer' + i + '@example.test', institution: i % 3 === 0 ? '확인 전 기관' : i % 2 ? '행정안전부' : '한국서부발전' },
    files: [{ id: 'f_' + i, name: '한글 설명 ' + i + '.pdf', size: 10, type: 'application/pdf', storage: 'r2', key: 'uploads/m_owner/f_' + i + '_한글.pdf' }],
    status: 'submitted', team: i % 8 + 1, presenting: i < 6, updatedAt: '2026-11-22T01:00:00Z',
  }));
  for (const work of works) await bucket.put(work.files[0].key, 'private-camp-file-' + work.id);
  await bucket.put('data/submissions.json', JSON.stringify([...works, {
    id: 's_general', projectId: 'p_general', title: '선택하면 안 되는 일반 과제', body: '비공개 일반 데이터',
    author: { name: '일반 작성자', email: 'general@example.test', institution: '행정안전부' }, files: [],
  }]));
  await bucket.put('data/votes.json', JSON.stringify([{ id: 'original-camp-vote' }]));
  await bucket.put('data/scores.json', JSON.stringify([{ id: 'original-camp-score' }]));
  const original = snapshot(bucket);
  const start = async (extra = {}) => {
    const idle = await admin(BASE + '/status');
    const response = await admin(BASE + '/start', { confirm: true, expectedRunId: idle.body.lastRunId, ...extra });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
  };
  return { bucket, env, admin, member, owner, guest, start, original, works };
}
const scoped = (runId, suffix) => BASE + '/' + runId + suffix;
async function stateOf(ctx) { return JSON.parse(await (await ctx.bucket.get(REHEARSAL_KEY)).text()); }

console.log('\n== Build Camp 격리 리허설 ==');
await test('비회원은 상태·원본·시상 모두 거절, 회원은 관리자 원본 목록을 읽지 못함', async () => {
  const ctx = await setup();
  for (const suffix of ['/status', '/sources', '/00000000-0000-0000-0000-000000000000/awards']) {
    assert.equal((await ctx.guest(BASE + suffix)).status, 401);
  }
  assert.equal((await ctx.member(BASE + '/sources')).status, 403);
  assert.equal((await ctx.member(BASE + '/start', { confirm: true })).status, 403);
  assert.equal((await ctx.member(BASE + '/reset', { confirm: true })).status, 403);
  assert.equal((await ctx.member(BASE + '/status')).body.active, false);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('실제 Camp만 목록화하고 발표 선정작 우선·결정적 순서·본문 안전 링크를 사용', async () => {
  const ctx = await setup();
  const response = await ctx.admin(BASE + '/sources');
  assert.equal(response.status, 200);
  assert.equal(response.body.sources.length, 7);
  assert.deepEqual(response.body.sources.slice(0, 6).map((row) => row.id), ['s_0', 's_1', 's_2', 's_3', 's_4', 's_5']);
  assert.equal(response.body.sources[0].deployUrl, 'https://demo.example.test/app');
  assert.equal(response.body.sources[0].githubUrl, 'https://github.com/example/project');
  assert.equal(JSON.stringify(response.body).includes('uploads/m_owner'), false);
  const run = await ctx.start();
  assert.equal(run.entryCount, 6); assert.equal(run.rehearsal.realCount, 6); assert.equal(run.rehearsal.sampleCount, 0);
  assert.deepEqual(run.entries.map((row) => row.rehearsal.sourceId), ['s_0', 's_1', 's_2', 's_3', 's_4', 's_5']);
  assert.ok(run.entries.filter((row) => row.institution === '행정안전부').length >= 2);
  assert.ok(run.entries.filter((row) => row.institution === '한국서부발전').length >= 1);
  assert.ok(run.entries[0].rehearsal.syntheticFields.includes('institution'));
  assert.ok(run.entries[1].rehearsal.syntheticFields.includes('description'));
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('명시한 선택만 복사하고 빈 자리만 가상 보충, 빈 선택은 전부 가상 샘플', async () => {
  const ctx = await setup();
  const run = await ctx.start({ selections: [{ sourceId: 's_6', institution: '행정안전부' }] });
  assert.equal(run.rehearsal.realCount, 1); assert.equal(run.rehearsal.sampleCount, 5);
  assert.equal(run.entries[0].rehearsal.sourceId, 's_6');
  assert.ok(run.entries.slice(1).every((entry) => entry.rehearsal.sample));
  assert.equal((await ctx.admin(BASE + '/reset', { confirm: true, runId: run.runId })).status, 200);
  const samples = await ctx.start({ selections: [] });
  assert.equal(samples.rehearsal.realCount, 0); assert.equal(samples.rehearsal.sampleCount, 6);
  assert.ok(samples.entries.every((entry) => entry.rehearsal.notice.includes('가상')));
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('실제 작품 0개·4개도 6명·2+1 기관과 비동점 모의 점수로 즉시 마감 가능', async () => {
  for (const count of [0, 4]) {
    const ctx = await setup({ count }); const run = await ctx.start();
    assert.equal(run.rehearsal.realCount, count); assert.equal(run.rehearsal.sampleCount, 6 - count);
    const before = await stateOf(ctx);
    assert.equal(new Set(before.entries.map((entry) => entry.author.email)).size, 6);
    assert.equal(new Set(before.juryPanels.final.scores.map((row) => row.scores.reduce((a, b) => a + b))).size, 6);
    assert.equal(before.juryPanels.final.memberScores.length, 0);
    assert.ok(before.juryPanels.final.judges[0].email.endsWith('.invalid'));
    assert.equal((await ctx.admin(scoped(run.runId, '/jury/status'), { panel: 'final', status: 'closed' })).status, 200);
    const result = await ctx.member(scoped(run.runId, '/awards'));
    assert.equal(result.status, 200); assert.equal(result.body.recipients.length, 6);
    assert.deepEqual(result.body.recipients.reduce((out, row) => ({ ...out, [row.award]: (out[row.award] || 0) + 1 }), {}), { grand: 1, excellence: 2, encouragement: 3 });
    assert.equal((await ctx.guest(scoped(run.runId, '/awards'))).status, 401);
    assert.equal((await ctx.admin(BASE + '/reset', { confirm: true, runId: run.runId })).status, 200);
    assert.deepEqual(snapshot(ctx.bucket), ctx.original);
  }
});
await test('활성 리허설의 선택작만 회원에게 공개하고 원본 출처·이메일·가상심사 점수는 숨김', async () => {
  const ctx = await setup(); const run = await ctx.start();
  const status = await ctx.member(BASE + '/status');
  assert.equal(status.body.runId, run.runId); assert.equal(status.body.entries, undefined);
  const response = await ctx.member(scoped(run.runId, '/jury/member-final'));
  assert.equal(response.status, 200); assert.equal(response.body.entries.length, 6);
  for (const entry of response.body.entries) {
    assert.equal(entry.author.email, undefined);
    assert.deepEqual(Object.keys(entry.rehearsal).sort(), ['notice', 'sample', 'syntheticFields']);
    assert.equal(entry.myScores, null);
  }
  for (const secret of ['s_6', 's_general', 'fileMap', 'secret', 'writer0@example.test', '비공개 원본 설명 6']) {
    assert.equal(JSON.stringify(response.body).includes(secret), false, secret);
  }
});
await test('일회용 R2 text body에서도 조회·투표·마감이 정상이고 모든 운영 데이터는 동일', async () => {
  const ctx = await setup({ bucket: new OnceBucket() }); const run = await ctx.start();
  const list = await ctx.member(scoped(run.runId, '/jury/member-final'));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const entryId = list.body.entries[0].id;
  const score = await ctx.member(scoped(run.runId, '/jury/member-score'), { entryId, scores: [40, 30, 20, 10] });
  assert.equal(score.status, 200, JSON.stringify(score.body));
  assert.equal((await ctx.admin(scoped(run.runId, '/jury/status'), { panel: 'final', status: 'closed' })).status, 200);
  assert.equal((await ctx.member(scoped(run.runId, '/awards'))).status, 200);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('실회원은 모의 표에 추가 투표·수정하고 본인 작품은 평가하지 못함', async () => {
  const ctx = await setup(); const run = await ctx.start();
  const entryId = run.entries[0].id;
  assert.equal((await ctx.owner(scoped(run.runId, '/jury/member-score'), { entryId, scores: [40, 30, 20, 10] })).status, 403);
  for (const scores of [[0, 0, 0, 0], [30, 20, 10, 5]]) assert.equal((await ctx.member(scoped(run.runId, '/jury/member-score'), { entryId, scores })).status, 200);
  const state = await stateOf(ctx);
  assert.equal(state.juryPanels.final.scores.length, 6);
  assert.equal(state.juryPanels.final.memberScores.length, 1);
  assert.deepEqual(state.juryPanels.final.memberScores[0].scores, [30, 20, 10, 5]);
  const admin = await ctx.admin(scoped(run.runId, '/jury/admin'));
  assert.equal(admin.status, 200);
  assert.equal(admin.body.panels.find((panel) => panel.key === 'final').results.find((row) => row.entryId === entryId).scoreCount, 2);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('첨부파일은 별칭을 통해 선택본만 읽고 미선택·운영 키·비회원·마감 후에는 거절', async () => {
  const ctx = await setup(); const run = await ctx.start();
  const list = await ctx.member(scoped(run.runId, '/jury/member-final'));
  const key = list.body.entries[0].files[0].key;
  assert.ok(key.startsWith('festa/uploads/'));
  const path = scoped(run.runId, '/jury/member-file/' + encodeURIComponent(key));
  const file = await ctx.member(path);
  assert.equal(file.status, 200); assert.equal(file.body, 'private-camp-file-s_0');
  assert.ok(file.headers.get('Content-Disposition').includes(encodeURIComponent('한글 설명 0.pdf')));
  assert.equal((await ctx.guest(path)).status, 401);
  for (const invalid of ['uploads/m_owner/f_6_한글.pdf', 'data/members.json', 'festa/uploads/00000000-0000-0000-0000-000000000000.pdf']) {
    assert.ok([400, 403].includes((await ctx.member(scoped(run.runId, '/jury/member-file/' + encodeURIComponent(invalid)))).status));
  }
  await ctx.admin(scoped(run.runId, '/jury/status'), { panel: 'final', status: 'closed' });
  assert.equal((await ctx.member(path)).status, 409);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('원본 첨부가 교체되면 예전 별칭으로 새로운 파일이 노출되지 않음', async () => {
  const ctx = await setup(); const run = await ctx.start();
  const state = await stateOf(ctx); const key = state.entries[0].files[0].key;
  await ctx.bucket.put(ctx.works[0].files[0].key, 'changed-original');
  const response = await ctx.member(scoped(run.runId, '/jury/member-file/' + encodeURIComponent(key)));
  assert.equal(response.status, 409);
});
await test('초기화는 확인과 정확한 runId가 필요하며 이전 표·초기화는 새 실행에 영향 없음', async () => {
  const ctx = await setup(); const first = await ctx.start();
  const env = await rehearsalEnvironment(ctx.env, first.runId);
  const old = await env.BUCKET.get('data/festa.json'); const oldState = await old.text();
  assert.equal((await ctx.admin(BASE + '/reset', { runId: first.runId })).status, 400);
  assert.equal((await ctx.admin(BASE + '/reset', { confirm: true, runId: crypto.randomUUID() })).status, 409);
  assert.equal((await ctx.admin(BASE + '/reset', { confirm: true, runId: first.runId })).status, 200);
  assert.equal((await ctx.member(scoped(first.runId, '/jury/member-final'))).status, 409);
  const second = await ctx.start(); assert.notEqual(second.runId, first.runId);
  const before = JSON.stringify(await stateOf(ctx));
  assert.equal((await ctx.member(scoped(first.runId, '/jury/member-score'), { entryId: first.entries[0].id, scores: [40, 30, 20, 10] })).status, 409);
  assert.equal((await ctx.admin(BASE + '/reset', { confirm: true, runId: first.runId })).status, 409);
  await assert.rejects(env.BUCKET.put('data/festa.json', oldState, { onlyIf: { etagMatches: old.etag } }), (error) => error.status === 409);
  assert.equal(JSON.stringify(await stateOf(ctx)), before);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('진행 중인 투표가 reset·새 start와 겹쳐도 CAS가 새 실행을 보존', async () => {
  const ctx = await setup(); const first = await ctx.start();
  const realPut = ctx.bucket.put.bind(ctx.bucket);
  let unblock; let arrived;
  const waiting = new Promise((resolve) => { arrived = resolve; });
  const released = new Promise((resolve) => { unblock = resolve; });
  let intercepted = false;
  ctx.bucket.put = async (key, value, options) => {
    if (key === REHEARSAL_KEY && !intercepted) {
      const state = JSON.parse(value);
      if (state.rehearsal?.runId === first.runId && state.juryPanels?.final?.memberScores?.length) {
        intercepted = true; arrived(); await released;
      }
    }
    return realPut(key, value, options);
  };
  const pending = ctx.member(scoped(first.runId, '/jury/member-score'), { entryId: first.entries[0].id, scores: [35, 25, 15, 5] });
  await waiting;
  assert.equal((await ctx.admin(BASE + '/reset', { confirm: true, runId: first.runId })).status, 200);
  const second = await ctx.start(); const before = JSON.stringify(await stateOf(ctx));
  unblock();
  assert.equal((await pending).status, 409);
  assert.equal((await ctx.member(BASE + '/status')).body.runId, second.runId);
  assert.equal(JSON.stringify(await stateOf(ctx)), before);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('초기화 전 탭의 지연된 시작 요청은 idle 회차 토큰으로 거절하고 최신 시작만 허용', async () => {
  const ctx = await setup();
  assert.equal((await ctx.admin(BASE + '/status')).body.lastRunId, null);
  const first = await ctx.start();
  await ctx.admin(BASE + '/reset', { confirm: true, runId: first.runId });
  assert.equal((await ctx.admin(BASE + '/status')).body.lastRunId, first.runId);
  assert.equal((await ctx.admin(BASE + '/start', { confirm: true, expectedRunId: null })).status, 409);
  const second = await ctx.start();
  await ctx.admin(BASE + '/reset', { confirm: true, runId: second.runId });
  assert.equal((await ctx.admin(BASE + '/start', { confirm: true, expectedRunId: first.runId })).status, 409);
  const current = await ctx.admin(BASE + '/start', { confirm: true });
  assert.equal(current.status, 200);
  assert.notEqual(current.body.runId, second.runId);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('동시 start는 하나만 성공하고 운영 파일 저장·삭제 및 임의 심사 경로는 차단', async () => {
  const ctx = await setup();
  const responses = await Promise.all([1, 2].map(() => ctx.admin(BASE + '/start', { confirm: true })));
  assert.deepEqual(responses.map((row) => row.status).sort(), [200, 409]);
  const run = responses.find((row) => row.status === 200).body;
  const env = await rehearsalEnvironment(ctx.env, run.runId);
  await assert.rejects(env.BUCKET.get('data/members.json'), (error) => error.status === 403);
  await assert.rejects(env.BUCKET.put('data/projects.json', '[]', { onlyIf: { etagMatches: '*' } }), (error) => error.status === 403);
  await assert.rejects(env.BUCKET.delete(ctx.works[0].files[0].key), (error) => error.status === 403);
  for (const suffix of ['/entry', '/upload', '/jury/judge', '/jury/invite', '/jury/unlock']) {
    assert.equal((await ctx.admin(scoped(run.runId, suffix), {})).status, 404);
  }
  assert.equal((await ctx.admin(scoped(run.runId, '/jury/status'), { panel: 'mois', status: 'closed' })).status, 400);
  assert.equal((await ctx.member(scoped(run.runId, '/awards/preview'))).status, 403);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('인증된 관리 서비스도 같은 CAS를 사용하며 회원 인증명부를 읽거나 활성 회차를 덮어쓰지 않음', async () => {
  const ctx = await setup();
  const realGet = ctx.bucket.get.bind(ctx.bucket);
  const reads = [];
  ctx.bucket.get = async (key) => { reads.push(key); return realGet(key); };
  const state = await createRehearsal(ctx.env, { operator: 'cloudflare-maintenance' });
  assert.equal(state.rehearsal.createdBy, 'cloudflare-maintenance');
  assert.equal(reads.includes('data/members.json'), false);
  const before = JSON.stringify(await stateOf(ctx));
  await assert.rejects(createRehearsal(ctx.env, { operator: 'cloudflare-maintenance' }), (error) => error.status === 409);
  assert.equal(JSON.stringify(await stateOf(ctx)), before);
  assert.deepEqual(snapshot(ctx.bucket), ctx.original);
});
await test('잘못된 선택·중복 참가자·원본 손상은 리허설 상태를 만들지 않음', async () => {
  const ctx = await setup();
  assert.equal((await ctx.admin(BASE + '/start', {})).status, 400);
  for (const selections of [[{ sourceId: 's_general' }], [{ sourceId: 's_0' }, { sourceId: 's_0' }], [{ sourceId: 's_0', institution: '잘못된 기관' }]]) {
    assert.equal((await ctx.admin(BASE + '/start', { confirm: true, selections })).status, 400);
  }
  const source = JSON.parse(await (await ctx.bucket.get('data/submissions.json')).text());
  source[1].author.email = source[0].author.email;
  await ctx.bucket.put('data/submissions.json', JSON.stringify(source));
  assert.equal((await ctx.admin(BASE + '/start', { confirm: true, selections: [{ sourceId: 's_0' }, { sourceId: 's_1' }] })).status, 400);
  await ctx.bucket.put('data/submissions.json', 'broken-json');
  assert.equal((await ctx.admin(BASE + '/start', { confirm: true })).status, 503);
  assert.equal(await ctx.bucket.get(REHEARSAL_KEY), null);
});

console.log('\n리허설 API: ' + (failures.length ? failures.length + '건 실패' : '모든 검사 통과'));
if (failures.length) process.exitCode = 1;
