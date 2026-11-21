/** 개인 작품 페스타. 단계·출품작·평가는 같은 R2 객체에서 조건부 쓰기로 갱신합니다. */
import { conditionFor, normEmail } from './auth.js';

const STATE_KEY = 'data/festa.json';
const FILE_PREFIX = 'festa/uploads/';
export const FESTA_FILE_BYTES = 30 * 1024 * 1024;
export const FESTA_FILE_COUNT = 10;
export const FESTA_FILE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'ppt', 'pptx', 'doc', 'docx',
  'xls', 'xlsx', 'hwp', 'hwpx', 'zip', 'txt', 'md', 'csv', 'mp4', 'mov', 'webm',
]);
const PHASES = ['open', 'closed', 'judging', 'finished'];
const SCORE_LIMITS = [40, 30, 20, 10];
const KEY_RE = /^festa\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]+$/;

class FestaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new FestaError(status, message); };
const reply = (data, status, cors) => new Response(JSON.stringify(data), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const ownerOf = (entry) => normEmail(entry?.author?.email);
const isAdmin = (member) => member.role === 'admin';
const incarnationOf = (member) => String(member.createdAt || '');
const DUPLICATE_ENTRY = '이 이메일로 이미 접수된 작품이 있습니다. 기존 접수 확인은 운영자에게 문의해 주세요.';
const DUPLICATE_SCORE = '이 이메일로 이미 평가한 작품입니다. 평가 확인은 운영자에게 문의해 주세요.';
const SELF_SCORE = '자신의 작품은 평가할 수 없습니다.';
// 이메일을 삭제 후 재가입해도 예전 회원의 비공개 작품·파일·점수를 넘겨받지 않습니다.
const isMine = (entry, member) => ownerOf(entry) === normEmail(member.email)
  && entry?.author?.memberCreatedAt === incarnationOf(member);
const published = (state) => state.phase === 'judging' || state.phase === 'finished';
const requireOpen = (state) => {
  if (state.phase !== 'open') fail(409, '출품이 마감되어 작품과 파일을 변경할 수 없습니다.');
};
const requireAdmin = (member) => {
  if (!isAdmin(member)) fail(403, '관리자만 할 수 있습니다.');
};

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(value);
}
function contactEmail(state, env) {
  const saved = normEmail(state.email);
  const configured = normEmail(env.FESTA_EMAIL);
  return validEmail(saved) ? saved : (validEmail(configured) ? configured : '');
}

async function readState(env) {
  const obj = await env.BUCKET.get(STATE_KEY);
  if (!obj) return {
    etag: null,
    state: { version: 1, phase: 'open', entries: [], scores: [], uploads: [] },
  };
  let state;
  try { state = JSON.parse(await obj.text()); } catch {
    fail(503, '페스타 데이터를 읽지 못했습니다. 관리자에게 문의하세요.');
  }
  // 손상된 명부를 빈 상태로 덮어쓰지 않습니다. 기존/초기 상태에는 uploads가 없을 수 있습니다.
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || !PHASES.includes(state.phase) || !Array.isArray(state.entries)
      || !Array.isArray(state.scores)
      || (state.uploads !== undefined && !Array.isArray(state.uploads))) {
    fail(503, '페스타 데이터 형식이 올바르지 않습니다. 관리자에게 문의하세요.');
  }
  state.uploads ??= [];
  return { etag: obj.etag, state };
}

async function updateState(env, mutate) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { etag, state } = await readState(env);
    // 모든 권한·단계·중복 검사는 재시도할 때 최신 상태에서 다시 수행합니다.
    const result = mutate(state);
    const put = await env.BUCKET.put(STATE_KEY, JSON.stringify(state), {
      onlyIf: conditionFor(etag),
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    if (put) return { state, result };
    await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
  }
  fail(409, '동시에 변경된 내용이 있습니다. 잠시 후 다시 시도하세요.');
}

function limitedBody(request, limit) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) fail(413, '요청 데이터가 너무 큽니다.');
  if (!request.body) fail(400, '요청 내용이 없습니다.');
  let size = 0;
  const reader = request.body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        size += value.byteLength;
        if (size > limit) {
          controller.error(new FestaError(413, '요청 데이터가 너무 큽니다.'));
          await reader.cancel();
          return;
        }
        controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

async function jsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    fail(415, 'JSON 형식으로 요청해 주세요.');
  }
  let body;
  try { body = await new Response(limitedBody(request, 128 * 1024)).json(); } catch (error) {
    if (error instanceof FestaError) throw error;
    fail(400, '요청 내용을 읽을 수 없습니다.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '잘못된 요청 형식입니다.');
  return body;
}

function textField(value, label, limit) {
  if (typeof value !== 'string' || !value.trim()) fail(400, `${label}을(를) 입력하세요.`);
  const text = value.trim();
  if (text.length > limit) fail(400, `${label}은(는) ${limit}자 이내로 입력하세요.`);
  return text;
}

function webUrl(value, label, required, github = false) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, `${label}을(를) 입력하세요.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > 2048) fail(400, `${label}이(가) 올바르지 않습니다.`);
  const raw = value.trim();
  if (!raw && !required) return '';
  let url;
  try { url = new URL(raw); } catch { fail(400, `${label}이(가) 올바르지 않습니다.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /[\u0000-\u0020\u007f]/.test(raw)) {
    fail(400, `${label}은(는) 올바른 HTTP 또는 HTTPS 주소여야 합니다.`);
  }
  if (github && (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
      || !/^\/[^/]+\/[^/]+(?:\/.*)?$/.test(url.pathname))) {
    fail(400, 'GitHub 저장소 주소를 https://github.com/소유자/저장소 형식으로 입력하세요.');
  }
  return url.href;
}

function scoreIndex(state, member) {
  const index = new Map();
  const email = normEmail(member.email);
  for (const row of state.scores) {
    if (!row) continue;
    let summary = index.get(row.entryId);
    if (!summary) {
      summary = { count: 0, total: 0, myScores: null };
      index.set(row.entryId, summary);
    }
    summary.count += 1;
    summary.total += row.scores.reduce((a, b) => a + b, 0);
    if (row.rater === email) {
      if (row.raterCreatedAt === incarnationOf(member)) summary.myScores = [...row.scores];
      else summary.previousAccountScored = true;
    }
  }
  return index;
}

function entryView(entry, summaries, member) {
  const mine = isMine(entry, member);
  const admin = isAdmin(member);
  const summary = summaries.get(entry.id);
  const author = { name: entry.author?.name || '', institution: entry.author?.institution || '' };
  if (mine || admin) author.email = ownerOf(entry);
  const view = {
    id: entry.id, title: entry.title, description: entry.description,
    localOnly: Boolean(entry.localOnly), deployUrl: entry.deployUrl || '', githubUrl: entry.githubUrl,
    files: (entry.files || []).map(({ key, name, size }) => ({ key, name, size })),
    createdAt: entry.createdAt, updatedAt: entry.updatedAt, author, isMine: mine,
    myScores: summary?.myScores || null,
    scoreBlocked: ownerOf(entry) === normEmail(member.email) ? SELF_SCORE
      : (summary?.previousAccountScored ? DUPLICATE_SCORE : ''),
  };
  if (admin) {
    view.scoreCount = summary?.count || 0;
    view.average = summary?.count ? summary.total / summary.count : null;
  }
  return view;
}

async function overview(env, member, cors) {
  const { state } = await readState(env);
  const summaries = scoreIndex(state, member);
  const existing = state.entries.find((entry) => ownerOf(entry) === normEmail(member.email));
  const own = existing && isMine(existing, member) ? existing : null;
  return reply({
    phase: state.phase,
    mine: own ? entryView(own, summaries, member) : null,
    entryBlocked: existing && !own ? DUPLICATE_ENTRY : '',
    entries: isAdmin(member) || published(state) ? state.entries.map((entry) => entryView(entry, summaries, member)) : [],
    email: contactEmail(state, env),
  }, 200, cors);
}

async function checkedFiles(files, env, member) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > FESTA_FILE_COUNT) {
    fail(400, `첨부파일은 최대 ${FESTA_FILE_COUNT}개까지 등록할 수 있습니다.`);
  }
  const keys = new Set();
  const result = [];
  for (const file of files) {
    if (!file || typeof file.key !== 'string' || !KEY_RE.test(file.key) || keys.has(file.key)) {
      fail(400, '첨부파일 경로가 올바르지 않거나 중복되었습니다.');
    }
    keys.add(file.key);
    const obj = typeof env.BUCKET.head === 'function'
      ? await env.BUCKET.head(file.key) : await env.BUCKET.get(file.key);
    if (!obj || normEmail(obj.customMetadata?.owner) !== normEmail(member.email)
        || obj.customMetadata?.ownerCreatedAt !== incarnationOf(member)) {
      fail(403, '직접 업로드한 페스타 파일만 첨부할 수 있습니다.');
    }
    if (!Number.isInteger(obj.size) || obj.size <= 0 || obj.size > FESTA_FILE_BYTES) {
      fail(400, '첨부파일 크기가 올바르지 않습니다.');
    }
    let name;
    try { name = decodeURIComponent(obj.customMetadata?.originalName || ''); } catch { name = ''; }
    if (!name) fail(400, '첨부파일 정보가 올바르지 않습니다.');
    result.push({ key: file.key, name, size: obj.size });
  }
  return result;
}

async function saveEntry(request, env, member, cors) {
  const body = await jsonBody(request);
  const title = textField(body.title, '작품명', 160);
  const description = textField(body.description, '작품 설명', 10000);
  if (typeof body.localOnly !== 'boolean') fail(400, '로컬 동작 여부를 선택하세요.');
  const localOnly = body.localOnly;
  const deployUrl = localOnly ? '' : webUrl(body.deployUrl, '배포 주소', true);
  const githubUrl = webUrl(body.githubUrl, 'GitHub 저장소 주소', true, true);
  requireOpen((await readState(env)).state);
  const files = await checkedFiles(body.files, env, member);
  const email = normEmail(member.email);
  const id = `fe_${crypto.randomUUID()}`;
  const { state, result: saved } = await updateState(env, (current) => {
    requireOpen(current);
    for (const file of files) {
      if (!current.uploads.some((upload) => upload?.key === file.key && upload.owner === email
          && upload.ownerCreatedAt === incarnationOf(member))) {
        fail(403, '직접 업로드한 페스타 파일만 첨부할 수 있습니다.');
      }
    }
    const existing = current.entries.find((entry) => ownerOf(entry) === email);
    if (existing && !isMine(existing, member)) fail(409, DUPLICATE_ENTRY);
    const now = new Date().toISOString();
    const entry = {
      id: existing?.id || id, title, description, localOnly, deployUrl, githubUrl, files,
      createdAt: existing?.createdAt || now, updatedAt: now,
      author: {
        email, memberCreatedAt: incarnationOf(member),
        name: String(member.name || ''), institution: String(member.institution || ''),
      },
    };
    if (existing) current.entries[current.entries.indexOf(existing)] = entry;
    else current.entries.push(entry);
    return entry;
  });
  return reply({ entry: entryView(saved, scoreIndex(state, member), member) }, 200, cors);
}

async function setPhase(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  if (!['closed', 'judging', 'finished'].includes(body.phase)) fail(400, '올바르지 않은 진행 단계입니다.');
  const { state } = await updateState(env, (current) => {
    if (PHASES.indexOf(body.phase) !== PHASES.indexOf(current.phase) + 1) {
      fail(409, '접수 마감 → 평가 시작 → 평가 종료 순서로 진행해 주세요.');
    }
    current.phase = body.phase;
  });
  return reply({ phase: state.phase }, 200, cors);
}

async function setContact(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  if (typeof body.email !== 'string') fail(400, '파일을 받을 이메일 주소 하나를 입력하세요.');
  const email = normEmail(body.email);
  if (!validEmail(email)) fail(400, '파일을 받을 이메일 주소 하나를 입력하세요.');
  await updateState(env, (state) => { state.email = email; });
  return reply({ email }, 200, cors);
}

async function scoreEntry(request, env, member, cors) {
  const body = await jsonBody(request);
  if (typeof body.entryId !== 'string' || !/^fe_[A-Za-z0-9_-]{1,64}$/.test(body.entryId)) {
    fail(400, '작품 번호가 올바르지 않습니다.');
  }
  if (!Array.isArray(body.scores) || body.scores.length !== 4
      || body.scores.some((score, i) => !Number.isInteger(score) || score < 0 || score > SCORE_LIMITS[i])) {
    fail(400, '평가 점수는 각 항목의 배점(40·30·20·10) 안에서 정수로 입력하세요.');
  }
  const scores = [...body.scores];
  const email = normEmail(member.email);
  await updateState(env, (state) => {
    if (state.phase !== 'judging') fail(409, '현재 평가 기간이 아닙니다.');
    const entry = state.entries.find((item) => item?.id === body.entryId);
    if (!entry) fail(404, '작품을 찾을 수 없습니다.');
    if (ownerOf(entry) === email) fail(403, SELF_SCORE);
    const existing = state.scores.find((row) => row?.entryId === entry.id && row.rater === email);
    if (existing && existing.raterCreatedAt !== incarnationOf(member)) fail(409, DUPLICATE_SCORE);
    const row = {
      entryId: entry.id, rater: email, raterCreatedAt: incarnationOf(member),
      scores, updatedAt: new Date().toISOString(),
    };
    if (existing) state.scores[state.scores.indexOf(existing)] = row;
    else state.scores.push(row);
  });
  return reply({ ok: true, entryId: body.entryId, myScores: scores }, 200, cors);
}

async function uploadFile(request, env, member, cors) {
  requireOpen((await readState(env)).state);
  const contentType = request.headers.get('Content-Type') || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) fail(415, '파일 업로드 형식이 올바르지 않습니다.');
  let form;
  try {
    form = await new Response(limitedBody(request, FESTA_FILE_BYTES + 64 * 1024), {
      headers: { 'Content-Type': contentType },
    }).formData();
  } catch (error) {
    if (error instanceof FestaError) throw error;
    fail(400, '업로드 파일을 읽을 수 없습니다.');
  }
  const parts = [...form.entries()];
  const file = form.get('file');
  if (parts.length !== 1 || parts[0][0] !== 'file' || !file || typeof file.arrayBuffer !== 'function') {
    fail(400, '파일 하나를 선택해 주세요.');
  }
  const name = String(file.name || '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1];
  if (!name || name.length > 200 || !FESTA_FILE_EXTENSIONS.has(ext)) {
    fail(415, '허용되지 않는 파일 형식입니다. 소스 코드는 ZIP 파일로 첨부해 주세요.');
  }
  if (file.size <= 0) fail(400, '빈 파일은 업로드할 수 없습니다.');
  if (file.size > FESTA_FILE_BYTES) fail(413, '파일당 최대 30MB까지 첨부할 수 있습니다. 큰 파일은 안내된 이메일로 제출해 주세요.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > FESTA_FILE_BYTES) fail(413, '파일 크기는 1바이트 이상, 최대 30MB입니다.');
  const key = `${FILE_PREFIX}${crypto.randomUUID()}.${ext}`;
  const owner = normEmail(member.email);
  // MIME을 클라이언트에서 받지 않고 모든 파일을 다운로드로 제공합니다.
  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { owner, ownerCreatedAt: incarnationOf(member), originalName: encodeURIComponent(name) },
  });
  let discarded;
  try {
    const update = await updateState(env, (state) => {
      requireOpen(state);
      state.uploads.push({ key, name, size: bytes.byteLength, owner, ownerCreatedAt: incarnationOf(member) });
      // 수정 중인 파일과 저장된 작품을 보호하면서, 반복 선택으로 남은 임시 파일을 정리합니다.
      const entry = state.entries.find((item) => isMine(item, member));
      const attached = new Set(entry?.files.map((item) => item.key));
      const pending = state.uploads.filter((item) => item.owner === owner
        && item.ownerCreatedAt === incarnationOf(member) && !attached.has(item.key));
      const expired = new Set(pending.slice(0, -2 * FESTA_FILE_COUNT).map((item) => item.key));
      if (expired.size) state.uploads = state.uploads.filter((item) => !expired.has(item.key));
      return expired;
    });
    discarded = update.result;
  } catch (error) {
    // 업로드 중 접수가 마감된 경우 출품 가능한 파일로 남기지 않습니다.
    await env.BUCKET.delete(key).catch(() => {});
    throw error;
  }
  // 목록에서 먼저 제외했으므로 동시에 저장한 작품의 첨부를 삭제하지 않습니다.
  await Promise.all([...discarded].map((oldKey) => env.BUCKET.delete(oldKey).catch(() => {})));
  return reply({ file: { key, name, size: bytes.byteLength } }, 200, cors);
}

async function downloadFile(env, member, rawKey, cors) {
  let key;
  try { key = decodeURIComponent(rawKey); } catch { fail(400, '파일 경로가 올바르지 않습니다.'); }
  if (!KEY_RE.test(key)) fail(400, '파일 경로가 올바르지 않습니다.');
  const { state } = await readState(env);
  const upload = state.uploads.find((file) => file?.key === key);
  if (!upload) fail(404, '파일을 찾을 수 없습니다.');
  const mine = upload.owner === normEmail(member.email) && upload.ownerCreatedAt === incarnationOf(member);
  const attached = state.entries.some((entry) => entry?.files?.some((file) => file.key === key));
  if (!isAdmin(member) && !mine && !(published(state) && attached)) {
    fail(403, '현재 이 파일을 열람할 수 없습니다.');
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) fail(404, '파일을 찾을 수 없습니다.');
  return new Response(obj.body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(upload.name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

/** currentMember로 확인한 회원만 전달합니다. 일반 데이터/파일 API와 분리되어 있습니다. */
export async function handleFesta(request, env, { path, member, cors = {} }) {
  if (!member) return reply({ message: '로그인이 필요합니다.' }, 401, cors);
  try {
    if (path === '/festa' && request.method === 'GET') return await overview(env, member, cors);
    if (request.method === 'POST') {
      if (path === '/festa/entry') return await saveEntry(request, env, member, cors);
      if (path === '/festa/phase') return await setPhase(request, env, member, cors);
      if (path === '/festa/contact') return await setContact(request, env, member, cors);
      if (path === '/festa/score') return await scoreEntry(request, env, member, cors);
      if (path === '/festa/upload') return await uploadFile(request, env, member, cors);
    }
    if (request.method === 'GET' && path.startsWith('/festa/file/')) {
      return await downloadFile(env, member, path.slice('/festa/file/'.length), cors);
    }
    return reply({ message: '허용되지 않은 페스타 요청입니다.' }, 405, cors);
  } catch (error) {
    if (error instanceof FestaError) return reply({ message: error.message }, error.status, cors);
    throw error;
  }
}
