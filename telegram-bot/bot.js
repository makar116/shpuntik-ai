import { Bot, InputFile } from "grammy";
import { config } from "dotenv";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";

config({ path: "/root/secrets/tg.env" });
const exec = promisify(execFile);

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new Bot(TG_TOKEN);
const DIFY_API = "https://admin.shpuntikai.ru/v1";
const DIFY_KEY = process.env.DIFY_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const OWNER_FILE = "/root/secrets/owner_id";

const conversations = new Map();
const voiceMode = new Set();

bot.command("start", (ctx) =>
  ctx.reply("Привет! Я Шпунтик. Пиши или говори голосовыми. /voice — голос, /reset — новая тема, /whoami — твой ID."));

bot.command("reset", (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply("Память очищена. Начинаем заново!");
});

bot.command("whoami", (ctx) => {
  fs.writeFileSync(OWNER_FILE, String(ctx.from.id));
  ctx.reply(`Твой ID: ${ctx.from.id} — сохранён для алертов.`);
});

bot.command("voice", (ctx) => {
  const id = ctx.from.id;
  if (voiceMode.has(id)) { voiceMode.delete(id); ctx.reply("Голосовой режим выключен."); }
  else { voiceMode.add(id); ctx.reply("Голосовой режим включён!"); }
});

async function say(text, outPath) {
  const clean = text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[*_`#]/g, "")
    .slice(0, 1500);
  await exec("edge-tts", ["--voice", "ru-RU-DmitryNeural", "--text", clean, "--write-media", outPath]);
}

async function askAndReply(ctx, query) {
  const userId = ctx.from.id;
  await ctx.replyWithChatAction("typing");
  try {
    const response = await fetch(`${DIFY_API}/chat-messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DIFY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: {},
        query,
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

    for (let i = 0; i < answer.length; i += 4000) await ctx.reply(answer.slice(i, i + 4000));

    if (voiceMode.has(userId)) {
      await ctx.replyWithChatAction("record_voice");
      const tmp = `/tmp/voice-${userId}.mp3`;
      try {
        await say(answer, tmp);
        await ctx.replyWithVoice(new InputFile(tmp));
      } catch (e) { console.error("TTS error:", e); }
      fs.unlink(tmp, () => {});
    }
  } catch (error) {
    console.error("Bot error:", error);
    ctx.reply("Ошибка связи.");
  }
}

async function transcribe(buf) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", "whisper-large-v3");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error("Groq: " + (await r.text()));
  return (await r.json()).text;
}

bot.on("message:voice", async (ctx) => {
  if (!GROQ_KEY) { ctx.reply("Голосовой ввод ещё не настроен."); return; }
  await ctx.reply("🎧 Слушаю...");
  try {
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = await transcribe(buf);
    if (!text || !text.trim()) { ctx.reply("Не расслышал. Повтори?"); return; }
    await ctx.reply(`Ты сказал: «${text}»`);
    await askAndReply(ctx, text);
  } catch (e) {
    console.error("STT error:", e);
    ctx.reply("Не смог распознать голосовое.");
  }
});

bot.on("message:text", (ctx) => askAndReply(ctx, ctx.message.text));

// ---- Монитор баланса OpenRouter ----
async function checkCredits() {
  if (!OR_KEY) { console.log("Монитор: нет OPENROUTER_API_KEY, пропускаю."); return; }
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${OR_KEY}` },
    });
    if (!r.ok) { console.error("Credits check HTTP", r.status); return; }
    const d = await r.json();
    const left = (d.data?.total_credits ?? 0) - (d.data?.total_usage ?? 0);
    console.log("OpenRouter balance: $" + left.toFixed(2));
    if (left < 1 && fs.existsSync(OWNER_FILE)) {
      const owner = fs.readFileSync(OWNER_FILE, "utf8").trim();
      await bot.api.sendMessage(owner,
        "⚠️ Баланс OpenRouter: $" + left.toFixed(2) + ". Пора пополнить, иначе Шпунтик замолчит.");
    }
  } catch (e) {
    console.error("Credits monitor error:", e);
  }
}
setTimeout(checkCredits, 30000);          // первая проверка через 30 сек
setInterval(checkCredits, 6 * 3600000);   // затем каждые 6 часов

bot.start();
console.log("Шпунтик запущен в Telegram!");
