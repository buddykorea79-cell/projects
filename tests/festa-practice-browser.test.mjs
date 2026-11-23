/** 관리자 샘플 심사 연습: 모든 점수·초기화가 실제 행사와 분리되는지 검증합니다. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startServer, browserGoogleLogin } from './mock-r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'aireader@mois.go.kr';
const SECOND_ADMIN = 'second-admin@example.com';
const PASSWORD = 'Practice-test-2026!';
const PRACTICE = '/#/admin/festa/practice';
const { server, bucket, origin, setNextGoogleUser } = await startServer({ root, env: {
  ADMIN_EMAILS: `${ADMIN},${SECOND_ADMIN}`,
} });
const failures = [];
const pageErrors = [];
const festaRequests = [];
let browser;
async function step(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.message}`); }
}
async function person() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return page;
}
async function register(page, email, name) {
  await browserGoogleLogin(page, {
    origin, setNextGoogleUser, email, name, institution: '연습 테스트',
  });
}
async function selectSample(page, index) {
  const id = `sample-${String(index).padStart(2, '0')}`;
  await page.getByTestId('practice-list').locator(`[data-select-sample="${id}"]`).click();
  await page.locator(`[data-testid="practice-score-form"][data-sample-id="${id}"]`).waitFor();
}
async function score(page, values) {
  const form = page.getByTestId('practice-score-form');
  for (let i = 0; i < 4; i += 1) await form.locator(`[name="score${i}"]`).fill(String(values[i]));
  await page.getByTestId('practice-save').click();
  await page.waitForFunction(() => /저장했습니다|현재 화면에 평가를 반영/.test(
    document.querySelector('[data-testid="practice-status"]')?.textContent || ''));
}
const liveSnapshot = async () => ({
  state: await (await bucket.get('data/festa.json')).text(),
  uploads: bucket.keys('festa/uploads/'),
});
function monitor(page) {
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/festa')) {
      festaRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
}

try {
  browser = await chromium.launch(chromeOptions());
  console.log(`\nFesta 샘플 연습 브라우저 서버: ${origin}`);
  const guest = await person();
  const member = await person();
  const admin = await person();
  const otherAdmin = await person();
  let before;

  await step('비회원과 일반회원은 관리자 샘플에 접근할 수 없음', async () => {
    await guest.goto(`${origin}${PRACTICE}`);
    await guest.waitForFunction(() => /로그인|관리자/.test(document.querySelector('main')?.textContent || ''));
    assert.equal(await guest.getByTestId('practice-root').count(), 0);
    await register(member, 'member@example.com', '일반회원');
    await member.goto(`${origin}${PRACTICE}`);
    await member.waitForFunction(() => /관리자|권한/.test(document.querySelector('main')?.textContent || ''));
    assert.equal(await member.getByTestId('practice-root').count(), 0);
  });
  await step('두 관리자와 실제 접수·마감 상태를 준비', async () => {
    await register(admin, ADMIN, '첫 관리자');
    await register(otherAdmin, SECOND_ADMIN, '다른 관리자');
    const futureDeadline = new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);
    const deadline = await admin.request.post(`${origin}/api/festa/deadline`, { data: { deadline: futureDeadline } });
    assert.equal(deadline.status(), 200);
    const save = await admin.request.post(`${origin}/api/festa/entry`, { data: {
      institution: '행정안전부', title: '운영 접수 보존 대상', description: '연습 점수의 영향을 받으면 안 되는 실제 행사 테스트 자료입니다.',
      localOnly: true, deployUrl: '', githubUrl: 'https://github.com/example/live-fixture', files: [],
    } });
    assert.equal(save.status(), 200);
    const close = await admin.request.post(`${origin}/api/festa/phase`, { data: { phase: 'closed' } });
    assert.equal(close.status(), 200);
    before = await liveSnapshot();
    monitor(admin);
    monitor(otherAdmin);
  });
  await step('샘플 10개와 가상 작품·실제 결과 분리 안내가 표시', async () => {
    await admin.goto(`${origin}${PRACTICE}`);
    await admin.getByTestId('practice-root').waitFor();
    assert.equal(await admin.getByTestId('practice-choice').count(), 10);
    const notice = await admin.getByTestId('practice-notice').innerText();
    assert.ok(notice.includes('가상'));
    assert.ok(notice.includes('실제 접수·심사 결과에 포함되지 않습니다'));
    assert.ok((await admin.getByTestId('practice-summary').innerText()).includes('0 / 10'));
    assert.equal(await admin.getByTestId('practice-results-empty').count(), 1);
  });
  await step('각 샘플에 서로 다른 설명·입력·결과·검토할 점이 있고 가짜 외부 링크는 없음', async () => {
    const titles = new Set();
    const details = new Set();
    for (let index = 1; index <= 10; index += 1) {
      await selectSample(admin, index);
      titles.add(await admin.locator('#practiceDetailTitle').innerText());
      const detail = await admin.getByTestId('practice-detail').innerText();
      for (const phrase of ['해결하려는 문제', '예시 입력', '예시 결과', '평가할 때 살펴볼 점', '확장 아이디어']) {
        assert.ok(detail.includes(phrase), `${index}: missing ${phrase}`);
      }
      details.add(detail);
      assert.equal(await admin.getByTestId('practice-detail').locator('a[href^="http"]').count(), 0);
    }
    assert.equal(titles.size, 10);
    assert.equal(details.size, 10);
  });
  await step('40·30·20·10점 네 항목을 사용하고 범위 밖·소수 점수는 저장하지 않음', async () => {
    await selectSample(admin, 1);
    const form = admin.getByTestId('practice-score-form');
    for (let i = 0; i < 4; i += 1) {
      const input = form.locator(`[name="score${i}"]`);
      assert.equal(await input.getAttribute('max'), String([40, 30, 20, 10][i]));
      assert.equal(await input.getAttribute('min'), '0');
      await input.fill(String([41, 30, 20, 10][i]));
    }
    await admin.getByTestId('practice-save').click();
    assert.equal(await form.evaluate((element) => element.checkValidity()), false);
    assert.equal(await admin.getByTestId('practice-result-row').count(), 0);
    await form.locator('[name="score0"]').fill('1.5');
    await admin.getByTestId('practice-save').click();
    assert.equal(await form.evaluate((element) => element.checkValidity()), false);
    assert.equal(await admin.getByTestId('practice-result-row').count(), 0);
  });
  await step('샘플 10개를 모두 채점하면 합계·완료 수·평균·결과 순서가 맞음', async () => {
    for (let index = 0; index < 10; index += 1) {
      await selectSample(admin, index + 1);
      const scores = [40 - index * 3, 30 - index * 3, 20 - index * 2, 10 - index];
      await score(admin, scores);
      const row = admin.locator(`[data-result-id="sample-${String(index + 1).padStart(2, '0')}"]`);
      assert.equal(await row.getByTestId('practice-result-total').innerText(), `${scores.reduce((a, b) => a + b, 0)} / 100점`);
    }
    assert.equal(await admin.getByTestId('practice-result-row').count(), 10);
    const summary = await admin.getByTestId('practice-summary').innerText();
    assert.ok(summary.includes('10 / 10'));
    assert.ok(summary.includes('59.5'));
    assert.equal(await admin.getByTestId('practice-result-row').first().getAttribute('data-result-id'), 'sample-01');
  });
  await step('결과에서 다시 채점해 0점으로 수정해도 평가 수는 늘지 않음', async () => {
    await admin.locator('[data-result-id="sample-01"] [data-select-sample="sample-01"]').click();
    await score(admin, [0, 0, 0, 0]);
    assert.equal(await admin.getByTestId('practice-result-row').count(), 10);
    assert.equal(await admin.locator('[data-result-id="sample-01"]').getByTestId('practice-result-total').innerText(), '0 / 100점');
    assert.equal(await admin.getByTestId('practice-result-row').last().getAttribute('data-result-id'), 'sample-01');
    assert.ok((await admin.getByTestId('practice-summary').innerText()).includes('49.5'));
  });
  await step('새로고침해도 현재 관리자 탭의 점수와 선택 샘플을 복원', async () => {
    await admin.reload();
    await admin.getByTestId('practice-root').waitFor();
    assert.equal(await admin.getByTestId('practice-score-form').getAttribute('data-sample-id'), 'sample-01');
    for (let index = 0; index < 4; index += 1) {
      assert.equal(await admin.locator(`[name="score${index}"]`).inputValue(), '0');
    }
    assert.equal(await admin.getByTestId('practice-result-row').count(), 10);
  });
  await step('개별 초기화는 취소할 수 있고 확인하면 해당 샘플 점수만 지움', async () => {
    await admin.getByTestId('practice-reset-one').click();
    await admin.locator('.modal [data-cancel]').click();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 10);
    await admin.getByTestId('practice-reset-one').click();
    await admin.locator('.modal [data-ok]').click();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 9);
    assert.equal(await admin.locator('[name="score0"]').inputValue(), '');
    assert.equal(await admin.locator('[data-result-id="sample-02"]').getByTestId('practice-result-total').innerText(), '91 / 100점');
  });
  await step('같은 탭에서 관리자를 바꿔도 다른 관리자 점수는 섞이지 않음', async () => {
    const login = await admin.request.post(`${origin}/api/auth/login`, { data: { email: SECOND_ADMIN, password: PASSWORD } });
    assert.equal(login.status(), 200);
    await admin.reload();
    await admin.getByTestId('practice-root').waitFor();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 0);
    await score(admin, [10, 10, 10, 10]);
    assert.equal(await admin.getByTestId('practice-result-row').count(), 1);
    const original = await admin.request.post(`${origin}/api/auth/login`, { data: { email: ADMIN, password: PASSWORD } });
    assert.equal(original.status(), 200);
    await admin.reload();
    await admin.getByTestId('practice-root').waitFor();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 9);
    assert.equal(await admin.locator('[data-result-id="sample-01"]').count(), 0);
  });
  await step('전체 다시 하기는 확인 후 현재 관리자 연습 결과만 초기화', async () => {
    await admin.getByTestId('practice-reset-all').click();
    await admin.locator('.modal [data-cancel]').click();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 9);
    await admin.getByTestId('practice-reset-all').click();
    await admin.locator('.modal [data-ok]').click();
    await admin.getByTestId('practice-results-empty').waitFor();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 0);
    assert.ok((await admin.getByTestId('practice-summary').innerText()).includes('0 / 10'));
    await admin.reload();
    await admin.getByTestId('practice-root').waitFor();
    assert.equal(await admin.getByTestId('practice-result-row').count(), 0);
  });
  await step('저장소를 사용할 수 없어도 연습 화면은 작동하고 보관 실패를 안내', async () => {
    const constrained = await admin.context().newPage();
    constrained.setDefaultTimeout(8000);
    constrained.on('pageerror', (error) => pageErrors.push(error.message));
    monitor(constrained);
    await constrained.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key.startsWith('ah.festaPractice.')) throw new DOMException('blocked', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await constrained.goto(`${origin}${PRACTICE}`);
    await constrained.getByTestId('practice-root').waitFor();
    await score(constrained, [1, 2, 3, 4]);
    assert.equal(await constrained.getByTestId('practice-result-row').count(), 1);
    assert.ok((await constrained.getByTestId('practice-root').innerText()).includes('연습 기록을 보관할 수 없습니다'));
    await constrained.reload();
    await constrained.getByTestId('practice-root').waitFor();
    assert.equal(await constrained.getByTestId('practice-result-row').count(), 0);
    await constrained.close();
  });
  await step('375·1024·1280px에서 목록·상세·결과가 가로 화면 밖으로 넘치지 않음', async () => {
    await score(admin, [35, 25, 15, 5]);
    for (const width of [375, 1024, 1280]) {
      await admin.setViewportSize({ width, height: 900 });
      assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `overflow ${width}px`);
      await admin.getByTestId('practice-save').scrollIntoViewIfNeeded();
      assert.equal(await admin.getByTestId('practice-save').isVisible(), true);
    }
  });
  await step('연습 과정에 운영 Festa API 호출·저장소 변경·브라우저 예외가 없음', async () => {
    assert.deepEqual(festaRequests, []);
    assert.deepEqual(await liveSnapshot(), before);
    assert.deepEqual(pageErrors, []);
  });
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(`\nFesta 샘플 연습: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
