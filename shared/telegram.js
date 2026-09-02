/**
 * Hermes — 텔레그램 알림 + 재설정 버튼 (서버 측)
 * ---------------------------------------------------------------------------
 * 가입 · 과제 제출 · 비밀번호 재설정 요청이 생길 때마다 지정한 텔레그램 채팅으로
 * 알리고, 재설정 요청은 알림에 붙은 버튼을 눌러 그 자리에서 임시 비밀번호를
 * 발급합니다. 텔레그램 봇 만들기 · 채팅 ID 확인 · 웹훅 등록은 docs/SETUP.md 를
 * 보세요.
 *
 * 환경변수 (전부 선택 — 하나라도 비어 있으면 알림 기능만 조용히 꺼집니다.
 * 가입 · 제출 · 재설정 같은 본 기능은 텔레그램이 죽어 있어도 절대 실패하지
 * 않습니다)
 *   TELEGRAM_BOT_TOKEN      BotFather 가 발급한 봇 토큰
 *   TELEGRAM_CHAT_ID        알림을 받고 버튼을 누를 채팅 ID
 *   TELEGRAM_WEBHOOK_SECRET setWebhook 의 secret_token 과 동일한 값
 *
 * 신뢰 경계 — 이 채팅방에 들어와 있는 사람은 누구든 버튼으로 임시 비밀번호를
 * 발급할 수 있습니다. 신뢰하는 관리자만 이 채팅에 초대하세요.
 */
import { issueTempPassword, normEmail, safeEqual, RESET_TOKEN_TTL_MS } from './auth.js';

const apiUrl = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** 실패해도 절대 던지지 않는 best-effort 호출. 텔레그램이 죽어 있어도 서비스는 계속됩니다. */
async function callTelegram(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(apiUrl(env.TELEGRAM_BOT_TOKEN, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * 알림 전송을 요청 처리와 분리합니다. `waitUntil` 이 있으면(Workers/Pages 런타임)
 * 거기 맡겨 응답을 늦추지 않고, 없으면(예: 테스트) 그냥 흘려보냅니다 — 테스트는
 * `waitUntil` 에 수집용 콜백을 넘겨 결정적으로 기다릴 수 있습니다.
 */
function fire(waitUntil, promise) {
  const settled = promise.catch(() => {});
  if (typeof waitUntil === 'function') waitUntil(settled);
}

async function notify(env, waitUntil, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  fire(waitUntil, callTelegram(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    ...extra,
  }));
}

export function notifySignup(env, waitUntil, member) {
  const text = `🆕 <b>회원가입</b>\n`
    + `${escapeHtml(member.name)} · ${escapeHtml(member.institution)}\n`
    + `${escapeHtml(member.email)}`;
  return notify(env, waitUntil, text);
}

export function notifySubmission(env, waitUntil, submission, project) {
  const text = `📎 <b>과제 제출</b>\n`
    + `${escapeHtml(project?.title || submission.projectId)}\n`
    + `${escapeHtml(submission.author?.name)} · ${escapeHtml(submission.author?.institution)}\n`
    + `${escapeHtml(submission.title)}`;
  return notify(env, waitUntil, text);
}

/**
 * 재설정 요청 알림. `resetUrl` 이 있으면 신청자 본인이 새 비밀번호를 직접 정할 수
 * 있는 1회용 링크를 함께 보냅니다 — 관리자가 이 링크를 신청자에게 전달하면
 * 비밀번호가 채팅에 노출되지 않습니다. 급할 때를 위해 임시 비밀번호 버튼도
 * 그대로 둡니다.
 */
export function notifyResetRequest(env, waitUntil, member, resetUrl) {
  const email = normEmail(member.email);
  const minutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
  const text = `🔑 <b>비밀번호 재설정 요청</b>\n`
    + `${escapeHtml(member.name)} · ${escapeHtml(member.institution)}\n`
    + `${escapeHtml(email)}\n\n`
    + (resetUrl
      ? `아래 링크를 <b>신청자 본인에게</b> 전달하세요. 링크를 연 사람이 새 비밀번호를 직접 정합니다`
        + ` (${minutes}분 유효 · 1회용):\n${escapeHtml(resetUrl)}\n\n`
      : '')
    + `또는 버튼으로 임시 비밀번호를 바로 발급할 수 있습니다.`;
  return notify(env, waitUntil, text, {
    reply_markup: {
      inline_keyboard: [[{ text: '🔓 임시 비밀번호 발급', callback_data: `reset:${email}` }]],
    },
  });
}

/* ------------------------------------------------------------ 웹훅 -- */

/**
 * 텔레그램이 호출하는 웹훅. 처리하지 못한 업데이트라도 항상 200 을 돌려줘야
 * 텔레그램이 같은 업데이트를 계속 재시도하지 않습니다.
 */
export async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }

  const update = await request.json().catch(() => null);
  const cb = update?.callback_query;
  if (cb && typeof cb.data === 'string' && cb.data.startsWith('reset:')) {
    await handleResetCallback(env, cb);
  }
  return new Response('ok', { status: 200 });
}

async function handleResetCallback(env, cb) {
  const chatId = String(cb.message?.chat?.id ?? '');
  const allowed = String(env.TELEGRAM_CHAT_ID || '');

  if (!chatId || !allowed || !safeEqual(chatId, allowed)) {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '허용되지 않은 채팅입니다.', show_alert: true,
    });
    return;
  }

  const email = normEmail(cb.data.slice('reset:'.length));
  const result = email ? await issueTempPassword(email, env) : { ok: false };

  if (!result.ok) {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '해당 회원을 찾을 수 없습니다.', show_alert: true,
    });
    return;
  }

  await callTelegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '발급했습니다.' });

  const original = cb.message?.text || '';
  await callTelegram(env, 'editMessageText', {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: `${original}\n\n✅ 임시 비밀번호: <code>${escapeHtml(result.tempPassword)}</code>\n`
      + `${escapeHtml(email)} 님께 직접 전달하세요.`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
}
