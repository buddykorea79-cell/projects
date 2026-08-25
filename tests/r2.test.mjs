/**
 * R2 저장소 통합 테스트.
 * 메모리 R2 스텁 위에서 **실제** shared/r2api.js 와 **실제** store/r2.js 를 돌립니다.
 * 브라우저 없이 API 계약과 동시성·보안 규칙을 확인합니다.
 */
import { MockBucket } from './mock-r2.mjs';
import { handleApi } from '../shared/r2api.js';
import { R2Store } from '../assets/js/store/r2.js';

const ORIGIN = 'https://site.test';

const fails = [];
const t = async (name, fn) => {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (e) { console.log(`  FAIL  ${name} — ${e.message}`); fails.push(name); }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};

/* --------------------------------------------------------------- 환경 -- */

let bucket = new MockBucket();
let env = { BUCKET: bucket };

/** 브라우저의 fetch 를 가로채 핸들러로 직접 넘깁니다. */
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = raw.startsWith('http') ? raw : `${ORIGIN}${raw}`;
  const request = new Request(url, {
    ...init,
    headers: { Origin: ORIGIN, ...(init?.headers || {}) },
  });
  return handleApi(request, env, { basePath: '/api' });
};
globalThis.sessionStorage = {
  map: new Map(),
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
  setItem(k, v) { this.map.set(k, String(v)); },
  removeItem(k) { this.map.delete(k); },
};

const api = (path, init = {}) => handleApi(
  new Request(`${ORIGIN}${path}`, { headers: { Origin: ORIGIN }, ...init }), env,
  { basePath: '/api' },
);

const store = new R2Store({ apiBase: '/api' });

console.log('\n== 기본 동작 ==');

await t('health 로 초기화', async () => {
  await store.init();
  eq(store.ready, true, 'ready');
  eq(store.materialsGate, false, '기본은 잠금 꺼짐');
  eq(store.maxUploadMB, 100, '업로드 한도');
});

await t('교육생이 토큰 없이 쓸 수 있다고 보고', () => {
  const c = store.capabilities();
  eq(c.canWrite, true, 'canWrite');
  eq(c.canPublicWrite, true, 'canPublicWrite');
  eq(c.needsToken, false, 'needsToken');
});

await t('색인이 없으면 자동으로 만들어짐', async () => {
  eq((await store.listProjects()).length, 0, '프로젝트');
  if (!bucket.objects.has('data/projects.json')) throw new Error('색인이 안 만들어짐');
});

let project;
await t('프로젝트 생성 · 한글 보존', async () => {
  project = await store.saveProject({ title: '1주차 · 브랜드 분석', status: 'open' });
  const list = await store.listProjects();
  eq(list.length, 1, '개수');
  eq(list[0].title, '1주차 · 브랜드 분석', '제목');
  const raw = new TextDecoder().decode(bucket.objects.get('data/projects.json').bytes);
  if (!raw.includes('1주차 · 브랜드 분석')) throw new Error('한글 깨짐');
});

let sub;
await t('첨부와 함께 제출 → uploads/ 에 원본 저장', async () => {
  const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10])], '시안 v2.png', { type: 'image/png' });
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], '리포트.pdf', { type: 'application/pdf' });
  sub = await store.saveSubmission({
    projectId: project.id,
    author: { institution: '한국디자인진흥원', name: '홍길동', email: 'hong@example.com' },
    title: '제출합니다', body: '내용', files: [], editCode: 'ABC123',
  }, [png, pdf]);
  eq(sub.files.length, 2, '첨부 수');
  for (const f of sub.files) {
    eq(f.storage, 'r2', 'storage');
    if (!f.key.startsWith(`uploads/${sub.id}/`)) throw new Error(`키: ${f.key}`);
    if (!bucket.objects.has(f.key)) throw new Error(`버킷에 없음: ${f.key}`);
  }
});

await t('업로드된 바이트가 그대로 보존', () => {
  const f = sub.files.find((x) => x.name === '시안 v2.png');
  const bytes = bucket.objects.get(f.key).bytes;
  eq(Buffer.from(bytes).toString('hex').slice(0, 8), '89504e47', 'PNG 시그니처');
});

await t('공백이 있는 한글 파일명이 키에서 정규화됨', () => {
  const f = sub.files.find((x) => x.name === '시안 v2.png');
  if (f.key.includes(' ')) throw new Error(`키에 공백: ${f.key}`);
  if (!f.key.includes('시안_v2.png')) throw new Error(`키: ${f.key}`);
  eq(f.name, '시안 v2.png', '표시용 원본 이름은 유지');
});

await t('fileURL 이 같은 도메인 API 주소', async () => {
  eq(await store.fileURL(sub.files[0]), `/api/file/${encodeURI(sub.files[0].key)}`, 'URL');
});

console.log('\n== 파일 응답 헤더 ==');

await t('이미지·PDF 는 inline, 원본 파일명 유지', async () => {
  const f = sub.files.find((x) => x.name === '리포트.pdf');
  const res = await api(`/file/${encodeURI(f.key)}`);
  eq(res.status, 200, 'status');
  eq(res.headers.get('Content-Type'), 'application/pdf', 'type');
  const cd = res.headers.get('Content-Disposition');
  if (!cd.startsWith('inline')) throw new Error(cd);
  if (!cd.includes(encodeURIComponent('리포트.pdf'))) throw new Error(cd);
});

await t('download=1 이면 첨부로 강제', async () => {
  const f = sub.files.find((x) => x.name === '리포트.pdf');
  const res = await api(`/file/${encodeURI(f.key)}?download=1`);
  if (!res.headers.get('Content-Disposition').startsWith('attachment')) {
    throw new Error(res.headers.get('Content-Disposition'));
  }
});

await t('업로드 파일에 스크립트 차단 헤더가 붙음', async () => {
  const res = await api(`/file/${encodeURI(sub.files[0].key)}`);
  eq(res.headers.get('X-Content-Type-Options'), 'nosniff', 'nosniff');
  eq(res.headers.get('Content-Security-Policy'), "default-src 'none'; sandbox", 'CSP');
});

await t('SVG 는 인라인으로 열리지 않고 첨부로 내려감', async () => {
  const svg = new File(
    [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    'evil.svg', { type: 'image/svg+xml' },
  );
  const rec = await store.uploadFile(svg, sub.id);
  const res = await api(`/file/${encodeURI(rec.key)}`);
  if (!res.headers.get('Content-Disposition').startsWith('attachment')) {
    throw new Error('SVG 가 인라인으로 열림 — XSS 위험');
  }
  await store.deleteFile(rec);
});

console.log('\n== 동시성 ==');

await t('etag 없이 쓰면 거부 (428)', async () => {
  const res = await api('/data/projects', {
    method: 'PUT',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [] }),
  });
  eq(res.status, 428, 'status');
});

await t('낡은 etag 로 쓰면 409 + 최신본 반환', async () => {
  const before = await store.readIndex('projects');
  await store.saveProject({ title: '2주차 · 프로토타입', status: 'open' });   // etag 변경
  const res = await api('/data/projects', {
    method: 'PUT',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ etag: before.etag, data: [] }),
  });
  eq(res.status, 409, 'status');
  const body = await res.json();
  eq(body.current.data.length, 2, '최신본 항목 수');
  if (!body.current.etag) throw new Error('최신 etag 없음');
});

await t('동시 저장이 서로를 덮어쓰지 않음', async () => {
  const base = (await store.listProjects()).length;
  // 같은 색인에 동시에 저장 — 재시도로 둘 다 살아남아야 합니다.
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

console.log('\n== 삭제 연쇄 ==');

await t('제출물 삭제가 첨부까지 정리', async () => {
  const keys = sub.files.map((f) => f.key);
  await store.deleteSubmission(sub.id);
  eq((await store.listSubmissions()).length, 0, '색인');
  for (const k of keys) if (bucket.objects.has(k)) throw new Error(`파일 잔여: ${k}`);
});

await t('프로젝트 삭제가 하위 제출물·파일까지 정리', async () => {
  await store.saveSubmission({
    projectId: project.id,
    author: { institution: 'A', name: 'B', email: 'b@e.com' },
    title: 'x', body: 'y', files: [], editCode: 'ZZZ999',
  }, [new File([new Uint8Array([1, 2])], 'a.png', { type: 'image/png' })]);
  await store.deleteProject(project.id);
  eq((await store.listSubmissions({ projectId: project.id })).length, 0, '제출물');
  eq(bucket.keys('uploads/').length, 0, `업로드 잔여: ${bucket.keys('uploads/')}`);
});

console.log('\n== 강의자료 ==');

let material;
await t('강의자료 등록 → uploads/materials/ 아래', async () => {
  const pdf = new File([new Uint8Array([37, 80, 68, 70])], '1강 자료.pdf', { type: 'application/pdf' });
  material = await store.saveMaterial({ title: '1강 · 개론', session: '1주차', files: [] }, [pdf]);
  eq(material.files.length, 1, '파일 수');
  if (!material.files[0].key.startsWith('uploads/materials/')) {
    throw new Error(material.files[0].key);
  }
});

await t('강의자료와 제출물 색인이 분리됨', async () => {
  eq((await store.listMaterials()).length, 1, '강의자료');
  eq((await store.listSubmissions()).length, 0, '제출물');
});

await t('백업에 세 종류가 모두 포함', async () => {
  const dump = await store.exportAll();
  for (const k of ['projects', 'submissions', 'materials']) {
    if (!Array.isArray(dump[k])) throw new Error(`${k} 누락`);
  }
});

console.log('\n== 입력 검증 ==');

await t('허용되지 않는 확장자 업로드 거부', async () => {
  const res = await api(`/upload?dir=${sub.id}&name=evil.exe`, {
    method: 'POST', headers: { Origin: ORIGIN }, body: new Uint8Array([1]),
  });
  eq(res.status, 415, 'status');
});

await t('잘못된 저장 위치 거부 (경로 탈출)', async () => {
  const bad = ['../data', 'data', 'a/b/c', '', 'materials/../data',
    'materials/s_abc', 'm_abc', 'uploads', 's_ab-cd', '../../etc'];
  for (const dir of bad) {
    const res = await api(`/upload?dir=${encodeURIComponent(dir)}&name=a.pdf`, {
      method: 'POST', headers: { Origin: ORIGIN }, body: new Uint8Array([1]),
    });
    eq(res.status, 400, `허용돼버림: "${dir}"`);
  }
});

await t('uploads/ 밖의 키는 읽기·삭제 불가', async () => {
  for (const key of ['data/projects.json', '../secret', 'data/materials.json']) {
    eq((await api(`/file/${encodeURIComponent(key)}`)).status, 400, `읽기 허용됨: ${key}`);
    eq((await api(`/file/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Origin: ORIGIN } })).status,
      400, `삭제 허용됨: ${key}`);
  }
  if (!bucket.objects.has('data/projects.json')) throw new Error('색인이 지워짐');
});

await t('빈 파일 거부', async () => {
  const res = await api('/upload?dir=s_test&name=a.pdf', {
    method: 'POST', headers: { Origin: ORIGIN }, body: new Uint8Array([]),
  });
  eq(res.status, 400, 'status');
});

await t('용량 초과 거부', async () => {
  const small = { ...env, MAX_UPLOAD_MB: 1 };
  const res = await handleApi(
    new Request(`${ORIGIN}/api/upload?dir=s_test&name=big.pdf`, {
      method: 'POST', headers: { Origin: ORIGIN }, body: new Uint8Array(2 * 1024 * 1024),
    }), small, { basePath: '/api' });
  eq(res.status, 413, 'status');
});

await t('알 수 없는 색인 이름 거부', async () => {
  eq((await api('/data/secrets')).status, 404, 'status');
});

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
});

console.log('\n== 강의자료 다운로드 잠금 (선택 기능) ==');

{
  const gatedEnv = {
    BUCKET: bucket,
    MATERIALS_PASSWORD: 'AI2026',
    TOKEN_SECRET: 'test-secret-please-change',
  };
  const gapi = (path, init = {}) => handleApi(
    new Request(`${ORIGIN}${path}`, { headers: { Origin: ORIGIN }, ...init }),
    gatedEnv, { basePath: '/api' });

  const materialKey = material.files[0].key;

  await t('health 가 잠금 상태를 알려줌', async () => {
    const body = await (await gapi('/health')).json();
    eq(body.materialsGate, true, 'materialsGate');
  });

  await t('토큰 없이는 강의자료 다운로드 403', async () => {
    eq((await gapi(`/file/${encodeURI(materialKey)}`)).status, 403, 'status');
  });

  await t('과제 첨부는 잠금과 무관하게 열림', async () => {
    const rec = await store.uploadFile(
      new File([new Uint8Array([1])], 'ok.png', { type: 'image/png' }), 's_free');
    eq((await gapi(`/file/${encodeURI(rec.key)}`)).status, 200, 'status');
    await store.deleteFile(rec);
  });

  await t('틀린 비밀번호로는 토큰이 안 나옴', async () => {
    const res = await gapi('/materials/token', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    eq(res.status, 403, 'status');
  });

  let token;
  await t('맞는 비밀번호로 토큰 발급 → 다운로드 성공', async () => {
    const res = await gapi('/materials/token', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'AI2026' }),
    });
    eq(res.status, 200, 'status');
    ({ token } = await res.json());
    if (!token) throw new Error('토큰 없음');
    eq((await gapi(`/file/${encodeURI(materialKey)}?t=${encodeURIComponent(token)}`)).status, 200, '다운로드');
  });

  await t('위조·만료 토큰 거부', async () => {
    const [exp, sig] = token.split('.');
    const forged = [
      `${exp}.${'0'.repeat(sig.length)}`,                    // 서명 위조
      `${Date.now() + 3600000}.${sig}`,                      // 만료시각만 바꿈
      `${Date.now() - 1000}.${sig}`,                         // 이미 만료
      'garbage',
    ];
    for (const bad of forged) {
      const res = await gapi(`/file/${encodeURI(materialKey)}?t=${encodeURIComponent(bad)}`);
      eq(res.status, 403, `통과해버림: ${bad.slice(0, 24)}`);
    }
  });

  await t('다른 비밀 키로 만든 토큰은 거부', async () => {
    const other = { ...gatedEnv, TOKEN_SECRET: 'different-secret' };
    const res = await handleApi(
      new Request(`${ORIGIN}/api/file/${encodeURI(materialKey)}?t=${encodeURIComponent(token)}`,
        { headers: { Origin: ORIGIN } }), other, { basePath: '/api' });
    eq(res.status, 403, 'status');
  });

  await t('클라이언트가 잠금 상태에 맞춰 토큰을 붙임', async () => {
    const gatedStore = new R2Store({ apiBase: '/api' });
    const saved = env;
    env = gatedEnv;                       // 이 블록 동안 fetch 를 잠금 환경으로
    try {
      await gatedStore.init();
      eq(gatedStore.materialsGate, true, 'gate 감지');
      eq(gatedStore.hasMaterialsAccess(), false, '토큰 전에는 접근 불가');
      eq(await gatedStore.fileURL(material.files[0]), null, '토큰 없으면 URL 없음');

      await gatedStore.authorizeMaterials('AI2026');
      eq(gatedStore.hasMaterialsAccess(), true, '토큰 후 접근 가능');
      const url = await gatedStore.fileURL(material.files[0]);
      if (!url.includes('?t=')) throw new Error(`토큰 미포함: ${url}`);

      gatedStore.clearMaterialsAccess();
      eq(gatedStore.hasMaterialsAccess(), false, '해제 후 접근 불가');
    } finally { env = saved; }
  });
}

console.log('\n== Workers 진입점 (정적 자산 배포용) ==');

{
  const { default: workerEntry } = await import('../shared/worker-entry.js');
  const assetHits = [];
  const wEnv = {
    BUCKET: bucket,
    ASSETS: { fetch: async (req) => { assetHits.push(new URL(req.url).pathname); return new Response('asset', { status: 200 }); } },
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

  await t('Workers 경로로도 파일이 실제로 내려옴', async () => {
    const rec = await store.uploadFile(
      new File([new Uint8Array([37, 80, 68, 70])], 'w.pdf', { type: 'application/pdf' }), 's_wtest');
    const res = await call(`/api/file/${encodeURI(rec.key)}`);
    eq(res.status, 200, 'status');
    eq(res.headers.get('Content-Type'), 'application/pdf', 'type');
    await store.deleteFile(rec);
  });
}

console.log('\n================ 결과 ================');
console.log(`버킷 객체 ${bucket.objects.size}개`);
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(', ')}`); process.exit(1); }
console.log('모든 검사 통과');
