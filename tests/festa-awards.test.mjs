/** 최종 시상 규칙·완전동점·검토 후 공개·공개 응답 비밀정보 차단 회귀. */
import assert from 'node:assert/strict';
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import { calculateAwards, publicAwards } from '../shared/festa-awards.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.message}`); }
}
function scoreOf(total) {
  return [40, 30, 20, 10].map((max) => { const value = Math.min(total, max); total -= value; return value; });
}
function fixture() {
  const names = ['김하늘', '이바다', '박나래', '정다온', '최가람', '한여울'];
  const titles = ['민원 업무 길잡이', '현장 점검 보고서', '회의 업무 정리기', '발전소 점검 보드', '설비 자료 검색기', '교육 일정 도우미'];
  const totals = [80, 70, 90, 95, 85, 60];
  const entries = names.map((name, index) => ({
    id: `fe_final_${index + 1}`, title: titles[index], institution: index < 3 ? '행정안전부' : '한국서부발전',
    author: { name, email: `candidate${index + 1}@example.com`, institution: index < 3 ? '행정안전부' : '한국서부발전' },
  }));
  return { version: 1, phase: 'finished', deadline: '2099-12-31', entries, scores: [], uploads: [],
    juryPanels: { final: {
      status: 'closed', entryIds: entries.map((entry) => entry.id),
      judges: [{ id: 'fj_judge1', name: '외부 심사위원', email: 'judge@example.com', tokenHash: 'DO-NOT-EXPOSE-TOKEN', pinHash: 'DO-NOT-EXPOSE-PIN', revoked: false, expiresAt: 1 }],
      scores: entries.map((entry, i) => ({ judgeId: 'fj_judge1', entryId: entry.id, scores: scoreOf(totals[i]) })),
    } },
  };
}
function session(env) {
  let cookie = '';
  return async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await handleApi(new Request(`${ORIGIN}/api${path}`, {
      method, headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { basePath: '/api' });
    const set = response.headers.get('Set-Cookie'); if (set) cookie = set.split(';')[0];
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
}
async function setup(state = fixture()) {
  const bucket = new MockBucket();
  const env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000, TOKEN_SECRET: 'awards-test-session-secret' };
  const admin = session(env); const member = session(env); const guest = session(env);
  for (const [client, email] of [[admin, ADMIN], [member, 'member@example.com']]) {
    assert.equal((await client('/auth/signup', { email, password: 'Awards-2026!', name: '회원', institution: '행정안전부' })).status, 200);
  }
  await bucket.put('data/festa.json', JSON.stringify(state));
  return { bucket, env, admin, member, guest };
}
async function publish(ctx, tieOrder) {
  const preview = await ctx.admin('/festa/awards/preview', tieOrder ? { tieOrder } : undefined);
  assert.equal(preview.status, 200);
  const result = await ctx.admin('/festa/awards/publish', { revision: preview.body.revision, confirm: true, ...(tieOrder ? { tieOrder } : {}) });
  return { preview, result };
}

console.log('\n== 최종 시상 계산 ==');
await test('최종 평균과 기관별 2+1 조건으로 최우수1·우수2·장려3 결정', () => {
  const result = calculateAwards(fixture());
  assert.equal(result.ready, true, result.issues.join(' '));
  assert.equal(result.recipients.length, 6);
  assert.deepEqual(result.recipients.map((row) => row.award), ['grand', 'excellence', 'excellence', 'encouragement', 'encouragement', 'encouragement']);
  assert.equal(result.recipients[0].name, '정다온');
  assert.deepEqual(new Set(result.recipients.slice(0, 3).map((row) => row.name)), new Set(['정다온', '박나래', '김하늘']));
  assert.equal(result.recipients.find((row) => row.name === '최가람').award, 'encouragement', '85점이어도 한국서부발전 상위1명 조건 적용');
  assert.equal(result.recipients[0].certificate, '행정안전부 장관상');
  assert.equal(result.recipients[0].prizeText, '50만원 상당');
  assert.ok(result.recipients.slice(1).every((row) => row.prizeText === '30만원 상당'));
  assert.ok(result.recipients.slice(3).every((row) => row.certificate === '한국서부발전 사장상'));
});
await test('배정 심사위원 한 명도 허용하며 만료·취소된 로그인 자격이 이미 낸 점수를 바꾸지 않음', () => {
  const state = fixture(); state.juryPanels.final.judges[0].revoked = true;
  const result = calculateAwards(state);
  assert.equal(result.ready, true);
  assert.ok(result.ranking.every((row) => row.ballotCount === 1 && row.eligibleCount === 1));
});
await test('마감 전·누락 평가·유효 심사위원 없음은 공개 준비 불가', () => {
  for (const mutate of [
    (s) => { s.juryPanels.final.status = 'open'; },
    (s) => { s.juryPanels.final.scores.pop(); },
    (s) => { s.juryPanels.final.judges[0].email = s.entries[0].author.email; s.juryPanels.final.scores = s.juryPanels.final.scores.filter((r) => r.entryId !== s.entries[0].id); },
  ]) { const state = fixture(); mutate(state); assert.equal(calculateAwards(state).ready, false); }
});
await test('자기평가를 제외한 모든 배정 심사가 필요하며 평균은 실제 유효 평가 수로 계산', () => {
  const state = fixture();
  state.juryPanels.final.judges.push({ id: 'fj_judge2', email: state.entries[0].author.email, name: '참가 심사위원' });
  for (const entry of state.entries.slice(1)) state.juryPanels.final.scores.push({ judgeId: 'fj_judge2', entryId: entry.id, scores: [0, 0, 0, 0] });
  const result = calculateAwards(state);
  assert.equal(result.ready, true, result.issues.join(' '));
  assert.equal(result.ranking.find((row) => row.entryId === state.entries[0].id).average, 80);
  assert.equal(result.ranking.find((row) => row.entryId === state.entries[3].id).average, 47.5);
});
await test('후보는 정확히6개·서로다른사람·필요기관을 만족해야 함', () => {
  for (const mutate of [
    (s) => { s.juryPanels.final.entryIds.pop(); },
    (s) => { s.entries[1].author.email = s.entries[0].author.email.toUpperCase(); },
    (s) => { s.entries[1].institution = '한국서부발전'; s.entries[2].institution = '한국서부발전'; },
    (s) => { s.entries[0].institution = '분류되지 않은 기관'; },
    (s) => { s.entries[0].author.name = ''; },
  ]) { const state = fixture(); mutate(state); assert.equal(calculateAwards(state).ready, false); }
});
await test('중복·자기평가·미배정·범위초과 점수는 차단', () => {
  for (const mutate of [
    (s) => { s.juryPanels.final.scores.push(structuredClone(s.juryPanels.final.scores[0])); },
    (s) => { s.juryPanels.final.judges[0].email = s.entries[0].author.email; },
    (s) => { s.juryPanels.final.scores[0].judgeId = 'fj_unknown'; },
    (s) => { s.juryPanels.final.scores[0].scores = [41, 30, 20, 10]; },
    (s) => { s.juryPanels.final.scores[0].scores = ['40', 30, 20, 10]; },
  ]) { const state = fixture(); mutate(state); assert.equal(calculateAwards(state).ready, false); }
});
await test('기관별 수상 경계 완전동점은 관리자 명시 순서 없이는 확정하지 않음', () => {
  const state = fixture();
  state.juryPanels.final.scores[4].scores = [...state.juryPanels.final.scores[3].scores];
  const unresolved = calculateAwards(state);
  assert.equal(unresolved.ready, false);
  assert.ok(unresolved.ties.some((tie) => tie.reason.includes('한국서부발전')));
  const order = ['fe_final_5', 'fe_final_4', 'fe_final_3', 'fe_final_1', 'fe_final_2', 'fe_final_6'];
  const resolved = calculateAwards(state, order);
  assert.equal(resolved.ready, true, resolved.issues.join(' '));
  assert.equal(resolved.recipients[0].name, '최가람');
  assert.equal(resolved.recipients.find((r) => r.name === '정다온').award, 'encouragement');
});
await test('최우수·우수 간 완전동점도 명시 순서 필요, 문항 평균이 다르면 공지한 규칙 적용', () => {
  const state = fixture();
  state.juryPanels.final.scores[3].scores = [...state.juryPanels.final.scores[2].scores];
  assert.equal(calculateAwards(state).ready, false);
  state.juryPanels.final.scores[3].scores = [39, 30, 20, 1];
  const result = calculateAwards(state);
  assert.equal(result.ready, true);
  assert.equal(result.recipients[0].name, '박나래', '같은90점이면 문제인식40점이39점보다 우선');
});
await test('동점순서로 더 높은 실제 평균을 뒤집을 수 없고 잘못된 후보순서는 거절', () => {
  const state = fixture();
  const reversed = [...state.juryPanels.final.entryIds].reverse();
  assert.equal(calculateAwards(state, reversed).recipients[0].name, '정다온');
  assert.equal(calculateAwards(state, reversed.slice(1)).ready, false);
  assert.equal(calculateAwards(state, Array(6).fill(reversed[0])).ready, false);
});

console.log('\n== 검토·공개 권한과 스냅샷 ==');
await test('본선 평가 완료 후 관리자 마감에서 발표가 열리고, 점수는 공개되지 않음', async () => {
  const state = fixture();
  state.juryPanels.final.status = 'open';
  const ctx = await setup(state);
  assert.equal((await ctx.guest('/festa/awards')).status, 404);
  const close = () => ctx.admin('/festa/jury/status', { panel: 'final', status: 'closed' });
  assert.equal((await close()).status, 200);
  const result = await ctx.guest('/festa/awards');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.recipients, calculateAwards(fixture()).recipients);
  assert.ok(!/ballotCount|entryId|average|scores|judgeId/i.test(JSON.stringify(result.body)));
  assert.equal((await close()).status, 409);
  assert.deepEqual((await ctx.guest('/festa/awards')).body, result.body);
});
await test('미완료 본선이나 예선 마감은 발표를 열지 않고, 수상 경계 동점은 순서 확정 뒤 공개', async () => {
  const state = fixture();
  const final = state.juryPanels.final;
  final.status = 'open';
  const last = final.scores.pop();
  state.juryPanels.mois = { ...final, entryIds: final.entryIds.slice(0, 3), scores: final.scores.slice(0, 3) };
  const ctx = await setup(state);
  const close = (panel) => ctx.admin('/festa/jury/status', { panel, status: 'closed' });
  assert.equal((await close('mois')).status, 200);
  assert.equal((await ctx.guest('/festa/awards')).status, 404);
  assert.equal((await close('final')).status, 409);
  assert.equal((await ctx.guest('/festa/awards')).status, 404);
  final.scores.push(last);
  final.scores[3].scores = [...final.scores[2].scores];
  await ctx.bucket.put('data/festa.json', JSON.stringify(state));
  assert.equal((await close('final')).status, 200);
  assert.equal((await ctx.guest('/festa/awards')).status, 404);
  assert.equal((await ctx.admin('/festa/awards/preview')).body.ties.length, 1);
  assert.equal((await publish(ctx, final.entryIds)).result.status, 200);
  assert.equal((await ctx.guest('/festa/awards')).status, 200);
});
await test('미발행 공개 응답은404이며 비회원·일반회원은 검토와 공개 불가', async () => {
  const ctx = await setup();
  const response = await ctx.guest('/festa/awards');
  assert.equal(response.status, 404);
  assert.deepEqual(Object.keys(response.body), ['message']);
  assert.equal((await ctx.guest('/festa/awards/preview')).status, 401);
  assert.equal((await ctx.member('/festa/awards/preview')).status, 403);
  assert.equal((await ctx.member('/festa/awards/publish', { confirm: true })).status, 403);
  assert.equal((await ctx.guest('/festa/awards/publish', { confirm: true })).status, 401);
});
await test('관리자가 검토만 하면 공개되지 않고 명시 확인 없이 발행할 수 없음', async () => {
  const ctx = await setup();
  const preview = await ctx.admin('/festa/awards/preview');
  assert.equal(preview.status, 200); assert.equal(preview.body.ready, true);
  assert.equal((await ctx.guest('/festa/awards')).status, 404);
  assert.equal((await ctx.admin('/festa/awards/publish', { revision: preview.body.revision })).status, 400);
});
await test('불완전·동점 미해결 패널은 관리자도 발행 불가', async () => {
  for (const mutate of [
    (s) => { s.juryPanels.final.scores.pop(); },
    (s) => { s.juryPanels.final.status = 'open'; },
    (s) => { s.juryPanels.final.scores[4].scores = [...s.juryPanels.final.scores[3].scores]; },
  ]) {
    const state = fixture(); mutate(state);
    const ctx = await setup(state);
    assert.equal((await publish(ctx)).result.status, 409);
    assert.equal((await ctx.guest('/festa/awards')).status, 404);
  }
});
await test('공개 응답은 허용된 수상 정보만 포함하고 원점수·심사자·이메일·ID는 없음', async () => {
  const ctx = await setup();
  const { result } = await publish(ctx);
  assert.equal(result.status, 200, result.body.message);
  const response = await ctx.guest('/festa/awards');
  assert.equal(response.status, 200);
  assert.equal(response.body.recipients.length, 6);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const safeFields = ['award', 'awardName', 'certificate', 'institution', 'name', 'prizeText', 'projectTitle'].sort();
  response.body.recipients.forEach((row) => assert.deepEqual(Object.keys(row).sort(), safeFields));
  const raw = JSON.stringify(response.body);
  for (const value of ['candidate1@', 'judge@', 'DO-NOT-EXPOSE', 'judgeId', 'scores', 'ballotCount', 'eligibleCount', 'fe_final', 'fj_judge']) assert.equal(raw.includes(value), false, value);
});
await test('발행된 자료는 이후 원본 변경·재발행 요청에 영향받지 않음', async () => {
  const ctx = await setup();
  const { result } = await publish(ctx); assert.equal(result.status, 200);
  const before = (await ctx.guest('/festa/awards')).body;
  const state = JSON.parse(await (await ctx.bucket.get('data/festa.json')).text());
  state.entries[3].author.name = '변경한 이름'; state.juryPanels.final.scores[3].scores = [0, 0, 0, 0];
  await ctx.bucket.put('data/festa.json', JSON.stringify(state));
  assert.deepEqual((await ctx.guest('/festa/awards')).body, before);
  assert.equal((await publish(ctx)).result.status, 409);
});
await test('미리보기 이후 후보 정보가 바뀌면 재검토해야 함', async () => {
  const ctx = await setup();
  const preview = await ctx.admin('/festa/awards/preview');
  const state = fixture(); state.entries[0].title = '바뀐 작품명';
  await ctx.bucket.put('data/festa.json', JSON.stringify(state));
  const result = await ctx.admin('/festa/awards/publish', { revision: preview.body.revision, confirm: true });
  assert.equal(result.status, 409);
  assert.equal((await ctx.guest('/festa/awards')).status, 404);
});
await test('동시 발행 요청은 한 번만 성공', async () => {
  const ctx = await setup();
  const preview = await ctx.admin('/festa/awards/preview');
  const body = { revision: preview.body.revision, confirm: true };
  const results = await Promise.all([ctx.admin('/festa/awards/publish', body), ctx.admin('/festa/awards/publish', body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});
await test('발행 저장본에 예상 밖 내부 필드가 있어도 공개 allowlist만 직렬화', () => {
  const plan = calculateAwards(fixture());
  const snapshot = { version: 1, publishedAt: new Date().toISOString(), judges: ['private'], scores: [99],
    recipients: plan.recipients.map((row) => ({ ...row, email: 'private@example.com', score: 99, judgeId: 'private' })) };
  const raw = JSON.stringify(publicAwards(snapshot));
  assert.equal(raw.includes('private'), false);
  assert.equal(raw.includes('score'), false);
});

console.log(`\n시상 API: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
