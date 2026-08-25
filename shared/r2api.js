/**
 * Assignment Hub — R2 저장소 API
 * ---------------------------------------------------------------------------
 * Cloudflare Pages Functions 와 독립 Worker 가 함께 쓰는 핸들러입니다.
 * 브라우저는 이 API 만 호출하고, R2 버킷은 서버(바인딩)에서만 접근합니다.
 *
 * 필요한 바인딩 / 환경변수
 *   BUCKET               (필수) R2 버킷 바인딩
 *   ALLOWED_ORIGINS      (선택) 쉼표 구분. 비우면 같은 오리진만 허용
 *   MAX_UPLOAD_MB        (선택) 기본 100
 *   ALLOWED_EXT          (선택) 쉼표 구분. 비우면 아래 기본 목록
 *   MATERIALS_PASSWORD   (선택) 설정하면 강의자료 다운로드에 토큰이 필요해집니다
 *   TOKEN_SECRET         (MATERIALS_PASSWORD 를 쓸 때 필수) HMAC 서명 키
 *
 * 경로 (basePath 기본 '/api')
 *   GET    /health
 *   GET    /data/:name          -> { etag, data }   (없으면 [] 로 만들어 줍니다)
 *   PUT    /data/:name          <- { etag, data }   -> { etag } / 409 { current }
 *   POST   /upload?dir=&name=   <- 원본 바이트      -> { key, size, type }
 *   GET    /file/<key>          -> 파일 스트리밍
 *   DELETE /file/<key>          -> 삭제
 *   POST   /materials/token     <- { password }     -> { token, expiresAt }
 */

const DATA_NAMES = new Set(['projects', 'submissions', 'materials']);

const DEFAULT_EXT = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic',
  'mp4', 'webm', 'mov', 'm4v',
  'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'hwp', 'hwpx',
  'zip', 'txt', 'md', 'csv',
];

/**
 * 브라우저에서 바로 열어도 안전한 타입만 인라인으로 내보냅니다.
 * 나머지는 첨부(다운로드)로 강제합니다 — 같은 오리진에서 임의의 HTML/SVG 가
 * 실행되면 관리자 세션이나 저장된 토큰을 읽어갈 수 있기 때문입니다.
 */
const SAFE_INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
]);

const TOKEN_TTL_MS = 6 * 3600 * 1000;

export async function handleApi(request, env, { basePath = '/api' } = {}) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(basePath)
    ? url.pathname.slice(basePath.length) || '/'
    : url.pathname;

  const origin = request.headers.get('Origin') || '';
  const cors = corsHeaders(origin, url, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!originAllowed(origin, url, env)) {
    return json({ message: '허용되지 않은 출처입니다.' }, 403, cors);
  }
  if (!env.BUCKET) {
    return json({ message: 'R2 버킷 바인딩(BUCKET)이 설정되지 않았습니다.' }, 500, cors);
  }

  try {
    if (path === '/health' && request.method === 'GET') {
      return json({
        ok: true,
        mode: 'r2',
        // 강의자료 다운로드에 비밀번호 토큰이 필요한지 — 클라이언트가 이 값에 맞춰 동작합니다.
        materialsGate: isGated(env),
        maxUploadMB: maxUploadMB(env),
      }, 200, cors);
    }

    const dataMatch = path.match(/^\/data\/([a-z]+)$/);
    if (dataMatch) {
      const name = dataMatch[1];
      if (!DATA_NAMES.has(name)) return json({ message: '알 수 없는 데이터입니다.' }, 404, cors);
      if (request.method === 'GET') return readData(env, name, cors);
      if (request.method === 'PUT') return writeData(request, env, name, cors);
      return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
    }

    if (path === '/upload' && request.method === 'POST') {
      return upload(request, env, url, cors);
    }

    if (path === '/materials/token' && request.method === 'POST') {
      return materialsToken(request, env, cors);
    }

    if (path.startsWith('/file/')) {
      const key = decodeURIComponent(path.slice('/file/'.length));
      if (request.method === 'GET') return serveFile(env, key, url, cors);
      if (request.method === 'DELETE') return deleteFile(env, key, cors);
      return json({ message: '허용되지 않은 메서드입니다.' }, 405, cors);
    }

    return json({ message: 'Not found' }, 404, cors);
  } catch (e) {
    return json({ message: `서버 오류: ${e.message}` }, 500, cors);
  }
}

/* ------------------------------------------------------------ 색인 JSON -- */

const dataKey = (name) => `data/${name}.json`;

/**
 * 색인을 읽습니다. 아직 없으면 빈 배열로 만들어 두고 그 etag 를 돌려줍니다.
 * 이렇게 해두면 이후 모든 쓰기가 "실제 etag 로 조건부 덮어쓰기" 한 가지 경로만
 * 타게 되어, 동시 제출에서 조용히 덮어쓰는 사고가 나지 않습니다.
 */
async function readData(env, name, cors) {
  const key = dataKey(name);
  let obj = await env.BUCKET.get(key);

  if (!obj) {
    await env.BUCKET.put(key, '[]', {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    obj = await env.BUCKET.get(key);
    if (!obj) return json({ message: '색인을 만들지 못했습니다.' }, 500, cors);
  }

  const text = await obj.text();
  let data;
  try { data = JSON.parse(text); } catch { data = []; }
  if (!Array.isArray(data)) data = [];

  return json({ etag: obj.etag, data }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

/** etag 가 어긋나면 덮어쓰지 않고 409 와 함께 최신본을 돌려줍니다. */
async function writeData(request, env, name, cors) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) {
    return json({ message: '잘못된 요청 형식입니다.' }, 400, cors);
  }
  if (typeof body.etag !== 'string' || !body.etag) {
    return json({ message: 'etag 가 필요합니다. 먼저 GET 으로 읽으세요.' }, 428, cors);
  }

  const key = dataKey(name);
  const payload = JSON.stringify(body.data, null, 2);

  const put = await env.BUCKET.put(key, payload, {
    onlyIf: { etagMatches: body.etag },
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  if (!put) {
    // 그 사이 다른 사람이 저장했습니다. 최신본을 함께 실어 보내 재시도를 돕습니다.
    const current = await env.BUCKET.get(key);
    let data = [];
    if (current) {
      try { data = JSON.parse(await current.text()); } catch { data = []; }
    }
    return json({
      message: '동시 수정 충돌이 발생했습니다.',
      current: { etag: current?.etag || null, data: Array.isArray(data) ? data : [] },
    }, 409, cors);
  }

  return json({ etag: put.etag }, 200, cors);
}

/* ---------------------------------------------------------------- 업로드 -- */

function maxUploadMB(env) {
  const n = Number(env.MAX_UPLOAD_MB);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function allowedExt(env) {
  const raw = String(env.ALLOWED_EXT || '').trim();
  if (!raw) return new Set(DEFAULT_EXT);
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** 저장소 키에 쓸 수 있게 파일명을 정리합니다. 한글은 유지합니다. */
function safeName(name) {
  const cleaned = String(name || 'file')
    .replace(/[\\/:*?"<>|#%&{}$!'`+=@]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(-120);
  return cleaned || 'file';
}

async function upload(request, env, url, cors) {
  const dir = String(url.searchParams.get('dir') || '').trim();
  const name = String(url.searchParams.get('name') || '').trim();

  // 키는 서버가 만듭니다. dir 은 앱이 실제로 쓰는 두 가지 형태만 허용합니다
  // (제출물 s_… / 강의자료 materials/m_…). 그 밖은 전부 거부합니다.
  if (!/^(?:materials\/m_[A-Za-z0-9]{1,60}|s_[A-Za-z0-9]{1,60})$/.test(dir)) {
    return json({ message: '잘못된 저장 위치입니다.' }, 400, cors);
  }
  if (!name) return json({ message: '파일명이 없습니다.' }, 400, cors);

  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (!allowedExt(env).has(ext)) {
    return json({ message: `허용되지 않는 형식입니다: .${ext || '?'}` }, 415, cors);
  }

  const limit = maxUploadMB(env) * 1024 * 1024;
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) {
    return json({ message: `파일이 너무 큽니다. 최대 ${maxUploadMB(env)}MB.` }, 413, cors);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return json({ message: '빈 파일입니다.' }, 400, cors);
  if (bytes.length > limit) {
    return json({ message: `파일이 너무 큽니다. 최대 ${maxUploadMB(env)}MB.` }, 413, cors);
  }

  const fid = `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const key = `uploads/${dir}/${fid}_${safeName(name)}`;
  const type = request.headers.get('X-File-Type') || 'application/octet-stream';

  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: type },
    customMetadata: { originalName: encodeURIComponent(name) },
  });

  return json({ key, size: bytes.length, type }, 200, cors);
}

/* ------------------------------------------------------------- 파일 제공 -- */

function keyAllowed(key) {
  if (!key || key.length > 400) return false;
  if (key.includes('..') || key.includes('//')) return false;
  return key.startsWith('uploads/');
}

async function serveFile(env, key, url, cors) {
  if (!keyAllowed(key)) return json({ message: '잘못된 경로입니다.' }, 400, cors);

  // 강의자료 잠금이 켜져 있으면 서명 토큰이 있어야 내려받을 수 있습니다.
  if (isGated(env) && key.startsWith('uploads/materials/')) {
    const ok = await verifyToken(url.searchParams.get('t'), env);
    if (!ok) return json({ message: '강의자료 열람 권한이 필요합니다.' }, 403, cors);
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ message: '파일을 찾을 수 없습니다.' }, 404, cors);

  const type = obj.httpMetadata?.contentType || 'application/octet-stream';
  const original = obj.customMetadata?.originalName
    ? decodeURIComponent(obj.customMetadata.originalName)
    : key.split('/').pop();

  const wantsDownload = url.searchParams.get('download') === '1';
  const inline = !wantsDownload && SAFE_INLINE.has(type);
  const disposition = inline ? 'inline' : 'attachment';

  const headers = new Headers(cors);
  headers.set('Content-Type', type);
  headers.set('Content-Length', String(obj.size));
  headers.set('ETag', obj.httpEtag);
  // 키에 난수가 들어 있어 같은 키의 내용이 바뀔 일이 없습니다.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  // 업로드된 SVG·HTML 이 우리 오리진에서 스크립트를 실행하지 못하게 막습니다.
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  headers.set(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(original)}`,
  );

  return new Response(obj.body, { status: 200, headers });
}

async function deleteFile(env, key, cors) {
  if (!keyAllowed(key)) return json({ message: '잘못된 경로입니다.' }, 400, cors);
  await env.BUCKET.delete(key);
  return json({ ok: true }, 200, cors);
}

/* -------------------------------------------------- 강의자료 다운로드 토큰 -- */

function isGated(env) {
  return Boolean(env.MATERIALS_PASSWORD && env.TOKEN_SECRET);
}

async function materialsToken(request, env, cors) {
  if (!isGated(env)) return json({ token: null, gate: false }, 200, cors);

  const body = await request.json().catch(() => null);
  const given = String(body?.password ?? '');

  if (!constantTimeEqual(given, String(env.MATERIALS_PASSWORD))) {
    return json({ message: '비밀번호가 올바르지 않습니다.' }, 403, cors);
  }

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const sig = await hmac(String(expiresAt), env.TOKEN_SECRET);
  return json({ token: `${expiresAt}.${sig}`, expiresAt, gate: true }, 200, cors);
}

async function verifyToken(token, env) {
  if (!token) return false;
  const [expRaw, sig] = String(token).split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmac(expRaw, env.TOKEN_SECRET);
  return constantTimeEqual(sig || '', expected);
}

async function hmac(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ CORS -- */

function originList(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/** 같은 오리진 요청은 항상 허용하고, 다른 오리진은 목록에 있을 때만 허용합니다. */
function originAllowed(origin, url, env) {
  if (!origin) return true;                 // 같은 오리진 GET 등 Origin 없는 요청
  if (origin === url.origin) return true;
  const list = originList(env);
  return list.length ? list.includes(origin) : false;
}

function corsHeaders(origin, url, env) {
  const list = originList(env);
  const ok = origin === url.origin || (list.length > 0 && list.includes(origin));
  return {
    'Access-Control-Allow-Origin': ok ? (origin || url.origin) : url.origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
