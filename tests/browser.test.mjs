import { chromium } from 'playwright';
import { existsSync } from 'fs';

const BASE = 'http://localhost:8899';
const errors = [];
const log = (...a) => console.log(...a);

// 이 환경에는 Chromium 이 미리 깔려 있습니다. 다른 곳에서는 CHROME_PATH 로 지정하거나
// 이 옵션을 지우고 `npx playwright install chromium` 을 쓰세요.
const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// 이 묶음은 UI 흐름 검증용이라 브라우저 저장 모드로 고정합니다.
// (R2 경로는 r2.test.mjs 와 r2-browser.test.mjs 가 담당합니다.)
await ctx.addInitScript(() => {
  try { localStorage.setItem('ah.storageMode', 'local'); } catch { /* ignore */ }
});
const page = await ctx.newPage();

page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url || '')) errors.push(`console: ${m.text()} @ ${m.location()?.url}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function step(name, fn) {
  try { await fn(); log(`  PASS  ${name}`); }
  catch (e) { log(`  FAIL  ${name} — ${e.message}`); errors.push(`${name}: ${e.message}`); }
}

log('\n== 1. 홈 ==');
await page.goto(BASE, { waitUntil: 'networkidle' });
await step('히어로 제목 렌더', async () => {
  await page.waitForSelector('.hero__title', { timeout: 5000 });
});
await step('시드 프로젝트 2건 표시', async () => {
  await page.waitForSelector('.tile', { timeout: 5000 });
  const n = await page.locator('.tile').count();
  if (n !== 2) throw new Error(`tile count = ${n}`);
});
await step('히어로 문구가 새 문구로 표시', async () => {
  const t = await page.locator('.hero__title').innerText();
  if (!t.includes('여기에서 과제를 제출하고') || !t.includes('강의자료를 받을 수 있습니다'))
    throw new Error(t);
});
await step('안내 제목이 "과제 제출 방법"', async () => {
  const h = await page.locator('.band h2').first().innerText();
  if (h.trim() !== '과제 제출 방법') throw new Error(h);
  const steps = await page.locator('.step h3').allInnerTexts();
  const want = ['제출할 과제 목록 선택', '참석자 정보', '과제 내용'];
  if (JSON.stringify(steps) !== JSON.stringify(want)) throw new Error(steps.join(' / '));
});
await step('프로젝트 그리드가 한 행에 2개', async () => {
  const cols = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length);
  if (cols !== 2) throw new Error(`컬럼 ${cols}개`);
});
await step('"진행중 프로젝트 보기"가 목록으로 스크롤 (404 아님)', async () => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('[data-scroll-projects]').click();
  await page.waitForTimeout(900);
  if (!(await page.locator('.tile').first().isVisible())) throw new Error('스크롤 안 됨');
  if (await page.locator('.empty h3').count()) throw new Error('404 화면이 떴음');
  if (page.url().endsWith('#projects')) throw new Error('해시가 오염됨');
});
await step('헤더에 강의자료 메뉴 존재', async () => {
  const href = await page.locator('.gnav__links a[data-nav="materials"]').getAttribute('href');
  if (href !== '#/materials') throw new Error(href);
});

log('\n== 2. 프로젝트 상세 ==');
await step('첫 프로젝트 열기', async () => {
  await page.locator('.tile').first().click();
  await page.waitForSelector('h1', { timeout: 5000 });
});

log('\n== 3. 제출 플로우 ==');
await step('제출 화면 진입', async () => {
  await page.getByRole('link', { name: '과제 제출하기' }).click();
  await page.waitForSelector('#submitForm', { timeout: 5000 });
});
await step('1단계 검증 — 빈 값이면 막힘', async () => {
  await page.locator('[data-next]').click();
  await page.waitForSelector('.field__err', { timeout: 3000 });
  if (await page.locator('[data-panel="2"]').isVisible()) throw new Error('2단계로 넘어가 버림');
});
await step('1단계 통과', async () => {
  await page.fill('[name="institution"]', '한국디자인진흥원');
  await page.fill('[name="name"]', '홍길동');
  await page.fill('[name="email"]', 'hong@example.com');
  await page.locator('[data-next]').click();
  await page.waitForSelector('[data-panel="2"]:not([hidden])', { timeout: 3000 });
});
await step('파일 첨부 (이미지)', async () => {
  await page.setInputFiles('[data-input]', {
    name: 'poster.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
      '01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'),
  });
  await page.waitForSelector('.fileitem', { timeout: 3000 });
});
await step('거부: 허용되지 않는 확장자', async () => {
  await page.setInputFiles('[data-input]', {
    name: 'evil.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ'),
  });
  await page.waitForSelector('.toast--err', { timeout: 3000 });
  const n = await page.locator('.fileitem').count();
  if (n !== 1) throw new Error(`fileitem count = ${n}, 확장자 거부 실패`);
});
await step('2단계 검증 — 동의 없으면 막힘', async () => {
  await page.fill('[name="title"]', '스타벅스 디자인 시스템 분석');
  await page.fill('[name="body"]', '색상 4단계 그린 체계와 50px 필 버튼을 정리했습니다.');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(400);
  if (page.url().includes('/done/')) throw new Error('동의 없이 제출됨');
});
let editCode = '';
await step('제출 성공 + 수정코드 발급', async () => {
  await page.check('[name="agree"]');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/done\//, { timeout: 8000 });
  await page.waitForSelector('.code-ceremony__code', { timeout: 5000 });
  editCode = (await page.locator('.code-ceremony__code').innerText()).trim();
  if (!/^[A-Z0-9]{6}$/.test(editCode)) throw new Error(`code = "${editCode}"`);
  log(`        발급된 코드: ${editCode}`);
});

log('\n== 4. 내 제출물 조회 / 수정 / 삭제 ==');
await step('틀린 코드는 거부', async () => {
  await page.goto(`${BASE}#/my`, { waitUntil: 'networkidle' });
  await page.fill('#unlockForm [name="email"]', 'hong@example.com');
  await page.fill('#unlockForm [name="code"]', 'ZZZZZZ');
  await page.locator('#unlockForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 4000 });
});
await step('올바른 코드로 조회', async () => {
  await page.fill('#unlockForm [name="code"]', editCode);
  await page.locator('#unlockForm button[type="submit"]').click();
  await page.waitForSelector('.table tbody tr', { timeout: 5000 });
});
await step('제출물 수정', async () => {
  await page.locator('.table tbody tr a[href*="/s/"]').first().click();
  await page.waitForSelector('.page-title', { timeout: 5000 });
  await page.getByRole('link', { name: '수정' }).first().click();
  await page.waitForSelector('#editForm', { timeout: 5000 });
  await page.fill('[name="title"]', '수정된 제목입니다');
  await page.locator('#editForm button[type="submit"]').click();
  await page.waitForURL((u) => /#\/s\//.test(u.href) && !u.href.includes('/edit'), { timeout: 8000 });
  await page.waitForFunction(
    () => document.querySelector('.page-title')?.textContent.includes('수정된 제목'),
    null, { timeout: 6000 });
});
await step('첨부 이미지가 렌더됨', async () => {
  await page.waitForSelector('.media-card img', { timeout: 5000 });
});

log('\n== 5. 관리자 ==');
await step('잘못된 비밀번호 거부', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.fill('#loginForm [name="email"]', 'aireader@mois.go.kr');
  await page.fill('#loginForm [name="password"]', 'wrong');
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 4000 });
});
await step('올바른 자격증명으로 로그인', async () => {
  await page.fill('#loginForm [name="password"]', 'dlrhd26');
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForSelector('.stat', { timeout: 6000 });
});
await step('대시보드 통계', async () => {
  const stats = await page.locator('.stat__v').allInnerTexts();
  log(`        통계: ${stats.join(' / ')}`);
  if (stats[2] !== '1') throw new Error(`총 제출물 = ${stats[2]}`);
});
await step('프로젝트 개설', async () => {
  await page.goto(`${BASE}#/admin/project/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#projForm', { timeout: 5000 });
  await page.fill('#projForm [name="title"]', '3주차 · 최종 발표자료');
  await page.fill('#projForm [name="description"]', '최종 발표용 슬라이드를 제출하세요.');
  await page.locator('#projForm button[type="submit"]').click();
  await page.waitForURL(/#\/p\//, { timeout: 6000 });
});
await step('제출물 관리 화면 + 검색', async () => {
  await page.goto(`${BASE}#/admin`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#adminProjects .table', { timeout: 6000 });
  const link = page.locator('a[href*="/admin/submissions/"]').first();
  await link.click();
  await page.waitForSelector('.toolbar', { timeout: 5000 });
});

log('\n== 6. 강의자료 ==');
await step('관리자가 PDF 자료 등록', async () => {
  await page.goto(`${BASE}#/admin/material/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matForm', { timeout: 5000 });
  await page.fill('#matForm [name="title"]', '1강 · AI 리더십 개론');
  await page.fill('#matForm [name="session"]', '1주차');
  await page.fill('#matForm [name="description"]', '수업에서 사용한 슬라이드입니다.');
  await page.setInputFiles('#matPicker [data-input]', {
    name: '1강_AI리더십개론.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%강의자료\n'),
  });
  await page.waitForSelector('#matPicker .fileitem', { timeout: 3000 });
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForURL(/#\/materials/, { timeout: 8000 });
});
await step('강의자료에 PDF 아닌 파일은 거부', async () => {
  await page.goto(`${BASE}#/admin/material/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matPicker', { timeout: 5000 });
  await page.setInputFiles('#matPicker [data-input]', {
    name: '사진.png', mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex'),
  });
  await page.waitForSelector('.toast--err', { timeout: 3000 });
  if (await page.locator('#matPicker .fileitem').count()) throw new Error('거부 실패');
});
await step('파일 없이 저장하면 막힘', async () => {
  await page.fill('#matForm [name="title"]', '파일 없는 자료');
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 3000 });
  if (page.url().includes('#/materials')) throw new Error('파일 없이 저장됨');
});
await step('관리자는 비밀번호 없이 열람', async () => {
  await page.goto(`${BASE}#/materials`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.fileitem', { timeout: 5000 });
  if (await page.locator('#gateForm').count()) throw new Error('관리자에게 잠금이 걸림');
});
await step('로그아웃하면 비밀번호 잠금이 걸림', async () => {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#gateForm', { timeout: 5000 });
});
await step('틀린 비밀번호는 거부', async () => {
  await page.fill('#gateForm [name="password"]', 'wrong');
  await page.locator('#gateForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 4000 });
});
await step('AI2026 으로 잠금 해제 + 다운로드 링크 노출', async () => {
  await page.fill('#gateForm [name="password"]', 'AI2026');
  await page.locator('#gateForm button[type="submit"]').click();
  await page.waitForSelector('.fileitem', { timeout: 5000 });
  const name = await page.locator('.fileitem__name').first().innerText();
  if (!name.includes('1강_AI리더십개론.pdf')) throw new Error(name);
  const dl = page.locator('.fileitem a.btn--primary').first();
  if (!(await dl.isVisible())) throw new Error('내려받기 버튼 없음');
  const href = await dl.getAttribute('href');
  if (!href || !href.startsWith('blob:')) throw new Error(`href = ${href}`);
});
await step('잠금 해제 후 새로고침해도 유지', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.fileitem', { timeout: 5000 });
});

log('\n== 7. 라우팅 / 반응형 ==');
await step('404 처리', async () => {
  await page.goto(`${BASE}#/does-not-exist`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.empty h3', { timeout: 4000 });
});
await step('이용안내 아코디언', async () => {
  await page.goto(`${BASE}#/guide`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.expander', { timeout: 4000 });
  await page.locator('.expander__btn').nth(1).click();
  await page.waitForTimeout(400);
  const open = await page.locator('.expander').nth(1).getAttribute('data-open');
  if (open !== 'true') throw new Error('아코디언이 열리지 않음');
});
await step('모바일 뷰포트 — 가로 스크롤 없음', async () => {
  await page.setViewportSize({ width: 375, height: 780 });
  await page.goto(`${BASE}#/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`가로 오버플로 ${overflow}px`);
});
await step('모바일 드로어', async () => {
  await page.locator('#gnavBurger').click();
  await page.waitForSelector('#gnavDrawer:not([hidden])', { timeout: 3000 });
});

await browser.close();

log('\n================ 결과 ================');
if (errors.length) { log(`실패/오류 ${errors.length}건:`); errors.forEach((e) => log(' - ' + e)); process.exit(1); }
log('모든 검사 통과');
