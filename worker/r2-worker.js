/**
 * R2 저장소 API 를 독립 Worker 로 띄우고 싶을 때 쓰는 진입점.
 *
 * Cloudflare Pages 로 배포한다면 이 파일은 필요 없습니다.
 * `functions/api/[[path]].js` 가 같은 핸들러를 사이트와 같은 도메인에서
 * 자동으로 서비스하기 때문입니다 (그 편이 CORS 도 없고 배포도 한 번입니다).
 *
 * 사이트를 Cloudflare 밖(예: GitHub Pages)에 두면서 파일만 R2 에 넣고 싶을 때만
 * 이걸 쓰세요.
 *
 *   wrangler deploy --config wrangler.r2.toml
 *
 * 그리고 assets/js/config.js 에서:
 *   storage: 'r2',
 *   r2: { apiBase: 'https://<이름>.<계정>.workers.dev' }
 *
 * 이때는 사이트가 다른 도메인이므로 ALLOWED_ORIGINS 를 반드시 지정해야 합니다.
 */
import { handleApi } from '../shared/r2api.js';

export default {
  // 독립 Worker 에서는 경로 앞에 /api 가 붙지 않으므로 basePath 를 비웁니다.
  fetch: (request, env) => handleApi(request, env, { basePath: '' }),
};
