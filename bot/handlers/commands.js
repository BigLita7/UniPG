import { getMainKeyboard, getFallbackKeyboard } from "../keyboards/main.js";

export const AVAILABLE_COMMANDS_TEXT =
  "/start — открыть главное меню UniPG\n" +
  "/help — посмотреть возможности сервиса";

export function getWelcomeText(firstName) {
  return (
    `Привет, ${firstName || "спортсмен"}! 👋\n\n` +
    "Добро пожаловать в UniPG — приложение для поиска спортивных площадок " +
    "и организации игр в Москве.\n\n" +
    "Доступные команды:\n" +
    AVAILABLE_COMMANDS_TEXT
  );
}

export const UNKNOWN_COMMAND_TEXT =
  "Не удалось распознать команду. Попробуйте одну из доступных:\n\n" +
  AVAILABLE_COMMANDS_TEXT;

export function registerCommands(bot) {
  bot.command("start", async (ctx) => {
    const text =
      "Добро пожаловать в UniPG! 🏆\n\n" +
      "Находите спортивные площадки, создавайте события " +
      "и находите компанию для совместных занятий спортом.\n\n" +
      "Доступные команды:\n" +
      AVAILABLE_COMMANDS_TEXT +
      "\n\n" +
      "Нажмите кнопку ниже, чтобы открыть приложение:";

    try {
      await ctx.reply(text, {
        attachments: [getMainKeyboard()],
      });
    } catch (err) {
      console.warn("Не удалось отправить основную клавиатуру в /start, пробуем fallback:", err.message);
      try {
        await ctx.reply(text, {
          attachments: [getFallbackKeyboard()],
        });
      } catch (_) {
        await ctx.reply(text);
      }
    }
  });

  bot.command("help", async (ctx) => {
    const text =
      "Возможности UniPG:\n\n" +
      "🏆 Открыть UniPG — запуск интерактивной карты\n" +
      "🔎 Найти игру — просмотр и поиск спортивных событий\n" +
      "📍 Площадки — поиск площадок рядом с вами\n" +
      "📅 Мои события — ваши записи на матчи и тренировки\n" +
      "ℹ️ О проекте — информация о сервисе\n\n" +
      "Используйте кнопки ниже для быстрого перехода:";

    try {
      await ctx.reply(text, {
        attachments: [getMainKeyboard()],
      });
    } catch (err) {
      console.warn("Не удалось отправить основную клавиатуру в /help, пробуем fallback:", err.message);
      try {
        await ctx.reply(text, {
          attachments: [getFallbackKeyboard()],
        });
      } catch (_) {
        await ctx.reply(text);
      }
    }
  });
}
