/** Festa 회원 제출부터 관리자 마감·심사까지 실제 화면으로 진행합니다. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startServer, browserGoogleLogin } from './mock-r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const errors = [];
const { server, origin, setNextGoogleUser } = await startServer({
  root, env: { FESTA_EMAIL: 'festa@example.com' },
});
const browser = await chromium.launch(chromeOptions());
console.log(`\nFesta 브라우저 서버: ${origin}`);
async function step(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.message}`); }
}
async function person(label) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  page.on('response', (response) => {
    if (response.url().startsWith(`${origin}/api/`) && response.status() >= 500) {
      errors.push(`${label}: ${response.status()} ${response.url()}`);
    }
  });
  return page;
}
async function signup(page, email, name) {
  await browserGoogleLogin(page, {
    origin, setNextGoogleUser, email, name, institution: '행정안전부',
  });
}
async function festa(page) {
  const url = `${origin}/#/festa`;
  if (page.url() === url) await page.reload();
  else await page.goto(url);
  await page.locator('h1').first().waitFor();
}
async function state(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/festa');
    if (!response.ok) throw new Error(`Festa ${response.status}`);
    return response.json();
  });
}
async function saveEntry(page) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/festa/entry') && r.request().method() === 'POST'),
    page.getByTestId('festa-save-entry').click(),
  ]);
  assert.equal(response.status(), 200);
  await page.getByTestId('festa-entry-form').waitFor({ state: 'hidden' });
  await page.getByTestId('festa-receipt').first().waitFor();
}
async function setDeadline(page, deadline) {
  const input = page.getByTestId('festa-deadline-input');
  await input.fill(deadline);
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/festa/deadline') && r.request().method() === 'POST'),
    page.getByTestId('festa-deadline-save').click(),
  ]);
  assert.equal(response.status(), 200);
  assert.equal((await state(page)).deadline, deadline);
}
async function phase(page, next) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/festa/phase') && r.request().method() === 'POST'),
    (async () => {
      await page.locator(`[data-phase="${next}"]`).click();
      const confirm = page.locator('.modal [data-ok]');
      // 단계 전환 확인 모달은 사용자에게 최종 클릭을 받는 화면 흐름의 일부입니다.
      await confirm.waitFor();
      await confirm.click();
    })(),
  ]);
  assert.equal(response.status(), 200);
  await page.waitForFunction(async (expected) => (await (await fetch('/api/festa')).json()).phase === expected, next);
}

try {
  const guest = await person('비회원');
  const admin = await person('관리자');
  const alice = await person('김교육');
  const bob = await person('이참여');

  await step('비회원 홈의 히어로·접수 영역과 상단 메뉴에서 Festa를 발견할 수 있음', async () => {
    await guest.goto(origin);
    const title = '바이브 코딩 페스타 접수';
    const heroButton = guest.locator('.hero').getByRole('link', { name: title, exact: true });
    await heroButton.waitFor();
    await guest.locator('#projects').getByRole('link', { name: title, exact: true }).waitFor();
    const menu = guest.locator('.gnav__links a[href="#/festa"]');
    const accent = await heroButton.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(await menu.evaluate((el) => getComputedStyle(el).backgroundColor), accent);
    await guest.setViewportSize({ width: 375, height: 812 });
    await guest.locator('#gnavBurger').click();
    const drawerMenu = guest.locator('#gnavDrawer a[href="#/festa"]');
    await drawerMenu.waitFor();
    assert.equal(await drawerMenu.evaluate((el) => getComputedStyle(el).backgroundColor), accent);
    await guest.locator('#gnavBurger').click();
    await guest.setViewportSize({ width: 1360, height: 1000 });
    assert.equal(await guest.locator('.gnav__links a[href="#/camp"]').count(), 0);
  });
  await step('비회원이 Festa 메뉴를 누르면 로그인 안내가 나오고 접수 폼은 보이지 않음', async () => {
    await guest.locator('.gnav__links a[href="#/festa"]').click();
    await guest.locator('a[href*="#/login"]').first().waitFor();
    await guest.waitForFunction(() => document.querySelector('main')?.textContent.includes('로그인'));
    assert.equal(await guest.getByTestId('festa-entry-form').count(), 0);
  });
  await step('관리자와 회원이 각자 가입하고 관리자 대시보드에 Festa 관리 링크가 있음', async () => {
    await signup(admin, 'aireader@mois.go.kr', '운영자');
    await signup(alice, 'alice@example.com', '김교육');
    await signup(bob, 'bob@example.com', '이참여');
    await alice.locator('.hero').getByRole('button', { name: '진행중 프로젝트', exact: true }).waitFor();
    await alice.locator('.hero').getByRole('link', { name: '강의자료', exact: true }).waitFor();
    await admin.goto(`${origin}/#/admin`);
    await admin.locator('main a[href="#/admin/festa"]').first().waitFor();
  });
  const openDeadline = `${new Date().getUTCFullYear() + 2}-12-07`;
  await step('관리자가 기본 접수기한을 확인하고 변경하면 회원 화면에도 한국 시간으로 안내', async () => {
    await admin.goto(`${origin}/#/admin/festa`);
    assert.equal(await admin.getByTestId('festa-deadline-input').inputValue(), '2027-12-07');
    await setDeadline(admin, openDeadline);
    await festa(alice);
    const notice = alice.getByTestId('festa-deadline');
    assert.match(await notice.innerText(), new RegExp(openDeadline.slice(0, 4)));
    assert.match(await notice.innerText(), /한국|KST|서울/);
  });
  await step('일반회원은 관리자 Festa 화면을 이용할 수 없음', async () => {
    await alice.goto(`${origin}/#/admin/festa`);
    await alice.waitForFunction(() => /관리자|권한/.test(document.querySelector('main')?.textContent || ''));
    assert.equal(await alice.locator('[data-phase]').count(), 0);
  });
  await step('접수 폼의 로컬 실행 선택으로 배포 URL 없이 접수할 수 있음', async () => {
    await festa(alice);
    const form = alice.getByTestId('festa-entry-form');
    await form.waitFor();
    const institution = form.locator('[name="institution"]');
    assert.equal(await institution.inputValue(), '');
    assert.deepEqual(await institution.locator('option').evaluateAll((rows) => rows.map((row) => row.value)), ['', '행정안전부', '한국서부발전']);
    assert.equal(await institution.evaluate((el) => el.validity.valueMissing), true);
    await institution.selectOption('한국서부발전');
    await form.locator('[name="title"]').fill('민원 안내 도우미');
    const fields = await form.locator('input[name], textarea[name]').evaluateAll((els) => els.map((el) => el.name));
    assert.deepEqual(fields.slice(0, 5), ['title', 'deployUrl', 'localOnly', 'githubUrl', 'description']);
    assert.ok(await form.locator('[name="deployUrl"]').evaluate((el) => el.required));
    assert.ok(await form.locator('textarea[name="description"]').evaluate((el) => el.rows > 7));
    for (const criterion of ['문제 인식', '기능 구현 수준', '완성도', '확산 가능성']) {
      assert.ok((await form.innerText()).includes(criterion), criterion);
    }
    await form.locator('[name="deployUrl"]').fill('https://example.com/original');
    await form.locator('[name="localOnly"]').check();
    assert.equal(await form.locator('[name="deployUrl"]').inputValue(), 'Local');
    await form.locator('[name="localOnly"]').uncheck();
    assert.equal(await form.locator('[name="deployUrl"]').inputValue(), 'https://example.com/original');
    await form.locator('[name="description"]').fill('민원을 쉽게 찾을 수 있도록 만든 로컬 실행 서비스입니다.');
    await form.locator('[name="localOnly"]').check();
    await form.locator('[name="githubUrl"]').fill('https://github.com/example/civil-service');
    await alice.getByTestId('festa-upload-input').setInputFiles({
      name: '사용설명.txt', mimeType: 'text/plain', buffer: Buffer.from('사용 방법과 기능 안내'),
    });
    await alice.getByTestId('festa-file-list').getByText('사용설명.txt').waitFor();
    const [uploadResponse] = await Promise.all([
      alice.waitForResponse((r) => r.url().endsWith('/api/festa/upload')),
      saveEntry(alice),
    ]);
    assert.equal(uploadResponse.status(), 200);
    assert.ok((await alice.getByTestId('festa-receipt').innerText()).includes('민원 안내 도우미'));
    const mine = (await state(alice)).mine;
    assert.equal(mine.localOnly, true);
    assert.equal(mine.institution, '한국서부발전');
    assert.equal(mine.files.length, 1);
    assert.equal(mine.author.email, 'alice@example.com');
  });
  await step('접수 확인에서 수정하면 기존 정보가 채워지고 같은 작품이 갱신됨', async () => {
    const before = (await state(alice)).mine.id;
    await alice.getByTestId('festa-edit-entry').click();
    const form = alice.getByTestId('festa-entry-form');
    await form.waitFor();
    assert.equal(await form.locator('[name="institution"]').inputValue(), '한국서부발전');
    assert.equal(await form.locator('[name="title"]').inputValue(), '민원 안내 도우미');
    assert.equal(await form.locator('[name="localOnly"]').isChecked(), true);
    await form.locator('[name="title"]').fill('민원 안내 도우미 최종본');
    await saveEntry(alice);
    assert.equal((await state(alice)).mine.id, before);
    assert.equal((await state(alice)).mine.title, '민원 안내 도우미 최종본');
  });
  await step('두 번째 회원이 배포 URL을 포함한 작품을 접수', async () => {
    await festa(bob);
    const form = bob.getByTestId('festa-entry-form');
    await form.waitFor();
    await form.locator('[name="institution"]').selectOption('행정안전부');
    for (const [name, value] of Object.entries({
      title: '문서 정리 웹앱', description: '문서를 분류하고 검색하는 웹앱입니다.',
      deployUrl: 'https://example.com/documents', githubUrl: 'https://github.com/example/documents',
    })) await form.locator(`[name="${name}"]`).fill(value);
    await saveEntry(bob);
    assert.equal((await state(bob)).mine.localOnly, false);
  });
  await step('같은 회원의 두 번째 작품에 별도 접수증이 발급되고 두 작품을 개별 수정', async () => {
    const first = (await state(alice)).myEntries[0];
    await alice.getByTestId('festa-add-entry').click();
    const form = alice.getByTestId('festa-entry-form');
    assert.equal(await form.locator('[name="title"]').inputValue(), '');
    assert.equal(await alice.getByTestId('festa-file-list').getByText('사용설명.txt').count(), 0);
    await form.locator('[name="institution"]').selectOption('한국서부발전');
    await form.locator('[name="title"]').fill('현장 점검표');
    await form.locator('[name="localOnly"]').check();
    await form.locator('[name="githubUrl"]').fill('https://github.com/example/checks');
    await form.locator('[name="description"]').fill('현장 점검 사항을 정리합니다.');
    // 서버 저장 직후 응답이 끊겨도 같은 초안을 재시도하면 두 번째 자리를 한 번만 사용합니다.
    await alice.route('**/api/festa/entry', async (route) => {
      const saved = await route.fetch();
      await saved.dispose();
      await route.abort('failed');
    }, { times: 1 });
    const [lostResponse] = await Promise.all([
      alice.waitForEvent('requestfailed', { predicate: (req) => req.url().endsWith('/api/festa/entry') }),
      alice.getByTestId('festa-save-entry').click(),
    ]);
    assert.equal(lostResponse.method(), 'POST');
    assert.equal((await state(alice)).myEntries.length, 2);
    await saveEntry(alice);
    const second = (await state(alice)).myEntries.find((entry) => entry.id !== first.id);
    assert.ok(second);
    assert.equal(await alice.getByTestId('festa-receipt').count(), 2);
    assert.equal(await alice.getByTestId('festa-add-entry').isVisible(), false);
    await alice.locator(`[data-testid="festa-edit-entry"][data-entry-id="${second.id}"]`).click();
    assert.equal(await form.locator('[name="title"]').inputValue(), '현장 점검표');
    await form.locator('[name="title"]').fill('현장 점검표 개정판');
    await saveEntry(alice);
    const updated = (await state(alice)).myEntries;
    assert.equal(updated.length, 2);
    assert.deepEqual(updated.find((entry) => entry.id === first.id), first);
    assert.equal(updated.find((entry) => entry.id === second.id).title, '현장 점검표 개정판');
  });
  await step('접수기한이 지나면 두 작품의 접수증을 보존하고 수정을 닫으며 기한 연장으로 복구', async () => {
    await admin.goto(`${origin}/#/admin/festa`);
    await setDeadline(admin, '2020-01-01');
    await festa(alice);
    await alice.getByTestId('festa-receipt').first().waitFor();
    assert.equal(await alice.getByTestId('festa-receipt').count(), 2);
    assert.equal(await alice.getByTestId('festa-edit-entry').count(), 0);
    assert.ok((await state(alice)).deadlinePassed);
    await setDeadline(admin, openDeadline);
    await festa(alice);
    await alice.getByTestId('festa-edit-entry').first().waitFor();
    assert.equal(await alice.getByTestId('festa-edit-entry').count(), 2);
  });
  await step('관리자는 접수 목록에서 세 작품을 확인하고 접수를 마감', async () => {
    await admin.goto(`${origin}/#/admin/festa`);
    const list = admin.getByTestId('festa-admin-list');
    await list.waitFor();
    assert.ok((await list.innerText()).includes('민원 안내 도우미 최종본'));
    assert.ok((await list.innerText()).includes('문서 정리 웹앱'));
    assert.ok((await list.innerText()).includes('현장 점검표 개정판'));
    await admin.getByTestId('festa-contact-email').fill('submissions@example.com');
    await admin.getByTestId('festa-contact-add').click();
    await admin.getByTestId('festa-contact-email-2').fill('backup@example.com');
    const [contactResponse] = await Promise.all([
      admin.waitForResponse((r) => r.url().endsWith('/api/festa/contact')),
      admin.getByTestId('festa-contact-save').click(),
    ]);
    assert.equal(contactResponse.status(), 200);
    assert.equal((await state(admin)).email, 'submissions@example.com, backup@example.com');
    assert.deepEqual((await state(admin)).emails, ['submissions@example.com', 'backup@example.com']);
    await admin.locator('a[href="mailto:submissions@example.com,backup@example.com"]').waitFor();
    await phase(admin, 'closed');
  });
  await step('마감된 접수 화면에서는 수정·신규 제출 동작이 사라짐', async () => {
    await festa(alice);
    await alice.getByTestId('festa-receipt').first().waitFor();
    assert.equal(await alice.getByTestId('festa-entry-form').count(), 0);
    assert.equal(await alice.getByTestId('festa-edit-entry').count(), 0);
    assert.equal(await alice.getByTestId('festa-judging-list').count(), 0);
  });
  await step('관리자에게 심사위원 관리와 시상 버튼이 나타나고 일반회원은 전용 심사권한을 받지 않음', async () => {
    assert.ok(await admin.locator('main a[href="#/admin/festa/jury"]').first().isVisible());
    assert.ok(await admin.locator('main a[href="#/admin/festa/awards"]').first().isVisible());
    assert.deepEqual((await state(bob)).entries, []);
    assert.equal(await alice.getByTestId('festa-score-form').count(), 0);
  });
  await step('모바일에서도 Festa 본문이 화면 밖으로 넘치지 않음', async () => {
    await alice.setViewportSize({ width: 375, height: 812 });
    await festa(alice);
    await alice.getByTestId('festa-receipt').first().waitFor();
    assert.ok(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  });
  await step('브라우저 예외와 서버 500 오류가 없음', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(`\nFesta 브라우저: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
