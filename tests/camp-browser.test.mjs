/**
 * AI Build Camp — 브라우저 종단간 테스트.
 *
 * 서버 규칙(누가 뽑을 수 있고 누가 점수를 줄 수 있는지)은 camp.test.mjs 가
 * 봅니다. 여기서는 **화면**이 그 규칙대로 움직이는지 — 메뉴가 바뀌었는지,
 * 제출할 때 조를 받는지, 그룹장에게 선정 버튼이 뜨는지, 세 문항 점수가
 * 저장되고 결과 화면에 모이는지를 확인합니다.
 */
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { startServer } from './mock-r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fails = [];
const log = (...a) => console.log(...a);
const step = async (name, fn) => {
  try { await fn(); log(`  PASS  ${name}`); }
  catch (e) { log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const ok = (v, m) => { if (!v) throw new Error(m); };
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

const { server, bucket, origin } = await startServer({ root, env: { PBKDF2_ITERATIONS: 1000 } });
log(`\n로컬 R2 스텁 서버: ${origin}`);

const browser = await chromium.launch(chromeOptions());

const consoleErrors = [];
const PASSWORD = 'hunter2!hunter2';

async function person(label) {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    const fromFonts = /fonts\.(googleapis|gstatic)/.test(m.location()?.url || '');
    // 설계된 거절(400·401·403·409)과 서버를 내릴 때의 연결 끊김은 오류가 아닙니다.
    const expected = /Failed to load resource.*(400|401|403|404|409)|ERR_CONNECTION_RESET/.test(text);
    if (m.type() === 'error' && !fromFonts && !expected) consoleErrors.push(`[${label}] ${text}`);
  });
  return page;
}

async function signup(page, email, name) {
  await page.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#signupForm', { timeout: 8000 });
  for (const [k, v] of [
    ['institution', '행정안전부'], ['name', name], ['email', email],
    ['password', PASSWORD], ['confirm', PASSWORD],
  ]) await page.fill(`#signupForm [name="${k}"]`, v);
  await page.check('#signupForm [name="agree"]');
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForURL((u) => u.hash === '#/' || u.hash === '', { timeout: 12000 });
}

/** 제출 폼을 채워 보내고 상세 화면까지 갑니다. */
async function submitWork(page, projectId, title, team) {
  await page.goto(`${origin}/#/p/${projectId}/submit`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#submitForm', { timeout: 8000 });
  await page.fill('#submitForm [name="title"]', title);
  await page.fill('#submitForm [name="body"]', `${title} 의 설명입니다.`);
  if (team) await page.selectOption('#submitForm [name="team"]', String(team));
  await page.check('#submitForm [name="agree"]');
  await page.locator('#submitForm button[type="submit"]').click();
  await page.waitForURL(/#\/s\//, { timeout: 12000 });
  return page.url().split('#/s/')[1];
}

const admin = await person('관리자');
const leader = await person('그룹장');
const kim = await person('김');
const park = await person('박');

const iso = (ms) => new Date(Date.now() + ms).toISOString();
const CAMP = 'pc1';

/** 관리자 브라우저에서 프로젝트 색인을 바꿉니다. */
async function putProjects(list) {
  const etag = await admin.evaluate(async () => (await (await fetch('/api/data/projects')).json()).etag);
  const status = await admin.evaluate(async ([tag, data]) => (await fetch('/api/data/projects', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: tag, data }),
  })).status, [etag, list]);
  if (status !== 200) throw new Error(`프로젝트 저장 실패 (${status})`);
}

const campProject = (over = {}) => ({
  id: CAMP,
  title: 'AI Build Camp · 최종 과제',
  description: '조별로 만든 결과물을 올리세요.',
  status: 'open',
  visibility: 'private',
  dueAt: iso(600000),
  allowFiles: false,
  track: 'buildcamp',
  createdAt: iso(-86400000),
  presentation: {
    enabled: true, startAt: null, endAt: null, showScores: false, allowOwnTeam: false,
  },
  ...over,
});

log('\n== 1. 메뉴 ==');

await step('상단 메뉴에 과제 투표가 없고 Build Camp 가 있음', async () => {
  await signup(admin, 'aireader@mois.go.kr', '관리자');
  const links = await admin.locator('.gnav__links a').allInnerTexts();
  eq(links.includes('과제 투표'), false, `과제 투표가 남아 있음: ${links.join(' / ')}`);
  eq(links.includes('Build Camp'), true, `Build Camp 없음: ${links.join(' / ')}`);
  eq(await admin.locator('.gnav__links a[href="#/camp"]').count(), 1, '링크');
});

await step('Build Camp 메뉴를 누르면 목록이 열림', async () => {
  await admin.locator('.gnav__links a[href="#/camp"]').click();
  await admin.waitForSelector('.page-title', { timeout: 8000 });
  eq(await admin.locator('h1.page-title').innerText(), 'Build Camp', '제목');
  await admin.waitForSelector('.empty h3', { timeout: 8000 });
});

log('\n== 2. 과제 개설 ==');

await step('프로젝트 개설 화면에 과제 종류와 발표 평가가 있음', async () => {
  await admin.goto(`${origin}/#/admin/project/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#projForm', { timeout: 8000 });
  const tracks = await admin.locator('#projForm [name="track"] option').allInnerTexts();
  eq(tracks.join(' / '), '일반 과제 / AI Build Camp', '과제 종류');
  // 일반 과제에서는 발표 평가 상자가 숨어 있습니다.
  eq(await admin.locator('#presentBox').isHidden(), true, '일반 과제에서 숨김');
  await admin.selectOption('#projForm [name="track"]', 'buildcamp');
  eq(await admin.locator('#presentBox').isHidden(), false, 'Build Camp 에서 보임');
});

await step('Build Camp 과제를 만들어 둠', async () => {
  await putProjects([campProject()]);
  await admin.goto(`${origin}/#/camp`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.tile', { timeout: 8000 });
  eq(await admin.locator('.tile__title').innerText(), 'AI Build Camp · 최종 과제', '목록에 올라옴');
});

log('\n== 3. 그룹장 지정 ==');

await step('회원 관리에서 2조 그룹장으로 지정', async () => {
  await signup(leader, 'leader@example.com', '그룹장');
  await signup(kim, 'kim@example.com', '김');
  await signup(park, 'park@example.com', '박');

  await admin.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 8000 });
  const row = admin.locator('.table tbody tr', { hasText: 'leader@example.com' });
  await row.locator('[data-rolepick]').selectOption('leader:2');
  await admin.locator('.modal [data-ok], .modal button', { hasText: '적용' }).first().click();
  await admin.waitForSelector('.toast--ok', { timeout: 8000 });

  await admin.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 8000 });
  const again = admin.locator('.table tbody tr', { hasText: 'leader@example.com' });
  eq(await again.locator('[data-rolepick]').inputValue(), 'leader:2', '저장된 권한');
});

await step('그룹장만 보기 필터가 있음', async () => {
  await admin.selectOption('#filter', 'leader');
  await admin.waitForTimeout(150);
  eq(await admin.locator('.table tbody tr').count(), 1, '줄 수');
  ok((await admin.locator('.table tbody tr').innerText()).includes('leader@example.com'), '그 사람');
});

log('\n== 4. 조를 골라 제출 ==');

let kimId = '';
let parkId = '';

await step('Build Camp 과제는 제출 폼에 조 선택이 있음', async () => {
  await kim.goto(`${origin}/#/p/${CAMP}/submit`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('#submitForm', { timeout: 8000 });
  const opts = await kim.locator('#submitForm [name="team"] option').allInnerTexts();
  eq(opts.length, 9, `선택지 수: ${opts.join(',')}`);
  eq(opts[1], '1조', '첫 조');
  eq(opts[8], '8조', '마지막 조');
  const note = (await kim.locator('.notice--info').first().innerText()).replace(/\s+/g, ' ');
  ok(note.includes('AI Build Camp'), `안내: ${note}`);
});

await step('조를 고르지 않으면 제출이 막힘', async () => {
  await kim.fill('#submitForm [name="title"]', '조 없이');
  await kim.fill('#submitForm [name="body"]', '내용');
  await kim.check('#submitForm [name="agree"]');
  await kim.locator('#submitForm button[type="submit"]').click();
  await kim.waitForSelector('.field__err', { timeout: 5000 });
  eq(await kim.locator('#submitForm [name="team"]').evaluate((el) => el.value), '', '빈 값 유지');
});

await step('조를 고르면 제출되고 상세에 조가 보임', async () => {
  kimId = await submitWork(kim, CAMP, '김 작품', 2);
  const kv = (await kim.locator('.kv').first().innerText()).replace(/\s+/g, ' ');
  ok(kv.includes('2조'), `상세: ${kv}`);
  parkId = await submitWork(park, CAMP, '박 작품', 5);
  ok(parkId && kimId, 'id');
});

await step('내 제출물 표에 조 열이 있음', async () => {
  await kim.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('.table tbody tr', { timeout: 8000 });
  const head = await kim.locator('.table thead').innerText();
  ok(head.includes('조'), `머리글: ${head}`);
  ok((await kim.locator('.table tbody').innerText()).includes('2조'), '조 값');
});

log('\n== 5. 그룹장이 발표 과제 선정 ==');

await step('그룹장 권한은 새로고침 없이도 바로 먹힘', async () => {
  // 그룹장이 된 것은 관리자 화면에서 방금 일어난 일입니다. 그룹장의 브라우저는
  // 그 사이 한 번도 다시 불러오지 않았는데도 알아봐야 합니다(auth.refreshRole).
  await leader.goto(`${origin}/#/camp`, { waitUntil: 'networkidle' });
  await leader.waitForSelector('#campList', { timeout: 10000 });
  const note = (await leader.locator('#main').innerText()).replace(/\s+/g, ' ');
  ok(note.includes('2조 그룹장'), `안내: ${note}`);
});

await step('그룹장은 우리 조 제출물을 모아 봄', async () => {
  await leader.locator('#campList .tile').first().click();
  await leader.waitForSelector('.table tbody tr', { timeout: 10000 });
  const text = (await leader.locator('#campBody').innerText()).replace(/\s+/g, ' ');
  ok(text.includes('김 작품'), `우리 조: ${text}`);
  ok(!text.includes('박 작품'), `다른 조가 보임: ${text}`);
  ok(text.includes('2조'), '조 표시');
});

await step('일반 회원에게는 선정 버튼이 없음', async () => {
  await kim.goto(`${origin}/#/camp/${CAMP}`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('#campBody', { timeout: 8000 });
  eq(await kim.locator('[data-pick]').count(), 0, '버튼');
});

await step('그룹장이 발표 과제로 선정하면 배지가 붙음', async () => {
  await leader.goto(`${origin}/#/camp/${CAMP}`, { waitUntil: 'networkidle' });
  await leader.waitForSelector('[data-pick]', { timeout: 10000 });
  await leader.locator('[data-pick]').first().click();
  await leader.waitForSelector('.toast--ok', { timeout: 10000 });
  await leader.waitForSelector('.badge--gold:text-is("발표 과제")', { timeout: 8000 });

  const rows = JSON.parse(await (await bucket.get('data/submissions.json')).text());
  eq(rows.find((s) => s.id === kimId).presenting, true, '저장된 선정');
});

await step('관리자는 다른 조도 선정할 수 있음', async () => {
  await admin.goto(`${origin}/#/camp/${CAMP}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('[data-pick]', { timeout: 10000 });
  const row = admin.locator('.table tbody tr', { hasText: '박 작품' });
  await row.locator('[data-pick]').click();
  await admin.waitForSelector('.toast--ok', { timeout: 10000 });
  const rows = JSON.parse(await (await bucket.get('data/submissions.json')).text());
  eq(rows.find((s) => s.id === parkId).presenting, true, '저장된 선정');
});

log('\n== 6. 발표 평가 (세 문항) ==');

await step('평가 화면에 세 문항과 만점이 보임', async () => {
  await kim.goto(`${origin}/#/camp/${CAMP}?tab=judge`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('.judge', { timeout: 10000 });
  const legend = (await kim.locator('.rubric-legend').innerText()).replace(/\s+/g, ' ');
  for (const want of ['목표 타당성 및 문제 정의', '20점', '창의성 및 차별성', '완성도 및 전달력']) {
    ok(legend.includes(want), `안내에 "${want}" 없음: ${legend}`);
  }
  eq(await kim.locator('.judge').count(), 2, '발표 수');
});

await step('자기 조의 발표에는 입력칸 대신 이유가 보임', async () => {
  const mine = kim.locator('.judge', { hasText: '김 작품' });
  eq(await mine.locator('form').count(), 0, '폼');
  ok((await mine.locator('.judge__blocked').innerText()).includes('본인'), '이유');
});

await step('다른 조 발표에 점수를 주면 합계가 따라오고 저장됨', async () => {
  const card = kim.locator('.judge', { hasText: '박 작품' });
  await card.locator('[name="goal"]').fill('18');
  await card.locator('[name="creative"]').fill('7');
  await card.locator('[name="quality"]').fill('9');
  eq(await card.locator('[data-total]').innerText(), '34', '합계 미리보기');
  await card.locator('button[type="submit"]').click();
  await kim.waitForSelector('.toast--ok', { timeout: 10000 });
  await kim.waitForSelector('.judge--done', { timeout: 8000 });

  const rows = JSON.parse(await (await bucket.get('data/scores.json')).text());
  const one = rows.find((r) => r.submissionId === parkId && r.voter === 'kim@example.com');
  eq(one.goal, 18, '목표');
  eq(one.creative, 7, '창의성');
  eq(one.quality, 9, '완성도');
  eq(one.total, 34, '합계');
});

await step('만점을 넘겨 적으면 만점으로 잘림', async () => {
  const card = kim.locator('.judge', { hasText: '박 작품' });
  await card.locator('[name="goal"]').fill('99');
  eq(await card.locator('[data-total]').innerText(), '36', '잘린 합계');
  await card.locator('button[type="submit"]').click();
  await kim.waitForSelector('.toast--ok', { timeout: 10000 });
  const rows = JSON.parse(await (await bucket.get('data/scores.json')).text());
  eq(rows.find((r) => r.submissionId === parkId && r.voter === 'kim@example.com').goal, 20, '20점');
});

await step('평가 중에는 다른 사람 점수가 보이지 않음', async () => {
  await kim.goto(`${origin}/#/camp/${CAMP}?tab=judge`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('.judge', { timeout: 10000 });
  eq(await kim.locator('.judge__avg').count(), 0, '평균 표시');
  const note = (await kim.locator('#campBody .notice--info').first().innerText()).replace(/\s+/g, ' ');
  ok(note.includes('평가가 끝난 뒤'), `안내: ${note}`);
});

await step('관리자에게는 평가 중에도 평균이 보임', async () => {
  await admin.goto(`${origin}/#/camp/${CAMP}?tab=judge`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.judge', { timeout: 10000 });
  const card = admin.locator('.judge', { hasText: '박 작품' });
  ok((await card.locator('.judge__avg').innerText()).includes('36'), '평균');
});

log('\n== 7. 결과 (관리자) ==');

await step('결과 화면에 순위·문항별 평균이 모임', async () => {
  await park.goto(`${origin}/#/camp/${CAMP}?tab=judge`, { waitUntil: 'networkidle' });
  await park.waitForSelector('.judge', { timeout: 10000 });
  const card = park.locator('.judge', { hasText: '김 작품' });
  await card.locator('[name="goal"]').fill('10');
  await card.locator('[name="creative"]').fill('5');
  await card.locator('[name="quality"]').fill('5');
  await card.locator('button[type="submit"]').click();
  await park.waitForSelector('.toast--ok', { timeout: 10000 });

  await admin.goto(`${origin}/#/admin/scores/${CAMP}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 10000 });
  const head = (await admin.locator('.table thead').first().innerText()).replace(/\s+/g, ' ');
  for (const want of ['순위', '조', '목표 타당성 및 문제 정의', '합계 (40점)']) {
    ok(head.includes(want), `머리글에 "${want}" 없음: ${head}`);
  }
  const first = (await admin.locator('.table tbody tr').first().innerText()).replace(/\s+/g, ' ');
  ok(first.includes('1위'), `1위 줄: ${first}`);
  ok(first.includes('5조'), `1위는 5조(36점)여야 함: ${first}`);
});

await step('채점 원자료가 관리자에게 보임', async () => {
  const text = (await admin.locator('#main').innerText()).replace(/\s+/g, ' ');
  ok(text.includes('채점 원자료'), '제목');
  ok(text.includes('kim@example.com'), '채점자');
  ok(text.includes('park@example.com'), '채점자2');
});

await step('일반 회원은 결과 화면에 들어갈 수 없음', async () => {
  await kim.goto(`${origin}/#/admin/scores/${CAMP}`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('.notice--warn', { timeout: 8000 });
  ok((await kim.locator('.notice--warn').first().innerText()).includes('관리자만'), '차단 문구');
});

log('\n== 8. 평가 마감 ==');

await step('마감하면 입력칸이 사라지고 모두에게 점수가 공개됨', async () => {
  await putProjects([campProject({
    presentation: { enabled: true, startAt: null, endAt: iso(-600000) },
  })]);
  await kim.goto(`${origin}/#/camp/${CAMP}?tab=judge`, { waitUntil: 'networkidle' });
  await kim.waitForSelector('.judge', { timeout: 10000 });
  eq(await kim.locator('.judge form').count(), 0, '입력칸');
  const card = kim.locator('.judge', { hasText: '박 작품' });
  ok((await card.locator('.judge__avg').innerText()).includes('36'), '공개된 평균');
});

await step('마감 뒤에는 선정도 바꿀 수 없음', async () => {
  await leader.goto(`${origin}/#/camp/${CAMP}?tab=teams`, { waitUntil: 'networkidle' });
  await leader.waitForSelector('#campBody', { timeout: 8000 });
  eq(await leader.locator('[data-pick]').count(), 0, '버튼');
  const text = (await leader.locator('#campBody').innerText()).replace(/\s+/g, ' ');
  ok(text.includes('마감되어 선정을 바꿀 수 없습니다'), `안내: ${text}`);
});

log('\n== 9. 옛 투표 화면 ==');

await step('과제 투표 기능은 메뉴에서만 내려갔고 주소는 그대로 열림', async () => {
  await admin.goto(`${origin}/#/vote`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('h1.page-title', { timeout: 8000 });
  eq(await admin.locator('h1.page-title').innerText(), '과제 투표', '제목');
});

await step('자바스크립트 오류 없음', () => {
  if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 4).join(' | '));
});

await browser.close();
server.close();

log(fails.length ? `\n실패 ${fails.length}건: ${fails.join(', ')}` : '\n모든 검사 통과');
process.exit(fails.length ? 1 : 0);
