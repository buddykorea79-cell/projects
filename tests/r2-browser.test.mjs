/**
 * R2 + 회원제 브라우저 종단간 테스트.
 *
 * 메모리 R2 스텁 위에 사이트와 /api 를 같은 오리진으로 띄우고 — 실제 Cloudflare
 * 배포와 같은 구조 — 진짜 크로미움으로 가입부터 제출·다운로드까지 밟아 봅니다.
 */
import { chromium } from 'playwright';
import { chromeOptions } from './chrome.mjs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { startServer, browserGoogleLogin } from './mock-r2.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fails = [];
const log = (...a) => console.log(...a);
const step = async (name, fn) => {
  try { await fn(); log(`  PASS  ${name}`); }
  catch (e) { log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};

const { server, bucket, origin, setNextGoogleUser } = await startServer({ root });
log(`\n로컬 R2 스텁 서버: ${origin}`);

const browser = await chromium.launch(chromeOptions());

const consoleErrors = [];
/** 사람마다 별도 브라우저 컨텍스트 — 세션 쿠키가 섞이지 않습니다. */
async function person(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    const text = m.text();
    const fromFonts = /fonts\.(googleapis|gstatic)/.test(m.location()?.url || '');
    const expectedHttp = /Failed to load resource.*(401|403|409|410|Unauthorized|Forbidden|Conflict)/.test(text);
    if (m.type() === 'error' && !fromFonts && !expectedHttp) {
      consoleErrors.push(`[${label}] ${text}`);
    }
  });
  return page;
}

async function signup(page, { email, name, institution }) {
  await browserGoogleLogin(page, {
    origin, setNextGoogleUser, email, name, institution,
  });
}

const admin = await person('관리자');
const alice = await person('앨리스');
const bob = await person('밥');

log('\n== 1. 로그인 벽 ==');

await step('비회원도 홈은 보이되 과제 목록만 가려짐', async () => {
  await admin.goto(origin, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.hero__title', { timeout: 10000 });
  await admin.waitForSelector('#projectGrid .empty h3', { timeout: 10000 });
  const title = await admin.locator('#projectGrid .empty h3').innerText();
  if (!title.includes('로그인')) throw new Error(title);
  if (await admin.locator('.tile').count()) throw new Error('과제 목록이 노출됨');
  if (!(await admin.locator('#projectGrid a[href="#/login"]').count())) {
    throw new Error('로그인 버튼이 없음');
  }
});

await step('비회원은 강의자료·내 제출물도 막힘', async () => {
  for (const path of ['#/materials', '#/my']) {
    await admin.goto(`${origin}/${path}`, { waitUntil: 'networkidle' });
    await admin.waitForSelector('.empty h3', { timeout: 8000 });
  }
});

await step('비로그인 상태에서는 회원 전용 메뉴가 숨겨짐', async () => {
  const visible = await admin.locator('.gnav__links a:visible').allInnerTexts();
  if (visible.some((t) => t.includes('내 제출물'))) throw new Error(visible.join(','));
  if (!visible.some((t) => t.includes('이용안내'))) throw new Error('이용안내는 보여야 함');
});

log('\n== 2. Google 로그인 및 최초 프로필 등록 ==');

await step('관리자 Google 이메일로 로그인하면 관리자 권한 + 프로필 설정 완료', async () => {
  await signup(admin, { email: 'aireader@mois.go.kr', name: '관리자', institution: '행정안전부' });
  await admin.waitForSelector('.gnav__actions a[href="#/admin"]', { timeout: 8000 });
});

await step('회원 명부가 R2 에 저장되고 비밀번호 없이 Google sub 만 보관됨', () => {
  const raw = new TextDecoder().decode(bucket.objects.get('data/members.json').bytes);
  if (!raw.includes('aireader@mois.go.kr')) throw new Error('명부에 없음');
  if (!raw.includes('"googleSub"')) throw new Error('googleSub 없음');
  if (raw.includes('passwordHash')) throw new Error('비밀번호 해시가 저장됨');
});

await step('예전 #/signup · #/forgot 경로는 Google 로그인 화면으로 리다이렉트', async () => {
  const other = await person('중복');
  await other.goto(`${origin}/#/signup`, { waitUntil: 'networkidle' });
  await other.waitForSelector('#googleLoginBtn', { timeout: 8000 });
  await other.goto(`${origin}/#/forgot`, { waitUntil: 'networkidle' });
  await other.waitForSelector('#googleLoginBtn', { timeout: 8000 });
  await other.context().close();
});

let projectId;
await step('관리자가 프로젝트 개설', async () => {
  await admin.goto(`${origin}/#/admin/project/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#projForm', { timeout: 8000 });
  await admin.fill('#projForm [name="title"]', '1주차 · 브랜드 분석');
  await admin.fill('#projForm [name="description"]', '분석 결과를 제출하세요.');
  await admin.locator('#projForm button[type="submit"]').click();
  await admin.waitForURL(/#\/p\//, { timeout: 12000 });
  projectId = admin.url().split('#/p/')[1];
});

log('\n== 3. 회원 제출 ==');

await step('교육생 가입 후 바로 이용', async () => {
  await signup(alice, { email: 'alice@example.com', name: '앨리스', institution: '한국디자인진흥원' });
  await alice.waitForSelector('.tile', { timeout: 10000 });
});

await step('제출 폼에 제출자 정보가 자동으로 채워짐', async () => {
  await alice.goto(`${origin}/#/p/${projectId}/submit`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#submitForm', { timeout: 8000 });
  const info = await alice.locator('.card--flat').innerText();
  if (!info.includes('앨리스') || !info.includes('alice@example.com')) throw new Error(info);
  // 이름·이메일을 다시 입력받는 칸이 없어야 합니다.
  if (await alice.locator('#submitForm [name="email"]').count()) throw new Error('이메일 입력칸이 남아 있음');
});

await step('첨부와 함께 제출 — 수정코드 없이 바로 상세로', async () => {
  await alice.fill('[name="title"]', '스타벅스 디자인 시스템 분석');
  await alice.fill('[name="body"]', '4단계 그린 체계를 정리했습니다.');
  await alice.setInputFiles('[data-input]', {
    name: '시안 최종.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'),
  });
  await alice.waitForSelector('.fileitem', { timeout: 5000 });
  await alice.check('[name="agree"]');
  await alice.locator('#submitForm button[type="submit"]').click();
  await alice.waitForURL(/#\/s\//, { timeout: 15000 });
});

await step('작성자가 로그인 계정으로 기록됨', () => {
  const raw = new TextDecoder().decode(bucket.objects.get('data/submissions.json').bytes);
  const list = JSON.parse(raw);
  if (list.length !== 1) throw new Error(`제출물 ${list.length}건`);
  if (list[0].author.email !== 'alice@example.com') throw new Error(list[0].author.email);
  if (list[0].author.name !== '앨리스') throw new Error(list[0].author.name);
});

await step('업로드가 회원 전용 폴더로 들어감', () => {
  const keys = bucket.keys('uploads/');
  if (keys.length !== 1) throw new Error(`${keys.length}개: ${keys}`);
  if (!/^uploads\/m_[0-9a-f]{16}\//.test(keys[0])) throw new Error(keys[0]);
  if (!keys[0].includes('시안_최종.png')) throw new Error(keys[0]);
});

await step('첨부 이미지가 실제로 렌더됨', async () => {
  await alice.waitForSelector('.media-card img', { timeout: 10000 });
  const ok = await alice.locator('.media-card img').first().evaluate(
    (img) => img.complete && img.naturalWidth > 0);
  if (!ok) throw new Error('이미지가 로드되지 않음');
});

await step('내 제출물 목록에 로그인만으로 보임', async () => {
  await alice.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.table tbody tr', { timeout: 10000 });
  // 예전의 이메일+코드 입력 폼이 없어야 합니다.
  if (await alice.locator('#unlockForm').count()) throw new Error('수정코드 폼이 남아 있음');
});

log('\n== 4. 남의 제출물 ==');

await step('다른 회원은 비공개 프로젝트의 제출물을 못 봄', async () => {
  await signup(bob, { email: 'bob@example.com', name: '밥', institution: '한국정보화진흥원' });
  const subId = JSON.parse(new TextDecoder().decode(
    bucket.objects.get('data/submissions.json').bytes))[0].id;
  await bob.goto(`${origin}/#/s/${subId}`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.empty h3', { timeout: 8000 });
});

await step('다른 회원은 남의 제출물을 수정할 수 없음', async () => {
  const subId = JSON.parse(new TextDecoder().decode(
    bucket.objects.get('data/submissions.json').bytes))[0].id;
  const res = await bob.request.patch(`${origin}/api/submissions/${subId}`, {
    data: { title: '가로채기' },
  });
  if (res.status() !== 403) throw new Error(`status ${res.status()}`);
});

await step('내 제출물 목록에 남의 것이 섞이지 않음', async () => {
  await bob.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.empty h3, .table tbody tr', { timeout: 10000 });
  const empty = await bob.locator('.empty h3').count();
  if (!empty) throw new Error('밥에게 제출물이 보임');
});

log('\n== 5. 수정 · 삭제 ==');

await step('본인은 첨부를 추가해 수정할 수 있음', async () => {
  const before = bucket.keys('uploads/').length;
  await alice.goto(`${origin}/#/my`, { waitUntil: 'networkidle' });
  await alice.locator('a[href*="/edit"]').first().click();
  await alice.waitForSelector('#editForm', { timeout: 8000 });
  await alice.fill('#editForm [name="title"]', '수정된 제목');
  await alice.setInputFiles('#picker [data-input]', {
    name: '추가자료.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  await alice.waitForSelector('#picker .fileitem', { timeout: 5000 });
  await alice.locator('#editForm button[type="submit"]').click();
  await alice.waitForURL((u) => /#\/s\//.test(u.href) && !u.href.includes('/edit'), { timeout: 15000 });
  if (bucket.keys('uploads/').length !== before + 1) {
    throw new Error(`파일 ${bucket.keys('uploads/').length}개`);
  }
});

await step('관리자가 삭제하면 첨부까지 정리됨', async () => {
  await admin.goto(`${origin}/#/admin/submissions/${projectId}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 10000 });
  await admin.locator('[data-del]').first().click();
  await admin.locator('.modal [data-ok]').click();
  await admin.waitForTimeout(2500);
  if (bucket.keys('uploads/').length !== 0) {
    throw new Error(`파일 잔여: ${bucket.keys('uploads/')}`);
  }
});

log('\n== 6. 강의자료 ==');

await step('관리자가 강의자료 등록', async () => {
  await admin.goto(`${origin}/#/admin/material/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#matForm', { timeout: 8000 });
  await admin.fill('#matForm [name="title"]', '1강 · AI 리더십 개론');
  await admin.fill('#matForm [name="session"]', '1주차');
  await admin.setInputFiles('#matPicker [data-input]', {
    name: '1강 자료.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n강의자료\n'),
  });
  await admin.waitForSelector('#matPicker .fileitem', { timeout: 5000 });
  await admin.locator('#matForm button[type="submit"]').click();
  await admin.waitForURL(/#\/materials/, { timeout: 15000 });
});

let materialHref;
await step('회원은 비밀번호 없이 목록을 보고 내려받음', async () => {
  await alice.goto(`${origin}/#/materials`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.fileitem', { timeout: 10000 });
  if (await alice.locator('#gateForm').count()) throw new Error('비밀번호 화면이 남아 있음');
  materialHref = await alice.locator('.fileitem a.btn--primary').first().getAttribute('href');
  const res = await alice.request.get(origin + materialHref);
  if (res.status() !== 200) throw new Error(`status ${res.status()}`);
});

await step('로그인하지 않으면 그 주소로도 못 받음', async () => {
  const stranger = await browser.newContext();
  const res = await stranger.request.get(origin + materialHref);
  if (res.status() !== 401) throw new Error(`status ${res.status()}`);
  await stranger.close();
});

log('\n== 6-2. 소통방 ==');

await step('회원이 글을 남기면 서버에 저장됨', async () => {
  await alice.goto(`${origin}/#/board/new`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#postForm', { timeout: 8000 });
  await alice.fill('#postForm [name="title"]', '스터디 같이 하실 분');
  await alice.fill('#postForm [name="body"]', '주 1회 온라인으로 모이려 합니다.');
  await alice.locator('#postForm button[type="submit"]').click();
  await alice.waitForURL(/#\/board\/b_[a-z0-9]+$/, { timeout: 15000 });

  const raw = new TextDecoder().decode(bucket.objects.get('data/posts.json').bytes);
  if (!raw.includes('스터디 같이 하실 분')) throw new Error('R2 에 저장되지 않음');
  if (!raw.includes('alice@example.com')) throw new Error('글쓴이가 서버에서 안 채워짐');
});

await step('다른 회원이 댓글을 달면 글쓴이에게도 보임', async () => {
  await bob.goto(`${origin}/#/board`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.post', { timeout: 10000 });
  await bob.locator('.post').first().click();
  await bob.waitForSelector('#commentForm', { timeout: 8000 });
  await bob.fill('#commentForm [name="body"]', '저도 참여하고 싶습니다.');
  await bob.locator('#commentForm button[type="submit"]').click();
  await bob.waitForSelector('.comment', { timeout: 10000 });

  await alice.reload({ waitUntil: 'networkidle' });
  await alice.waitForSelector('.comment', { timeout: 10000 });
  const text = await alice.locator('.comment__body').first().innerText();
  if (!text.includes('저도 참여하고')) throw new Error(text);
});

await step('남의 글에는 수정·삭제·공지 버튼이 없음', async () => {
  if (await bob.locator('[data-del]').count()) throw new Error('삭제 버튼이 보임');
  if (await bob.locator('[data-pin]').count()) throw new Error('공지 버튼이 보임');
});

await step('관리자가 공지로 지정하면 맨 위로', async () => {
  await admin.goto(`${origin}/#/board/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#postForm', { timeout: 8000 });
  await admin.fill('#postForm [name="title"]', '더 최근 글');
  await admin.fill('#postForm [name="body"]', '공지보다 나중에 쓴 글입니다.');
  await admin.locator('#postForm button[type="submit"]').click();
  await admin.waitForURL(/#\/board\/b_[a-z0-9]+$/, { timeout: 15000 });

  await admin.goto(`${origin}/#/board`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.post', { timeout: 10000 });
  await admin.locator('.post', { hasText: '스터디 같이' }).click();
  await admin.waitForSelector('[data-pin]', { timeout: 8000 });
  await admin.locator('[data-pin]').click();
  await admin.waitForTimeout(1500);

  await bob.goto(`${origin}/#/board`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.post', { timeout: 10000 });
  const first = await bob.locator('.post').first().innerText();
  if (!first.includes('스터디 같이')) throw new Error(first.split('\n')[0]);
  if (!(await bob.locator('.post--pinned').count())) throw new Error('공지 표시 없음');
});

log('\n== 6-3. 상호 투표 ==');

let voteProjectId;

await step('관리자가 투표를 켠 프로젝트를 개설', async () => {
  await admin.goto(`${origin}/#/admin/project/new`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#projForm', { timeout: 8000 });
  await admin.fill('#projForm [name="title"]', '2주차 · 랜딩 페이지 시안');
  await admin.fill('#projForm [name="description"]', '시안을 올리고 서로 투표합니다.');
  await admin.check('#projForm [name="voteEnabled"]');
  await admin.fill('#projForm [name="votePerMember"]', '1');
  await admin.locator('#projForm button[type="submit"]').click();
  await admin.waitForURL(/#\/p\//, { timeout: 12000 });
  voteProjectId = admin.url().split('#/p/')[1];

  const saved = JSON.parse(new TextDecoder().decode(bucket.objects.get('data/projects.json').bytes))
    .find((p) => p.id === voteProjectId);
  if (!saved?.voting?.enabled) throw new Error('투표 설정이 저장되지 않음');
  if (saved.voting.perMember !== 1) throw new Error(`1인당 표 ${saved.voting.perMember}`);
});

// 상호 투표는 상단 메뉴에서 내려갔습니다(그 자리에 Build Camp 가 들어갔습니다).
// 이제 프로젝트 상세의 '투표하기' 로 들어갑니다 — camp-browser.test.mjs 가 메뉴를 봅니다.
await step('프로젝트 상세의 투표하기 버튼으로 투표 화면이 열림', async () => {
  await alice.goto(`${origin}/#/p/${voteProjectId}`, { waitUntil: 'networkidle' });
  const link = alice.locator(`.band a[href="#/vote/${voteProjectId}"]`);
  await link.first().waitFor({ timeout: 10000 });
  if ((await link.first().innerText()).trim() !== '투표하기') {
    throw new Error(await link.first().innerText());
  }
  await link.first().click();
  await alice.waitForSelector('#voteBoard', { timeout: 10000 });
  if (!(await alice.locator('#main').innerText()).includes('2주차')) {
    throw new Error(await alice.locator('#main').innerText());
  }
});

await step('과제 투표 목록 주소도 그대로 열림', async () => {
  await alice.goto(`${origin}/#/vote`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#voteList .tile', { timeout: 10000 });
  const text = await alice.locator('#voteList').innerText();
  if (!text.includes('2주차')) throw new Error(text);
  if (!text.includes('투표중')) throw new Error(text);
});

await step('세 사람이 시안을 제출', async () => {
  for (const [page, title] of [[alice, '앨리스 시안'], [bob, '밥 시안'], [admin, '관리자 시안']]) {
    await page.goto(`${origin}/#/p/${voteProjectId}/submit`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#submitForm', { timeout: 8000 });
    await page.fill('#submitForm [name="title"]', title);
    await page.fill('#submitForm [name="body"]', '설명입니다.');
    await page.check('#submitForm [name="agree"]');
    await page.locator('#submitForm button[type="submit"]').click();
    await page.waitForURL(/#\/s\//, { timeout: 15000 });
  }
});

await step('투표를 받는 프로젝트는 비공개여도 서로의 시안이 보임', async () => {
  await alice.goto(`${origin}/#/vote/${voteProjectId}`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.votecard', { timeout: 10000 });
  const count = await alice.locator('.votecard').count();
  if (count !== 3) throw new Error(`카드 ${count}장`);
  const text = await alice.locator('#voteBoard').innerText();
  if (!text.includes('밥 시안')) throw new Error('남의 시안이 안 보임');
});

await step('본인 시안에는 투표 버튼이 없음', async () => {
  const own = alice.locator('.votecard', { hasText: '앨리스 시안' });
  if (await own.locator('[data-vote]').count()) throw new Error('본인 카드에 투표 버튼이 있음');
});

await step('표를 넣으면 득표가 오르고 R2 에 남음', async () => {
  await alice.locator('.votecard', { hasText: '밥 시안' })
    .locator('[data-vote][data-on="1"]').click();
  await alice.waitForSelector('.votecard--picked', { timeout: 10000 });

  const card = await alice.locator('.votecard', { hasText: '밥 시안' }).innerText();
  if (!card.includes('1표')) throw new Error(card);

  const raw = new TextDecoder().decode(bucket.objects.get('data/votes.json').bytes);
  if (!raw.includes('alice@example.com')) throw new Error('R2 에 표가 남지 않음');
});

await step('남은 표를 다 쓰면 다른 카드의 버튼이 잠김', async () => {
  const btn = alice.locator('.votecard', { hasText: '관리자 시안' })
    .locator('[data-vote][data-on="1"]');
  if (!(await btn.count())) throw new Error('투표 버튼이 없음');
  if (!(await btn.isDisabled())) throw new Error('표가 없는데 버튼이 열려 있음');
});

await step('투표를 취소하면 표가 되돌아옴', async () => {
  await alice.locator('.votecard', { hasText: '밥 시안' })
    .locator('[data-vote][data-on="0"]').click();
  await alice.waitForFunction(() => !document.querySelector('.votecard--picked'), null,
    { timeout: 10000 });
  const btn = alice.locator('.votecard', { hasText: '관리자 시안' })
    .locator('[data-vote][data-on="1"]');
  if (await btn.isDisabled()) throw new Error('표를 뺐는데 버튼이 잠겨 있음');

  // 결과 확인을 위해 다시 한 표 넣어 둡니다.
  await alice.locator('.votecard', { hasText: '밥 시안' })
    .locator('[data-vote][data-on="1"]').click();
  await alice.waitForSelector('.votecard--picked', { timeout: 10000 });
});

await step('다른 회원의 표는 브라우저로 내려오지 않음', async () => {
  const res = await bob.request.get(`${origin}/api/votes?projectId=${voteProjectId}`);
  const body = await res.json();
  if (JSON.stringify(body).includes('alice@example.com')) throw new Error('투표자 이메일이 새어 나감');
  if (body.summary.used !== 0) throw new Error(`밥이 쓴 표 ${body.summary.used}`);
});

await step('관리자 제출물 화면에 득표 열이 생김', async () => {
  await admin.goto(`${origin}/#/admin/submissions/${voteProjectId}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('.table tbody tr', { timeout: 10000 });
  const head = await admin.locator('.table thead').innerText();
  if (!head.includes('득표')) throw new Error(head);
});

log('\n== 7. 회원 관리 ==');

await step('관리자만 회원 목록을 볼 수 있음', async () => {
  await alice.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.notice--warn', { timeout: 8000 });

  await admin.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#memberRows .table tbody tr', { timeout: 10000 });
  const text = await admin.locator('#memberRows').innerText();
  for (const who of ['alice@example.com', 'bob@example.com']) {
    if (!text.includes(who)) throw new Error(`${who} 없음`);
  }
});

await step('이용 정지하면 그 회원의 세션이 끊김', async () => {
  const row = admin.locator('tr', { hasText: 'bob@example.com' });
  await row.locator('[data-status]').click();
  await admin.locator('.modal [data-ok]').click();
  await admin.waitForTimeout(1500);

  await bob.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  await bob.waitForSelector('.empty h3', { timeout: 10000 });
  const title = await bob.locator('.empty h3').innerText();
  if (!title.includes('로그인')) throw new Error(title);
});

log('\n== 7-2. 제출 현황 · 회원 삭제 ==');

await step('제출 현황 확인용으로 제출물을 하나 준비', async () => {
  await alice.goto(`${origin}/#/p/${projectId}/submit`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('#submitForm', { timeout: 8000 });
  await alice.fill('[name="title"]', '현황 확인용 시안');
  await alice.fill('[name="body"]', '참고 사이트는 https://example.com 입니다.');
  await alice.setInputFiles('[data-input]', {
    name: '현황시안.png',
    mimeType: 'image/png',
    buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
      + '0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex'),
  });
  await alice.waitForSelector('.fileitem', { timeout: 5000 });
  await alice.check('[name="agree"]');
  await alice.locator('#submitForm button[type="submit"]').click();
  await alice.waitForURL(/#\/s\//, { timeout: 15000 });
});

await step('제출 현황이 제출자와 미제출자를 갈라 보여줌', async () => {
  await admin.goto(`${origin}/#/admin/roster/${projectId}`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#rosterRows .table tbody tr', { timeout: 10000 });

  // 정지 회원 제외가 기본 — 정지된 밥은 대상에서 빠집니다.
  if (await admin.locator('#rosterRows tr', { hasText: 'bob@example.com' }).count()) {
    throw new Error('정지 회원이 기본으로 보임');
  }
  const aliceRow = admin.locator('#rosterRows tr', { hasText: 'alice@example.com' });
  if (!(await aliceRow.locator('.badge--open').count())) throw new Error('제출 표시 없음');

  // 체크를 풀면 정지 회원도 대상에 들어가고 미제출로 잡힙니다.
  await admin.uncheck('#noBlocked');
  const bobRow = admin.locator('#rosterRows tr', { hasText: 'bob@example.com' });
  if (!(await bobRow.locator('.badge--due').count())) throw new Error('미제출 표시 없음');
});

await step('미제출자만 걸러서 볼 수 있음', async () => {
  await admin.selectOption('#filter', 'missing');
  const text = await admin.locator('#rosterRows').innerText();
  if (text.includes('alice@example.com')) throw new Error('제출자가 남아 있음');
  if (!text.includes('bob@example.com')) throw new Error('미제출자가 없음');
});

await step('삭제 버튼은 정지된 회원에게만 보임', async () => {
  await admin.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#memberRows .table tbody tr', { timeout: 10000 });

  const aliceRow = admin.locator('#memberRows tr', { hasText: 'alice@example.com' });
  if (await aliceRow.locator('[data-remove]').count()) throw new Error('이용중 회원에 삭제 버튼');
  const bobRow = admin.locator('#memberRows tr', { hasText: 'bob@example.com' });
  if (!(await bobRow.locator('[data-remove]').count())) throw new Error('정지 회원에 삭제 버튼 없음');
});

await step('정지된 회원을 삭제하면 명부에서 사라짐', async () => {
  const bobRow = admin.locator('#memberRows tr', { hasText: 'bob@example.com' });
  await bobRow.locator('[data-remove]').click();
  await admin.fill('.modal [data-require]', '삭제');
  await admin.locator('.modal [data-ok]').click();

  // 밥은 투표 과제에 시안을 냈으므로 "제출물도 함께 지울까요?" 를 한 번 더 묻습니다.
  // 여기서는 기록으로 남기는 쪽(취소)을 고릅니다.
  await admin.waitForSelector('.modal [data-cancel]', { timeout: 8000 });
  await admin.locator('.modal [data-cancel]').click();
  await admin.waitForTimeout(2500);

  const members = JSON.parse(new TextDecoder().decode(bucket.objects.get('data/members.json').bytes));
  if (members.some((m) => m.email === 'bob@example.com')) throw new Error('명부에 남아 있음');
  if (await admin.locator('#memberRows tr', { hasText: 'bob@example.com' }).count()) {
    throw new Error('표에 남아 있음');
  }
});

await step('대시보드 회원 수는 이용중 인원만 셈', async () => {
  await admin.goto(`${origin}/#/admin`, { waitUntil: 'networkidle' });
  await admin.waitForSelector('#stats .stat', { timeout: 10000 });
  // 관리자 + 앨리스 = 2명 (밥은 삭제됨)
  const stats = (await admin.locator('#stats').innerText()).replace(/\n/g, ' ');
  if (!/2\s*회원/.test(stats)) throw new Error(stats);
});

log('\n== 8. 계정 · 사전 등록 ==');

await step('내 계정 화면에 Google 계정 연동 표시가 보이고 비밀번호 폼은 없음', async () => {
  await alice.goto(`${origin}/#/account`, { waitUntil: 'networkidle' });
  await alice.waitForSelector('.kv', { timeout: 8000 });
  const text = await alice.locator('#main').innerText();
  if (!text.includes('Google 계정 연동')) throw new Error(text);
  if (await alice.locator('#pwForm').count()) throw new Error('비밀번호 폼이 남아 있음');
});

await step('로그아웃하면 다시 Google 로그인 벽', async () => {
  await alice.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  await alice.locator('.gnav__actions [data-logout]').click();
  await alice.waitForSelector('#googleLoginBtn, .empty h3', { timeout: 10000 });
});

await step('관리자가 교육생 이메일을 사전 등록하면 프로필 입력 없이 바로 홈 진입', async () => {
  await admin.goto(`${origin}/#/admin/members`, { waitUntil: 'networkidle' });
  await admin.locator('#toggleInvite').click();
  await admin.fill('#inviteCard [name="lines"]', 'charlie@example.com, 찰리, 한국서부발전');
  await admin.locator('#inviteCard button[type="submit"]').click();
  await admin.waitForSelector('.toast--ok', { timeout: 10000 });

  const charlie = await person('찰리');
  await browserGoogleLogin(charlie, {
    origin, setNextGoogleUser,
    email: 'charlie@example.com', name: 'Charlie Google',
    completeProfile: false,
  });
  await charlie.waitForURL((u) => u.hash === '#/' || u.hash === '', { timeout: 12000 });
  const header = await charlie.locator('#gnavActions').innerText();
  if (!header.includes('찰리님')) throw new Error(`사전 등록 성명 미반영: ${header}`);
  await charlie.context().close();
});

log('\n== 9. 콘솔 오류 ==');
await step('실행 중 자바스크립트 오류 없음', () => {
  if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '));
});

await browser.close();
server.close();

log('\n================ 결과 ================');
log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
log('모든 검사 통과');
