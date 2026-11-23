/**
 * Workers(정적 자산) 배포용 진입점.
 *
 * Cloudflare 는 이제 신규 프로젝트에 Pages 대신 **Workers + static assets** 를
 * 권장합니다. 이 파일이 /api 를 처리하고 나머지는 보안 헤더를 붙여 정적 자산으로
 * 넘깁니다.
 */
import { handleApi } from './r2api.js';

function withSecurityHeaders(response, url) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (url.protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  const ct = headers.get('Content-Type') || '';
  if (ct.includes('text/html')) {
    const isReceipt = url.pathname === '/receipt' || url.pathname.startsWith('/receipt/');
    const scriptSrc = isReceipt
      ? "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com"
      : "script-src 'self'";
    headers.set('Content-Security-Policy', [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
    const res = await env.ASSETS.fetch(request);
    return withSecurityHeaders(res, url);
  },
};
