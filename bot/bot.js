import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, "..");
const caWasProvidedAtStartup = Boolean(process.env.NODE_EXTRA_CA_CERTS);

dotenv.config({ path: path.join(projectDir, ".env"), quiet: true });

const configuredCertPath = process.env.NODE_EXTRA_CA_CERTS?.trim();
const certPath = configuredCertPath
  ? path.resolve(projectDir, configuredCertPath)
  : path.join(projectDir, "certs/russian-trusted-root-ca.pem");

// Автоматическая подгрузка сертификата Минцифры для работы с API MAX
if (!caWasProvidedAtStartup && fs.existsSync(certPath)) {
  const child = fork(__filename, process.argv.slice(2), {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  await new Promise(() => {});
}

import { Bot } from "@maxhub/max-bot-api";
import {
  getWelcomeText,
  registerCommands,
  UNKNOWN_COMMAND_TEXT,
} from "./handlers/commands.js";
import { registerActions } from "./handlers/actions.js";
import { setBotUsername } from "./keyboards/main.js";

const token = process.env.BOT_TOKEN?.trim();
if (!token) {
  console.warn("⚠️ BOT_TOKEN не задан в .env. Бот не может подключиться к MAX API.");
  console.warn("Укажите BOT_TOKEN в файле .env и перезапустите бота.");
  process.exit(0);
}

const bot = new Bot(token);

bot.catch((error, ctx) => {
  console.error(`Ошибка обработки события MAX (${ctx?.updateType || "unknown"}):`, error);
});

// Регистрируем команды (/start, /help)
registerCommands(bot);

// Регистрируем действия (кнопки)
registerActions(bot);

// Обработка события запуска бота пользователем
bot.on("bot_started", async (ctx) => {
  const user = ctx.update?.user;
  await ctx.reply(getWelcomeText(user?.first_name));
});

// Неизвестный текст или slash-команда в личном диалоге получает подсказку.
// Зарегистрировано после известных команд, поэтому /start и /help сюда не попадут.
bot.on("message_created", async (ctx) => {
  const text = ctx.message?.body?.text?.trim();
  const chatType = ctx.message?.recipient?.chat_type;
  if (!text || chatType !== "dialog") return;
  await ctx.reply(UNKNOWN_COMMAND_TEXT);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Получен ${signal}, останавливаем MAX-бота…`);
  try {
    bot.stopPolling?.();
  } catch (_) {}
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function start() {
  console.log("Запуск UniPG MAX-бота...");
  try {
    const myInfo = await bot.api.getMyInfo();
    if (myInfo?.username) {
      setBotUsername(myInfo.username);
    }
    console.log(`MAX-бот успешно авторизован: @${myInfo.username || myInfo.first_name || myInfo.user_id}`);
  } catch (error) {
    console.warn("Предупреждение при подключении к MAX API (getMyInfo):", error.message);
  }

  try {
    await bot.api.setMyCommands([
      { name: "start", description: "Главное меню" },
      { name: "help", description: "Помощь" },
    ]);
    console.log("Команды бота в MAX обновлены (/start, /help)");
  } catch (error) {
    console.warn("Не удалось обновить подсказки команд в MAX:", error.message);
  }

  // Запуск Long Polling
  bot.start();
  console.log("UniPG MAX-бот слушает обновления (long polling)");
}

start().catch((err) => {
  console.error("Критическая ошибка при запуске бота:", err);
  process.exit(1);
});
