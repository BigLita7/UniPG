import { getMainKeyboard, openAppKeyboard, aboutKeyboard, getFallbackKeyboard } from "../keyboards/main.js";

export function registerActions(bot) {
  // Вспомогательная функция безопасного подтверждения callback
  async function safeAnswerCallback(ctx) {
    try {
      if (typeof ctx.answerOnCallback === "function") {
        await ctx.answerOnCallback();
      }
    } catch (_) {}
  }

  async function safeReplyWithKeyboard(ctx, text, getKeyboardFn) {
    try {
      await ctx.reply(text, {
        attachments: [getKeyboardFn()],
      });
    } catch (err) {
      console.warn("Не удалось отправить клавиатуру в action, пробуем fallback:", err.message);
      try {
        await ctx.reply(text, {
          attachments: [getFallbackKeyboard()],
        });
      } catch (_) {
        await ctx.reply(text);
      }
    }
  }

  bot.action("find_game", async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeReplyWithKeyboard(
      ctx,
      "🔎 Поиск спортивных событий\n\n" +
        "Нажмите кнопку ниже, чтобы открыть список доступных игр в UniPG:",
      () => openAppKeyboard("🔎 Открыть поиск игр", "games"),
    );
  });

  bot.action("find_place", async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeReplyWithKeyboard(
      ctx,
      "📍 Спортивные площадки\n\n" +
        "Нажмите кнопку ниже, чтобы открыть интерактивную карту площадок Москвы:",
      () => openAppKeyboard("📍 Открыть карту площадок", "venues"),
    );
  });

  bot.action("create_event", async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeReplyWithKeyboard(
      ctx,
      "➕ Создание спортивного события\n\n" +
        "Откройте приложение, выберите подходящую площадку на карте и создайте игру:",
      () => openAppKeyboard("➕ Создать событие в UniPG", "venues"),
    );
  });

  bot.action("my_events", async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeReplyWithKeyboard(
      ctx,
      "📅 Мои записи\n\n" +
        "Нажмите кнопку ниже, чтобы посмотреть список игр, в которых вы участвуете:",
      () => openAppKeyboard("📅 Открыть мои события", "my_events"),
    );
  });

  bot.action("about", async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeReplyWithKeyboard(
      ctx,
      "ℹ️ О проекте UniPG\n\n" +
        "UniPG — сервис для поиска спортивных площадок и организации совместных игр в Москве.\n\n" +
        "🎯 Наша цель — сделать любительский спорт доступным и объединять людей для тренировок и матчей.\n\n" +
        "Ключевые возможности:\n" +
        "• Интерактивная векторная карта площадок на базе 2ГИС MapGL\n" +
        "• Поиск и фильтрация по видам спорта (футбол, баскетбол, волейбол, теннис, воркаут)\n" +
        "• Создание игр и автоматическое управление составом участников\n" +
        "• Временные групповые чаты для участников матчей в MAX\n" +
        "• Каталог площадок с возможностью аренды, ценами и контактами\n\n" +
        "Запустите UniPG кнопкой ниже:",
      () => aboutKeyboard(),
    );
  });

  bot.action("back_to_menu", async (ctx) => {
    await safeAnswerCallback(ctx);
    await safeReplyWithKeyboard(
      ctx,
      "Главное меню UniPG. Выберите нужный раздел:",
      () => getMainKeyboard(),
    );
  });
}
