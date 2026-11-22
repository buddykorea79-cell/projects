/** 실제 API로 위원 명단·초대·PIN·배정 작품·비공개 채점·첨부 접근을 확인합니다. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { startServer } from './mock-r2.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { server, origin, bucket } = await startServer({ root, env: { PBKDF2_ITERATIONS: 1000 } });
const browser = await chromium.launch(chromeOptions());
const failures = [];
const errors = [];
async function step(name, run) {
  try { await run(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.stack || error.message}`); }
}
async function post(context, path, data) {
  const response = await context.request.post(`${origin}/api${path}`, { data });
  assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
  return response.json();
}
async function signup(email, name, institution = '행정안전부') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await post(context, '/auth/signup', { email, name, institution, password: 'Jury-browser-2026!' });
  return context;
}
async function apiClick(page, suffix, action) {
  const [response] = await Promise.all([
    page.waitForResponse((value) => value.url().endsWith(`/api/festa/jury/${suffix}`) && value.request().method() === 'POST'),
    action(),
  ]);
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function confirmStage(page, status) {
  return apiClick(page, 'status', async () => {
    await page.locator(`[data-jury-status="${status}"]`).click();
    await page.locator('.modal [data-ok]').click();
  });
}
async function capture(page, filename) {
  if (!process.env.FESTA_SCREENSHOT_DIR) return;
  await page.waitForFunction(() => !document.querySelector('#toaster')?.children.length);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: resolve(process.env.FESTA_SCREENSHOT_DIR, filename), fullPage: true });
}

try {
  console.log(`\nFesta jury browser: ${origin}`);
  const adminContext = await signup('aireader@mois.go.kr', '운영자');
  const admin = await adminContext.newPage();
  admin.setDefaultTimeout(10000);
  admin.on('pageerror', (error) => errors.push(error.message));
  const entries = [];
  let foreignFile;
  for (let i = 0; i < 7; i += 1) {
    const institution = i < 3 || i === 6 ? '행정안전부' : '한국서부발전';
    const context = await signup(`entrant${i}@example.com`, `출품자 ${i + 1}`, institution);
    let files = [];
    if (i === 0 || i === 3) {
      const upload = await context.request.post(`${origin}/api/festa/upload`, { multipart: { file: { name: `작품${i + 1}-설명.txt`, mimeType: 'text/plain', buffer: Buffer.from(`작품 ${i + 1} 설명자료`) } } });
      assert.equal(upload.status(), 200, await upload.text());
      files = [(await upload.json()).file];
      if (i === 3) foreignFile = files[0];
    }
    const { entry } = await post(context, '/festa/entry', {
      id: null, requestId: crypto.randomUUID(), institution,
      title: `현장 업무 개선 작품 ${i + 1}`, description: `현장의 문제를 구체적으로 해결합니다.\n입력에서 처리와 결과까지 설명합니다.\n${'설명이 길어도 모든 내용을 확인할 수 있어야 합니다. '.repeat(15)}\n마지막 설명 문장입니다.`,
      localOnly: false, deployUrl: `https://example.com/work/${i + 1}`, githubUrl: `https://github.com/example/work${i + 1}`, files,
    });
    entries.push(entry);
    await context.close();
  }
  // 이전 버전에 저장된 기관 미지정 기록을 재현합니다.
  const existing = JSON.parse(await (await bucket.get('data/festa.json')).text());
  const legacy = existing.entries.find((entry) => entry.id === entries[6].id);
  legacy.institution = '';
  legacy.author.institution = '과거 미지정 기관';
  await bucket.put('data/festa.json', JSON.stringify(existing));
  await post(adminContext, '/festa/phase', { phase: 'closed' });
  let judgeId;
  let inviteUrl;
  let token;
  let secondToken;
  let secondJudgeId;

  await step('관리자 전용 화면과 기관 미지정 작품 보정', async () => {
    await admin.goto(`${origin}/#/admin/festa/jury`);
    await admin.getByTestId('jury-roster-form').waitFor();
    await admin.getByTestId('jury-awards-link').waitFor();
    const form = admin.locator(`[data-institution-entry="${entries[6].id}"]`);
    await form.locator('[name=institution]').selectOption('행정안전부');
    const [response] = await Promise.all([
      admin.waitForResponse((value) => value.url().endsWith('/api/festa/institution')),
      form.locator('button[type=submit]').click(),
    ]);
    assert.equal(response.status(), 200, await response.text());
    await admin.locator(`[name=entryId][value="${entries[6].id}"]`).waitFor();
    const outsider = await browser.newContext();
    assert.equal((await outsider.request.get(`${origin}/api/festa/jury/admin`)).status(), 401);
    await outsider.close();
  });
  await step('세 기관별 공용 주소는 발급 전에도 개인 코드 폼으로 바로 입장', async () => {
    const guest = await browser.newContext();
    const screen = await guest.newPage();
    for (const [key, title] of [['mois', '행정안전부'], ['iwest', '한국서부발전'], ['final', '2차 본선']]) {
      await screen.goto(`${origin}/#/festa/jury/${key}`);
      await screen.getByTestId('juror-unlock-form').waitFor();
      assert.ok((await screen.getByTestId('juror-panel-title').innerText()).includes(title));
      assert.equal(await screen.getByTestId('juror-unlock-form').locator('input').count(), 1);
      assert.equal(await screen.getByTestId('juror-unlock-form').locator('select').count(), 0);
      assert.equal(await screen.getByTestId('juror-identity').count(), 0);
      for (const [width, height] of [[375, 667], [1280, 720]]) {
        await screen.setViewportSize({ width, height });
        const layout = await screen.evaluate(() => {
          const button = document.querySelector('[data-testid="juror-unlock"]').getBoundingClientRect();
          const input = document.querySelector('[name=pin]').getBoundingClientRect();
          const title = document.querySelector('[data-testid="juror-panel-title"]').getBoundingClientRect();
          const nav = document.querySelector('#gnav').getBoundingClientRect();
          return { width:innerWidth, height:innerHeight, scroll:document.documentElement.scrollWidth, buttonBottom:button.bottom, inputTop:input.top, titleTop:title.top, navBottom:nav.bottom };
        });
        assert.ok(layout.scroll <= layout.width + 1, `${key} ${width}: 가로 넘침`);
        assert.ok(layout.buttonBottom <= layout.height, `${key} ${width}: 입장 버튼이 첫 화면 아래 ${layout.buttonBottom}px`);
        assert.ok(layout.inputTop >= layout.navBottom && layout.titleTop >= layout.navBottom, `${key} ${width}: 제목/입력이 헤더 아래에 가려짐`);
        await capture(screen, `jury-entry-${key}-${width}.png`);
      }
      await admin.locator(`[data-panel=${key}]`).click();
      await admin.getByTestId('jury-panel-url').waitFor();
      assert.equal(await admin.getByTestId('jury-panel-url').inputValue(), `${origin}/#/festa/jury/${key}`);
    }
    await admin.locator('[data-panel=mois]').click();
    await admin.getByTestId('jury-roster-form').waitFor();
    await guest.close();
  });
  await step('기관별 대상 선택과 관리자 지정 0 시작 6자리 개인 코드', async () => {
    const roster = admin.getByTestId('jury-roster-form');
    assert.equal(await roster.locator(`[name=entryId][value="${entries[3].id}"]`).count(), 0);
    for (const entry of entries.slice(0, 2)) await roster.locator(`[name=entryId][value="${entry.id}"]`).check();
    await apiClick(admin, 'panel', () => admin.getByTestId('jury-roster-save').click());
    const add = admin.getByTestId('jury-add-judge-form');
    await add.locator('[name=name]').fill('첫째 심사위원');
    await add.locator('[name=email]').fill('judge-one@example.com');
    const result = await apiClick(admin, 'judge', () => add.locator('button[type=submit]').click());
    judgeId = result.judge.id;
    const invite = admin.locator(`[data-invite-judge="${judgeId}"]`);
    await invite.locator('[name=pin]').fill('012345');
    token = (await apiClick(admin, 'invite', () => invite.locator('button[type=submit]').click())).token;
    await admin.getByTestId('jury-invite-url').waitFor();
    inviteUrl = await admin.getByTestId('jury-invite-url').inputValue();
    assert.equal(new URL(inviteUrl).hash, '#/festa/jury/mois');
    assert.ok(/^[a-f0-9]{64}$/.test(token));
    assert.equal(await admin.locator('[data-copy-judge]').count(), 1);
    await adminContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    await admin.locator('[data-copy-judge]').click();
    assert.equal(await admin.evaluate(() => navigator.clipboard.readText()), inviteUrl);
    const emailDraft = new URL(await admin.locator('[data-mail-judge]').getAttribute('href'));
    assert.equal(emailDraft.protocol, 'mailto:');
    assert.equal(emailDraft.pathname, 'judge-one@example.com');
    assert.ok(emailDraft.searchParams.get('subject').includes('말하는 대로, 바이브 코딩 페스타'));
    assert.ok(emailDraft.searchParams.get('subject').includes('행정안전부'));
    assert.ok(emailDraft.searchParams.get('body').includes(inviteUrl));
    assert.ok(!emailDraft.searchParams.get('body').replace(inviteUrl, '').includes('012345'));
    assert.equal(emailDraft.searchParams.has('cc'), false);
    assert.equal(emailDraft.searchParams.has('bcc'), false);
    const { judge } = await post(adminContext, '/festa/jury/judge', { panel: 'mois', name: '둘째 심사위원', email: 'judge-two@example.com' });
    secondJudgeId = judge.id;
    await admin.locator('[data-jury-refresh]').click();
    await admin.locator(`[data-judge-id="${judge.id}"]`).waitFor();
    const secondInvite = admin.locator(`[data-invite-judge="${judge.id}"]`);
    await secondInvite.locator('[name=pin]').fill('012345');
    const [duplicate] = await Promise.all([
      admin.waitForResponse((response) => response.url().endsWith('/api/festa/jury/invite')),
      secondInvite.locator('button[type=submit]').click(),
    ]);
    assert.equal(duplicate.status(), 409);
    await secondInvite.locator('[data-invite-status]').getByText(/다른 심사위원/).waitFor();
    await secondInvite.locator('[name=pin]').fill('654321');
    secondToken = (await apiClick(admin, 'invite', () => secondInvite.locator('button[type=submit]').click())).token;
    await admin.locator(`[data-judge-id="${judge.id}"]`).getByText('개인 코드 발급됨').waitFor();
    await confirmStage(admin, 'open');
    await admin.locator('[data-jury-status=closed]').waitFor();
    assert.equal(await admin.getByTestId('jury-roster-save').count(), 0);
    assert.equal(await admin.locator(`[data-institution-entry="${entries[0].id}"] select`).isDisabled(), true);
  });

  const secondContext = await browser.newContext();
  await post(secondContext, '/festa/jury/unlock', { token: secondToken, pin: '654321' });
  for (const entry of entries.slice(0, 2)) await post(secondContext, '/festa/jury/score', { token: secondToken, entryId: entry.id, scores: [40, 30, 20, 10] });
  const juryContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await juryContext.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await step('회원가입 없이 초대 URL 접속, 잘못된 PIN 거절과 올바른 PIN 입장', async () => {
    await page.goto(inviteUrl);
    const form = page.getByTestId('juror-unlock-form');
    await form.waitFor();
    await form.locator('[name=pin]').fill('999999');
    const [wrong] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/festa/jury/unlock')),
      page.getByTestId('juror-unlock').click(),
    ]);
    assert.ok([401, 403].includes(wrong.status()));
    await form.locator('[data-unlock-status]').getByText(/PIN|코드/).waitFor();
    await form.locator('[name=pin]').fill('012345');
    await apiClick(page, 'unlock', () => page.getByTestId('juror-unlock').click());
    await page.getByTestId('juror-score-form').waitFor();
    const session = await (await juryContext.request.get(`${origin}/api/festa/jury/session?panel=mois&judgeId=${judgeId}`)).json();
    assert.equal(session.judgeId, judgeId);
    assert.equal(session.entries.length, 2);
    assert.ok(session.entries.every((entry) => entry.myScores === null && !('average' in entry) && !('email' in entry.author)));
    assert.equal(await page.getByTestId('jury-private-scores').count(), 0);
  });
  await step('전체 작품 설명·배포와 GitHub 링크·배정된 첨부만 접근', async () => {
    assert.ok((await page.getByTestId('juror-description').innerText()).endsWith('마지막 설명 문장입니다.'));
    assert.equal(await page.getByTestId('juror-description').evaluate((element) => element.scrollHeight <= element.clientHeight + 1), true);
    assert.equal(await page.locator(`a[href="https://example.com/work/1"]`).count(), 1);
    assert.equal(await page.locator('a[href="https://github.com/example/work1"]').count(), 1);
    const href = await page.getByTestId('jury-file').getAttribute('href');
    const response = await juryContext.request.get(`${origin}${href}`);
    assert.equal(response.status(), 200);
    assert.equal(await response.text(), '작품 1 설명자료');
    const foreign = await juryContext.request.get(`${origin}/api/festa/jury/file/${encodeURIComponent(foreignFile.key)}?token=${token}`);
    assert.ok([403, 404].includes(foreign.status()));
    const noSession = await browser.newContext();
    assert.ok([401, 403].includes((await noSession.request.get(`${origin}${href}`)).status()));
    await noSession.close();
    assert.equal((await juryContext.request.get(`${origin}/api/festa/jury/session?token=${secondToken}`)).status(), 401);
    assert.equal((await juryContext.request.get(`${origin}/api/festa/jury/session?panel=iwest&judgeId=${judgeId}`)).status(), 401);
    assert.equal((await juryContext.request.post(`${origin}/api/festa/jury/score`, {data:{panel:'iwest',judgeId,entryId:entries[0].id,scores:[1,1,1,1]}})).status(), 401);
    assert.ok(new URL(href,origin).searchParams.get('judgeId') === judgeId);
  });
  await step('공유 PC 위원 전환 시 이전 탭의 점수·첨부·로그아웃을 차단', async () => {
    const oldFile = await page.getByTestId('jury-file').getAttribute('href');
    const other = await juryContext.newPage();
    await other.goto(inviteUrl);
    // 기존 쿠키가 있어도 이름 선택 없이 코드 입력부터 시작합니다.
    await other.getByTestId('juror-unlock-form').waitFor();
    await other.locator('[name=pin]').fill('654321');
    const unlocked = await apiClick(other, 'unlock', () => other.getByTestId('juror-unlock').click());
    assert.equal(unlocked.judgeId, secondJudgeId);
    await other.getByTestId('juror-identity').getByText('둘째 심사위원').waitFor();
    assert.equal(await other.locator('[name=score0]').inputValue(), '40');
    assert.equal((await juryContext.request.get(`${origin}${oldFile}`)).status(), 401);
    assert.equal((await juryContext.request.get(`${origin}/api/festa/jury/session?panel=mois&judgeId=${judgeId}`)).status(), 401);
    assert.equal((await juryContext.request.post(`${origin}/api/festa/jury/logout`, { data: { panel: 'mois', judgeId } })).status(), 401);
    for (let i = 0; i < 4; i += 1) await page.locator(`[name=score${i}]`).fill('2');
    const [stale] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/festa/jury/score')),
      page.getByTestId('juror-score-save').click(),
    ]);
    assert.equal(stale.status(), 401);
    await page.getByTestId('juror-unlock-form').waitFor();
    const stillSecond = await (await juryContext.request.get(`${origin}/api/festa/jury/session?panel=mois&judgeId=${secondJudgeId}`)).json();
    assert.ok(stillSecond.entries.every((entry) => entry.myScores[0] === 40));
    await apiClick(other, 'logout', () => other.getByTestId('juror-signout').click());
    await other.getByTestId('juror-unlock-form').waitFor();
    assert.equal((await juryContext.request.get(`${origin}/api/festa/jury/session?panel=mois`)).status(), 401);
    await page.locator('[name=pin]').fill('012345');
    await apiClick(page, 'unlock', () => page.getByTestId('juror-unlock').click());
    await page.getByTestId('juror-score-form').waitFor();
    assert.equal(await page.locator('[name=score0]').inputValue(), '');
    await other.close();
  });
  await step('기존 개별 토큰 링크도 같은 심사위원의 점수를 사용', async () => {
    const legacyContext = await browser.newContext();
    const legacyPage = await legacyContext.newPage();
    await legacyPage.goto(`${origin}/#/festa/jury/${token}`);
    await legacyPage.getByTestId('juror-unlock-form').waitFor();
    await legacyPage.locator('[name=pin]').fill('012345');
    await apiClick(legacyPage, 'unlock', () => legacyPage.getByTestId('juror-unlock').click());
    await legacyPage.getByTestId('juror-identity').getByText('첫째 심사위원').waitFor();
    const query = new URL(await legacyPage.getByTestId('jury-file').getAttribute('href'), origin).searchParams;
    assert.equal(query.get('token'), token);
    assert.equal(query.has('panel'), false);
    await legacyContext.close();
  });
  await step('0점 저장과 진행 표시, 다른 작품으로 이동 후 저장·수정', async () => {
    for (let i = 0; i < 4; i += 1) await page.locator(`[name=score${i}]`).fill('0');
    await apiClick(page, 'score', () => page.getByTestId('juror-score-save').click());
    await page.getByTestId('juror-progress').getByText('평가 1 / 2건 완료').waitFor();
    assert.equal(await page.locator(`[data-juror-entry="${entries[0].id}"].is-complete.is-current`).count(), 1);
    await page.locator(`[data-juror-entry="${entries[1].id}"]`).click();
    for (let i = 0; i < 4; i += 1) await page.locator(`[name=score${i}]`).fill(String([35, 25, 15, 5][i]));
    await apiClick(page, 'score', () => page.getByTestId('juror-score-save').click());
    await page.getByTestId('juror-progress').getByText('평가 2 / 2건 완료').waitFor();
    await page.locator(`[data-juror-entry="${entries[0].id}"]`).click();
    assert.equal(await page.locator('[name=score0]').inputValue(), '0');
    await page.locator('[name=score0]').fill('1');
    await apiClick(page, 'score', () => page.getByTestId('juror-score-save').click());
    assert.equal((await (await juryContext.request.get(`${origin}/api/festa/jury/session?token=${token}`)).json()).entries.find((entry) => entry.id === entries[0].id).myScores[0], 1);
  });
  await step('375·1024·1280px에서 가로 넘침 없이 네 점수 입력 오른쪽 정렬', async () => {
    for (const width of [375, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, inputs: [...document.querySelectorAll('.fj-score-row input')].map((input) => ({ left: input.getBoundingClientRect().left, right: input.getBoundingClientRect().right })) }));
      assert.ok(layout.scroll <= layout.width + 1, `${width}: scroll ${layout.scroll}`);
      assert.equal(layout.inputs.length, 4);
      assert.ok(layout.inputs.every((input) => Math.abs(input.left - layout.inputs[0].left) <= 1 && Math.abs(input.right - layout.inputs[0].right) <= 1));
      await capture(page, `jury-review-${width}.png`);
    }
  });
  await step('관리자만 원점수·진행 확인, 완료 후 마감 및 위원 화면 종료', async () => {
    await admin.locator('[data-jury-refresh]').click();
    await admin.getByTestId('jury-private-scores').waitFor();
    assert.equal(await admin.getByTestId('jury-private-scores').locator('tbody tr').count(), 4);
    assert.ok((await admin.locator(`[data-judge-id="${judgeId}"] [data-judge-progress]`).innerText()).includes('2 / 2'));
    for (const width of [375, 1280]) {
      await admin.setViewportSize({ width, height: 900 });
      assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await capture(admin, `jury-admin-${width}.png`);
    }
    await confirmStage(admin, 'closed');
    await page.goto(`${origin}/#/festa/jury/${token}`);
    await page.getByTestId('juror-closed').waitFor();
    assert.equal(await page.getByTestId('juror-score-form').count(), 0);
    assert.ok([403, 409].includes((await juryContext.request.get(`${origin}/api/festa/jury/file/${encodeURIComponent(entries[0].files[0].key)}?token=${token}`)).status()));
  });
  await step('본선 단계는 6명 작품 조건을 안내하고 부족한 대상의 시작을 차단', async () => {
    await admin.locator('[data-panel=final]').click();
    await admin.locator('[data-jury-status=open]').waitFor();
    const roster = admin.getByTestId('jury-roster-form');
    for (const entry of entries.slice(0, 3)) await roster.locator(`[name=entryId][value="${entry.id}"]`).check();
    await apiClick(admin, 'panel', () => admin.getByTestId('jury-roster-save').click());
    await admin.locator('[data-jury-status=open]').click();
    await admin.locator('[data-panel-status]').getByText('최종 심사는 정확히 6개 작품으로 진행합니다.').waitFor();
    assert.equal(await admin.locator('.modal').count(), 0);
  });
  await step('이전 개별 코드의 재발급 안내와 서부·본선 공용 주소 입장·패널별 종료', async () => {
    await post(adminContext, '/festa/jury/panel', { panel: 'iwest', entryIds: [entries[3].id] });
    const { judge: westJudge } = await post(adminContext, '/festa/jury/judge', { panel: 'iwest', name: '서부 심사위원', email: 'west-judge@example.com' });
    const westInvite = await post(adminContext, '/festa/jury/invite', { panel: 'iwest', judgeId: westJudge.id, pin: '234567' });
    // 공용 코드 색인이 도입되기 전에 발급된 기존 초대를 재현합니다.
    const stored = JSON.parse(await (await bucket.get('data/festa.json')).text());
    delete stored.juryPanels.iwest.judges[0].pinLookup;
    await bucket.put('data/festa.json', JSON.stringify(stored));
    await post(adminContext, '/festa/jury/status', { panel: 'iwest', status: 'open' });
    await admin.locator('[data-panel=iwest]').click();
    await admin.getByTestId('jury-legacy-code').waitFor();
    const sharedUrl = await admin.getByTestId('jury-panel-url').inputValue();
    const westContext = await browser.newContext();
    await post(westContext, '/festa/jury/unlock', { token: westInvite.token, pin: '234567' });
    const legacyFailure = await westContext.request.post(`${origin}/api/festa/jury/unlock`, { data: { panel: 'iwest', pin: '234567' } });
    assert.equal(legacyFailure.status(), 403);
    const reissue = admin.locator(`[data-invite-judge="${westJudge.id}"]`);
    await reissue.locator('[name=pin]').fill('234567');
    await apiClick(admin, 'invite', async () => {
      await reissue.locator('button[type=submit]').click();
      await admin.locator('.modal [data-ok]').click();
    });
    await admin.locator(`[data-judge-id="${westJudge.id}"]`).getByText('개인 코드 발급됨').waitFor();
    assert.equal(await admin.getByTestId('jury-legacy-code').count(), 0);
    assert.equal(await admin.getByTestId('jury-panel-url').inputValue(), sharedUrl);
    assert.equal((await westContext.request.get(`${origin}/api/festa/jury/session?token=${westInvite.token}`)).status(), 404);
    const westPage = await westContext.newPage();
    await westPage.goto(sharedUrl);
    await westPage.locator('[name=pin]').fill('234567');
    await apiClick(westPage, 'unlock', () => westPage.getByTestId('juror-unlock').click());
    await westPage.getByTestId('juror-identity').getByText('서부 심사위원').waitFor();
    assert.equal(await westPage.locator('[data-juror-entry]').count(), 1);
    assert.equal((await westContext.request.get(new URL(await westPage.getByTestId('jury-file').getAttribute('href'), origin).href)).status(), 200);
    await post(adminContext, '/festa/jury/panel', { panel: 'final', entryIds: entries.slice(0, 6).map((entry) => entry.id) });
    const { judge: finalJudge } = await post(adminContext, '/festa/jury/judge', { panel: 'final', name: '본선 심사위원', email: 'final-judge@example.com' });
    await post(adminContext, '/festa/jury/invite', { panel: 'final', judgeId: finalJudge.id, pin: '234567' });
    await post(adminContext, '/festa/jury/status', { panel: 'final', status: 'open' });
    const finalPage = await westContext.newPage();
    await finalPage.goto(`${origin}/#/festa/jury/final`);
    await finalPage.locator('[name=pin]').fill('234567');
    await apiClick(finalPage, 'unlock', () => finalPage.getByTestId('juror-unlock').click());
    await finalPage.getByTestId('juror-identity').getByText('본선 심사위원').waitFor();
    assert.equal(await finalPage.locator('[data-juror-entry]').count(), 6);
    await apiClick(westPage, 'logout', () => westPage.getByTestId('juror-signout').click());
    assert.equal((await westContext.request.get(`${origin}/api/festa/jury/session?panel=final&judgeId=${finalJudge.id}`)).status(), 200);
    await westContext.close();
  });
  await step('브라우저 예외가 없음', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(`\nFesta jury browser: ${failures.length ? `${failures.length} failed` : 'all passed'}`);
if (failures.length) process.exitCode = 1;
