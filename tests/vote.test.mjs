/**
 * 상호 투표 · 회원 삭제 테스트.
 * 메모리 R2 스텁 위에서 실제 shared/r2api.js 를 돌립니다 (브라우저·네트워크 없음).
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

const bucket = new MockBucket();
const env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000 };

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await handleApi(new Request(`${ORIGIN}/api${path}`, init), env, { basePath: '/api' });
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const pair = set.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    let data = null;
    if ((res.headers.get('Content-Type') || '').includes('json')) {
      data = await res.json().catch(() => null);
    }
    return { status: res.status, data };
  };
}

const signup = (c, email, extra = {}) => c('/auth/signup', {
  method: 'POST',
  body: {
    email, password: 'hunter2!hunter2', name: email.split('@')[0], institution: '한국디자인진흥원', ...extra,
  },
});

/** 프로젝트 색인을 통째로 갈아끼웁니다 (관리자 경로). */
async function putProjects(admin, list) {
  const cur = await admin('/data/projects');
  const r = await admin('/data/projects', {
    method: 'PUT', body: { etag: cur.data.etag, data: list },
  });
  eq(r.status, 200, '프로젝트 저장');
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

const project = (over = {}) => ({
  id: 'p_vote',
  title: '투표 대상 과제',
  description: '설명',
  status: 'open',
  visibility: 'private',        // 비공개인데도 투표 때문에 열려야 합니다
  dueAt: null,
  allowFiles: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  voting: {
    enabled: true, startAt: null, endAt: null,
    perMember: 2, allowSelf: false, showCounts: true,
  },
  ...over,
});

const admin = client();
const alice = client();
const bob = client();
const carol = client();

console.log('\n== 준비 ==');

await t('관리자와 회원 3명이 가입하고 각자 제출함', async () => {
  eq((await signup(admin, ADMIN)).status, 200, '관리자');
  eq((await signup(alice, 'alice@example.com')).status, 200, 'alice');
  eq((await signup(bob, 'bob@example.com')).status, 200, 'bob');
  eq((await signup(carol, 'carol@example.com')).status, 200, 'carol');

  await putProjects(admin, [project()]);

  for (const [c, who] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol']]) {
    const r = await c('/submissions', {
      method: 'POST',
      body: { projectId: 'p_vote', title: `${who} 작품`, body: '내용', files: [] },
    });
    eq(r.status, 200, `${who} 제출`);
  }
});

/** 이름으로 제출물 id 를 찾습니다. */
async function subId(who) {
  const rows = (await admin('/submissions')).data.data;
  const one = rows.find((s) => s.title === `${who} 작품`);
  if (!one) throw new Error(`${who} 제출물을 찾을 수 없음`);
  return one.id;
}

console.log('\n== 열람 범위 ==');

await t('투표를 받는 프로젝트는 비공개여도 다른 회원의 제출물이 보임', async () => {
  const rows = (await alice('/submissions')).data.data;
  eq(rows.length, 3, '보이는 제출물 수');
  const others = rows.filter((s) => s.title !== 'alice 작품');
  eq(others.every((s) => s.author.email === undefined), true, '남의 이메일은 가려짐');
});

await t('투표를 끄면 다시 본인 것만 보임', async () => {
  await putProjects(admin, [project({ voting: { enabled: false } })]);
  const rows = (await alice('/submissions')).data.data;
  eq(rows.length, 1, '보이는 제출물 수');
  await putProjects(admin, [project()]);            // 원복
});

console.log('\n== 표 넣기 ==');

await t('로그인하지 않으면 집계도 투표도 막힘', async () => {
  const anon = client();
  eq((await anon('/votes?projectId=p_vote')).status, 401, '집계');
  eq((await anon('/votes', { method: 'POST', body: { submissionId: 'x' } })).status, 401, '투표');
});

await t('집계는 설정과 내 상태를 알려줌', async () => {
  const r = await alice('/votes?projectId=p_vote');
  eq(r.status, 200, 'status');
  eq(r.data.summary.phase, 'open', 'phase');
  eq(r.data.summary.limit, 2, '1인당 표');
  eq(r.data.summary.used, 0, '쓴 표');
  eq(r.data.summary.total, 0, '전체 표');
});

await t('표를 넣으면 집계와 내 표에 반영됨', async () => {
  const bobSub = await subId('bob');
  const r = await alice('/votes', { method: 'POST', body: { submissionId: bobSub, on: true } });
  eq(r.status, 200, 'status');
  eq(r.data.summary.used, 1, '쓴 표');
  eq(r.data.summary.counts[bobSub], 1, '득표');
  eq(r.data.summary.mine.includes(bobSub), true, '내 표');
  eq(r.data.summary.voters, 1, '참여 인원');
});

await t('같은 제출물에 두 번 넣어도 한 표', async () => {
  const bobSub = await subId('bob');
  const r = await alice('/votes', { method: 'POST', body: { submissionId: bobSub, on: true } });
  eq(r.data.summary.counts[bobSub], 1, '득표');
  eq(r.data.summary.used, 1, '쓴 표');
});

await t('본인 제출물에는 넣을 수 없음', async () => {
  const r = await alice('/votes', { method: 'POST', body: { submissionId: await subId('alice') } });
  eq(r.status, 400, 'status');
  eq(r.data.message.includes('본인'), true, '문구');
});

await t('1인당 표 수를 넘기면 거부됨', async () => {
  const ok = await alice('/votes', { method: 'POST', body: { submissionId: await subId('carol') } });
  eq(ok.data.summary.used, 2, '두 표째');

  await putProjects(admin, [project({ voting: {
    enabled: true, perMember: 2, allowSelf: true, showCounts: true,
  } })]);
  const over = await alice('/votes', { method: 'POST', body: { submissionId: await subId('alice') } });
  eq(over.status, 400, 'status');
  eq(over.data.message.includes('2표'), true, `문구: ${over.data.message}`);
  await putProjects(admin, [project()]);
});

await t('표를 빼면 다시 넣을 수 있음', async () => {
  const carolSub = await subId('carol');
  const off = await alice('/votes', { method: 'POST', body: { submissionId: carolSub, on: false } });
  eq(off.data.summary.used, 1, '뺀 뒤 쓴 표');
  eq(off.data.summary.counts[carolSub] ?? 0, 0, '득표');

  const again = await alice('/votes', { method: 'POST', body: { submissionId: carolSub, on: true } });
  eq(again.data.summary.used, 2, '다시 넣은 뒤');
});

await t('없는 제출물·투표를 안 받는 프로젝트는 거부됨', async () => {
  eq((await bob('/votes', { method: 'POST', body: { submissionId: 's_nope' } })).status, 404, '없는 제출물');

  await putProjects(admin, [project({ voting: { enabled: false } })]);
  const off = await bob('/votes', { method: 'POST', body: { submissionId: await subId('alice') } });
  eq(off.status, 400, '투표 없음');
  await putProjects(admin, [project()]);
});

console.log('\n== 기간 ==');

await t('시작 전에는 넣을 수 없음', async () => {
  await putProjects(admin, [project({ voting: {
    enabled: true, startAt: iso(60 * 60 * 1000), perMember: 2,
  } })]);
  const sum = await bob('/votes?projectId=p_vote');
  eq(sum.data.summary.phase, 'before', 'phase');
  const r = await bob('/votes', { method: 'POST', body: { submissionId: await subId('alice') } });
  eq(r.status, 400, 'status');
  eq(r.data.message.includes('아직'), true, '문구');
});

await t('마감 뒤에는 관리자도 넣을 수 없음', async () => {
  await putProjects(admin, [project({ voting: {
    enabled: true, endAt: iso(-1000), perMember: 2,
  } })]);
  const sum = await bob('/votes?projectId=p_vote');
  eq(sum.data.summary.phase, 'closed', 'phase');
  eq((await bob('/votes', { method: 'POST', body: { submissionId: await subId('alice') } })).status, 400, '회원');
  eq((await admin('/votes', { method: 'POST', body: { submissionId: await subId('alice') } })).status, 400, '관리자');
});

console.log('\n== 집계 공개 ==');

await t('득표수를 숨기면 진행중에는 회원에게 내려가지 않음', async () => {
  await putProjects(admin, [project({ voting: {
    enabled: true, perMember: 2, showCounts: false,
  } })]);
  const member = await bob('/votes?projectId=p_vote');
  eq(member.data.summary.counts, null, '회원 집계');
  eq(member.data.summary.total, null, '회원 전체 표');
  eq(member.data.summary.used >= 0, true, '내 표는 그대로');

  const boss = await admin('/votes?projectId=p_vote');
  eq(typeof boss.data.summary.counts, 'object', '관리자 집계');
});

await t('마감되면 숨겼던 집계도 공개됨', async () => {
  await putProjects(admin, [project({ voting: {
    enabled: true, perMember: 2, showCounts: false, endAt: iso(-1000),
  } })]);
  const member = await bob('/votes?projectId=p_vote');
  eq(typeof member.data.summary.counts, 'object', '집계 공개');
  await putProjects(admin, [project()]);
});

console.log('\n== 제출물 삭제 ==');

await t('제출물을 지우면 거기 들어간 표도 함께 사라짐', async () => {
  const carolSub = await subId('carol');
  const before = await alice('/votes?projectId=p_vote');
  eq(before.data.summary.mine.includes(carolSub), true, '삭제 전 내 표');

  eq((await carol(`/submissions/${carolSub}`, { method: 'DELETE' })).status, 200, '삭제');

  const after = await alice('/votes?projectId=p_vote');
  eq(after.data.summary.mine.includes(carolSub), false, '표가 남음');
  eq(after.data.summary.used, 1, '표 수가 되돌아옴');
  eq(after.data.summary.counts[carolSub] ?? 0, 0, '집계에 남음');
});

console.log('\n== 회원 삭제 ==');
// 삭제 권한 규칙(관리자만·정지된 일반 회원만·자기 계정 불가)은 auth.test.mjs 가 봅니다.
// 여기서는 지워진 회원의 표가 집계에서 함께 빠지는지만 확인합니다.

await t('회원을 지우면 그 사람이 넣은 표도 집계에서 사라짐', async () => {
  const aliceSub = await subId('alice');
  const before = (await admin(`/votes?projectId=p_vote`)).data.summary;
  const had = before.counts[aliceSub] || 0;

  eq((await carol('/votes', { method: 'POST', body: { submissionId: aliceSub } })).status, 200, '캐롤 투표');
  const mid = (await admin('/votes?projectId=p_vote')).data.summary;
  eq(mid.counts[aliceSub], had + 1, '투표 반영');

  eq((await admin('/auth/members', {
    method: 'PATCH', body: { email: 'carol@example.com', status: 'blocked' },
  })).status, 200, '정지');
  eq((await admin('/auth/members', {
    method: 'DELETE', body: { email: 'carol@example.com' },
  })).status, 200, '삭제');

  const after = (await admin('/votes?projectId=p_vote')).data.summary;
  eq(after.counts[aliceSub] || 0, had, '표가 남아 있음');
});

console.log('\n================ 결과 ================');
console.log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
