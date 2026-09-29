import { Keyboard } from "@maxhub/max-bot-api";

let currentBotUsername = process.env.MAX_BOT_USERNAME || "t126_hakaton_max_bot";

export function setBotUsername(username) {
  if (username) {
    currentBotUsername = username.replace(/^@/, "");
  }
}

export function getBotUsername() {
  return currentBotUsername;
}

export function getAppUrl(path = "") {
  const base = (process.env.MINI_APP_URL || "https://unipg.ru").replace(/\/+$/, "");
  if (!path) return base;
  return path.startsWith("?") || path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/**
 * Главная клавиатура бота:
 * - Все кнопки перехода в приложение используют Keyboard.button.openApp,
 *   передавая username бота в web_app и строковый payload ("games", "venues", "my_events").
 * - В MAX Bot API: web_app должен быть юзернеймом бота в MAX (не внешним URL),
 *   а payload должен состоять из буквенно-цифровых символов и подчеркиваний.
 */
export function getMainKeyboard(botUsername = getBotUsername()) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.openApp("🏆 Открыть UniPG", botUsername)],
    [
      Keyboard.button.openApp("🔎 Найти игру", botUsername, undefined, "games"),
      Keyboard.button.openApp("📍 Площадки", botUsername, undefined, "venues"),
    ],
    [
      Keyboard.button.openApp("📅 Мои события", botUsername, undefined, "my_events"),
      Keyboard.button.callback("ℹ️ О проекте", "about"),
    ],
  ]);
}

export const mainKeyboard = getMainKeyboard();

export function aboutKeyboard(botUsername = getBotUsername()) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.openApp("🏆 Открыть UniPG", botUsername)],
    [
      Keyboard.button.openApp("🔎 Найти игру", botUsername, undefined, "games"),
      Keyboard.button.openApp("📍 Площадки", botUsername, undefined, "venues"),
    ],
    [Keyboard.button.callback("🏠 Главное меню", "back_to_menu")],
  ]);
}

export function eventChatKeyboard(activityId, botUsername = getBotUsername()) {
  const cleanId = String(activityId).replace(/[^0-9]/g, "");
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.openApp(
        "💬 Открыть чат события",
        botUsername,
        undefined,
        `activity_${cleanId}`,
      ),
    ],
    [Keyboard.button.openApp("🏆 Открыть UniPG", botUsername)],
  ]);
}

export function openAppKeyboard(label, actionOrPayload = "", botUsername = getBotUsername()) {
  const cleanPayload = String(actionOrPayload)
    .replace(/^[?&]*(view=)?/, "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "") || undefined;

  return Keyboard.inlineKeyboard([
    [Keyboard.button.openApp(label, botUsername, undefined, cleanPayload)],
    [Keyboard.button.openApp("🏆 Открыть UniPG", botUsername)],
  ]);
}

/**
 * Резервная клавиатура со ссылками на случай сетевых ограничений или старых версий клиента.
 */
export function getFallbackKeyboard() {
  const appUrl = getAppUrl();
  return Keyboard.inlineKeyboard([
    [Keyboard.button.link("🏆 Открыть UniPG", appUrl)],
    [
      Keyboard.button.link("🔎 Найти игру", `${appUrl}?view=games`),
      Keyboard.button.link("📍 Площадки", `${appUrl}?view=venues`),
    ],
    [Keyboard.button.callback("ℹ️ О проекте", "about")],
  ]);
}
