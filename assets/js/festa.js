import { store } from './store/index.js';

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
  contact: (email) => server().post('/festa/contact', { email }),
  score: (entryId, scores) => server().post('/festa/score', { entryId, scores }),
  async upload(file) {
    const body = new FormData();
    body.append('file', file);
    const result = await server().json('/festa/upload', { method: 'POST', body });
    return result.file;
  },
  fileUrl: (file) => `${server().base}/festa/file/${encodeURIComponent(file.key)}`,
};
