const BACKEND_API_URL = process.env.BACKEND_API_URL || "http://127.0.0.1:8000";

/**
 * Отправить уведомление пользователю о событии.
 */
export async function notifyUser(bot, userId, text, keyboard = null) {
  try {
    const options = keyboard ? { attachments: [keyboard] } : {};
    await bot.api.messages.send({
      user_id: Number(userId),
      text,
      ...options,
    });
  } catch (error) {
    console.error(`Ошибка отправки уведомления пользователю ${userId}:`, error.message);
  }
}

/**
 * Уведомить создателя события о новом участнике.
 */
export async function notifyNewParticipant(bot, activity, participantName) {
  if (!activity.creator_id) return;
  const text =
    `🎉 Новый участник!\n\n` +
    `${participantName || "Кто-то"} присоединился к вашей игре ` +
    `«${activity.title}».\n` +
    `Участников: ${activity.current_players}/${activity.max_players}`;
  await notifyUser(bot, activity.creator_id, text);
}

/**
 * Уведомить создателя, что участник покинул событие.
 */
export async function notifyParticipantLeft(bot, activity, participantName) {
  if (!activity.creator_id) return;
  const text =
    `👋 Участник вышел\n\n` +
    `${participantName || "Кто-то"} покинул вашу игру ` +
    `«${activity.title}».\n` +
    `Участников: ${activity.current_players}/${activity.max_players}`;
  await notifyUser(bot, activity.creator_id, text);
}

/**
 * Отправить всем участникам события ссылку на чат.
 */
export async function broadcastChatLink(bot, activityId, inviteLink, title) {
  try {
    const res = await fetch(`${BACKEND_API_URL}/api/activities/${activityId}/participants`);
    if (!res.ok) return;
    const participants = await res.json();
    const text =
      `💬 Чат для события «${title}» создан!\n\n` +
      `Присоединяйтесь: ${inviteLink}`;
    for (const p of participants) {
      if (p.user_id) {
        await notifyUser(bot, p.user_id, text);
      }
    }
  } catch (error) {
    console.error("Ошибка рассылки ссылки на чат:", error.message);
  }
}
