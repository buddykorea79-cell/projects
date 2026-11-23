/**
 * Hermes — 텔레그램 알림 + 가입 승인 버튼 (서버 측)
 * ---------------------------------------------------------------------------
 * 신규 Google 로그인 승인 요청 · 가입 · 과제 제출이 생길 때마다 지정한 텔레그램
 * 채팅으로 알리고, 승인 대기 요청은 알림에 붙은 버튼으로 그 자리에서 승인하거나
 * 거절할 수 있습니다.
 *
 * 환경변수 (전부 선택 — 하나라도 비어 있으면 알림 기능만 조용히 꺼집니다.
 * 로그인·제출 같은 본 기능은 텔레그램이 죽어 있어도 절대 실패하지 않습니다)
 *   TELEGRAM_BOT_TOKEN      BotFather 가 발급한 봇 토큰
 *   TELEGRAM_CHAT_ID        알림을 받고 버튼을 누를 채팅 ID
 *   TELEGRAM_WEBHOOK_SECRET setWebhook 의 secret_token 과 동일한 값
 *
 * 신뢰 경계 — 이 채팅방에 들어와 있는 사람은 누구든 버튼으로 회원을 승인·거절할 수
 * 있습니다. 신뢰하는 관리자만 이 채팅에 초대하세요.
 */
import {
  normEmail, safeEqual, updateMembers, findMember, bumpEpoch,
} from './auth.js';

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
 * 거기 맡겨 응답을 늦추지 않고, 없으면(예: 테스트) 그냥 흘려보냅니다.
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
  const info = [member.name, member.institution].filter(Boolean).join(' · ') || '프로필 입력 전';
  const text = `🆕 <b>Google 회원가입</b>\n`
    + `${escapeHtml(info)}\n`
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
 * 사전 등록되지 않은 Google 계정이 로그인을 시도했을 때 관리자에게 승인 요청을 보냅니다.
 * 인라인 버튼으로 그 자리에서 승인하거나 거절(삭제)할 수 있습니다.
 */
export function notifyApprovalRequest(env, waitUntil, member) {
  const email = normEmail(member.email);
  const label = [member.name, member.institution].filter(Boolean).join(' · ') || 'Google 신규 사용자';
  const text = `⏳ <b>가입 승인 요청</b>\n`
    + `${escapeHtml(label)}\n`
    + `${escapeHtml(email)}\n\n`
    + `교육생이 맞다면 아래 버튼으로 승인해 주세요.`;
  return notify(env, waitUntil, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ 승인', callback_data: `approve:${email}` },
        { text: '🚫 거절', callback_data: `reject:${email}` },
      ]],
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
  if (cb && typeof cb.data === 'string') {
    if (cb.data.startsWith('approve:')) {
      await handleApprovalCallback(env, cb, 'approve');
    } else if (cb.data.startsWith('reject:')) {
      await handleApprovalCallback(env, cb, 'reject');
    }
  }
  return new Response('ok', { status: 200 });
}

async function handleApprovalCallback(env, cb, action) {
  const chatId = String(cb.message?.chat?.id ?? '');
  const allowed = String(env.TELEGRAM_CHAT_ID || '');

  if (!chatId || !allowed || !safeEqual(chatId, allowed)) {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '허용되지 않은 채팅입니다.', show_alert: true,
    });
    return;
  }

  const prefix = `${action}:`;
  const email = normEmail(cb.data.slice(prefix.length));
  let outcome = 'missing';

  if (email) {
    await updateMembers(env, (list) => {
      const m = findMember(list, email);
      if (!m) { outcome = 'missing'; return null; }
      if ((m.status || 'active') !== 'pending') { outcome = 'already'; return null; }

      if (action === 'approve') {
        m.status = 'active';
        m.updatedAt = new Date().toISOString();
        bumpEpoch(m);
        outcome = 'approved';
        return list;
      }
      outcome = 'rejected';
      return list.filter((x) => normEmail(x.email) !== email);
    });
  }

  if (outcome === 'missing') {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '해당 승인 요청을 찾을 수 없습니다.', show_alert: true,
    });
    return;
  }
  if (outcome === 'already') {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '이미 처리된 계정입니다.', show_alert: true,
    });
    return;
  }

  const doneText = outcome === 'approved' ? '승인했습니다.' : '거절(삭제)했습니다.';
  await callTelegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: doneText });

  const original = cb.message?.text || '';
  const badge = outcome === 'approved'
    ? `✅ <b>승인 완료</b> — ${escapeHtml(email)} 님이 이제 Google 로그인을 이용할 수 있습니다.`
    : `🚫 <b>거절 완료</b> — ${escapeHtml(email)} 요청을 삭제했습니다.`;
  await callTelegram(env, 'editMessageText', {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: `${escapeHtml(original)}\n\n${badge}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
}
