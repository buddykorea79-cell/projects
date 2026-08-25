/**
 * GitHubStore ↔ Worker 통합 테스트.
 * 가짜 GitHub API 를 메모리에 두고, 실제 worker.js 와 실제 github.js 를 그 사이에 끼웁니다.
 */
import workerMod from '../worker/worker.js';
import { GitHubStore } from '../assets/js/store/github.js';

const CFG = { owner: 'acme', repo: 'hub', branch: 'main',
  dataDir: 'data', uploadDir: 'uploads', proxyUrl: 'https://proxy.test' };
const ENV = { REPO_OWNER: 'acme', REPO_NAME: 'hub', REPO_BRANCH: 'main',
  ALLOWED_ORIGINS: 'https://site.test', GITHUB_TOKEN: 'ghp_fake' };

/* ---- 가짜 GitHub 저장소 ------------------------------------------------- */
const repo = new Map();          // path -> { content(base64), sha }
let shaSeq = 0;
const commits = [];
let failNextPut = 0;             // 동시 수정 충돌을 흉내낼 횟수

function ghApi(url, init) {
  const u = new URL(url);
  const path = decodeURIComponent(u.pathname.replace('/repos/acme/hub/contents/', ''));
  const method = init?.method || 'GET';

  if (method === 'GET') {
    const f = repo.get(path);
    if (!f) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify({ sha: f.sha, content: f.content }), { status: 200 });
  }

  const body = JSON.parse(init.body);
  const existing = repo.get(path);

  if (method === 'PUT') {
    if (failNextPut > 0) { failNextPut--; return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 }); }
    // GitHub 의 낙관적 동시성: sha 가 현재와 다르면 409
    if (existing && body.sha !== existing.sha) {
      return new Response(JSON.stringify({ message: 'does not match' }), { status: 409 });
    }
    if (!existing && body.sha) {
      return new Response(JSON.stringify({ message: 'sha given but file absent' }), { status: 422 });
    }
    const sha = `sha${++shaSeq}`;
    repo.set(path, { content: body.content, sha });
    commits.push({ op: 'PUT', path, message: body.message, branch: body.branch });
    return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
  }

  if (method === 'DELETE') {
    if (!existing) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (body.sha !== existing.sha) return new Response(JSON.stringify({ message: 'sha mismatch' }), { status: 409 });
    repo.delete(path);
    commits.push({ op: 'DELETE', path, message: body.message });
    return new Response('{}', { status: 200 });
  }
  return new Response('{}', { status: 405 });
}

/* ---- fetch 라우팅 ------------------------------------------------------- */
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;

  if (url.startsWith('https://api.github.com/')) return ghApi(url, init);

  if (url.startsWith('https://raw.githubusercontent.com/')) {
    const path = url.split('/main/')[1].split('?')[0];
    const f = repo.get(decodeURIComponent(path));
    if (!f) return new Response('404: Not Found', { status: 404 });
    return new Response(Buffer.from(f.content, 'base64').toString('utf8'), { status: 200 });
  }

  if (url.startsWith('https://proxy.test')) {
    const req = new Request(url, { ...init, headers: { ...(init?.headers || {}), Origin: 'https://site.test' } });
    return workerMod.fetch(req, ENV);
  }
  throw new Error(`예상치 못한 fetch: ${url}`);
};

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

/* ---- 테스트 ------------------------------------------------------------- */
const store = new GitHubStore(CFG);
const fails = [];
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

console.log('\n== GitHub 모드 (프록시 경유) ==');

await t('빈 레포에서 목록은 빈 배열', async () => {
  eq((await store.listProjects()).length, 0, 'projects');
  eq((await store.listSubmissions()).length, 0, 'submissions');
});

await t('쓰기 가능 · 교육생 제출 가능으로 보고', () => {
  const c = store.capabilities();
  eq(c.canWrite, true, 'canWrite');
  eq(c.canPublicWrite, true, 'canPublicWrite');
  eq(c.needsToken, false, 'needsToken');
});

let project;
await t('프로젝트 생성 → data/projects.json 커밋', async () => {
  project = await store.saveProject({ title: '1주차 · 분석', description: '설명', status: 'open' });
  if (!project.id) throw new Error('id 미발급');
  const list = await store.listProjects();
  eq(list.length, 1, '개수');
  eq(list[0].title, '1주차 · 분석', '제목');
});

await t('한글이 base64 왕복에서 깨지지 않음', async () => {
  const raw = Buffer.from(repo.get('data/projects.json').content, 'base64').toString('utf8');
  if (!raw.includes('1주차 · 분석')) throw new Error('한글 깨짐: ' + raw.slice(0, 120));
});

let sub;
await t('첨부 2개와 함께 제출 → uploads/ 에 파일, 색인에 메타데이터', async () => {
  const png = new File([new Uint8Array([137, 80, 78, 71])], '시안.png', { type: 'image/png' });
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], '리포트 v2.pdf', { type: 'application/pdf' });
  sub = await store.saveSubmission({
    projectId: project.id,
    author: { institution: '한국디자인진흥원', name: '홍길동', email: 'hong@example.com' },
    title: '제출합니다', body: '내용', files: [], editCode: 'ABC123',
  }, [png, pdf]);
  eq(sub.files.length, 2, '첨부 수');
  const paths = sub.files.map((f) => f.path);
  for (const p of paths) if (!repo.has(p)) throw new Error(`레포에 없음: ${p}`);
  // 파일명이 안전하게 정규화되었는지 (공백 -> _)
  if (!paths.some((p) => p.includes('리포트_v2.pdf'))) throw new Error(`정규화 실패: ${paths}`);
});

await t('첨부 바이트가 그대로 보존됨', () => {
  const f = sub.files.find((x) => x.name === '시안.png');
  const bytes = Buffer.from(repo.get(f.path).content, 'base64');
  eq(bytes.toString('hex'), '89504e47', 'PNG 시그니처');
});

await t('fileURL 은 raw 주소를 돌려줌', async () => {
  const url = await store.fileURL(sub.files[0]);
  if (!url.startsWith('https://raw.githubusercontent.com/acme/hub/main/uploads/')) {
    throw new Error(url);
  }
});

await t('이메일로 조회', async () => {
  eq((await store.listSubmissions({ email: 'hong@example.com' })).length, 1, '건수');
  eq((await store.listSubmissions({ email: 'nobody@example.com' })).length, 0, '없는 이메일');
});

await t('제출물 수정이 색인만 갱신하고 첨부는 유지', async () => {
  const before = sub.files.map((f) => f.path);
  const updated = await store.saveSubmission({ ...sub, title: '수정된 제목' });
  eq(updated.title, '수정된 제목', '제목');
  eq((await store.getSubmission(sub.id)).title, '수정된 제목', '재조회');
  for (const p of before) if (!repo.has(p)) throw new Error(`첨부가 사라짐: ${p}`);
});

await t('동시 수정 충돌(409) 발생 시 재시도로 복구', async () => {
  failNextPut = 2;                         // 처음 두 번은 409
  const p2 = await store.saveProject({ title: '2주차 · 프로토타입', status: 'open' });
  eq((await store.listProjects()).length, 2, '재시도 후 개수');
  if (!p2.id) throw new Error('저장 실패');
});

await t('제출물 삭제가 첨부까지 정리', async () => {
  const paths = sub.files.map((f) => f.path);
  await store.deleteSubmission(sub.id);
  eq((await store.listSubmissions()).length, 0, '색인');
  for (const p of paths) if (repo.has(p)) throw new Error(`첨부가 남음: ${p}`);
});

await t('프로젝트 삭제가 하위 제출물까지 정리', async () => {
  await store.saveSubmission({
    projectId: project.id,
    author: { institution: 'A', name: 'B', email: 'b@e.com' },
    title: 'x', body: 'y', files: [], editCode: 'ZZZ999',
  }, [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })]);
  eq((await store.listSubmissions({ projectId: project.id })).length, 1, '사전 조건');
  await store.deleteProject(project.id);
  eq((await store.listSubmissions({ projectId: project.id })).length, 0, '제출물');
  eq((await store.listProjects()).length, 1, '남은 프로젝트');
  if ([...repo.keys()].some((k) => k.startsWith('uploads/'))) {
    throw new Error(`업로드 잔여: ${[...repo.keys()].filter((k) => k.startsWith('uploads/'))}`);
  }
});

console.log('\n== 워커 보안 검사 ==');

const call = (body, origin = 'https://site.test') => workerMod.fetch(
  new Request('https://proxy.test/commit', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), ENV);

await t('허용되지 않은 출처는 403', async () => {
  const r = await call({ op: 'head', path: 'data/projects.json' }, 'https://evil.test');
  eq(r.status, 403, 'status');
});

await t('경로 탈출(..) 차단', async () => {
  const r = await call({ op: 'put', path: 'data/../.github/workflows/pages.yml', content: 'eA==', message: 'x' });
  eq(r.status, 400, 'status');
});

await t('허용 폴더 밖 경로 차단', async () => {
  for (const p of ['assets/js/config.js', '.github/workflows/pages.yml', 'index.html']) {
    const r = await call({ op: 'put', path: p, content: 'eA==', message: 'x' });
    eq(r.status, 400, `차단 실패: ${p}`);
  }
});

await t('지원하지 않는 op 차단', async () => {
  eq((await call({ op: 'nuke', path: 'data/x.json' })).status, 400, 'status');
});

await t('과대 용량 거부', async () => {
  const r = await call({ op: 'put', path: 'uploads/a/b.png', content: 'A'.repeat(40 * 1024 * 1024), message: 'x' });
  eq(r.status, 413, 'status');
});

await t('CORS 프리플라이트 응답', async () => {
  const r = await workerMod.fetch(new Request('https://proxy.test/commit',
    { method: 'OPTIONS', headers: { Origin: 'https://site.test' } }), ENV);
  eq(r.status, 204, 'status');
  eq(r.headers.get('Access-Control-Allow-Origin'), 'https://site.test', 'ACAO');
});

await t('health 엔드포인트', async () => {
  const r = await workerMod.fetch(new Request('https://proxy.test/health',
    { headers: { Origin: 'https://site.test' } }), ENV);
  eq(r.status, 200, 'status');
  eq((await r.json()).repo, 'acme/hub', 'repo');
});

await t('알 수 없는 경로는 404', async () => {
  const r = await workerMod.fetch(new Request('https://proxy.test/anything',
    { method: 'POST', headers: { Origin: 'https://site.test' }, body: '{}' }), ENV);
  eq(r.status, 404, 'status');
});

console.log('\n== 토큰 모드 (프록시 없음) ==');
const direct = new GitHubStore({ ...CFG, proxyUrl: '' });
await t('토큰 없으면 쓰기 불가로 보고', () => {
  const c = direct.capabilities();
  eq(c.canWrite, false, 'canWrite');
  eq(c.canPublicWrite, false, 'canPublicWrite');
  eq(c.needsToken, true, 'needsToken');
});
await t('토큰 없이 쓰기 시도하면 한국어 오류', async () => {
  try { await direct.saveProject({ title: 'x' }); throw new Error('막지 못함'); }
  catch (e) { if (!e.message.includes('쓰기 권한이 없습니다')) throw new Error(e.message); }
});
await t('토큰 없어도 읽기는 가능', async () => {
  eq((await direct.listProjects()).length, 1, '읽기');
});

console.log('\n================ 결과 ================');
console.log(`커밋 ${commits.length}건 생성됨`);
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
