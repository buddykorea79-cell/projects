/** 시상식: 관리자 최종 확인, 공개 제한, 장려→우수→최우수 발표 흐름. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startServer } from './mock-r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { server, bucket, origin } = await startServer({ root, env: { PBKDF2_ITERATIONS: 1000 } });
const failures = [];
const errors = [];
let browser;
async function step(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (error) { failures.push(name); console.error(`  FAIL  ${name} — ${error.message}`); }
}
const titles = ['민원 업무 길잡이', '현장 점검 보고서', '회의 업무 정리기', '발전소 점검 보드', '설비 자료 검색기', '교육 일정 도우미'];
const names = ['김하늘', '이바다', '박나래', '정다온', '최가람', '한여울'];
function fixture(tied = false) {
  const entries = names.map((name, i) => ({ id: `fe_final_${i + 1}`, title: titles[i], institution: i < 3 ? '행정안전부' : '한국서부발전',
    author: { name, email: `candidate${i + 1}@example.com`, institution: i < 3 ? '행정안전부' : '한국서부발전' } }));
  const totals = [80, 70, 90, 95, tied ? 95 : 85, 60];
  return { version: 1, phase: 'finished', entries, scores: [], uploads: [], juryPanels: { final: {
    status: 'closed', entryIds: entries.map((entry) => entry.id),
    judges: [{ id: 'fj_judge', name: '비공개 심사위원', email: 'judge@example.com', tokenHash: 'not-public-token', pinHash: 'not-public-pin', expiresAt: Date.now() + 86400000, revoked: false }],
    scores: entries.map((entry, index) => { let remaining = totals[index]; return {
      judgeId: 'fj_judge', entryId: entry.id, scores: [40, 30, 20, 10].map((max) => { const value = Math.min(max, remaining); remaining -= value; return value; }),
    }; }),
  } } };
}
async function person() {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.url().startsWith(`${origin}/api/`) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  return page;
}
async function register(page, email) {
  await page.goto(`${origin}/#/signup`);
  await page.locator('#signupForm').waitFor();
  for (const [name, value] of Object.entries({ email, institution: '행정안전부', name: '운영 테스트', password: 'Awards-2026!', confirm: 'Awards-2026!' })) {
    await page.locator(`#signupForm [name="${name}"]`).fill(value);
  }
  await page.locator('#signupForm [name="agree"]').check();
  await page.locator('#signupForm button[type="submit"]').click();
  await page.waitForURL((url) => url.hash === '#/' || url.hash === '');
}
async function publicPage(page) {
  const url = `${origin}/#/festa/awards`;
  if (page.url() === url) await page.reload(); else await page.goto(url);
}
async function presentationPage(page, path = '/festa/results') {
  const url = `${origin}/#${path}`;
  if (page.url() === url) await page.reload(); else await page.goto(url);
  await page.getByTestId('awards-curtain').waitFor();
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="awards-next"]')?.getAttribute('aria-disabled') !== 'true');
}
async function advance(page, testid = 'awards-next') {
  await ready(page);
  await page.getByTestId(testid).click();
}
async function assertConcealed(page) {
  assert.equal(await page.getByTestId('awards-recipient').count(), 0);
  const content = await page.locator('main').innerText();
  for (const name of names) assert.equal(content.includes(name), false, name);
  for (const title of titles) assert.equal(content.includes(title), false, title);
}
async function assertFits(page) {
  const layout = await page.evaluate(() => {
    const elements = document.querySelectorAll('[data-testid="awards-recipient"], .festa-awards-certificate, .festa-awards-name, .festa-awards-institution, .festa-awards-project, .festa-awards-prize, [data-testid="awards-next"]');
    return { scrollY, height: document.documentElement.scrollHeight, viewportHeight: innerHeight,
      outOfView: [...elements].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1;
      }).map((element) => `${element.className}: ${element.textContent.trim()}`),
    };
  });
  assert.equal(layout.scrollY, 0);
  assert.deepEqual(layout.outOfView, []);
  assert.ok(layout.height <= layout.viewportHeight + 1, `페이지 높이 ${layout.height}`);
}
async function screenshot(page, name, fullPage = true) {
  if (!process.env.FESTA_AWARDS_SCREENSHOT_DIR) return;
  await mkdir(process.env.FESTA_AWARDS_SCREENSHOT_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: join(process.env.FESTA_AWARDS_SCREENSHOT_DIR, name), fullPage });
}
async function confirmPublish(admin) {
  await admin.getByTestId('awards-publish').click();
  await admin.locator('.modal [data-ok]').waitFor();
  const [response] = await Promise.all([
    admin.waitForResponse((r) => r.url().endsWith('/api/festa/awards/publish')),
    admin.locator('.modal [data-ok]').click(),
  ]);
  assert.equal(response.status(), 200);
  await admin.getByTestId('awards-public-link').waitFor();
}

try {
  await bucket.put('data/festa.json', JSON.stringify(fixture()));
  browser = await chromium.launch(chromeOptions());
  console.log(`\n시상식 브라우저 서버: ${origin}`);
  const guest = await person();
  const member = await person();
  const admin = await person();
  const waiting = await person();

  await step('미발행 공개 주소에는 발표 대기 안내만 표시', async () => {
    await publicPage(guest);
    await guest.getByTestId('awards-unpublished').waitFor();
    assert.equal(await guest.getByTestId('awards-recipient').count(), 0);
    assert.ok((await guest.getByTestId('awards-unpublished').innerText()).includes('발표를 기다려 주세요'));
    await waiting.goto(`${origin}/#/festa/results`);
    await waiting.getByTestId('awards-unpublished').waitFor();
    assert.ok((await waiting.getByTestId('awards-unpublished').innerText()).includes('2차 심사 마감과 수상 순서 확정 후 발표가 열립니다'));
  });
  await step('일반회원은 관리자 검토 화면에 접근 불가', async () => {
    await register(member, 'member@example.com');
    await member.goto(`${origin}/#/admin/festa/awards`);
    await member.waitForFunction(() => /관리자|권한/.test(document.querySelector('main')?.textContent || ''));
    assert.equal(await member.getByTestId('awards-ranking').count(), 0);
  });
  await step('관리자는 최종6명·기관별조건·수상예정6명과 심사설정 링크를 확인', async () => {
    await register(admin, 'aireader@mois.go.kr');
    await admin.goto(`${origin}/#/admin/festa/awards`);
    await admin.getByTestId('awards-ready').waitFor();
    assert.equal(await admin.getByTestId('awards-ranking').locator('tbody tr').count(), 6);
    assert.equal(await admin.getByTestId('awards-recipient-preview').locator('article').count(), 6);
    assert.equal(await admin.locator('main a[href="#/admin/festa/jury"]').count(), 1);
    assert.ok((await admin.getByTestId('awards-recipient-preview').innerText()).includes('행정안전부 장관상'));
    assert.ok((await admin.getByTestId('awards-recipient-preview').innerText()).includes('한국서부발전 사장상'));
  });
  await step('공개 확인 모달에서 취소하면 미발행 상태 유지', async () => {
    await admin.getByTestId('awards-publish').click();
    await admin.locator('.modal [data-cancel]').click();
    assert.equal((await guest.request.get(`${origin}/api/festa/awards`)).status(), 404);
    assert.equal(await admin.getByTestId('awards-publish').isEnabled(), true);
  });
  await step('관리자 확인 후 공개되며 공개 화면에 이름·기관·작품·상훈·상품만 표시', async () => {
    await confirmPublish(admin);
    assert.equal(await admin.getByTestId('awards-present-link').getAttribute('href'), '#/festa/results');
    assert.equal(await admin.getByTestId('awards-public-link').getAttribute('href'), '#/festa/awards');
    await publicPage(guest);
    await guest.getByTestId('awards-all').waitFor();
    assert.equal(await guest.getByTestId('awards-recipient').count(), 6);
    assert.equal(await guest.locator('[data-testid="awards-recipient"][data-award="grand"]').count(), 1);
    assert.equal(await guest.locator('[data-testid="awards-recipient"][data-award="excellence"]').count(), 2);
    assert.equal(await guest.locator('[data-testid="awards-recipient"][data-award="encouragement"]').count(), 3);
    const content = await guest.getByTestId('awards-public').innerText();
    for (const name of names) assert.ok(content.includes(name), name);
    for (const title of titles) assert.ok(content.includes(title), title);
    assert.ok(content.includes('행정안전부 장관상'));
    assert.ok(content.includes('한국서부발전 사장상'));
    assert.equal(await guest.locator('.festa-awards-prize', { hasText: '50만원 상당' }).count(), 1);
    assert.equal(await guest.locator('.festa-awards-prize', { hasText: '30만원 상당' }).count(), 5);
    for (const privateText of ['평균', '심사위원', 'judge@example.com', '점수', 'not-public']) assert.equal(content.includes(privateText), false, privateText);
    await screenshot(guest, 'awards-all-desktop.png');
    await waiting.getByTestId('awards-retry').click();
    await waiting.getByTestId('awards-curtain').waitFor();
    await assertConcealed(waiting);
  });
  await step('새 발표 주소와 기존 주소 모두 가림 화면에서 시작하고 자동 공개·음향이 없음', async () => {
    await guest.setViewportSize({ width: 1280, height: 720 });
    for (const path of ['/festa/results', '/festa/awards?mode=present']) {
      await presentationPage(guest, path);
      await assertConcealed(guest);
      assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '-1');
      assert.equal(await guest.locator('audio, video').count(), 0);
    }
    await presentationPage(guest);
    await screenshot(guest, 'ceremony-opening-1280x720.png', false);
  });
  await step('새로고침·뒤로·앞으로 이동해도 수상자 정보가 먼저 나타나지 않음', async () => {
    await advance(guest);
    await advance(guest);
    assert.equal(await guest.getByTestId('awards-recipient').count(), 1);
    await guest.reload();
    await guest.getByTestId('awards-curtain').waitFor();
    await assertConcealed(guest);
    await publicPage(guest);
    await guest.getByTestId('awards-all').waitFor();
    await guest.goBack();
    await guest.getByTestId('awards-curtain').waitFor();
    await assertConcealed(guest);
    await guest.goForward();
    await guest.getByTestId('awards-all').waitFor();
    assert.equal(await guest.getByTestId('awards-recipient').count(), 6);
    await guest.getByTestId('awards-present').click();
    await guest.getByTestId('awards-curtain').waitFor();
    await assertConcealed(guest);
  });
  await step('더블클릭과 누른 채 반복되는 Enter는 다음 수상자를 건너뛰지 않음', async () => {
    await advance(guest);
    await ready(guest);
    await guest.getByTestId('awards-next').dblclick({ delay: 30 });
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '0');
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-revealed'), 'true');
    await ready(guest);
    await guest.getByTestId('awards-next').focus();
    await guest.keyboard.down('Enter');
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '1');
    await ready(guest);
    await guest.keyboard.down('Enter');
    await guest.keyboard.up('Enter');
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-revealed'), 'false');
    await assertConcealed(guest);
    await guest.keyboard.press('Space');
    assert.equal(await guest.getByTestId('awards-recipient').count(), 1);
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '1');
  });
  await step('이전과 처음부터는 가림 상태로 이동하고 키보드 포커스를 유지', async () => {
    await advance(guest, 'awards-prev');
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '1');
    await assertConcealed(guest);
    await advance(guest, 'awards-prev');
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '0');
    await assertConcealed(guest);
    await advance(guest, 'awards-restart');
    assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), '-1');
    assert.equal(await guest.evaluate(() => document.activeElement?.dataset.testid), 'awards-next');
    await assertConcealed(guest);
  });
  await step('장려 3명 → 우수 2명 → 최우수 1명을 각각 가림·공개하며 두 프로젝터 해상도에서 전체 정보 표시', async () => {
    const order = [
      ['encouragement', '최가람'], ['encouragement', '이바다'], ['encouragement', '한여울'],
      ['excellence', '박나래'], ['excellence', '김하늘'], ['grand', '정다온'],
    ];
    await advance(guest);
    for (const [index, [award, name]] of order.entries()) {
      assert.equal(await guest.getByTestId('awards-public').getAttribute('data-position'), String(index));
      await assertConcealed(guest);
      if (award === 'grand') {
        await ready(guest);
        await screenshot(guest, 'ceremony-grand-curtain-1280x720.png', false);
      }
      await advance(guest);
      await ready(guest);
      assert.equal(await guest.getByTestId('awards-recipient').count(), 1);
      assert.equal(await guest.getByTestId('awards-recipient').getAttribute('data-award'), award);
      const content = await guest.getByTestId('awards-recipient').innerText();
      assert.ok(content.includes(name), name);
      for (const otherName of names.filter((item) => item !== name)) assert.equal(content.includes(otherName), false, otherName);
      assert.ok(content.includes(award === 'grand' ? '50만원 상당' : '30만원 상당'));
      assert.ok(content.includes(award === 'encouragement' ? '한국서부발전 사장상' : '행정안전부 장관상'));
      for (const viewport of [{ width: 1280, height: 720 }, { width: 1366, height: 768 }]) {
        await guest.setViewportSize(viewport);
        await assertFits(guest);
      }
      await guest.setViewportSize({ width: 1280, height: 720 });
      if (award === 'grand') {
        await screenshot(guest, 'ceremony-grand-reveal-1280x720.png', false);
        await screenshot(guest, 'awards-grand-desktop.png', false);
      }
      await advance(guest);
    }
    await guest.getByTestId('awards-ending').waitFor();
    await assertConcealed(guest);
    await advance(guest);
    await guest.getByTestId('awards-all').waitFor();
    assert.equal(await guest.getByTestId('awards-recipient').count(), 6);
    assert.equal(await guest.locator('#gnav').isVisible(), true);
    assert.equal(await guest.locator('body > .foot').isVisible(), true);
  });
  await step('모바일에서도 개별 공개가 가능하고 동작 줄이기 설정에서는 애니메이션 없이 표시', async () => {
    await guest.setViewportSize({ width: 375, height: 812 });
    await guest.emulateMedia({ reducedMotion: 'reduce' });
    await presentationPage(guest);
    await advance(guest);
    await advance(guest);
    assert.equal(await guest.getByTestId('awards-recipient').count(), 1);
    assert.ok(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await guest.locator('.festa-ceremony-reveal').evaluate((element) => getComputedStyle(element).animationName), 'none');
    assert.equal(await guest.locator('.festa-ceremony-reveal').evaluate((element) => getComputedStyle(element, '::before').display), 'none');
    const contrast = await guest.locator('.festa-awards-institution, .festa-awards-project').evaluateAll((elements) => {
      const luminance = (color) => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((c) => {
          const value = c / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      };
      return elements.map((element) => {
        const foreground = luminance(getComputedStyle(element).color);
        const card = getComputedStyle(element.closest('.festa-awards-card'));
        const colors = card.backgroundImage.match(/rgba?\([^)]+\)/g) || [card.backgroundColor];
        return Math.min(...colors.map((color) => {
          const background = luminance(color);
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        }));
      });
    });
    assert.ok(contrast.every((ratio) => ratio >= 4.5), '기관·작품명 명암비: ' + contrast);
    await screenshot(guest, 'ceremony-mobile-reveal.png');
    await guest.emulateMedia({ reducedMotion: 'no-preference' });
  });
  await step('긴 성명·작품명도 잘리지 않고 모바일은 자연 스크롤로 진행 가능', async () => {
    const publication = await (await guest.request.get(origin + '/api/festa/awards')).json();
    const longName = '긴성명'.repeat(20);
    const longTitle = '민원과 현장 업무를 돕는 지능형 업무 지원 서비스 '.repeat(8).slice(0, 160);
    publication.recipients = publication.recipients.map((row) => ({ ...row, name: longName, projectTitle: longTitle }));
    await guest.route('**/api/festa/awards', (route) => route.fulfill({ json: publication }));
    try {
      await presentationPage(guest);
      await advance(guest);
      await advance(guest);
      await ready(guest);
      for (const viewport of [{ width: 1280, height: 720 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
        await guest.setViewportSize(viewport);
        const layout = await guest.locator('.festa-awards-name, .festa-awards-project').evaluateAll((elements) => elements.map((element) => ({
          text: element.textContent, width: element.clientWidth, contentWidth: element.scrollWidth,
          height: element.clientHeight, contentHeight: element.scrollHeight,
        })));
        assert.equal(layout.length, 2);
        for (const item of layout) {
          assert.ok([longName, longTitle].includes(item.text));
          assert.ok(item.contentWidth <= item.width + 1, '긴 텍스트 가로 잘림: ' + viewport.width);
          assert.ok(item.contentHeight <= item.height + 1, '긴 텍스트 세로 잘림: ' + viewport.width);
        }
        assert.ok(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      assert.ok(await guest.evaluate(() => document.documentElement.scrollHeight > innerHeight));
      await guest.getByTestId('awards-next').scrollIntoViewIfNeeded();
      await advance(guest);
      assert.equal(await guest.getByTestId('awards-recipient').count(), 0);
      assert.equal(await guest.evaluate(() => scrollY), 0);
    } finally { await guest.unroute('**/api/festa/awards'); }
  });
  await step('완전동점은 자동발행을 막고 관리자 순서 입력 후 검토·공개', async () => {
    await bucket.put('data/festa.json', JSON.stringify(fixture(true)));
    await admin.reload();
    await admin.getByTestId('awards-tie-form').waitFor();
    assert.equal(await admin.getByTestId('awards-publish').isDisabled(), true);
    const order = ['fe_final_5', 'fe_final_4', 'fe_final_3', 'fe_final_1', 'fe_final_2', 'fe_final_6'];
    for (let i = 0; i < 6; i += 1) await admin.getByTestId('awards-tie-form').locator(`[name="order${i}"]`).selectOption(order[i]);
    const [response] = await Promise.all([
      admin.waitForResponse((r) => r.url().endsWith('/api/festa/awards/preview') && r.request().method() === 'POST'),
      admin.getByTestId('awards-preview-order').click(),
    ]);
    assert.equal(response.status(), 200);
    await admin.getByTestId('awards-ready').waitFor();
    assert.ok((await admin.getByTestId('awards-recipient-preview').locator('article').first().innerText()).includes('최가람'));
    await confirmPublish(admin);
    await publicPage(guest);
    await guest.getByTestId('awards-all').waitFor();
    assert.ok((await guest.locator('[data-award="grand"]').innerText()).includes('최가람'));
  });
  await step('브라우저 예외와 서버500이 없음', () => assert.deepEqual(errors, []));
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(`\n시상식 브라우저: ${failures.length ? `${failures.length}건 실패` : '모든 검사 통과'}`);
if (failures.length) process.exitCode = 1;
