import { store } from './store/index.js';

export const FESTA_RUBRIC = [
  { name: '문제 인식', max: 40, weight: 4, description: '어떤 현장의 문제를 왜 해결해야 하며, 그 문제를 얼마나 정확하게 이해했는가?' },
  { name: '기능 구현 수준', max: 30, weight: 3, description: '문제 해결에 필요한 기능이 실제로 만들어져 작동하는가?' },
  { name: '완성도', max: 20, weight: 2, description: '구현된 기능이 얼마나 정확하고, 안정적이며 사용하기 편리한가?' },
  { name: '확산 가능성', max: 10, weight: 1, description: '다른 업무나 부서에서도 활용할 수 있는가?' },
];

export const FESTA_RAW_MIN = 1;
export const FESTA_RAW_MAX = 10;

export function validFestaScores(scores) {
  return Array.isArray(scores) && scores.length === FESTA_RUBRIC.length
    && scores.every((score, i) => Number.isInteger(score) && score >= 0 && score <= FESTA_RUBRIC[i].max);
}

export function validRawFestaScores(rawScores) {
  return Array.isArray(rawScores) && rawScores.length === FESTA_RUBRIC.length
    && rawScores.every((score) => Number.isInteger(score) && score >= FESTA_RAW_MIN && score <= FESTA_RAW_MAX);
}

export function convertRawFestaScores(rawScores) {
  if (!validRawFestaScores(rawScores)) return null;
  return rawScores.map((score, i) => score * FESTA_RUBRIC[i].weight);
}

export function deriveRawFestaScores(scores) {
  if (!validFestaScores(scores)) return null;
  const raw = scores.map((score, i) => score / FESTA_RUBRIC[i].weight);
  return validRawFestaScores(raw) ? raw : null;
}

export function rankPrelimRows(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    for (let i = 0; i < FESTA_RUBRIC.length; i += 1) {
      if ((b.scores[i] || 0) !== (a.scores[i] || 0)) return (b.scores[i] || 0) - (a.scores[i] || 0);
    }
    return (a.order ?? 0) - (b.order ?? 0);
  });
  let prevTotal = null;
  let rank = 0;
  return sorted.map((row, index) => {
    if (row.total !== prevTotal) {
      rank = index + 1;
      prevTotal = row.total;
    }
    return { ...row, rank };
  });
}

// 접수·평가 권한과 마감 시각은 운영 서버가 판단합니다.
function server() {
  if (store?.kind !== 'r2') {
    throw new Error('페스타는 운영 사이트에서 이용할 수 있습니다. 저장소 설정을 확인해 주세요.');
  }
  return store;
}

export const festa = {
  get: () => server().json('/festa', { cache: 'no-store' }),
  saveEntry: (entry) => server().post('/festa/entry', entry),
  phase: (phase) => server().post('/festa/phase', { phase }),
  deadline: (deadline) => server().post('/festa/deadline', { deadline }),
  contact: (emails) => server().post('/festa/contact', Array.isArray(emails) ? { emails } : { email: emails }),
  async upload(file) {
    const body = new FormData();
    body.append('file', file);
    const result = await server().json('/festa/upload', { method: 'POST', body });
    return result.file;
  },
  fileUrl: (file) => `${server().base}/festa/file/${encodeURIComponent(file.key)}`,
};
