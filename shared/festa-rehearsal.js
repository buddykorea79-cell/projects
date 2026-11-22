/** Build Camp 리허설: 원본을 읽기만 하고 실행별 Festa 사본 하나에만 기록합니다. */
import { conditionFor, normEmail } from './auth.js';
import { isCamp } from './camp.js';
import { fail, reply, jsonBody, requireAdmin, validEmail } from './festa.js';
import { handleJury } from './festa-jury.js';
import { handleAwards } from './festa-awards.js';

export const REHEARSAL_KEY = 'data/festa-rehearsal.json';
const LIVE_KEY = 'data/festa.json';
const RUN_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ORGS = ['행정안전부', '한국서부발전'];
const NOTICE = '리허설 전용입니다. 기관·누락 정보·예시 점수는 가상으로 보충할 수 있으며 실제 행사 결과와 원본 작품에는 반영되지 않습니다.';
const SAMPLE_TITLES = ['민원 서류 준비 도우미', '현장 점검 기록 정리', '회의 후속 업무 보드', '발전 설비 점검 알림', '교육 일정 한눈에 보기', '업무 자료 검색 도우미'];
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const isAdmin = (member) => member?.role === 'admin';
const requireMember = (member) => { if (!member) fail(401, '리허설에 참여하려면 로그인하세요.'); };
const org = (value) => ORGS.includes(value) ? value : '';
const sourceKeyAllowed = (key) => typeof key === 'string' && key.startsWith('uploads/')
  && key.length <= 400 && !/\.\.|\/\/|\\|[\u0000-\u001f\u007f]/.test(key);

async function readArray(env, key) {
  const object = await env.BUCKET.get(key);
  if (!object) return [];
  let rows;
  try { rows = JSON.parse(await object.text()); } catch { fail(503, '빌드캠프 원본 데이터를 읽지 못했습니다.'); }
  if (!Array.isArray(rows)) fail(503, '빌드캠프 원본 데이터 형식을 확인해 주세요.');
  return rows;
}

async function catalog(env) {
  const [projects, submissions] = await Promise.all([
    readArray(env, 'data/projects.json'), readArray(env, 'data/submissions.json'),
  ]);
  const camps = new Map(projects.filter((row) => row && isCamp(row)).map((row) => [row.id, row]));
  const ids = new Map();
  for (const row of submissions) if (row && camps.has(row.projectId)) ids.set(row.id, (ids.get(row.id) || 0) + 1);
  return submissions.filter((row) => row && camps.has(row.projectId)).map((row) => {
    const project = camps.get(row.projectId);
    const eligible = typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.id) && ids.get(row.id) === 1;
    return {
      id: clean(row.id, 64), projectId: clean(row.projectId, 64), projectTitle: clean(project.title, 200),
      title: clean(row.title, 160), description: clean(row.body, 10000),
      author: { name: clean(row.author?.name, 60), email: normEmail(row.author?.email), institution: clean(row.author?.institution, 120) },
      institution: org(row.author?.institution), visibility: project.visibility === 'public' ? 'public' : 'private',
      eligible, issues: eligible ? [] : ['원본 작품 번호가 없거나 중복되었습니다.'],
      files: Array.isArray(row.files) ? row.files.filter((file) => sourceKeyAllowed(file?.key)).slice(0, 20).map((file) => ({
        key: file.key, name: clean(file.name, 200) || file.key.split('/').pop(), size: Number(file.size) || 0,
      })) : [],
      ...sourceUrls(row),
      presenting: Boolean(row.presenting), updatedAt: clean(row.updatedAt || row.createdAt, 40),
    };
  }).sort((a, b) => Number(b.presenting) - Number(a.presenting)
    || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

function safeUrl(value, github = false) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    if (github && (url.protocol !== 'https:' || url.hostname !== 'github.com'
        || !/^\/[^/]+\/[^/]+(?:\/.*)?$/.test(url.pathname))) return '';
    return url.href;
  } catch { return ''; }
}

function sourceUrls(row) {
  const candidates = (typeof row.body === 'string' ? row.body.match(/https?:\/\/[^\s<>"'`]+/g) || [] : [])
    .map((url) => safeUrl(url.replace(/[)\]}>,.;!?，。]+$/g, ''))).filter(Boolean);
  return {
    deployUrl: safeUrl(row.deployUrl) || candidates.find((url) => !['github.com', 'www.github.com'].includes(new URL(url).hostname)) || '',
    githubUrl: safeUrl(row.githubUrl, true) || candidates.map((url) => safeUrl(url, true)).find(Boolean) || '',
  };
}

function distinctSources(rows) {
  const authors = new Set();
  return rows.filter((row) => {
    if (!row.eligible) return false;
    const identity = validEmail(row.author.email) ? row.author.email : 'missing:' + row.id;
    if (authors.has(identity)) return false;
    authors.add(identity); return true;
  });
}

async function readRehearsal(env) {
  const object = await env.BUCKET.get(REHEARSAL_KEY);
  if (!object) return { object: null, state: null, etag: null };
  let state;
  try { state = JSON.parse(await object.text()); } catch { fail(503, '리허설 데이터를 읽지 못했습니다.'); }
  if (!state || state.version !== 1 || !state.rehearsal || typeof state.rehearsal.active !== 'boolean'
      || !Array.isArray(state.entries) || !Array.isArray(state.scores) || !Array.isArray(state.uploads)) {
    fail(503, '리허설 데이터 형식을 확인해 주세요.');
  }
  return { object, state, etag: object.etag };
}

function requireRun(state, runId) {
  if (!RUN_RE.test(runId || '') || !state?.rehearsal?.active || state.rehearsal.runId !== runId) {
    fail(409, '종료되었거나 새로 시작된 리허설입니다. 리허설 목록에서 다시 입장하세요.');
  }
}

function rehearsalInfo(state) {
  return { notice: NOTICE, seededScores: true,
    realCount: state?.rehearsal?.realCount || 0, sampleCount: state?.rehearsal?.sampleCount || 0 };
}

function statusView(state, member) {
  const active = Boolean(state?.rehearsal?.active);
  const result = { active, runId: active ? state.rehearsal.runId : null,
    lastRunId: state?.rehearsal?.endedRunId || null,
    startedAt: active ? state.rehearsal.startedAt : null,
    phase: active ? state.juryPanels?.final?.status || 'open' : null,
    published: active && Boolean(state.awardsPublication), entryCount: active ? state.entries.length : 0,
    isAdmin: isAdmin(member), rehearsal: rehearsalInfo(active ? state : null) };
  if (active && isAdmin(member)) result.entries = state.entries.map((entry) => ({
    id: entry.id, title: entry.title, institution: entry.institution, author: entry.author, rehearsal: entry.rehearsal,
  }));
  return result;
}

function assignInstitutions(entries) {
  const count = (institution) => entries.filter((entry) => entry.institution === institution).length;
  for (const entry of entries) if (!entry.institution) {
    entry.institution = count(ORGS[0]) < 2 ? ORGS[0] : count(ORGS[1]) < 1 ? ORGS[1]
      : count(ORGS[0]) <= count(ORGS[1]) ? ORGS[0] : ORGS[1];
  }
  for (const [institution, minimum] of [[ORGS[0], 2], [ORGS[1], 1]]) {
    for (const entry of [...entries].reverse()) {
      if (count(institution) >= minimum) break;
      if (entry.institution !== institution) entry.institution = institution;
    }
  }
  for (const entry of entries) {
    if (entry.institution !== entry.rehearsal.originalInstitution) entry.rehearsal.syntheticFields.push('institution');
    entry.author.institution = entry.institution;
  }
}

async function makeState(env, sources, selections, operator) {
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();
  let selected;
  if (selections === undefined) {
    selected = distinctSources(sources).slice(0, 6).map((source) => ({ source }));
  } else {
    if (!Array.isArray(selections) || selections.length > 6) fail(400, '실제 작품은 최대 6개까지 선택하세요.');
    const byId = new Map(sources.map((row) => [row.id, row]));
    const seen = new Set(); const authors = new Set();
    selected = selections.map((selection) => {
      const source = byId.get(selection?.sourceId);
      if (!source?.eligible || seen.has(source.id)) fail(400, '중복 없는 유효한 빌드캠프 작품을 선택하세요.');
      seen.add(source.id);
      if (selection.institution !== undefined && !org(selection.institution)) fail(400, '리허설 배정 기관을 선택하세요.');
      if (validEmail(source.author.email)) {
        if (authors.has(source.author.email)) fail(400, '한 참가자의 작품은 하나만 선택하세요.');
        authors.add(source.author.email);
      }
      return { source, institution: selection.institution };
    });
  }
  const fileMap = {};
  const entries = [];
  for (let index = 0; index < 6; index += 1) {
    const source = selected[index]?.source;
    const syntheticFields = [];
    const pick = (field, actual, fallback) => { if (actual) return actual; syntheticFields.push(field); return fallback; };
    const name = pick('name', source?.author.name, '가상 참가자 ' + (index + 1));
    const email = pick('email', validEmail(source?.author.email) ? source.author.email : '', 'participant-' + index + '-' + runId + '@rehearsal.invalid');
    const title = pick('title', source?.title, SAMPLE_TITLES[index] + ' (가상 샘플)');
    const description = pick('description', source?.description, '반복되는 업무를 정리하고 필요한 정보를 한눈에 확인하는 리허설용 가상 작품입니다. 실제 배포 서비스가 아닙니다.');
    if (!source?.deployUrl) syntheticFields.push('localOnly');
    const files = [];
    for (const file of source?.files || []) {
      const object = typeof env.BUCKET.head === 'function' ? await env.BUCKET.head(file.key) : await env.BUCKET.get(file.key);
      if (!object || !object.size) { if (!syntheticFields.includes('files')) syntheticFields.push('files'); continue; }
      const extension = (file.name.toLowerCase().match(/\.([a-z0-9]{1,12})$/) || [])[1] || 'bin';
      const key = 'festa/uploads/' + crypto.randomUUID() + '.' + extension;
      files.push({ key, name: file.name, size: object.size });
      fileMap[key] = { key: file.key, etag: object.etag };
    }
    entries.push({ id: 'fe_' + crypto.randomUUID(), title, description,
      institution: org(selected[index]?.institution) || org(source?.institution),
      localOnly: !source?.deployUrl, deployUrl: source?.deployUrl || '', githubUrl: source?.githubUrl || '',
      files, createdAt: now, updatedAt: now,
      author: { name, email, institution: '', memberCreatedAt: '' },
      rehearsal: { sample: !source, sourceId: source?.id || null, projectId: source?.projectId || null,
        projectTitle: source?.projectTitle || '가상 리허설 샘플', originalInstitution: source?.author.institution || '',
        syntheticFields, notice: '' },
    });
  }
  assignInstitutions(entries);
  for (const entry of entries) {
    entry.rehearsal.notice = entry.rehearsal.sample ? '실제 출품작이 아닌 가상 리허설 샘플입니다.'
      : entry.rehearsal.syntheticFields.length ? '빌드캠프 원본의 사본입니다. 누락 정보 또는 기관을 리허설용으로 가상 보충했습니다.'
        : '빌드캠프 원본의 리허설용 사본입니다.';
    entry.description = '[리허설] ' + entry.rehearsal.notice + '\n\n' + entry.description;
  }
  const judge = { id: 'fj_' + crypto.randomUUID(), name: '리허설 가상 심사위원', email: 'seed-' + runId + '@rehearsal.invalid', revoked: true };
  const seedPanel = (panelEntries, final) => ({ status: final ? 'open' : 'closed',
    entryIds: panelEntries.map((entry) => entry.id), judges: [judge],
    scores: panelEntries.map((entry) => ({ judgeId: judge.id, entryId: entry.id,
      scores: [40 - entries.indexOf(entry), 28, 19, 9], updatedAt: now })),
    ...(final ? { memberScores: [] } : { closedAt: now }), openedAt: now,
  });
  return { version: 1, phase: 'closed', deadline: '2099-12-31', entries, scores: [], uploads: [],
    juryPanels: { mois: seedPanel(entries.filter((entry) => entry.institution === ORGS[0]), false),
      iwest: seedPanel(entries.filter((entry) => entry.institution === ORGS[1]), false), final: seedPanel(entries, true) },
    rehearsal: { active: true, runId, startedAt: now, createdBy: operator,
      realCount: selected.length, sampleCount: 6 - selected.length, notice: NOTICE,
      secret: crypto.randomUUID() + crypto.randomUUID(), fileMap },
  };
}

async function start(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  if (body.confirm !== true) fail(400, '선택 작품과 가상 정보의 리허설 사용을 확인해 주세요.');
  const state = await createRehearsal(env, { selections: body.selections, expectedRunId: body.expectedRunId, operator: normEmail(member.email) });
  return reply(statusView(state, member), 200, cors);
}

/** 인증된 UI와 Cloudflare 관리 도구가 공유하는 CAS 생성 서비스. HTTP에서는 start가 관리자/확인을 검사합니다. */
export async function createRehearsal(env, { selections, expectedRunId, operator } = {}) {
  if (typeof operator !== 'string' || !operator.trim() || operator.length > 254 || /[\u0000-\u001f\u007f]/.test(operator)) {
    fail(400, '리허설을 생성하는 운영 주체를 기록해 주세요.');
  }
  const original = await readRehearsal(env);
  if (original.state?.rehearsal.active) {
    fail(409, '진행 중인 리허설을 먼저 초기화하고 다시 시작하세요.');
  }
  if (expectedRunId !== undefined && expectedRunId !== (original.state?.rehearsal?.endedRunId || null)) {
    fail(409, '리허설이 초기화된 뒤 상태가 변경되었습니다. 현재 상태를 확인하고 다시 시작하세요.');
  }
  const state = await makeState(env, await catalog(env), selections, operator.trim());
  const saved = await env.BUCKET.put(REHEARSAL_KEY, JSON.stringify(state), {
    onlyIf: conditionFor(original.etag), httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  if (!saved) fail(409, '리허설 상태가 변경되었습니다. 화면을 다시 확인하세요.');
  return state;
}

async function reset(request, env, member, cors) {
  requireAdmin(member);
  const body = await jsonBody(request);
  if (body.confirm !== true) fail(400, '현재 리허설의 초기화를 확인해 주세요.');
  const { state, etag } = await readRehearsal(env);
  requireRun(state, body.runId);
  const cleared = { version: 1, phase: 'closed', entries: [], scores: [], uploads: [],
    rehearsal: { active: false, runId: null, endedRunId: body.runId, endedAt: new Date().toISOString() } };
  const saved = await env.BUCKET.put(REHEARSAL_KEY, JSON.stringify(cleared), {
    onlyIf: conditionFor(etag), httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  if (!saved) fail(409, '리허설 상태가 변경되었습니다. 초기화 대상을 다시 확인하세요.');
  return reply(statusView(cleared, member), 200, cors);
}

/** 기존 심사/발표 코드가 운영 Festa 또는 원본 파일을 쓸 수 없는 좁은 R2 인터페이스. */
export async function rehearsalEnvironment(env, runId) {
  const initial = await readRehearsal(env);
  requireRun(initial.state, runId);
  const current = async () => {
    const result = await readRehearsal(env); requireRun(result.state, runId); return result;
  };
  const bucket = {
    async get(key) {
      const { object, state } = await current();
      // R2 객체의 body는 한 번만 읽을 수 있습니다. readRehearsal이 소비한 객체를 다시 반환하지 않습니다.
      if (key === LIVE_KEY) return { etag: object.etag, text: async () => JSON.stringify(state) };
      const source = state.rehearsal.fileMap?.[key];
      if (!source || !sourceKeyAllowed(source.key)) fail(403, '선택된 리허설 첨부파일만 읽을 수 있습니다.');
      const file = await env.BUCKET.get(source.key);
      if (!file || file.etag !== source.etag) fail(409, '원본 첨부파일이 변경되었습니다. 리허설을 다시 준비하세요.');
      return file;
    },
    async put(key, value, options = {}) {
      await current();
      if (key !== LIVE_KEY || !options.onlyIf) fail(403, '리허설 상태 외에는 저장할 수 없습니다.');
      let state;
      try { state = JSON.parse(value); } catch { fail(400, '리허설 저장 형식이 올바르지 않습니다.'); }
      requireRun(state, runId);
      return env.BUCKET.put(REHEARSAL_KEY, value, options);
    },
    async delete() { fail(403, '리허설에서 원본 파일을 삭제할 수 없습니다.'); },
  };
  return { ...env, TOKEN_SECRET: initial.state.rehearsal.secret, BUCKET: bucket };
}

async function decorate(response, env, runId, member) {
  if (!response.headers.get('Content-Type')?.includes('application/json')) return response;
  const body = await response.json();
  const { state } = await readRehearsal(env); requireRun(state, runId);
  const meta = new Map(state.entries.map((entry) => [entry.id, entry.rehearsal]));
  if (Array.isArray(body.entries)) body.entries = body.entries.map((entry) => {
    const provenance = meta.get(entry.id);
    return { ...entry, rehearsal: !provenance || isAdmin(member) ? provenance
      : { sample: provenance.sample, syntheticFields: provenance.syntheticFields, notice: provenance.notice } };
  });
  body.rehearsal = { ...rehearsalInfo(state), runId };
  return reply(body, response.status, Object.fromEntries(response.headers));
}

export async function handleRehearsal(request, env, { path, member, cors = {} }) {
  requireMember(member);
  if (path === '/festa/rehearsal/status' && request.method === 'GET') {
    return reply(statusView((await readRehearsal(env)).state, member), 200, cors);
  }
  if (path === '/festa/rehearsal/sources' && request.method === 'GET') {
    requireAdmin(member);
    const sources = await catalog(env);
    const realCount = distinctSources(sources).length;
    return reply({ sources: sources.map(({ files, ...source }) => ({ ...source, files: files.map(({ name, size }) => ({ name, size })) })),
      realCount, neededSamples: Math.max(0, 6 - realCount), notice: NOTICE }, 200, cors);
  }
  if (path === '/festa/rehearsal/start' && request.method === 'POST') return start(request, env, member, cors);
  if (path === '/festa/rehearsal/reset' && request.method === 'POST') return reset(request, env, member, cors);
  const match = path.match(/^\/festa\/rehearsal\/([a-f0-9-]{36})(\/.*)$/);
  if (!match) fail(404, '리허설 경로를 찾을 수 없습니다.');
  const [, runId, suffix] = match;
  const mapped = '/festa' + suffix;
  const reading = request.method === 'GET';
  const writing = request.method === 'POST';
  const memberRead = reading && (suffix === '/jury/member-final' || suffix.startsWith('/jury/member-file/') || suffix === '/awards');
  const memberWrite = writing && suffix === '/jury/member-score';
  const adminRead = reading && ['/jury/admin', '/awards/preview'].includes(suffix);
  const adminWrite = writing && ['/jury/status', '/awards/preview', '/awards/publish'].includes(suffix);
  if (!memberRead && !memberWrite && !adminRead && !adminWrite) fail(404, '허용되지 않은 리허설 요청입니다.');
  if (adminRead || adminWrite) requireAdmin(member);
  if (suffix === '/jury/status') {
    const body = await jsonBody(request.clone());
    if (body.panel !== 'final' || body.status !== 'closed') fail(400, '리허설에서는 2차 평가 마감만 할 수 있습니다.');
  }
  const scoped = await rehearsalEnvironment(env, runId);
  const response = suffix.startsWith('/awards')
    ? await handleAwards(request, scoped, { path: mapped, member, cors })
    : await handleJury(request, scoped, { path: mapped, member, cors });
  return decorate(response, env, runId, member);
}
