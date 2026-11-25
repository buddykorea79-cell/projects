/** 개인 작품 페스타. 단계·출품작·평가는 같은 R2 객체에서 조건부 쓰기로 갱신합니다. */
import { conditionFor, normEmail } from './auth.js';

const STATE_KEY = 'data/festa.json';
const FILE_PREFIX = 'festa/uploads/';
export const FESTA_FILE_BYTES = 30 * 1024 * 1024;
export const FESTA_FILE_COUNT = 10;
export const FESTA_ENTRY_COUNT = 2;
export const FESTA_CONTACT_EMAIL_COUNT = 5;
export const FESTA_DEFAULT_DEADLINE = '2027-12-07';
export const FESTA_FILE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'ppt', 'pptx', 'doc', 'docx',
  'xls', 'xlsx', 'hwp', 'hwpx', 'zip', 'txt', 'md', 'csv', 'mp4', 'mov', 'webm',
]);
const PHASES = ['open', 'closed', 'judging', 'finished'];
const INSTITUTIONS = ['행정안전부', '한국서부발전'];
export function entryInstitution(entry) {
  const value = entry?.institution ?? entry?.author?.institution;
  return INSTITUTIONS.includes(value) ? value : '';
}
function checkInstitutionChange(state, entry, institution) {
  if (entryInstitution(entry) === institution) return;
  if (Object.values(state.juryPanels || {}).some((panel) =>
    panel.status !== 'draft' && panel.entryIds.includes(entry.id))) {
    fail(409, '심사가 시작된 작품의 소속기관은 변경할 수 없습니다.');
  }
  // 접수 중 미리 배정한 작품의 기관을 바꿔도 잘못된 기관의 예선 초안에 남지 않습니다.
  const previousPanel = state.juryPanels?.[institution === '행정안전부' ? 'iwest' : 'mois'];
  if (previousPanel?.status === 'draft') {
    previousPanel.entryIds = previousPanel.entryIds.filter((id) => id !== entry.id);
  }
}
const KEY_RE = /^festa\/uploads\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]+$/;
const REQUEST_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class FestaError extends Error {
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
// 이메일을 삭제 후 재가입해도 예전 회원의 비공개 작품·파일·점수를 넘겨받지 않습니다.
const isMine = (entry, member) => ownerOf(entry) === normEmail(member.email)
  && entry?.author?.memberCreatedAt === incarnationOf(member);
// 기존 회원 연계(병합)로 이전된 R2 첨부파일의 customMetadata.owner(이전 이메일)도 허용합니다.
function ownsUploadMetadata(meta, member) {
  const owner = normEmail(meta?.owner);
  if (!owner) return false;
  if (owner === normEmail(member.email) && meta?.ownerCreatedAt === incarnationOf(member)) {
    return true;
  }
  const linked = Array.isArray(member.linkedFromEmails)
    ? member.linkedFromEmails.map(normEmail)
    : [];
  return linked.includes(owner);
}
const requireOpen = (state) => {
  if (state.phase !== 'open') fail(409, '출품이 마감되어 작품과 파일을 변경할 수 없습니다.');
  if (deadlinePassed(state)) fail(409, '접수 마감일이 지나 작품과 파일을 변경할 수 없습니다.');
};
const requireAdmin = (member) => {
  if (!member) fail(401, '관리자 로그인이 필요합니다.');
  if (!isAdmin(member)) fail(403, '관리자만 할 수 있습니다.');
};

export function validEmail(value) {
  return typeof value === 'string' && value.length <= 254
    && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(value);
}

export const juryScoreLimits = [40, 30, 20, 10];
export const juryRawWeights = [4, 3, 2, 1];
export const validJuryScores = (scores) => Array.isArray(scores) && scores.length === juryScoreLimits.length
  && scores.every((score, index) => Number.isInteger(score) && score >= 0 && score <= juryScoreLimits[index]);
export const validRawJuryScores = (rawScores) => Array.isArray(rawScores) && rawScores.length === juryRawWeights.length
  && rawScores.every((score) => Number.isInteger(score) && score >= 1 && score <= 10);
export const convertRawJuryScores = (rawScores) => (
  validRawJuryScores(rawScores) ? rawScores.map((score, index) => score * juryRawWeights[index]) : null
);
export const deriveRawJuryScores = (scores) => {
  if (!validJuryScores(scores)) return null;
  const raw = scores.map((score, index) => score / juryRawWeights[index]);
  return validRawJuryScores(raw) ? raw : null;
};

// 초대 만료는 접근만 막습니다. 이미 배정받은 작품과 심사표는 그대로 계산합니다.
export function judgeCanScore(judge, entry) {
  const email = normEmail(judge?.email);
  return Boolean(judge?.id && validEmail(email) && email !== normEmail(entry?.author?.email));
}

function parseStoredContactEmails(raw) {
  const items = Array.isArray(raw) ? raw
    : (typeof raw === 'string' && !/[\u0000-\u001f\u007f]/.test(raw) ? raw.split(/[,;]/) : []);
  const seen = new Set();
  const emails = [];
  for (const item of items) {
    if (typeof item !== 'string' || /[\u0000-\u001f\u007f]/.test(item)) continue;
    const email = normEmail(item);
    if (!validEmail(email) || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
    if (emails.length >= FESTA_CONTACT_EMAIL_COUNT) break;
  }
  return emails;
}

function contactEmails(state, env) {
  const fromArray = parseStoredContactEmails(state.emails);
  if (fromArray.length) return fromArray;
  const fromLegacy = parseStoredContactEmails(state.email);
  if (fromLegacy.length) return fromLegacy;
  return parseStoredContactEmails(env.FESTA_EMAIL);
}

function parseSubmittedContactEmails(body) {
  let raw;
  if (body.emails !== undefined) {
    if (!Array.isArray(body.emails) || !body.emails.length) {
      fail(400, '파일을 받을 이메일 주소를 1개 이상 입력하세요.');
    }
    raw = body.emails;
  } else if (typeof body.email === 'string') {
    if (/[\u0000-\u001f\u007f]/.test(body.email)) {
      fail(400, '올바른 이메일 주소를 입력하세요.');
    }
    raw = body.email.split(/[,;]/);
  } else {
    fail(400, '파일을 받을 이메일 주소를 1개 이상 입력하세요.');
  }
  if (raw.length > FESTA_CONTACT_EMAIL_COUNT) {
    fail(400, `수신 이메일은 최대 ${FESTA_CONTACT_EMAIL_COUNT}개까지 등록할 수 있습니다.`);
  }
  const seen = new Set();
  const emails = [];
  for (const item of raw) {
    if (typeof item !== 'string' || /[\u0000-\u001f\u007f]/.test(item)) {
      fail(400, '올바른 이메일 주소를 입력하세요.');
    }
    const email = normEmail(item);
    if (!validEmail(email)) {
      fail(400, '올바른 이메일 주소를 입력하세요.');
    }
    if (seen.has(email)) {
      fail(400, '중복된 이메일 주소가 있습니다.');
    }
    seen.add(email);
    emails.push(email);
  }
  if (!emails.length) fail(400, '파일을 받을 이메일 주소를 1개 이상 입력하세요.');
  return emails;
}

function validDeadline(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
const deadlineOf = (state) => state.deadline ?? FESTA_DEFAULT_DEADLINE;
// 한국 날짜의 다음 날 00:00:00부터 마감. 서버/브라우저의 현지 시간대와 무관합니다.
const deadlinePassed = (state) => Date.now() >= Date.parse(`${deadlineOf(state)}T00:00:00+09:00`) + 86400000;

async function readState(env) {
  const obj = await env.BUCKET.get(STATE_KEY);
  if (!obj) return {
    etag: null,
    state: { version: 1, phase: 'open', deadline: FESTA_DEFAULT_DEADLINE, entries: [], scores: [], uploads: [] },
  };
  let state;
  try { state = JSON.parse(await obj.text()); } catch {
    fail(503, '페스타 데이터를 읽지 못했습니다. 관리자에게 문의하세요.');
  }
  // 손상된 명부를 빈 상태로 덮어쓰지 않습니다. 기존/초기 상태에는 uploads가 없을 수 있습니다.
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || !PHASES.includes(state.phase) || !Array.isArray(state.entries)
      || !Array.isArray(state.scores)
      || (state.uploads !== undefined && !Array.isArray(state.uploads))
      || (state.deadline !== undefined && !validDeadline(state.deadline))) {
    fail(503, '페스타 데이터 형식이 올바르지 않습니다. 관리자에게 문의하세요.');
  }
  state.uploads ??= [];
  state.deadline ??= FESTA_DEFAULT_DEADLINE;
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

async function jsonBody(request, maxBytes = 128 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    fail(415, 'JSON 형식으로 요청해 주세요.');
  }
  let body;
  try { body = await new Response(limitedBody(request, maxBytes)).json(); } catch (error) {
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

function entryView(entry, member) {
  const mine = isMine(entry, member);
  const admin = isAdmin(member);
  const author = { name: entry.author?.name || '', institution: entry.author?.institution || '' };
  if (mine || admin) author.email = ownerOf(entry);
  return {
    id: entry.id, institution: entryInstitution(entry), title: entry.title, description: entry.description,
    localOnly: Boolean(entry.localOnly), deployUrl: entry.deployUrl || '', githubUrl: entry.githubUrl,
    files: (entry.files || []).map(({ key, name, size }) => ({ key, name, size })),
    createdAt: entry.createdAt, updatedAt: entry.updatedAt, author, isMine: mine,
  };
}

async function overview(env, member, cors) {
  const { state } = await readState(env);
  const memberEmail = normEmail(member.email);
  const existing = state.entries.filter((entry) => ownerOf(entry) === memberEmail);
  const own = existing.filter((entry) => isMine(entry, member));
  const myEntries = own.map((entry) => entryView(entry, member));
  const emails = contactEmails(state, env);
  const prelimLabels = { mois: '예선 심사(행정안전부)', iwest: '예선 심사(한국서부발전)' };
  const prelimPanels = ['mois', 'iwest'].map((key) => {
    const panel = state.juryPanels?.[key];
    const judge = Array.isArray(panel?.judges)
      ? panel.judges.find((row) => normEmail(row?.email) === memberEmail && !row.revoked)
      : null;
    if (!isAdmin(member) && !judge) return null;
    const completed = Boolean(
      (judge && panel?.completions?.[judge.id])
      || (!judge && isAdmin(member) && panel?.adminPreviews?.[memberEmail]?.completion),
    );
    return {
      key,
      label: prelimLabels[key],
      status: panel?.status || 'draft',
      isJudge: Boolean(judge),
      adminPreview: !judge && isAdmin(member),
      completed,
    };
  }).filter(Boolean);
  return reply({
    phase: state.phase,
    deadline: deadlineOf(state), deadlinePassed: deadlinePassed(state),
    mine: myEntries[0] || null,
    myEntries,
    entryBlocked: existing.some((entry) => !isMine(entry, member)) ? DUPLICATE_ENTRY : '',
    entries: isAdmin(member) ? state.entries.map((entry) => entryView(entry, member)) : [],
    awardsPublished: Boolean(state.awardsPublication),
    finalStatus: state.juryPanels?.final?.status || 'draft',
    prelimPanels,
    email: emails.join(', '),
    emails,
  }, 200, cors);
}

function pruneUploads(state, member) {
  // 두 작품 모두의 첨부(다른 소유자의 기록 포함)를 보호합니다. CAS 재시도 때 다시 계산합니다.
  const attached = new Set(state.entries.flatMap((entry) => (entry?.files || []).map((file) => file.key)));
  const pending = state.uploads.filter((upload) => upload.owner === normEmail(member.email)
    && upload.ownerCreatedAt === incarnationOf(member) && !attached.has(upload.key));
  const discarded = new Set(pending.slice(0, -2 * FESTA_FILE_COUNT).map((upload) => upload.key));
  if (discarded.size) state.uploads = state.uploads.filter((upload) => !discarded.has(upload.key));
  return discarded;
}
const deleteDiscarded = (env, discarded) => Promise.all(
  [...discarded].map((key) => env.BUCKET.delete(key).catch(() => {})),
);

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
    if (!obj || !ownsUploadMetadata(obj.customMetadata, member)) {
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
  if (!INSTITUTIONS.includes(body.institution)) fail(400, '작품의 소속기관을 선택해 주세요.');
  const title = textField(body.title, '작품명', 160);
  const description = textField(body.description, '작품 설명', 10000);
  if (typeof body.localOnly !== 'boolean') fail(400, '로컬 동작 여부를 선택하세요.');
  const localOnly = body.localOnly;
  const deployUrl = localOnly ? '' : webUrl(body.deployUrl, '배포 주소', true);
  const githubUrl = webUrl(body.githubUrl, 'GitHub 저장소 주소', true, true);
  requireOpen((await readState(env)).state);
  const email = normEmail(member.email);
  const id = `fe_${crypto.randomUUID()}`;
  const hasId = Object.hasOwn(body, 'id');
  if (hasId && body.id !== null
      && (typeof body.id !== 'string' || !/^fe_[A-Za-z0-9_-]{1,64}$/.test(body.id))) {
    fail(400, '수정할 작품 번호가 올바르지 않습니다.');
  }
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !REQUEST_ID_RE.test(body.requestId))) {
    fail(400, '작품 접수 요청 번호가 올바르지 않습니다.');
  }
  const requestId = hasId && body.id === null && body.requestId ? body.requestId.toLowerCase() : null;
  // 응답을 받지 못해 재시도한 초안은, 그 후 파일이 교체/정리됐더라도 최신 저장본을 돌려줍니다.
  const checked = await checkedFiles(body.files, env, member)
    .then((files) => ({ files }), (error) => ({ error }));
  const { result } = await updateState(env, (current) => {
    requireOpen(current);
    const sameEmail = current.entries.filter((entry) => ownerOf(entry) === email);
    if (sameEmail.some((entry) => !isMine(entry, member))) fail(409, DUPLICATE_ENTRY);
    const replay = requestId && sameEmail.find((entry) => entry.requestId === requestId);
    if (replay) return { saved: replay, discarded: new Set() };
    if (checked.error) throw checked.error;
    const files = checked.files;
    for (const file of files) {
      if (!current.uploads.some((upload) => upload?.key === file.key && upload.owner === email
          && upload.ownerCreatedAt === incarnationOf(member))) {
        fail(403, '직접 업로드한 페스타 파일만 첨부할 수 있습니다.');
      }
    }
    let existing;
    if (hasId && body.id !== null) {
      existing = current.entries.find((entry) => entry.id === body.id);
      if (!existing) fail(404, '수정할 작품을 찾을 수 없습니다.');
      if (!isMine(existing, member)) fail(403, '본인의 작품만 수정할 수 있습니다.');
    } else if (!hasId) {
      // 이전 캐시 화면은 id를 보내지 않습니다. 한 작품일 때만 옛 수정 동작을 보존합니다.
      if (sameEmail.length > 1) fail(409, '수정할 작품을 선택해 주세요. 화면을 새로고침한 뒤 다시 시도하세요.');
      existing = sameEmail[0];
    }
    if (!existing && sameEmail.length >= FESTA_ENTRY_COUNT) {
      fail(409, `작품은 회원당 최대 ${FESTA_ENTRY_COUNT}개까지 접수할 수 있습니다.`);
    }
    const now = new Date().toISOString();
    const entry = {
      id: existing?.id || id, institution: body.institution, title, description, localOnly, deployUrl, githubUrl, files,
      ...((existing?.requestId || (!existing && requestId))
        ? { requestId: existing?.requestId || requestId } : {}),
      createdAt: existing?.createdAt || now, updatedAt: now,
      author: {
        email, memberCreatedAt: incarnationOf(member),
        name: String(member.name || ''), institution: String(member.institution || ''),
      },
    };
    if (existing) {
      checkInstitutionChange(current, existing, entry.institution);
      current.entries[current.entries.indexOf(existing)] = entry;
    } else current.entries.push(entry);
    return { saved: entry, discarded: pruneUploads(current, member) };
  });
  // 상태에서 먼저 제외한 키만 지워 동시에 저장되는 다른 작품의 파일을 보존합니다.
  await deleteDiscarded(env, result.discarded);
  return reply({ entry: entryView(result.saved, member) }, 200, cors);
}

async function setPhase(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  if (body.phase !== 'closed') fail(400, '심사 단계는 심사위원 관리에서 운영해 주세요.');
  const { state } = await updateState(env, (current) => {
    if (current.phase !== 'open') {
      fail(409, '이미 접수가 마감되었습니다.');
    }
    current.phase = body.phase;
  });
  return reply({ phase: state.phase }, 200, cors);
}

async function setContact(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  const emails = parseSubmittedContactEmails(body);
  const email = emails.join(', ');
  await updateState(env, (state) => {
    state.emails = emails;
    state.email = email;
  });
  return reply({ email, emails }, 200, cors);
}

async function setDeadline(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  if (!validDeadline(body.deadline)) fail(400, '접수 마감일을 올바른 YYYY-MM-DD 날짜로 입력하세요.');
  const { state } = await updateState(env, (current) => {
    // 날짜가 지나도 운영자가 수동 마감하기 전까지는 연장할 수 있습니다.
    if (current.phase !== 'open') fail(409, '접수를 마감한 뒤에는 마감일을 변경할 수 없습니다.');
    current.deadline = body.deadline;
  });
  return reply({ deadline: deadlineOf(state), deadlinePassed: deadlinePassed(state) }, 200, cors);
}

async function setInstitution(request, env, member, cors) {
  requireAdmin(member);
  const { entryId, institution } = await jsonBody(request);
  if (!INSTITUTIONS.includes(institution)) fail(400, '올바른 소속기관을 선택해 주세요.');
  await updateState(env, (state) => {
    const entry = state.entries.find((item) => item.id === entryId);
    if (!entry) fail(404, '작품을 찾을 수 없습니다.');
    checkInstitutionChange(state, entry, institution);
    entry.institution = institution;
  });
  return reply({ entryId, institution }, 200, cors);
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
      return pruneUploads(state, member);
    });
    discarded = update.result;
  } catch (error) {
    // 업로드 중 접수가 마감된 경우 출품 가능한 파일로 남기지 않습니다.
    await env.BUCKET.delete(key).catch(() => {});
    throw error;
  }
  // 목록에서 먼저 제외했으므로 동시에 저장한 작품의 첨부를 삭제하지 않습니다.
  await deleteDiscarded(env, discarded);
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
  if (!isAdmin(member) && !mine) {
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
  try {
    if (!member) fail(401, '로그인이 필요합니다.');
    if (path === '/festa' && request.method === 'GET') return await overview(env, member, cors);
    if (request.method === 'POST') {
      if (path === '/festa/entry') return await saveEntry(request, env, member, cors);
      if (path === '/festa/phase') return await setPhase(request, env, member, cors);
      if (path === '/festa/contact') return await setContact(request, env, member, cors);
      if (path === '/festa/deadline') return await setDeadline(request, env, member, cors);
      if (path === '/festa/institution') return await setInstitution(request, env, member, cors);
      if (path === '/festa/score') fail(403, '심사위원 전용 링크에서 평가해 주세요.');
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

export { readState, updateState, fail, reply, jsonBody, requireAdmin };
