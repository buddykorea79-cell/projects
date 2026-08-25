/**
 * 저장소 선택 + 도메인 규칙.
 * 화면 코드는 이 모듈만 import 하고, 어떤 백엔드인지 신경 쓰지 않습니다.
 */
import { CONFIG } from '../config.js';
import { LocalStore } from './local.js';
import { GitHubStore } from './github.js';
import { makeCode, normEmail, isPastDue } from '../utils.js';

const MODE_KEY = 'ah.storageMode';

/** config 값보다 브라우저 설정을 우선합니다 (관리자가 화면에서 전환 가능). */
export function currentMode() {
  try {
    const override = localStorage.getItem(MODE_KEY);
    if (override === 'local' || override === 'github') return override;
  } catch { /* private mode */ }
  return CONFIG.storage === 'github' ? 'github' : 'local';
}

export function setMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

export let store = null;

export async function initStore() {
  store = currentMode() === 'github' ? new GitHubStore() : new LocalStore();
  await store.init();
  if (store.kind === 'local') await seedIfEmpty();
  return store;
}

/* --------------------------------------------------------------- 시드 -- */

async function seedIfEmpty() {
  const existing = await store.listProjects();
  if (existing.length) return;
  const now = Date.now();
  const inDays = (d) => new Date(now + d * 86400000).toISOString();

  await store.saveProject({
    title: '1주차 · 브랜드 디자인 시스템 분석',
    description:
      '담당 브랜드를 하나 선택해 색상·타이포그래피·컴포넌트 규칙을 정리하고, '
      + '분석 결과를 이미지 또는 문서로 제출하세요.\n\n'
      + '· 분량 제한 없음\n· 참고한 출처는 본문 하단에 표기',
    status: 'open',
    visibility: 'private',
    dueAt: inDays(7),
    allowFiles: true,
    requireInstitution: true,
    createdAt: new Date(now - 86400000).toISOString(),
  });

  await store.saveProject({
    title: '2주차 · 랜딩 페이지 프로토타입',
    description:
      '1주차에서 정리한 디자인 시스템을 적용해 랜딩 페이지 시안을 만들고 '
      + '화면 캡처 또는 시연 영상을 첨부하세요.',
    status: 'open',
    visibility: 'public',
    dueAt: inDays(14),
    allowFiles: true,
    requireInstitution: true,
    createdAt: new Date(now - 3600000).toISOString(),
  });
}

/* ----------------------------------------------------- 도메인 헬퍼 -- */

/**
 * 같은 이메일로 이미 제출한 적이 있으면 그 수정코드를 재사용합니다.
 * 덕분에 한 사람이 여러 프로젝트에 제출해도 외울 코드는 하나뿐입니다.
 */
export async function issueCode(email) {
  const mine = await store.listSubmissions({ email: normEmail(email) });
  const existing = mine.find((s) => s.editCode);
  return existing ? existing.editCode : makeCode(CONFIG.editCodeLength);
}

/** 신규 제출 레코드를 만듭니다. 수정코드가 함께 발급됩니다. */
export async function newSubmission({ projectId, author, title, body }) {
  const email = normEmail(author.email);
  return {
    projectId,
    author: {
      institution: (author.institution || '').trim(),
      name: (author.name || '').trim(),
      email,
    },
    title: (title || '').trim(),
    body: (body || '').trim(),
    files: [],
    editCode: await issueCode(email),
    status: 'submitted',
  };
}

/** 이메일 + 수정코드가 맞는지. 대소문자/공백은 관대하게 봅니다. */
export function verifyOwner(sub, email, code) {
  if (!sub) return false;
  const e = normEmail(email);
  const c = String(code || '').trim().toUpperCase();
  return sub.author?.email === e && String(sub.editCode || '').toUpperCase() === c;
}

/** 지금 이 프로젝트가 제출을 받을 수 있는 상태인지. */
export function submissionOpen(project) {
  if (!project) return false;
  if (project.status !== 'open') return false;
  return !isPastDue(project.dueAt);
}

export function closedReason(project) {
  if (!project) return '프로젝트를 찾을 수 없습니다.';
  if (project.status !== 'open') return '관리자가 이 프로젝트의 제출을 마감했습니다.';
  if (isPastDue(project.dueAt)) return '제출 마감일이 지났습니다.';
  return '';
}
