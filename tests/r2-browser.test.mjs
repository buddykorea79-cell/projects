/**
 * R2 모드 브라우저 종단간 테스트.
 *
 * 메모리 R2 스텁 위에 사이트와 /api 를 같은 오리진으로 띄우고 — 실제 Cloudflare
 * Pages 배포와 같은 구조 — 진짜 크로미움으로 제출·다운로드까지 밟아 봅니다.
 * config.js 의 기본 모드(r2)를 그대로 씁니다.
 */
import { chromium } from 'playwright';
import { existsSync } from 'fs';
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

// 강의자료 다운로드 잠금까지 켠 상태로 — 가장 빡빡한 구성을 검증합니다.
const { server, bucket, origin } = await startServer({
  root,
  env: {
    MATERIALS_PASSWORD: 'AI2026',
    TOKEN_SECRET: 'browser-test-secret',
  },
});
log(`\n로컬 R2 스텁 서버: ${origin}`);

const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(existsSync(executablePath) ? { executablePath } : {});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.location()?.url || '')) {
    consoleErrors.push(`console: ${m.text()}`);
  }
});

const login = async () => {
  await page.goto(`${origin}/#/admin`, { waitUntil: 'networkidle' });
  await page.fill('#loginForm [name="email"]', 'aireader@mois.go.kr');
  await page.fill('#loginForm [name="password"]', 'dlrhd26');
  await page.locator('#loginForm button[type="submit"]').click();
  await page.waitForSelector('.stat', { timeout: 8000 });
};

log('\n== 1. R2 모드로 부팅 ==');

await step('앱이 R2 저장소로 초기화', async () => {
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForSelector('.hero__title', { timeout: 8000 });
  const meta = await page.locator('#footMeta').innerText();
  if (!meta.includes('Cloudflare R2')) throw new Error(meta);
});

await step('빈 버킷에서는 프로젝트가 없다고 안내', async () => {
  await page.waitForSelector('#projectGrid .empty h3', { timeout: 8000 });
});

log('\n== 2. 관리자 — 프로젝트 개설 ==');

let projectId;
await step('로그인 후 프로젝트 개설', async () => {
  await login();
  await page.goto(`${origin}/#/admin/project/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#projForm', { timeout: 8000 });
  await page.fill('#projForm [name="title"]', '1주차 · 브랜드 분석');
  await page.fill('#projForm [name="description"]', '분석 결과를 제출하세요.');
  await page.locator('#projForm button[type="submit"]').click();
  await page.waitForURL(/#\/p\//, { timeout: 10000 });
  projectId = page.url().split('#/p/')[1];
});

await step('프로젝트가 R2 색인에 기록됨', async () => {
  const raw = new TextDecoder().decode(bucket.objects.get('data/projects.json').bytes);
  if (!raw.includes('1주차 · 브랜드 분석')) throw new Error('색인에 없음');
});

log('\n== 3. 교육생 — 제출 (토큰 없이) ==');

let editCode;
await step('로그아웃한 상태로 첨부와 함께 제출', async () => {
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${origin}/#/p/${projectId}/submit`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#submitForm', { timeout: 8000 });
  await page.fill('[name="institution"]', '한국디자인진흥원');
  await page.fill('[name="name"]', '홍길동');
  await page.fill('[name="email"]', 'hong@example.com');
  await page.locator('[data-next]').click();
  await page.waitForSelector('[data-panel="2"]:not([hidden])', { timeout: 5000 });
  await page.fill('[name="title"]', '스타벅스 디자인 시스템 분석');
  await page.fill('[name="body"]', '4단계 그린 체계를 정리했습니다.');
  await page.setInputFiles('[data-input]', {
    name: '시안 최종.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'),
  });
  await page.waitForSelector('.fileitem', { timeout: 5000 });
  await page.check('[name="agree"]');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/done\//, { timeout: 15000 });
  editCode = (await page.locator('.code-ceremony__code').innerText()).trim();
  if (!/^[A-Z0-9]{6}$/.test(editCode)) throw new Error(`code = ${editCode}`);
});

await step('업로드된 파일이 R2 버킷에 존재', () => {
  const keys = bucket.keys('uploads/');
  if (keys.length !== 1) throw new Error(`업로드 키 ${keys.length}개: ${keys}`);
  if (!keys[0].includes('시안_최종.png')) throw new Error(keys[0]);
});

await step('제출물 상세에서 첨부 이미지가 실제로 렌더됨', async () => {
  await page.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await page.fill('#unlockForm [name="email"]', 'hong@example.com');
  await page.fill('#unlockForm [name="code"]', editCode);
  await page.locator('#unlockForm button[type="submit"]').click();
  await page.waitForSelector('.table tbody tr', { timeout: 10000 });
  await page.locator('.table tbody tr a[href*="/s/"]').first().click();
  await page.waitForSelector('.media-card img', { timeout: 10000 });
  const ok = await page.locator('.media-card img').first().evaluate(
    (img) => img.complete && img.naturalWidth > 0);
  if (!ok) throw new Error('이미지가 로드되지 않음 — /api/file 응답 확인 필요');
});

await step('첨부 받기 링크가 download=1 로 나감', async () => {
  const href = await page.locator('.media-card a').first().getAttribute('href');
  if (!href.startsWith('/api/file/')) throw new Error(href);
  if (!href.includes('download=1')) throw new Error(href);
});

log('\n== 4. 제출물 수정 · 삭제 ==');

await step('첨부를 추가하면 R2 에 파일이 늘어남', async () => {
  const before = bucket.keys('uploads/').length;
  await page.locator('a[href*="/edit"]').first().click();
  await page.waitForSelector('#editForm', { timeout: 8000 });
  await page.fill('[name="title"]', '수정된 제목');
  await page.setInputFiles('#picker [data-input]', {
    name: '추가자료.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  await page.waitForSelector('#picker .fileitem', { timeout: 5000 });
  await page.locator('#editForm button[type="submit"]').click();
  await page.waitForURL((u) => /#\/s\//.test(u.href) && !u.href.includes('/edit'), { timeout: 15000 });
  if (bucket.keys('uploads/').length !== before + 1) {
    throw new Error(`파일 수: ${bucket.keys('uploads/').length}`);
  }
});

await step('제출물 삭제가 R2 파일까지 정리', async () => {
  await login();
  await page.goto(`${origin}/#/admin/submissions/${projectId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.table tbody tr', { timeout: 10000 });
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-del]').first().click();
  await page.locator('.modal [data-ok]').click();
  await page.waitForTimeout(2500);
  if (bucket.keys('uploads/').length !== 0) {
    throw new Error(`파일 잔여: ${bucket.keys('uploads/')}`);
  }
});

log('\n== 5. 강의자료 + 다운로드 잠금 ==');

await step('관리자가 PDF 강의자료 등록', async () => {
  await page.goto(`${origin}/#/admin/material/new`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#matForm', { timeout: 8000 });
  await page.fill('#matForm [name="title"]', '1강 · AI 리더십 개론');
  await page.fill('#matForm [name="session"]', '1주차');
  await page.setInputFiles('#matPicker [data-input]', {
    name: '1강 자료.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n강의자료\n'),
  });
  await page.waitForSelector('#matPicker .fileitem', { timeout: 5000 });
  await page.locator('#matForm button[type="submit"]').click();
  await page.waitForURL(/#\/materials/, { timeout: 15000 });
});

await step('잠금이 켜져 있으면 관리자에게도 비밀번호를 물음', async () => {
  await page.waitForSelector('#gateForm', { timeout: 8000 });
});

let materialKey;
await step('토큰 없이 파일 주소를 직접 열면 403', async () => {
  materialKey = bucket.keys('uploads/materials/')[0];
  if (!materialKey) throw new Error('강의자료 파일이 없음');
  const res = await page.request.get(`${origin}/api/file/${encodeURI(materialKey)}`);
  if (res.status() !== 403) throw new Error(`status ${res.status()}`);
});

await step('틀린 비밀번호 거부', async () => {
  await page.fill('#gateForm [name="password"]', 'wrong');
  await page.locator('#gateForm button[type="submit"]').click();
  await page.waitForSelector('.field__err', { timeout: 8000 });
});

await step('AI2026 입력 후 목록 표시 + 링크에 토큰 부착', async () => {
  await page.fill('#gateForm [name="password"]', 'AI2026');
  await page.locator('#gateForm button[type="submit"]').click();
  await page.waitForSelector('.fileitem', { timeout: 10000 });
  const href = await page.locator('.fileitem a.btn--primary').first().getAttribute('href');
  if (!href.includes('?t=') && !href.includes('&t=')) throw new Error(`토큰 없음: ${href}`);
});

await step('그 링크로 실제 파일이 200 으로 내려옴', async () => {
  const href = await page.locator('.fileitem a.btn--primary').first().getAttribute('href');
  const res = await page.request.get(origin + href);
  if (res.status() !== 200) throw new Error(`status ${res.status()}`);
  const cd = res.headers()['content-disposition'] || '';
  if (!cd.startsWith('attachment')) throw new Error(cd);
  if (!cd.includes(encodeURIComponent('1강 자료.pdf'))) throw new Error(cd);
});

await step('열람 종료 후 다시 잠김', async () => {
  await page.locator('[data-lock]').click();
  await page.waitForSelector('#gateForm', { timeout: 8000 });
});

log('\n== 6. 콘솔 오류 ==');
await step('실행 중 자바스크립트 오류 없음', () => {
  if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '));
});

await browser.close();
server.close();

log('\n================ 결과 ================');
log(`버킷 객체 ${bucket.objects.size}개: ${bucket.keys().join(', ')}`);
if (fails.length) { log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
log('모든 검사 통과');
