import { Bot } from "grammy";
import { config } from "dotenv";

config({ path: "/root/secrets/tg.env" });

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const DIFY_API = "https://admin.shpuntikai.ru/v1";
const DIFY_KEY = process.env.DIFY_API_KEY;

const conversations = new Map();

bot.command("start", (ctx) => {
  ctx.reply("Привет! Я Шпунтик. Напиши что-нибудь — отвечу.");
});

bot.command("reset", (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply("Память очищена. Начинаем заново!");
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const userMessage = ctx.message.text;

  await ctx.replyWithChatAction("typing");

  try {
    const response = await fetch(`${DIFY_API}/chat-messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DIFY_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {},
        query: userMessage,
        response_mode: "blocking",
        conversation_id: conversations.get(userId) || "",
        user: `tg-${userId}`,
      }),
    });

    if (!response.ok) {
      console.error("Dify API error:", await response.text());
      ctx.reply("Упс, что-то пошло не так.");
      return;
    }

    const data = await response.json();
    if (data.conversation_id) conversations.set(userId, data.conversation_id);

    const answer = data.answer || "Не удалось получить ответ.";
    for (let i = 0; i < answer.length; i += 4000) {
      await ctx.reply(answer.slice(i, i + 4000));
    }
  } catch (error) {
    console.error("Bot error:", error);
    ctx.reply("Ошибка связи.");
  }
});

bot.start();
console.log("Шпунтик запущен в Telegram!");
