/**
 * 메일 발송 (선택) — Google Apps Script 웹훅 경유
 * ---------------------------------------------------------------------------
 * 이 사이트는 자체 메일 서버가 없습니다. 대신 관리자의 Google 계정에 만든
 * Apps Script 웹앱(무료)을 발송 창구로 씁니다. 서버는 그 웹앱 URL 로
 * { secret, to, subject, text } 를 POST 하고, 웹앱이 관리자 Gmail 명의로
 * 메일을 보냅니다. 웹앱 만들기는 docs/SETUP.md 의 "E. 메일로 재설정 링크
 * 자동 발송" 을 보세요.
 *
 * 환경변수 (전부 선택 — 하나라도 비어 있으면 메일 기능만 조용히 꺼집니다.
 * 텔레그램과 마찬가지로, 메일이 죽어 있어도 본 기능은 절대 실패하지 않습니다)
 *   EMAIL_WEBHOOK_URL     Apps Script 웹앱 배포 URL (https://script.google.com/...)
 *   EMAIL_WEBHOOK_SECRET  웹앱 스크립트에 적어둔 것과 동일한 비밀 문자열
 *   SITE_NAME             (선택) 메일 제목·발신자 표시 이름. 기본 'AI 리더스 아카데미'
 *
 * 참고: 개인 Gmail 은 하루 약 100통 발송 제한이 있습니다. 교육 과정 규모에는
 * 충분하지만, 대량 발송 용도는 아닙니다.
 */
import { RESET_TOKEN_TTL_MS } from './auth.js';

/** 실패해도 절대 던지지 않는 best-effort 발송. */
async function callEmailWebhook(env, payload) {
  if (!env.EMAIL_WEBHOOK_URL || !env.EMAIL_WEBHOOK_SECRET) return null;
  try {
    // Apps Script 는 302 리다이렉트로 응답하므로 fetch 기본값(follow)이 필요합니다.
    // 비밀값은 리다이렉트를 건너도 유지되도록 헤더가 아닌 본문에 넣습니다.
    const res = await fetch(env.EMAIL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.EMAIL_WEBHOOK_SECRET, ...payload }),
    });
    return res.ok;
  } catch {
    return null;
  }
}

/** 응답을 늦추지 않도록 waitUntil 로 흘려보냅니다 (shared/telegram.js 와 동일한 패턴). */
function fire(waitUntil, promise) {
  const settled = promise.catch(() => {});
  if (typeof waitUntil === 'function') waitUntil(settled);
}

/**
 * 재설정 링크를 신청자의 가입 이메일로 보냅니다.
 * 메일은 계정 소유자 본인에게만 가므로, 계정 존재 여부를 밖으로 흘리지 않습니다.
 * 링크가 클릭되도록 HTML 본문을 함께 보내고(text 는 예비), 발신자 표시 이름과
 * 제목 머리말은 SITE_NAME 환경변수로 바꿀 수 있습니다.
 */
export function sendResetEmail(env, waitUntil, member, resetUrl) {
  if (!env.EMAIL_WEBHOOK_URL || !env.EMAIL_WEBHOOK_SECRET || !resetUrl) return;
  const minutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
  const site = env.SITE_NAME || 'AI 리더스 아카데미';
  const name = escapeHtml(member.name);

  const text = `${member.name}님, 안녕하세요.\n\n`
    + `비밀번호 재설정 요청이 접수되었습니다.\n`
    + `아래 링크를 열어 새 비밀번호를 직접 정해주세요.\n\n`
    + `${resetUrl}\n\n`
    + `- 이 링크는 ${minutes}분 동안, 한 번만 쓸 수 있습니다.\n`
    + `- 새 비밀번호는 8자 이상이며 문자·숫자·특수문자를 모두 포함해야 합니다.\n`
    + `- 본인이 요청한 것이 아니라면 이 메일은 무시하셔도 됩니다. 비밀번호는 바뀌지 않습니다.`;

  // resetUrl 은 서버가 만든 값이라 안전하지만, 습관적으로 escape 해 둡니다.
  const url = escapeHtml(resetUrl);
  const html = `
    <div style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.7">
      <h2 style="font-size:18px;border-bottom:2px solid #222;padding-bottom:8px">${escapeHtml(site)} — 비밀번호 재설정</h2>
      <p>${name}님, 안녕하세요.<br>비밀번호 재설정 요청이 접수되었습니다.</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${url}" target="_blank"
           style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold">
          새 비밀번호 정하러 가기</a>
      </p>
      <p style="font-size:13px;color:#555">버튼이 눌리지 않으면 아래 주소를 복사해 브라우저에 붙여넣으세요.<br>
        <a href="${url}" target="_blank" style="color:#1a73e8;word-break:break-all">${url}</a></p>
      <ul style="font-size:13px;color:#555;padding-left:18px">
        <li>이 링크는 ${minutes}분 동안, 한 번만 쓸 수 있습니다.</li>
        <li>새 비밀번호는 8자 이상이며 문자·숫자·특수문자를 모두 포함해야 합니다.</li>
        <li>본인이 요청한 것이 아니라면 이 메일은 무시하셔도 됩니다. 비밀번호는 바뀌지 않습니다.</li>
      </ul>
    </div>`;

  fire(waitUntil, callEmailWebhook(env, {
    to: member.email,
    subject: `[${site}] 비밀번호 재설정 링크`,
    text,
    html,
    fromName: site,
  }));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
