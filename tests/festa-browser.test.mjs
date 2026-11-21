/** Festa 회원 제출부터 관리자 마감·심사까지 실제 화면으로 진행합니다. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startServer } from './mock-r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const errors = [];
const { server, origin } = await startServer({
  root, env: { PBKDF2_ITERATIONS: 1000, FESTA_EMAIL: 'festa@example.com' },
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
  await page.goto(`${origin}/#/signup`);
  await page.locator('#signupForm').waitFor();
  for (const [key, value] of Object.entries({
    institution: '행정안전부', name, email, password: 'Festa-test-2026!', confirm: 'Festa-test-2026!',
  })) await page.locator(`#signupForm [name="${key}"]`).fill(value);
  await page.locator('#signupForm [name="agree"]').check();
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForURL((url) => url.hash === '#/' || url.hash === '');
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
  await page.getByTestId('festa-receipt').waitFor();
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
    const title = '말하는 대로, 바이브 코딩 페스타 접수';
    await guest.locator('.hero a[href="#/festa"]', { hasText: title }).waitFor();
    await guest.locator('#projects a[href="#/festa"]', { hasText: title }).waitFor();
    await guest.locator('.gnav__links a[href="#/festa"]').waitFor();
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
    await admin.goto(`${origin}/#/admin`);
    await admin.locator('main a[href="#/admin/festa"]').first().waitFor();
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
    await form.locator('[name="title"]').fill('민원 안내 도우미');
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
    assert.equal(mine.files.length, 1);
    assert.equal(mine.author.email, 'alice@example.com');
  });
  await step('접수 확인에서 수정하면 기존 정보가 채워지고 같은 작품이 갱신됨', async () => {
    const before = (await state(alice)).mine.id;
    await alice.getByTestId('festa-edit-entry').click();
    const form = alice.getByTestId('festa-entry-form');
    await form.waitFor();
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
    for (const [name, value] of Object.entries({
      title: '문서 정리 웹앱', description: '문서를 분류하고 검색하는 웹앱입니다.',
      deployUrl: 'https://example.com/documents', githubUrl: 'https://github.com/example/documents',
    })) await form.locator(`[name="${name}"]`).fill(value);
    await saveEntry(bob);
    assert.equal((await state(bob)).mine.localOnly, false);
  });
  await step('관리자는 접수 목록에서 두 작품을 확인하고 접수를 마감', async () => {
    await admin.goto(`${origin}/#/admin/festa`);
    const list = admin.getByTestId('festa-admin-list');
    await list.waitFor();
    assert.ok((await list.innerText()).includes('민원 안내 도우미 최종본'));
    assert.ok((await list.innerText()).includes('문서 정리 웹앱'));
    await admin.getByTestId('festa-contact-email').fill('submissions@example.com');
    const [contactResponse] = await Promise.all([
      admin.waitForResponse((r) => r.url().endsWith('/api/festa/contact')),
      admin.getByTestId('festa-contact-save').click(),
    ]);
    assert.equal(contactResponse.status(), 200);
    assert.equal((await state(admin)).email, 'submissions@example.com');
    await phase(admin, 'closed');
  });
  await step('마감된 접수 화면에서는 수정·신규 제출 동작이 사라짐', async () => {
    await festa(alice);
    await alice.getByTestId('festa-receipt').waitFor();
    assert.equal(await alice.getByTestId('festa-entry-form').count(), 0);
    assert.equal(await alice.getByTestId('festa-edit-entry').count(), 0);
    assert.equal(await alice.getByTestId('festa-judging-list').count(), 0);
  });
  await step('관리자가 심사를 시작하면 작품 목록과 네 평가 항목이 표시', async () => {
    await phase(admin, 'judging');
    await festa(alice);
    await alice.getByTestId('festa-judging-list').waitFor();
    const mine = (await state(alice)).mine.id;
    assert.equal(await alice.locator(`[data-testid="festa-score-form"][data-entry-id="${mine}"]`).count(), 0);
    const form = alice.getByTestId('festa-score-form');
    assert.equal(await form.count(), 1);
    for (let i = 0; i < 4; i += 1) await form.locator(`[name="score${i}"]`).fill(String([40, 30, 20, 10][i]));
    assert.ok((await form.getByTestId('festa-score-total').innerText()).includes('100'));
    const [result] = await Promise.all([
      alice.waitForResponse((r) => r.url().endsWith('/api/festa/score')),
      form.getByTestId('festa-score-save').click(),
    ]);
    assert.equal(result.status(), 200);
  });
  await step('저장한 평가가 새로고침 후 유지되고 0점으로 수정해도 한 사람으로 집계', async () => {
    await festa(alice);
    const form = alice.getByTestId('festa-score-form');
    await form.waitFor();
    for (let i = 0; i < 4; i += 1) assert.equal(await form.locator(`[name="score${i}"]`).inputValue(), String([40, 30, 20, 10][i]));
    for (let i = 0; i < 4; i += 1) await form.locator(`[name="score${i}"]`).fill('0');
    const [result] = await Promise.all([
      alice.waitForResponse((r) => r.url().endsWith('/api/festa/score')),
      form.getByTestId('festa-score-save').click(),
    ]);
    assert.equal(result.status(), 200);
    const bobEntry = (await state(admin)).entries.find((e) => e.title === '문서 정리 웹앱');
    assert.equal(bobEntry.scoreCount, 1);
    assert.equal(bobEntry.average, 0);
  });
  await step('관리자 집계와 심사 종료 후 회원 결과 열람', async () => {
    await admin.goto(`${origin}/#/admin/festa`);
    await admin.getByTestId('festa-admin-list').waitFor();
    assert.ok((await admin.getByTestId('festa-admin-list').innerText()).includes('문서 정리 웹앱'));
    await phase(admin, 'finished');
    await festa(alice);
    await alice.getByTestId('festa-judging-list').waitFor();
    assert.equal(await alice.getByTestId('festa-score-save').count(), 0);
    assert.equal((await state(alice)).phase, 'finished');
  });
  await step('모바일에서도 Festa 본문이 화면 밖으로 넘치지 않음', async () => {
    await alice.setViewportSize({ width: 375, height: 812 });
    await festa(alice);
    await alice.getByTestId('festa-judging-list').waitFor();
    assert.ok(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  });
  await step('브라우저 예외와 서버 500 오류가 없음', () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(`\nFesta 브라우저: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
