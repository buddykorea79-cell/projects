/**
 * AI Build Camp — 조 편성 · 그룹장 · 발표 평가 테스트.
 *
 * 메모리 R2 스텁 위에서 실제 shared/r2api.js 와 shared/camp.js 를 돌립니다
 * (브라우저·네트워크 없음). 화면 쪽 동작은 camp-browser.test.mjs 가 봅니다.
 */
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import * as server from '../shared/camp.js';
import * as client from '../assets/js/camp.js';

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
const ok = (v, m) => { if (!v) throw new Error(m); };

const bucket = new MockBucket();
const env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000 };

function session() {
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
    email, password: 'hunter2!hunter2', name: email.split('@')[0],
    institution: '한국디자인진흥원', ...extra,
  },
});

async function putProjects(admin, list) {
  const cur = await admin('/data/projects');
  const r = await admin('/data/projects', {
    method: 'PUT', body: { etag: cur.data.etag, data: list },
  });
  eq(r.status, 200, '프로젝트 저장');
}

const iso = (ms) => new Date(Date.now() + ms).toISOString();

const camp = (over = {}) => ({
  id: 'p_camp',
  title: 'AI Build Camp · 최종 과제',
  description: '설명',
  status: 'open',
  visibility: 'private',          // 비공개인데도 그룹장·발표는 보여야 합니다
  dueAt: null,
  allowFiles: true,
  track: 'buildcamp',
  createdAt: '2026-01-01T00:00:00.000Z',
  presentation: {
    enabled: true, startAt: null, endAt: null, showScores: false, allowOwnTeam: false,
  },
  ...over,
});

const submit = (c, body) => c('/submissions', { method: 'POST', body });
const normTeamOf = (s) => server.normTeam(s?.team);

/* ===================================================== 규칙 사본 == */

console.log('\n== 규칙 모듈 ==');

await t('화면용 사본과 서버용 사본이 같은 것을 내보냄', () => {
  const a = Object.keys(client).sort();
  const b = Object.keys(server).sort();
  eq(JSON.stringify(a), JSON.stringify(b), '내보내는 이름');
});

await t('세 문항 만점이 20·10·10 이고 합계가 40점', () => {
  eq(server.RUBRIC.length, 3, '문항 수');
  eq(server.RUBRIC.map((r) => r.max).join(','), '20,10,10', '문항별 만점');
  eq(server.RUBRIC_TOTAL, 40, '합계');
  eq(client.RUBRIC_TOTAL, 40, '화면 사본 합계');
});

await t('조는 1조부터 8조까지이고 벗어난 값은 미지정', () => {
  eq(server.TEAMS.join(','), '1,2,3,4,5,6,7,8', '조 목록');
  eq(server.normTeam('3'), 3, '문자열');
  eq(server.normTeam(0), 0, '0');
  eq(server.normTeam(9), 0, '9조');
  eq(server.normTeam(-1), 0, '음수');
  eq(server.normTeam('없음'), 0, '글자');
  eq(server.teamLabel(5), '5조', '이름');
  eq(server.teamLabel(99), '조 미지정', '미지정 이름');
});

await t('점수는 항목 만점 안으로 잘리고 합계가 따라옴', () => {
  const s = server.normScore({ goal: 99, creative: 7, quality: -3 });
  eq(s.goal, 20, '목표');
  eq(s.creative, 7, '창의성');
  eq(s.quality, 0, '완성도');
  eq(s.total, 27, '합계');
  eq(server.normScore({}).total, 0, '빈 칸은 0점');
});

await t('그룹장은 조가 있어야 성립', () => {
  eq(server.leaderTeam({ role: 'leader', team: 3 }), 3, '그룹장');
  eq(server.leaderTeam({ role: 'leader', team: 0 }), 0, '조 없는 그룹장');
  eq(server.leaderTeam({ role: 'member', team: 3 }), 0, '일반 회원');
  eq(server.isLeader({ role: 'leader', team: 1 }), true, 'isLeader');
});

/* ========================================================= 준비 == */

console.log('\n== 준비 ==');

const admin = session();
const leader2 = session();   // 2조 그룹장
const kim = session();       // 2조
const lee = session();       // 2조
const park = session();      // 5조

await t('가입', async () => {
  eq((await signup(admin, ADMIN)).status, 200, '관리자');
  eq((await signup(leader2, 'leader2@example.com')).status, 200, '그룹장');
  eq((await signup(kim, 'kim@example.com')).status, 200, '김');
  eq((await signup(lee, 'lee@example.com')).status, 200, '이');
  eq((await signup(park, 'park@example.com')).status, 200, '박');
});

await t('Build Camp 과제 개설', async () => {
  await putProjects(admin, [camp()]);
  const r = await kim('/data/projects');
  eq(r.data.data[0].track, 'buildcamp', '과제 종류');
});

/* ================================================== 그룹장 권한 == */

console.log('\n== 그룹장 권한 ==');

await t('관리자가 그룹장으로 올리고 조를 지정', async () => {
  const r = await admin('/auth/members', {
    method: 'PATCH', body: { email: 'leader2@example.com', role: 'leader', team: 2 },
  });
  eq(r.status, 200, 'status');
  eq(r.data.member.role, 'leader', '권한');
  eq(r.data.member.team, 2, '조');
});

await t('조 없는 그룹장은 그냥 회원으로 둠', async () => {
  const r = await admin('/auth/members', {
    method: 'PATCH', body: { email: 'kim@example.com', role: 'leader' },
  });
  eq(r.data.member.role, 'member', '권한');
  eq(r.data.member.team, 0, '조');
});

await t('범위를 벗어난 조는 거절', async () => {
  const r = await admin('/auth/members', {
    method: 'PATCH', body: { email: 'kim@example.com', role: 'leader', team: 9 },
  });
  eq(r.status, 400, 'status');
});

await t('그룹장을 내리면 조도 함께 비워짐', async () => {
  await admin('/auth/members', {
    method: 'PATCH', body: { email: 'lee@example.com', role: 'leader', team: 7 },
  });
  const r = await admin('/auth/members', {
    method: 'PATCH', body: { email: 'lee@example.com', role: 'member' },
  });
  eq(r.data.member.role, 'member', '권한');
  eq(r.data.member.team, 0, '조');
});

await t('일반 회원은 남의 권한을 못 바꿈', async () => {
  const r = await kim('/auth/members', {
    method: 'PATCH', body: { email: 'lee@example.com', role: 'leader', team: 3 },
  });
  eq(r.status, 403, 'status');
});

/* ====================================================== 조 선택 == */

console.log('\n== 제출할 때 조 선택 ==');

let kimId = '';
let leeId = '';
let parkId = '';

await t('Build Camp 과제는 조 없이 제출되지 않음', async () => {
  const r = await submit(kim, { projectId: 'p_camp', title: '조 없음', body: '내용' });
  eq(r.status, 400, 'status');
  ok(r.data.message.includes('조를 선택'), `문구: ${r.data.message}`);
});

await t('범위를 벗어난 조도 거절', async () => {
  const r = await submit(kim, { projectId: 'p_camp', title: 'x', body: 'y', team: 12 });
  eq(r.status, 400, 'status');
});

await t('조를 골라 제출하면 조가 저장됨', async () => {
  const a = await submit(kim, { projectId: 'p_camp', title: '김 작품', body: '내용', team: 2 });
  eq(a.status, 200, 'status');
  eq(a.data.submission.team, 2, '조');
  kimId = a.data.submission.id;

  const b = await submit(lee, { projectId: 'p_camp', title: '이 작품', body: '내용', team: 2 });
  eq(b.data.submission.team, 2, '같은 조');
  leeId = b.data.submission.id;

  const c = await submit(park, { projectId: 'p_camp', title: '박 작품', body: '내용', team: 5 });
  eq(c.data.submission.team, 5, '다른 조');
  parkId = c.data.submission.id;
});

await t('일반 과제에서는 조를 받지 않음', async () => {
  await putProjects(admin, [camp(), {
    id: 'p_plain', title: '일반 과제', description: '-', status: 'open',
    visibility: 'private', dueAt: null, allowFiles: true, createdAt: '2026-01-01T00:00:00.000Z',
  }]);
  const r = await submit(kim, { projectId: 'p_plain', title: '일반', body: '내용', team: 4 });
  eq(r.status, 200, 'status');
  eq(r.data.submission.team, undefined, '조가 붙지 않음');
});

await t('본인이 조를 고쳐 보낼 수 있고 비울 수는 없음', async () => {
  const good = await kim(`/submissions/${kimId}`, { method: 'PATCH', body: { team: 3 } });
  eq(good.status, 200, 'status');
  eq(good.data.submission.team, 3, '바뀐 조');
  const bad = await kim(`/submissions/${kimId}`, { method: 'PATCH', body: { team: 0 } });
  eq(bad.status, 400, '조 비우기');
  await kim(`/submissions/${kimId}`, { method: 'PATCH', body: { team: 2 } });
});

/* ================================================ 그룹장의 열람 == */

console.log('\n== 그룹장이 자기 조를 봄 ==');

await t('일반 회원은 남의 제출물이 안 보임 (비공개 과제)', async () => {
  const r = await park('/submissions');
  const ids = r.data.data.map((s) => s.id);
  eq(ids.includes(kimId), false, '남의 것');
  eq(ids.includes(parkId), true, '내 것');
});

await t('2조 그룹장은 2조가 낸 것을 모두 봄', async () => {
  const r = await leader2('/submissions');
  const ids = r.data.data.map((s) => s.id);
  eq(ids.includes(kimId), true, '김(2조)');
  eq(ids.includes(leeId), true, '이(2조)');
  eq(ids.includes(parkId), false, '박(5조)은 안 보임');
});

await t('그룹장에게도 남의 이메일은 가려짐', async () => {
  const r = await leader2('/submissions');
  const one = r.data.data.find((s) => s.id === kimId);
  eq(one.author.email, undefined, '이메일');
  eq(one.author.name, 'kim', '이름은 보임');
});

/* ================================================ 발표 과제 선정 == */

console.log('\n== 발표 과제 선정 ==');

const nominate = (c, submissionId, on = true) =>
  c('/presentation', { method: 'POST', body: { submissionId, on } });

await t('일반 회원은 선정할 수 없음', async () => {
  const r = await nominate(kim, kimId);
  eq(r.status, 403, 'status');
});

await t('그룹장은 다른 조의 제출물을 선정할 수 없음', async () => {
  const r = await nominate(leader2, parkId);
  eq(r.status, 403, 'status');
});

await t('그룹장이 자기 조에서 하나 선정', async () => {
  const r = await nominate(leader2, kimId);
  eq(r.status, 200, 'status');
  const subs = (await admin('/submissions')).data.data;
  eq(subs.find((s) => s.id === kimId).presenting, true, '선정됨');
});

await t('같은 조에서 다른 것을 뽑으면 먼저 것이 내려감', async () => {
  const r = await nominate(leader2, leeId);
  eq(r.status, 200, 'status');
  eq(r.data.dropped.join(','), kimId, '내려간 제출물');
  const subs = (await admin('/submissions')).data.data;
  eq(subs.find((s) => s.id === kimId).presenting, undefined, '김은 내려감');
  eq(subs.find((s) => s.id === leeId).presenting, true, '이가 올라감');
});

await t('관리자는 어느 조든 선정', async () => {
  const r = await nominate(admin, parkId);
  eq(r.status, 200, 'status');
  const subs = (await admin('/submissions')).data.data;
  eq(subs.find((s) => s.id === parkId).presenting, true, '5조 선정');
});

await t('선정된 발표는 다른 조 사람에게도 보임', async () => {
  const ids = (await park('/submissions')).data.data.map((s) => s.id);
  eq(ids.includes(leeId), true, '2조 발표');
  eq(ids.includes(kimId), false, '선정 안 된 것은 그대로 안 보임');
});

await t('일반 과제에서는 발표 과제를 뽑지 못함', async () => {
  const plain = (await admin('/submissions')).data.data.find((s) => s.projectId === 'p_plain');
  const r = await nominate(admin, plain.id);
  eq(r.status, 400, 'status');
});

/* ===================================================== 발표 평가 == */

console.log('\n== 발표 평가 (세 문항) ==');

const score = (c, submissionId, body) =>
  c('/scores', { method: 'POST', body: { submissionId, ...body } });

await t('선정되지 않은 제출물에는 점수를 줄 수 없음', async () => {
  const r = await score(park, kimId, { goal: 10, creative: 5, quality: 5 });
  eq(r.status, 400, 'status');
});

await t('자기 조의 발표에는 점수를 줄 수 없음', async () => {
  const r = await score(kim, leeId, { goal: 20, creative: 10, quality: 10 });
  eq(r.status, 400, 'status');
  ok(r.data.message.includes('자기 조'), `문구: ${r.data.message}`);
});

await t('본인 발표에는 점수를 줄 수 없음', async () => {
  const r = await score(lee, leeId, { goal: 20, creative: 10, quality: 10 });
  eq(r.status, 400, 'status');
});

await t('다른 조 사람은 점수를 줄 수 있고 만점 밖은 잘림', async () => {
  const r = await score(park, leeId, { goal: 99, creative: 8, quality: 9 });
  eq(r.status, 200, 'status');
  const mine = r.data.summary.mine[leeId];
  eq(mine.goal, 20, '목표(20점 상한)');
  eq(mine.creative, 8, '창의성');
  eq(mine.quality, 9, '완성도');
  eq(mine.total, 37, '합계');
});

await t('다시 보내면 덮어씀 — 한 사람당 한 번', async () => {
  const r = await score(park, leeId, { goal: 12, creative: 4, quality: 6 });
  eq(r.data.summary.mine[leeId].total, 22, '고친 합계');
  const rows = (await admin('/scores/rows?projectId=p_camp')).data.data;
  eq(rows.filter((x) => x.submissionId === leeId).length, 1, '줄 수');
});

await t('평가 중에는 다른 사람 점수가 보이지 않음', async () => {
  const r = await park('/scores?projectId=p_camp');
  eq(r.data.summary.showScores, false, 'showScores');
  eq(r.data.summary.scores, null, 'scores');
  eq(r.data.summary.judged, 1, '내가 채점한 수');
});

await t('관리자는 평가 중에도 집계를 봄', async () => {
  await score(kim, parkId, { goal: 18, creative: 9, quality: 8 });
  const r = await admin('/scores?projectId=p_camp');
  eq(r.data.summary.showScores, true, 'showScores');
  eq(r.data.summary.scores[leeId].judges, 1, '2조 채점 인원');
  eq(r.data.summary.scores[leeId].avg.total, 22, '2조 평균');
  eq(r.data.summary.scores[parkId].avg.total, 35, '5조 평균');
  eq(r.data.summary.judges, 2, '전체 채점 인원');
});

await t('평균은 채점한 사람 수로 나눔 (빈 칸을 0점으로 세지 않음)', async () => {
  await score(lee, parkId, { goal: 10, creative: 5, quality: 5 });
  const r = await admin('/scores?projectId=p_camp');
  const acc = r.data.summary.scores[parkId];
  eq(acc.judges, 2, '채점 인원');
  eq(acc.total, 55, '합계');
  eq(acc.avg.total, 27.5, '평균');
  eq(acc.avg.goal, 14, '목표 평균');
});

await t('평가 기간 전에는 점수를 받지 않음', async () => {
  await putProjects(admin, [camp({ presentation: { enabled: true, startAt: iso(600000) } })]);
  const r = await score(park, leeId, { goal: 1, creative: 1, quality: 1 });
  eq(r.status, 400, 'status');
  ok(r.data.message.includes('아직'), `문구: ${r.data.message}`);
});

await t('평가가 마감되면 점수도, 선정 변경도 막힘', async () => {
  await putProjects(admin, [camp({ presentation: { enabled: true, endAt: iso(-600000) } })]);
  eq((await score(park, leeId, { goal: 1, creative: 1, quality: 1 })).status, 400, '점수');
  eq((await nominate(leader2, kimId)).status, 400, '선정 변경');
});

await t('마감되면 모두에게 결과가 공개됨', async () => {
  const r = await park('/scores?projectId=p_camp');
  eq(r.data.summary.phase, 'closed', 'phase');
  eq(r.data.summary.showScores, true, 'showScores');
  eq(r.data.summary.scores[leeId].avg.total, 22, '2조 평균');
});

await t('원자료는 관리자만 볼 수 있음', async () => {
  eq((await park('/scores/rows?projectId=p_camp')).status, 403, '일반 회원');
  eq((await leader2('/scores/rows?projectId=p_camp')).status, 403, '그룹장');
  eq((await admin('/scores/rows?projectId=p_camp')).status, 200, '관리자');
});

/* ================================================ 발표 순서 추첨 == */

console.log('\n== 발표 순서 추첨 ==');

/** 추첨만 보려고 따로 쓰는 과제 — 앞 단계가 남긴 상태에 기대지 않습니다. */
const DRAW = 'p_draw';
const plain = {
  id: 'p_plain', title: '일반 과제', description: '-', status: 'open',
  visibility: 'private', dueAt: null, allowFiles: true, createdAt: '2026-01-01T00:00:00.000Z',
};
const drawOrder = (c, id = DRAW) => c(`/draw?projectId=${id}`);
const runDraw = (c, id = DRAW) => c('/draw', { method: 'POST', body: { projectId: id } });

let seat2 = '';
let seat3 = '';
let seat5 = '';
let spare2 = '';

await t('치우침 없이 섞고 원본은 건드리지 않음', () => {
  const src = ['a', 'b', 'c', 'd'];
  const out = server.shuffle(src, () => 0);
  eq(src.join(''), 'abcd', '원본');
  eq(out.length, 4, '길이');
  eq([...out].sort().join(''), 'abcd', '같은 것들');

  // 많이 돌려보면 모든 값이 모든 자리에 한 번씩은 갑니다.
  const seen = new Map(src.map((v) => [v, new Set()]));
  for (let i = 0; i < 400; i += 1) {
    server.shuffle(src).forEach((v, at) => seen.get(v).add(at));
  }
  for (const [v, places] of seen) eq(places.size, 4, `${v} 가 간 자리 수`);
});

await t('세 조가 과제를 낸 Build Camp 과제 준비', async () => {
  await putProjects(admin, [camp(), camp({ id: DRAW, title: '추첨용 과제' }), plain]);
  const mk = async (c, team, title) => {
    const r = await submit(c, { projectId: DRAW, title, body: '내용', team });
    eq(r.status, 200, `${title} 제출`);
    return r.data.submission.id;
  };
  seat2 = await mk(kim, 2, '2조 작품');
  spare2 = await mk(lee, 2, '2조 다른 작품');
  seat3 = await mk(lee, 3, '3조 작품');
  seat5 = await mk(park, 5, '5조 작품');
});

await t('아무도 안 뽑았으면 진행 상황이 0', async () => {
  const r = await drawOrder(admin);
  eq(r.status, 200, 'status');
  eq(r.data.draw, null, '아직 추첨 전');
  eq(r.data.progress.teams, 3, '제출이 있는 조 수');
  eq(r.data.progress.picked, 0, '선정된 조 수');
  eq(r.data.progress.missing.join(','), '2,3,5', '남은 조');
});

await t('제출이 없는 조는 기다리지 않음', async () => {
  // 1·4·6·7·8조는 아무도 내지 않았습니다 — 그 조들 때문에 막히면 안 됩니다.
  eq((await drawOrder(admin)).data.progress.teams, 3, '제출이 있는 조만 셈');
});

await t('선정이 덜 끝났으면 추첨이 막힘', async () => {
  eq((await nominate(admin, seat2)).status, 200, '2조 선정');
  eq((await nominate(admin, seat3)).status, 200, '3조 선정');

  const info = await drawOrder(admin);
  eq(info.data.progress.picked, 2, '선정된 조 수');
  eq(info.data.progress.missing.join(','), '5', '남은 조');

  const r = await runDraw(admin);
  eq(r.status, 400, 'status');
  ok(r.data.message.includes('5조'), `문구: ${r.data.message}`);
});

await t('마지막 조까지 뽑으면 추첨이 열림', async () => {
  eq((await nominate(admin, seat5)).status, 200, '5조 선정');
  const info = await drawOrder(admin);
  eq(info.data.progress.picked, 3, '선정된 조 수');
  eq(info.data.progress.missing.length, 0, '남은 조');
});

await t('일반 회원과 그룹장은 추첨할 수 없음', async () => {
  eq((await runDraw(park)).status, 403, '일반 회원');
  eq((await runDraw(leader2)).status, 403, '그룹장');
});

let firstOrder = [];

await t('관리자가 뽑으면 선정된 발표가 한 번씩 들어감', async () => {
  const r = await runDraw(admin);
  eq(r.status, 200, 'status');
  firstOrder = r.data.draw.order;
  eq(firstOrder.length, 3, '자리 수');
  eq(new Set(firstOrder).size, 3, '겹치지 않음');
  eq(r.data.draw.seq, 1, '첫 추첨');
  ok(r.data.draw.drawnAt, '추첨 시각');
  eq(r.data.draw.drawnBy, ADMIN, '뽑은 사람');
  eq([...firstOrder].sort().join(','), [seat2, seat3, seat5].sort().join(','), '선정된 것들');
});

await t('뽑히지 않은 제출물은 순서에 들어가지 않음', () => {
  eq(firstOrder.includes(spare2), false, '2조의 다른 작품');
});

await t('뽑은 순서는 모두에게 같게 보임', async () => {
  for (const [who, c] of [['박', park], ['그룹장', leader2]]) {
    const r = await drawOrder(c);
    eq(r.status, 200, `${who} status`);
    eq(r.data.draw.order.join(','), firstOrder.join(','), `${who} 순서`);
  }
});

await t('다시 뽑으면 횟수가 올라가고 줄은 하나로 유지됨', async () => {
  const r = await runDraw(admin);
  eq(r.status, 200, 'status');
  eq(r.data.draw.seq, 2, '두 번째 추첨');
  eq(r.data.draw.order.length, 3, '자리 수');
  const raw = JSON.parse(await (await bucket.get('data/draws.json')).text());
  eq(raw.filter((d) => d.projectId === DRAW).length, 1, '저장된 줄 수');
});

await t('추첨 뒤에 발표 과제가 바뀌면 어긋났다고 알려줌', async () => {
  eq((await drawOrder(admin)).data.stale, false, '사전 조건');
  eq((await nominate(leader2, spare2)).status, 200, '2조에서 다른 것을 뽑음');
  eq((await drawOrder(admin)).data.stale, true, 'stale');
});

await t('다시 뽑으면 어긋남이 풀림', async () => {
  eq((await runDraw(admin)).status, 200, '재추첨');
  const r = await drawOrder(admin);
  eq(r.data.stale, false, 'stale');
  ok(r.data.draw.order.includes(spare2), '바뀐 발표가 들어감');
  eq(r.data.draw.order.includes(seat2), false, '내려간 발표는 빠짐');
});

await t('일반 과제에서는 추첨하지 않음', async () => {
  const r = await runDraw(admin, 'p_plain');
  eq(r.status, 400, 'status');
  ok(r.data.message.includes('Build Camp'), `문구: ${r.data.message}`);
});

await t('없는 과제는 404', async () => {
  eq((await runDraw(admin, 'p_nope')).status, 404, 'POST');
  eq((await drawOrder(admin, 'p_nope')).status, 404, 'GET');
});

await t('프로젝트를 지우면 추첨도 함께 사라짐', async () => {
  await putProjects(admin, [camp(), plain]);
  const raw = JSON.parse(await (await bucket.get('data/draws.json')).text());
  eq(raw.some((d) => d.projectId === DRAW), false, '남은 추첨');
});

/* ======================================================== 정리 == */

console.log('\n== 지우면 점수도 함께 ==');

await t('제출물을 지우면 그 발표의 점수가 사라짐', async () => {
  await putProjects(admin, [camp()]);
  const before = (await admin('/scores/rows?projectId=p_camp')).data.data.length;
  ok(before > 0, '사전 조건');
  eq((await admin(`/submissions/${leeId}`, { method: 'DELETE' })).status, 200, '삭제');
  const rows = (await admin('/scores/rows?projectId=p_camp')).data.data;
  eq(rows.some((r) => r.submissionId === leeId), false, '남은 점수');
});

await t('회원을 지우면 그 사람이 준 점수도 사라짐', async () => {
  await admin('/auth/members', {
    method: 'PATCH', body: { email: 'kim@example.com', status: 'blocked' },
  });
  eq((await admin('/auth/members', {
    method: 'DELETE', body: { email: 'kim@example.com' },
  })).status, 200, '삭제');
  const rows = (await admin('/scores/rows')).data.data;
  eq(rows.some((r) => r.voter === 'kim@example.com'), false, '남은 점수');
});

await t('프로젝트를 지우면 그 과제의 점수가 사라짐', async () => {
  await putProjects(admin, []);
  const rows = (await admin('/scores/rows')).data.data;
  eq(rows.some((r) => r.projectId === 'p_camp'), false, '남은 점수');
});

console.log('\n================ 결과 ================');
console.log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
