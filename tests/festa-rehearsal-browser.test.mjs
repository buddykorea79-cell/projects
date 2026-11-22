/** 운영·원본과 분리된 연습 회차의 실제 브라우저/API 통합 검사. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { startServer } from './mock-r2.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { server, origin, bucket } = await startServer({ root, env: { PBKDF2_ITERATIONS: 1000 } });
const browser = await chromium.launch(chromeOptions());
const failures = [], errors = [];
async function step(name, run) {
  try { await run(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.stack || error}`); }
}
async function post(context, path, data) {
  const response = await context.request.post(`${origin}/api${path}`, { data });
  assert.equal(response.status(), 200, `${path}: ${await response.text()}`); return response.json();
}
async function get(context, path) {
  const response = await context.request.get(`${origin}/api${path}`);
  assert.equal(response.status(), 200, `${path}: ${await response.text()}`); return response.json();
}
async function signup(email, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await post(context, '/auth/signup', { email, name, institution: '행정안전부', password: 'Rehearsal-browser-2026!' });
  return context;
}
async function action(page, path, trigger) {
  const [response] = await Promise.all([page.waitForResponse((value) => value.url().endsWith(`/api${path}`) && value.request().method() === 'POST'), trigger()]);
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
async function confirm(page, testId, path) {
  await page.getByTestId(testId).click();
  return action(page, path, () => page.getByRole('dialog').locator('[data-ok]').click());
}
async function screenshot(page, name) {
  if (!process.env.FESTA_SCREENSHOT_DIR) return;
  await page.waitForFunction(() => !document.querySelector('#toaster')?.children.length);
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: resolve(process.env.FESTA_SCREENSHOT_DIR, name), fullPage: true });
}

try {
  console.log(`\nFesta rehearsal browser: ${origin}`);
  const adminContext = await signup('aireader@mois.go.kr', '연습 운영자');
  const ownerContext = await signup('owner@example.com', 'Camp 제출자');
  const learnerContext = await signup('learner@example.com', '연습 참여 회원');
  const projects = [{ id: 'camp_demo', title: '실제 Camp 과정', track: 'buildcamp', visibility: 'private' }];
  const submissions = [
    { id: 'camp_first', projectId: 'camp_demo', title: '실제 현장 점검 도구', body: '입력과 처리, 결과를 연결하는 실제 Camp 설명입니다.\n끝까지 표시되는 설명입니다.', author: { name: 'Camp 제출자', email: 'owner@example.com', institution: '기관 미확인' }, files: [{ key: 'uploads/camp/first.txt', name: '실행 안내.txt', size: 24 }], deployUrl: 'https://example.com/camp', githubUrl: 'https://github.com/example/camp' },
    { id: 'camp_second', projectId: 'camp_demo', title: '<script>실제 작품 제목</script>', body: '', author: { name: '', email: 'second@example.com', institution: '' }, files: [] },
    { id: 'camp_duplicate_author', projectId: 'camp_demo', title: '동일 작성자의 다른 작품', body: '원본 유지', author: { name: 'Camp 제출자', email: 'owner@example.com', institution: '행정안전부' }, files: [] },
  ];
  const live = JSON.stringify({ version: 1, phase: 'open', deadline: '2027-12-07', entries: [], scores: [], uploads: [] });
  await bucket.put('data/projects.json', JSON.stringify(projects));
  await bucket.put('data/submissions.json', JSON.stringify(submissions));
  await bucket.put('uploads/camp/first.txt', '원본 실행 안내');
  await bucket.put('data/festa.json', live);
  const originals = new Map(await Promise.all(['data/projects.json', 'data/submissions.json', 'uploads/camp/first.txt', 'data/festa.json'].map(async (key) => [key, await (await bucket.get(key)).text()])));
  const admin = await adminContext.newPage();
  admin.setDefaultTimeout(10000); admin.on('pageerror', (error) => errors.push(error.message));
  const staleSetup = await adminContext.newPage();
  let runId, entryId, fileUrl, staleMemberPage;

  await step('관리자 전용 선택·추천과 시작 취소, 부분 선택만 실제 작품으로 복사', async () => {
    await admin.goto(`${origin}/#/admin/festa/rehearsal`);
    await admin.getByTestId('rehearsal-start-form').waitFor();
    await staleSetup.goto(`${origin}/#/admin/festa/rehearsal`);
    await staleSetup.getByTestId('rehearsal-start-form').waitFor();
    assert.equal(await admin.locator('[name=sourceId]:checked').count(), 2);
    for (const input of await admin.locator('[name=sourceId]').all()) await input.uncheck();
    await admin.getByTestId('rehearsal-auto').click();
    assert.equal(await admin.locator('[name=sourceId]:checked').count(), 2);
    for (const input of await admin.locator('[name=sourceId]').all()) await input.uncheck();
    await admin.locator('[name=sourceId][value=camp_first]').check();
    await admin.locator('[data-source-id=camp_first] [data-source-institution]').selectOption('한국서부발전');
    await admin.getByTestId('rehearsal-start').click();
    await admin.locator('.modal [data-cancel]').click();
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).active, false);
    const started = await confirm(admin, 'rehearsal-start', '/festa/rehearsal/start');
    runId = started.runId;
    await admin.getByTestId('rehearsal-vote-link').waitFor();
    const status = await get(adminContext, '/festa/rehearsal/status');
    assert.equal(status.entries.length, 6);
    assert.equal(status.rehearsal.realCount, 1); assert.equal(status.rehearsal.sampleCount, 5);
    entryId = status.entries.find((entry) => entry.rehearsal.sourceId === 'camp_first').id;
    assert.ok(status.entries.find((entry) => entry.id === entryId).rehearsal.syntheticFields.includes('institution'));
    assert.equal(await admin.getByTestId('rehearsal-entries').getByText('가상 작품', { exact: true }).count(), 5);
    assert.ok((await admin.getByTestId('rehearsal-admin').innerText()).includes('실제 참여 회원 0명'));
    assert.equal(await admin.getByTestId('rehearsal-vote-link').getAttribute('href'), `#/festa/rehearsal/${runId}/final`);
    assert.equal((await learnerContext.request.get(`${origin}/api/festa/rehearsal/sources`)).status(), 403);
    for (const width of [375, 1280]) {
      await admin.setViewportSize({ width, height: 800 });
      assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await screenshot(admin, `festa-rehearsal-admin-${width}.png`);
    }
  });
  await step('회차 주소 로그인 복귀·시험 데이터 표기·회원 채점과 원본 첨부 읽기', async () => {
    const guest = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await guest.newPage(); staleMemberPage = page;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/#/festa/rehearsal/${runId}/final`);
    const returnLink = `#/login?next=${encodeURIComponent(`/festa/rehearsal/${runId}/final`)}`;
    await page.locator(`a[href="${returnLink}"]`).click();
    await page.locator('#loginForm [name=email]').fill('learner@example.com');
    await page.locator('#loginForm [name=password]').fill('Rehearsal-browser-2026!');
    await page.locator('#loginForm button[type=submit]').click();
    await page.getByTestId('juror-entry-list').waitFor();
    assert.ok(page.url().endsWith(`/rehearsal/${runId}/final`));
    assert.equal(await page.locator('[name=pin]').count(), 0);
    assert.ok((await page.locator('[data-jury-root]').innerText()).includes('실제 결과에 반영되지 않습니다'));
    const before = await get(guest, `/festa/rehearsal/${runId}/jury/member-final`);
    assert.ok(before.entries.every((entry) => entry.myScores === null && !('average' in entry) && !('sourceId' in entry.rehearsal)));
    await page.locator(`[data-juror-entry="${entryId}"]`).click();
    fileUrl = new URL(await page.getByTestId('jury-file').getAttribute('href'), origin).href;
    assert.ok(fileUrl.includes(`/rehearsal/${runId}/jury/member-file/`));
    assert.equal(await (await guest.request.get(fileUrl)).text(), '원본 실행 안내');
    for (let i = 0; i < 4; i += 1) await page.locator(`[name=score${i}]`).fill('0');
    await action(page, `/festa/rehearsal/${runId}/jury/member-score`, () => page.getByTestId('juror-score-save').click());
    await page.getByTestId('juror-progress').getByText('평가 1 / 6건 완료').waitFor();
    await page.locator('[name=score0]').fill('1');
    await action(page, `/festa/rehearsal/${runId}/jury/member-score`, () => page.getByTestId('juror-score-save').click());
    assert.equal((await get(guest, `/festa/rehearsal/${runId}/jury/member-final`)).entries.find((entry) => entry.id === entryId).myScores[0], 1);
    const owner = await ownerContext.newPage();
    await owner.goto(`${origin}/#/festa/rehearsal/${runId}/final`);
    await owner.locator(`[data-juror-entry="${entryId}"]`).click();
    await owner.getByTestId('juror-score-blocked').waitFor();
    assert.equal(await owner.getByTestId('juror-score-form').count(), 0);
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await screenshot(page, `festa-rehearsal-member-${width}.png`);
    }
    await admin.getByTestId('rehearsal-refresh').click();
    await admin.getByTestId('rehearsal-admin').getByText(/실제 참여 회원 1명/).waitFor();
  });
  await step('마감 취소·마감·연습 발표와 관리자 동점 관리 연결', async () => {
    await admin.getByTestId('rehearsal-close').click();
    await admin.locator('.modal [data-cancel]').click();
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).phase, 'open');
    await confirm(admin, 'rehearsal-close', `/festa/rehearsal/${runId}/jury/status`);
    await admin.getByTestId('rehearsal-results-link').waitFor();
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).phase, 'closed');
    const publication = await get(learnerContext, `/festa/rehearsal/${runId}/awards`);
    assert.equal(publication.recipients.length, 6);
    assert.ok(publication.rehearsal.notice.includes('리허설'));
    const results = await learnerContext.newPage();
    await results.goto(`${origin}/#/festa/rehearsal/${runId}/results`);
    await results.getByTestId('awards-public').waitFor();
    assert.ok((await results.locator('.festa-awards-eyebrow').innerText()).includes('테스트'));
    assert.equal(await results.getByTestId('awards-curtain').count(), 1);
    assert.equal(await admin.getByTestId('rehearsal-awards-link').getAttribute('href'), `#/admin/festa/rehearsal/${runId}/awards`);
    await staleMemberPage.getByTestId('member-final-refresh').click();
    await staleMemberPage.getByTestId('juror-closed').waitFor();
    assert.equal((await learnerContext.request.get(fileUrl)).status(), 409);
  });
  await step('늦은 연습 시상 검토 응답이 운영 시상 화면을 덮어쓰지 않음', async () => {
    const page = await adminContext.newPage();
    await page.goto(`${origin}/#/admin/festa/rehearsal/${runId}/awards`);
    await page.getByTestId('awards-present-link').waitFor();
    const previewUrl = `${origin}/api/festa/rehearsal/${runId}/awards/preview`;
    let capture;
    const held = new Promise((resolve) => { capture = resolve; });
    await page.route(previewUrl, (route) => capture(route));
    await page.getByTestId('awards-refresh').click();
    const route = await held;
    await page.goto(`${origin}/#/admin/festa/awards`);
    await page.getByTestId('awards-issues').waitFor();
    const before = await page.getByTestId('awards-admin-root').innerText();
    const finished = page.waitForEvent('requestfinished', (item) => item === route.request());
    await route.continue();
    await finished;
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await page.getByTestId('awards-admin-root').innerText(), before);
    await page.close();
  });
  await step('초기화 취소는 회차 유지, 초기화 후 오래된 주소·저장 거절', async () => {
    await admin.getByTestId('rehearsal-reset').click();
    await admin.locator('.modal [data-cancel]').click();
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).runId, runId);
    await confirm(admin, 'rehearsal-reset', '/festa/rehearsal/reset');
    await admin.getByTestId('rehearsal-start-form').waitFor();
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).active, false);
    assert.equal((await learnerContext.request.post(`${origin}/api/festa/rehearsal/${runId}/jury/member-score`, {data:{entryId,scores:[1,1,1,1]}})).status(), 409);
    await staleMemberPage.reload();
    await staleMemberPage.getByTestId('member-final-unavailable').waitFor();
    assert.equal((await learnerContext.request.get(fileUrl)).status(), 409);
    const [staleStart] = await Promise.all([
      staleSetup.waitForResponse((response) => response.url().endsWith('/api/festa/rehearsal/start') && response.request().method() === 'POST'),
      (async () => { await staleSetup.getByTestId('rehearsal-start').click(); await staleSetup.locator('.modal [data-ok]').click(); })(),
    ]);
    assert.equal(staleStart.status(), 409);
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).active, false);
  });
  await step('0개 선택은 가상 작품 6개, 새 회차의 완전동점 순서 확정 후 발표', async () => {
    for (const input of await admin.locator('[name=sourceId]').all()) await input.uncheck();
    const started = await confirm(admin, 'rehearsal-start', '/festa/rehearsal/start');
    assert.notEqual(started.runId, runId);
    const newRunId = started.runId;
    assert.equal(started.rehearsal.realCount, 0); assert.equal(started.rehearsal.sampleCount, 6);
    const stored = JSON.parse(await (await bucket.get('data/festa-rehearsal.json')).text());
    stored.juryPanels.final.scores.forEach((row) => { row.scores = [0, 0, 0, 0]; });
    await bucket.put('data/festa-rehearsal.json', JSON.stringify(stored));
    await admin.getByTestId('rehearsal-close').waitFor();
    await confirm(admin, 'rehearsal-close', `/festa/rehearsal/${newRunId}/jury/status`);
    assert.equal((await get(adminContext, '/festa/rehearsal/status')).published, false);
    await admin.getByTestId('rehearsal-awards-link').click();
    const tie = admin.getByTestId('awards-tie-form'); await tie.waitFor();
    const ids = stored.entries.map((entry) => entry.id);
    for (let i = 0; i < 6; i += 1) await tie.locator(`[name=order${i}]`).selectOption(ids[i]);
    await action(admin, `/festa/rehearsal/${newRunId}/awards/preview`, () => admin.getByTestId('awards-preview-order').click());
    await admin.getByTestId('awards-recipient-preview').waitFor();
    await confirm(admin, 'awards-publish', `/festa/rehearsal/${newRunId}/awards/publish`);
    await admin.getByTestId('awards-present-link').waitFor();
    assert.equal((await get(learnerContext, `/festa/rehearsal/${newRunId}/awards`)).recipients.length, 6);
    assert.equal((await learnerContext.request.get(`${origin}/api/festa/rehearsal/${runId}/awards`)).status(), 409);
  });
  await step('잘못된 연습 회차 주소에서 운영 평가·발표 API를 호출하지 않음', async () => {
    const bad = await learnerContext.newPage();
    const requests = [];
    bad.on('request', (request) => { if (request.url().includes('/api/festa/')) requests.push(request.url()); });
    for (const suffix of ['final', 'results', 'awards']) {
      await bad.goto(`${origin}/#/festa/rehearsal/not-a-run/${suffix}`);
      await bad.getByText('테스트 회차 주소를 확인해 주세요', { exact: true }).waitFor();
    }
    assert.deepEqual(requests, []);
    const badAdmin = await adminContext.newPage();
    badAdmin.on('request', (request) => { if (request.url().includes('/api/festa/')) requests.push(request.url()); });
    await badAdmin.goto(`${origin}/#/admin/festa/rehearsal/not-a-run/awards`);
    await badAdmin.getByText('테스트 회차 주소를 확인해 주세요', { exact: true }).waitFor();
    assert.deepEqual(requests, []);
    await bad.close(); await badAdmin.close();
  });
  await step('원본 Camp·첨부·실운영 상태 바이트 보존 및 브라우저 예외 없음', async () => {
    for (const [key, original] of originals) assert.equal(await (await bucket.get(key)).text(), original, key);
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close(); await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(`\nFesta rehearsal browser: ${failures.length ? `${failures.length} failed` : 'all passed'}`);
if (failures.length) process.exitCode = 1;
