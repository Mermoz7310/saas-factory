import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { log } from "../log.ts";
import type { Button, Notifier } from "../notify.ts";
import * as cmd from "./commands.ts";

const MAX_TEXT = 4000;
const clip = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 20)}\n… (tronqué)` : t);

function keyboard(buttons: Button[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  buttons.forEach((row, i) => {
    row.forEach((b) => kb.text(b.label, b.data));
    if (i < buttons.length - 1) kb.row();
  });
  return kb;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly bot: Bot,
    private readonly ownerId: number,
  ) {}
  async send(text: string, buttons?: Button[][]): Promise<number | null> {
    try {
      const msg = await this.bot.api.sendMessage(this.ownerId, clip(text), buttons ? { reply_markup: keyboard(buttons) } : {});
      return msg.message_id;
    } catch (error) {
      log.error({ err: error }, "envoi Telegram impossible");
      return null;
    }
  }
}

async function reply(ctx: Context, r: cmd.Reply) {
  await ctx.reply(clip(r.text));
  if (r.file) await ctx.replyWithDocument(new InputFile(Buffer.from(r.file.content, "utf8"), r.file.name));
}

/**
 * Bot en « long polling » : aucun port à ouvrir, aucun domaine à configurer.
 * Seul le propriétaire (TELEGRAM_OWNER_ID) peut le commander ; les autres sont ignorés.
 */
export function createBot(token: string, ownerId: number | undefined, deps: cmd.CommandDeps): Bot {
  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    if (!ownerId) {
      await ctx.reply(`👋 Ton identifiant Telegram est ${ctx.from?.id}.\nMets-le dans TELEGRAM_OWNER_ID sur le serveur, puis redémarre l'usine.`);
      return;
    }
    if (ctx.from?.id === ownerId) await ctx.reply(cmd.HELP);
  });

  bot.use(async (ctx, next) => {
    if (!ownerId || ctx.from?.id !== ownerId) {
      log.warn({ from: ctx.from?.id }, "message Telegram ignoré : expéditeur non autorisé");
      return;
    }
    await next();
  });

  bot.command(["aide", "help"], (ctx) => ctx.reply(cmd.HELP));
  bot.command("idee", async (ctx) => reply(ctx, await cmd.cmdIdee(deps, ctx.match)));
  bot.command("projets", async (ctx) => reply(ctx, await cmd.cmdProjets(deps)));
  bot.command("dossier", async (ctx) => reply(ctx, await cmd.cmdDossier(deps, ctx.match)));
  bot.command("cout", async (ctx) => reply(ctx, await cmd.cmdCout(deps)));
  bot.command("stop", async (ctx) => reply(ctx, await cmd.cmdStop(deps)));
  bot.command("reprendre", async (ctx) => reply(ctx, await cmd.cmdReprendre(deps)));
  bot.command("relancer", async (ctx) => reply(ctx, await cmd.cmdRelancer(deps, ctx.match)));

  bot.on("callback_query:data", async (ctx) => {
    const res = await cmd.onApprovalButton(deps, ctx.callbackQuery.data);
    await ctx.answerCallbackQuery({ text: res.toast });
    if (res.append) {
      const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? (ctx.callbackQuery.message.text ?? "") : "";
      await ctx.editMessageText(clip(original + res.append)).catch(() => undefined);
    }
  });

  bot.on("message:text", (ctx) => ctx.reply("Pour une nouvelle idée : /idee <ton idée>\n/aide pour toutes les commandes."));

  bot.catch((err) => log.error({ err: err.error }, "erreur du bot Telegram"));
  return bot;
}
