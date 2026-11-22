import { store } from './store/index.js';

export const FESTA_RUBRIC = [
  { name: '문제 인식', max: 40, description: '어떤 현장의 문제를 왜 해결해야 하며, 그 문제를 얼마나 정확하게 이해했는가?' },
  { name: '기능 구현 수준', max: 30, description: '문제 해결에 필요한 기능이 실제로 만들어져 작동하는가?' },
  { name: '완성도', max: 20, description: '구현된 기능이 얼마나 정확하고, 안정적이며 사용하기 편리한가?' },
  { name: '확산 가능성', max: 10, description: '다른 업무나 부서에서도 활용할 수 있는가?' },
];

export function validFestaScores(scores) {
  return Array.isArray(scores) && scores.length === FESTA_RUBRIC.length
    && scores.every((score, i) => Number.isInteger(score) && score >= 0 && score <= FESTA_RUBRIC[i].max);
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
  contact: (email) => server().post('/festa/contact', { email }),
  async upload(file) {
    const body = new FormData();
    body.append('file', file);
    const result = await server().json('/festa/upload', { method: 'POST', body });
    return result.file;
  },
  fileUrl: (file) => `${server().base}/festa/file/${encodeURIComponent(file.key)}`,
};
