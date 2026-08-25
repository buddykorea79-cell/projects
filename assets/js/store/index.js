/**
 * 저장소 선택 + 도메인 규칙.
 * 화면 코드는 이 모듈만 import 하고, 어떤 백엔드인지 신경 쓰지 않습니다.
 */
import { CONFIG } from '../config.js';
import { LocalStore } from './local.js';
import { GitHubStore } from './github.js';
import { R2Store } from './r2.js';
import { isPastDue } from '../utils.js';

const MODE_KEY = 'ah.storageMode';
const MODES = ['local', 'github', 'r2'];

/** config 값보다 브라우저 설정을 우선합니다 (관리자가 화면에서 전환 가능). */
export function currentMode() {
  try {
    const override = localStorage.getItem(MODE_KEY);
    if (MODES.includes(override)) return override;
  } catch { /* private mode */ }
  return MODES.includes(CONFIG.storage) ? CONFIG.storage : 'local';
}

export function setMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

export let store = null;

const FACTORY = {
  local: () => new LocalStore(),
  github: () => new GitHubStore(),
  r2: () => new R2Store(),
};

export async function initStore() {
  store = (FACTORY[currentMode()] || FACTORY.local)();
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
