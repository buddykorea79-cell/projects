/**
 * Hermes — 텔레그램 알림 + 가입 승인 / 기존 계정 연계 버튼 (서버 측)
 * ---------------------------------------------------------------------------
 * 신규 Google 가입 승인 요청 · 기존 계정 연계 요청 · 과제 제출이 생길 때마다
 * 지정한 텔레그램 채팅으로 알리고, 버튼 한 번으로 승인·연계·거절할 수 있습니다.
 */
import {
  normEmail, safeEqual, updateMembers, findMember, bumpEpoch, mergeLegacyAccount,
} from './auth.js';

const apiUrl = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

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
 * 사전 등록되지 않은 Google 계정이 가입 승인 요청(소속·성명·선택 기존 이메일)을 남겼을 때.
 */
export function notifyApprovalRequest(env, waitUntil, member) {
  const email = normEmail(member.email);
  const label = [member.name, member.institution].filter(Boolean).join(' · ') || 'Google 신규 사용자';
  const legacy = member.linkRequestedEmail ? normEmail(member.linkRequestedEmail) : '';
  const text = `⏳ <b>가입 승인 요청</b>\n`
    + `${escapeHtml(label)}\n`
    + `${escapeHtml(email)}`
    + (legacy ? `\n🔗 기존 계정 연계 요청: <code>${escapeHtml(legacy)}</code>` : '')
    + `\n\n교육생이 맞다면 아래 버튼으로 처리해 주세요.`;

  const row = legacy
    ? [
      { text: '✅ 승인 + 연계', callback_data: `approve_link:${email}` },
      { text: '✅ 신규 승인', callback_data: `approve:${email}` },
      { text: '🚫 거절', callback_data: `reject:${email}` },
    ]
    : [
      { text: '✅ 승인', callback_data: `approve:${email}` },
      { text: '🚫 거절', callback_data: `reject:${email}` },
    ];

  return notify(env, waitUntil, text, { reply_markup: { inline_keyboard: [row] } });
}

/**
 * 이미 활성화된 Google 회원이 기존 비-구글 계정 연계를 요청했을 때.
 */
export function notifyLinkRequest(env, waitUntil, member) {
  const email = normEmail(member.email);
  const legacy = normEmail(member.linkRequestedEmail);
  if (!legacy) return;
  const label = [member.name, member.institution].filter(Boolean).join(' · ') || email;
  const text = `🔗 <b>기존 계정 연계 요청</b>\n`
    + `${escapeHtml(label)}\n`
    + `새 Google: ${escapeHtml(email)}\n`
    + `기존 계정: <code>${escapeHtml(legacy)}</code>\n\n`
    + `본인이 맞으면 승인하여 기존 제출물·권한을 이관하세요.`;
  return notify(env, waitUntil, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🔗 연계 승인', callback_data: `approve_link:${email}` },
        { text: '❌ 연계 거절', callback_data: `reject_link:${email}` },
      ]],
    },
  });
}

/* ------------------------------------------------------------ 웹훅 -- */

export async function handleTelegramWebhook(request, env) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }

  const update = await request.json().catch(() => null);
  const cb = update?.callback_query;
  if (cb && typeof cb.data === 'string') {
    if (cb.data.startsWith('approve_link:')) {
      await handleLinkCallback(env, cb, 'approve_link');
    } else if (cb.data.startsWith('reject_link:')) {
      await handleLinkCallback(env, cb, 'reject_link');
    } else if (cb.data.startsWith('approve:')) {
      await handleApprovalCallback(env, cb, 'approve');
    } else if (cb.data.startsWith('reject:')) {
      await handleApprovalCallback(env, cb, 'reject');
    }
  }
  return new Response('ok', { status: 200 });
}

async function checkChat(env, cb) {
  const chatId = String(cb.message?.chat?.id ?? '');
  const allowed = String(env.TELEGRAM_CHAT_ID || '');
  if (!chatId || !allowed || !safeEqual(chatId, allowed)) {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '허용되지 않은 채팅입니다.', show_alert: true,
    });
    return false;
  }
  return true;
}

async function handleApprovalCallback(env, cb, action) {
  if (!(await checkChat(env, cb))) return;

  const email = normEmail(cb.data.slice(`${action}:`.length));
  let outcome = 'missing';

  if (email) {
    await updateMembers(env, (list) => {
      const m = findMember(list, email);
      if (!m) { outcome = 'missing'; return null; }
      if ((m.status || 'active') !== 'pending') { outcome = 'already'; return null; }

      if (action === 'approve') {
        m.status = 'active';
        m.linkRequestedEmail = null;
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

async function handleLinkCallback(env, cb, action) {
  if (!(await checkChat(env, cb))) return;

  const email = normEmail(cb.data.slice(`${action}:`.length));
  let target = null;
  await updateMembers(env, (list) => {
    target = findMember(list, email);
    return null;
  });

  if (!target || !target.linkRequestedEmail) {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: '처리할 계정 연계 요청이 없습니다.', show_alert: true,
    });
    return;
  }

  const legacyEmail = normEmail(target.linkRequestedEmail);

  if (action === 'reject_link') {
    await updateMembers(env, (list) => {
      const m = findMember(list, email);
      if (!m) return null;
      m.linkRequestedEmail = null;
      m.updatedAt = new Date().toISOString();
      return list;
    });
    await callTelegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '연계 요청을 거절했습니다.' });
    const original = cb.message?.text || '';
    await callTelegram(env, 'editMessageText', {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: `${escapeHtml(original)}\n\n❌ <b>연계 거절</b> — ${escapeHtml(legacyEmail)} 연계 요청을 취소했습니다.`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
    return;
  }

  const merged = await mergeLegacyAccount(env, { googleEmail: email, legacyEmail });
  if (!merged.ok) {
    await callTelegram(env, 'answerCallbackQuery', {
      callback_query_id: cb.id, text: merged.message || '연계에 실패했습니다.', show_alert: true,
    });
    return;
  }

  await callTelegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: '승인 및 기존 계정 연계를 완료했습니다.' });
  const original = cb.message?.text || '';
  await callTelegram(env, 'editMessageText', {
    chat_id: cb.message.chat.id,
    message_id: cb.message.message_id,
    text: `${escapeHtml(original)}\n\n✅ <b>승인 + 연계 완료</b> — ${escapeHtml(legacyEmail)} → ${escapeHtml(email)}`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
}
