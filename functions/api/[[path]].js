/**
 * Cloudflare Pages Function — /api/* 전부를 R2 핸들러로 넘깁니다.
 *
 * 사이트와 같은 도메인에서 돌기 때문에 CORS 설정도, 별도 배포도 필요 없습니다.
 * Cloudflare 대시보드에서 R2 버킷을 `BUCKET` 이름으로 바인딩하기만 하면 됩니다.
 * (Pages 프로젝트 → Settings → Functions → R2 bucket bindings)
 */
import { handleApi } from '../../shared/r2api.js';

export const onRequest = (context) => handleApi(context.request, context.env, {
  basePath: '/api',
  waitUntil: context.waitUntil.bind(context),
});
