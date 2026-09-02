/**
 * Workers(정적 자산) 배포용 진입점.
 *
 * Cloudflare 는 이제 신규 프로젝트에 Pages 대신 **Workers + static assets** 를
 * 권장합니다. 그 방식으로 배포한다면 `functions/` 폴더는 쓰이지 않으므로
 * 이 파일이 대신 /api 를 처리하고 나머지는 정적 자산으로 넘깁니다.
 *
 * Pages 로 배포한다면 이 파일은 필요 없습니다
 * (`functions/api/[[path]].js` 가 같은 일을 합니다).
 *
 * wrangler.jsonc 예시:
 *
 *   {
 *     "name": "ai-leaders-academy",
 *     "main": "shared/worker-entry.js",
 *     "compatibility_date": "2026-08-01",
 *     "assets": { "directory": "./", "binding": "ASSETS" },
 *     "r2_buckets": [
 *       { "binding": "BUCKET", "bucket_name": "assignment-hub" }
 *     ]
 *   }
 */
import { handleApi } from './r2api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // ctx 는 실제 Workers 런타임이 항상 넘겨주지만, 없어도(예: 테스트) 죽지 않게 방어합니다.
      return handleApi(request, env, { basePath: '/api', waitUntil: ctx?.waitUntil?.bind(ctx) });
    }

    // 나머지는 정적 파일. assets 바인딩이 없으면 설정이 잘못된 것이라
    // 조용히 404 를 내기보다 원인을 알려줍니다.
    if (!env.ASSETS) {
      return new Response(
        'assets 바인딩이 없습니다. wrangler 설정의 assets.binding 을 "ASSETS" 로 지정하세요.',
        { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      );
    }
    return env.ASSETS.fetch(request);
  },
};
