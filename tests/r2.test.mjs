/**
 * R2 저장소 테스트 — 동시성 · 업로드 검증 · 파일 응답 · CORS.
 *
 * 권한과 인증 규칙은 auth.test.mjs 가 맡고, 여기서는 그 위에서 저장소가
 * 제대로 동작하는지 봅니다. 메모리 R2 스텁 위에서 실제 shared/r2api.js 와
 * 실제 assets/js/store/r2.js 를 함께 돌립니다.
 */
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import { R2Store } from '../assets/js/store/r2.js';

const ORIGIN = 'https://site.test';
const ADMIN = 'aireader@mois.go.kr';
const PASSWORD = 'hunter2!hunter2';

const fails = [];
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

const bucket = new MockBucket();
const env = { BUCKET: bucket, PBKDF2_ITERATIONS: 1000 };

/* 브라우저처럼 쿠키를 들고 다니는 fetch 로 바꿔 끼웁니다. */
let cookie = '';
globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = raw.startsWith('http') ? raw : `${ORIGIN}${raw}`;
  const headers = { Origin: ORIGIN, ...(init.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await handleApi(new Request(url, { ...init, headers }), env, { basePath: '/api' });
  const set = res.headers.get('Set-Cookie');
  if (set) {
    const pair = set.split(';')[0];
    cookie = pair.endsWith('=') ? '' : pair;
  }
  return res;
};
globalThis.window = { dispatchEvent() {} };

const api = (path, init = {}) => handleApi(
  new Request(`${ORIGIN}/api${path}`, {
    ...init,
    headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
  }), env, { basePath: '/api' },
);

const store = new R2Store({ apiBase: '/api' });

console.log('\n== 준비 ==');

await t('관리자로 가입하고 저장소 초기화', async () => {
  await store.init();
  await store.auth.signup({
    email: ADMIN, password: PASSWORD, name: '관리자', institution: '행정안전부',
  });
  eq(store.auth.isAdmin(), true, 'admin');
  await store.init();
  eq(store.maxUploadMB, 100, '업로드 한도');
});

let project;
await t('프로젝트 생성 · 한글 보존', async () => {
  project = await store.saveProject({ title: '1주차 · 브랜드 분석', status: 'open', visibility: 'private' });
  const list = await store.listProjects();
  eq(list.length, 1, '개수');
  eq(list[0].title, '1주차 · 브랜드 분석', '제목');
  const raw = new TextDecoder().decode(bucket.objects.get('data/projects.json').bytes);
  if (!raw.includes('1주차 · 브랜드 분석')) throw new Error('한글 깨짐');
});

console.log('\n== 동시성 ==');

await t('etag 없이 색인을 쓰면 거부 (428)', async () => {
  const res = await api('/data/projects', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [] }),
  });
  eq(res.status, 428, 'status');
});

await t('낡은 etag 로 쓰면 409 + 최신본 반환', async () => {
  const before = await store.readIndex('projects');
  await store.saveProject({ title: '2주차 · 프로토타입', status: 'open' });
  const res = await api('/data/projects', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: before.etag, data: [] }),
  });
  eq(res.status, 409, 'status');
  const body = await res.json();
  eq(body.current.data.length, 2, '최신본 항목 수');
  if (!body.current.etag) throw new Error('최신 etag 없음');
});

await t('동시 저장이 서로를 덮어쓰지 않음', async () => {
  const base = (await store.listProjects()).length;
  await Promise.all([
    store.saveProject({ title: '동시 A', status: 'open' }),
    store.saveProject({ title: '동시 B', status: 'open' }),
    store.saveProject({ title: '동시 C', status: 'open' }),
  ]);
  const after = await store.listProjects();
  eq(after.length, base + 3, '세 건 모두 반영');
  for (const title of ['동시 A', '동시 B', '동시 C']) {
    if (!after.some((p) => p.title === title)) throw new Error(`${title} 누락`);
  }
});

await t('동시 제출도 서로를 덮어쓰지 않음', async () => {
  const before = (await store.listSubmissions()).length;
  await Promise.all([1, 2, 3].map((n) => store.saveSubmission({
    projectId: project.id, title: `동시 제출 ${n}`, body: '내용', files: [],
  })));
  const after = await store.listSubmissions();
  eq(after.length, before + 3, '세 건 모두 반영');
});

console.log('\n== 업로드 검증 ==');

let fileRec;
await t('업로드하면 서버가 키를 정해 줌', async () => {
  const png = new File([new Uint8Array([137, 80, 78, 71])], '시안 v2.png', { type: 'image/png' });
  fileRec = await store.uploadFile(png);
  if (!/^uploads\/m_[0-9a-f]{16}\//.test(fileRec.key)) throw new Error(fileRec.key);
  if (fileRec.key.includes(' ')) throw new Error(`키에 공백: ${fileRec.key}`);
  if (!fileRec.key.includes('시안_v2.png')) throw new Error(fileRec.key);
  eq(fileRec.name, '시안 v2.png', '표시용 이름은 원본 유지');
});

await t('업로드된 바이트가 그대로 보존', () => {
  const bytes = bucket.objects.get(fileRec.key).bytes;
  eq(Buffer.from(bytes).toString('hex').slice(0, 8), '89504e47', 'PNG 시그니처');
});

await t('허용되지 않는 확장자 거부', async () => {
  const res = await api('/upload?name=evil.exe', { method: 'POST', body: new Uint8Array([1]) });
  eq(res.status, 415, 'status');
});

await t('빈 파일 거부', async () => {
  const res = await api('/upload?name=a.pdf', { method: 'POST', body: new Uint8Array([]) });
  eq(res.status, 400, 'status');
});

await t('용량 초과 거부', async () => {
  const res = await handleApi(
    new Request(`${ORIGIN}/api/upload?name=big.pdf`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: cookie },
      body: new Uint8Array(2 * 1024 * 1024),
    }), { ...env, MAX_UPLOAD_MB: 1 }, { basePath: '/api' });
  eq(res.status, 413, 'status');
});

await t('잘못된 자료 번호로는 강의자료를 못 올림', async () => {
  for (const bad of ['../data', 'abc', 'm_', '']) {
    const res = await api(`/upload?kind=material&materialId=${encodeURIComponent(bad)}&name=a.pdf`, {
      method: 'POST', body: new Uint8Array([1]),
    });
    eq(res.status, 400, `허용돼버림: "${bad}"`);
  }
});

console.log('\n== 파일 응답 ==');

await t('이미지·PDF 는 inline, 원본 파일명 유지', async () => {
  const pdf = await store.uploadFile(
    new File([new Uint8Array([37, 80, 68, 70])], '리포트.pdf', { type: 'application/pdf' }));
  const res = await api(`/file/${encodeURI(pdf.key)}`);
  eq(res.status, 200, 'status');
  eq(res.headers.get('Content-Type'), 'application/pdf', 'type');
  const cd = res.headers.get('Content-Disposition');
  if (!cd.startsWith('inline')) throw new Error(cd);
  if (!cd.includes(encodeURIComponent('리포트.pdf'))) throw new Error(cd);

  const forced = await api(`/file/${encodeURI(pdf.key)}?download=1`);
  if (!forced.headers.get('Content-Disposition').startsWith('attachment')) {
    throw new Error('download=1 인데 inline');
  }
});

await t('업로드 파일에 스크립트 차단 헤더가 붙음', async () => {
  const res = await api(`/file/${encodeURI(fileRec.key)}`);
  eq(res.headers.get('X-Content-Type-Options'), 'nosniff', 'nosniff');
  eq(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox", 'CSP');
  if (!(res.headers.get('Cache-Control') || '').includes('private')) throw new Error('private 아님');
});

await t('SVG 는 인라인으로 열리지 않고 첨부로 내려감', async () => {
  const svg = new File(
    [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    'evil.svg', { type: 'image/svg+xml' },
  );
  const rec = await store.uploadFile(svg);
  const res = await api(`/file/${encodeURI(rec.key)}`);
  if (!res.headers.get('Content-Disposition').startsWith('attachment')) {
    throw new Error('SVG 가 인라인으로 열림 — XSS 위험');
  }
});

await t('uploads/ 밖의 키는 읽기·삭제 불가', async () => {
  for (const key of ['data/projects.json', '../secret', 'data/members.json']) {
    eq((await api(`/file/${encodeURIComponent(key)}`)).status, 400, `읽기 허용됨: ${key}`);
    eq((await api(`/file/${encodeURIComponent(key)}`, { method: 'DELETE' })).status, 400, `삭제 허용됨: ${key}`);
  }
  if (!bucket.objects.has('data/projects.json')) throw new Error('색인이 지워짐');
});

console.log('\n== 삭제 연쇄 ==');

await t('제출물 삭제가 첨부까지 정리', async () => {
  const rec = await store.uploadFile(
    new File([new Uint8Array([1, 2])], 'chain.png', { type: 'image/png' }));
  const sub = await store.saveSubmission({
    projectId: project.id, title: '연쇄 삭제', body: '내용', files: [rec],
  });
  if (!bucket.objects.has(rec.key)) throw new Error('사전 조건 실패');
  await store.deleteSubmission(sub.id);
  if (bucket.objects.has(rec.key)) throw new Error('첨부가 남음');
});

await t('프로젝트 삭제가 하위 제출물까지 정리', async () => {
  const p = await store.saveProject({ title: '삭제될 프로젝트', status: 'open' });
  await store.saveSubmission({ projectId: p.id, title: 'x', body: 'y', files: [] });
  eq((await store.listSubmissions({ projectId: p.id })).length, 1, '사전 조건');
  await store.deleteProject(p.id);
  eq((await store.listSubmissions({ projectId: p.id })).length, 0, '제출물');
  eq((await store.listProjects()).some((x) => x.id === p.id), false, '프로젝트');
});

console.log('\n== 강의자료 ==');

await t('강의자료 등록 → uploads/materials/ 아래', async () => {
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], '1강 자료.pdf', { type: 'application/pdf' });
  const m = await store.saveMaterial({ title: '1강 · 개론', session: '1주차', files: [] }, [pdf]);
  eq(m.files.length, 1, '파일 수');
  if (!m.files[0].key.startsWith(`uploads/materials/${m.id}/`)) throw new Error(m.files[0].key);
});

await t('강의자료와 제출물 색인이 분리됨', async () => {
  eq((await store.listMaterials()).length, 1, '강의자료');
  if (!(await store.listSubmissions()).length) throw new Error('제출물이 사라짐');
});

await t('백업 내보내기에 세 종류가 모두 포함', async () => {
  const dump = await store.exportAll();
  for (const k of ['projects', 'submissions', 'materials']) {
    if (!Array.isArray(dump[k])) throw new Error(`${k} 누락`);
  }
});

console.log('\n== CORS ==');

await t('다른 오리진은 차단', async () => {
  const res = await handleApi(
    new Request(`${ORIGIN}/api/data/projects`, { headers: { Origin: 'https://evil.test' } }),
    env, { basePath: '/api' });
  eq(res.status, 403, 'status');
});

await t('ALLOWED_ORIGINS 에 있으면 다른 오리진도 허용', async () => {
  const res = await handleApi(
    new Request(`${ORIGIN}/api/health`, { headers: { Origin: 'https://partner.test' } }),
    { ...env, ALLOWED_ORIGINS: 'https://partner.test' }, { basePath: '/api' });
  eq(res.status, 200, 'status');
  eq(res.headers.get('Access-Control-Allow-Origin'), 'https://partner.test', 'ACAO');
  eq(res.headers.get('Access-Control-Allow-Credentials'), 'true', '쿠키 허용');
});

await t('알 수 없는 색인 이름 거부', async () => {
  eq((await api('/data/secrets')).status, 404, 'status');
});

console.log('\n== Workers 진입점 ==');

{
  const { default: workerEntry } = await import('../shared/worker-entry.js');
  const assetHits = [];
  const wEnv = {
    ...env,
    ASSETS: {
      fetch: async (req) => { assetHits.push(new URL(req.url).pathname); return new Response('asset'); },
    },
  };
  const call = (path, init = {}) => workerEntry.fetch(
    new Request(`${ORIGIN}${path}`, { headers: { Origin: ORIGIN }, ...init }), wEnv);

  await t('/api 는 저장소 핸들러로 감', async () => {
    const res = await call('/api/health');
    eq(res.status, 200, 'status');
    eq((await res.json()).mode, 'r2', 'mode');
    eq(assetHits.length, 0, '정적 자산으로 새지 않음');
  });

  await t('그 밖의 경로는 정적 자산으로 감', async () => {
    eq((await call('/')).status, 200, '루트');
    eq((await call('/assets/js/app.js')).status, 200, '스크립트');
    eq(assetHits.length, 2, '자산 요청 수');
  });

  await t('/apixyz 처럼 비슷한 경로는 API 로 오인하지 않음', async () => {
    await call('/apixyz');
    if (!assetHits.includes('/apixyz')) throw new Error('API 로 잘못 라우팅됨');
  });

  await t('ASSETS 바인딩이 없으면 원인을 알려줌', async () => {
    const res = await workerEntry.fetch(
      new Request(`${ORIGIN}/`, { headers: { Origin: ORIGIN } }), { BUCKET: bucket });
    eq(res.status, 500, 'status');
    if (!(await res.text()).includes('assets')) throw new Error('안내 문구 없음');
  });
}

console.log('\n================ 결과 ================');
console.log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
