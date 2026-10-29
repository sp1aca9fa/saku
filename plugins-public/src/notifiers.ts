// Alert channels (requirements 11), through the services' official APIs.
// Discord: a channel webhook (https://discord.com/developers/docs/resources/webhook#execute-webhook),
// content up to 2000 characters, mentions disabled. Telegram: the Bot API's sendMessage
// (https://core.telegram.org/bots/api#sendmessage), text up to 4096 characters, one bot per
// install (`TELEGRAM_BOT_TOKEN`), the target is the chat id. Errors never carry the address or
// token, which are secrets.
import { HttpError, type Notifier, type PluginContext } from '@saku/plugin-sdk';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function post(
  ctx: PluginContext,
  url: string,
  body: unknown,
  service: string,
  secret: string,
) {
  ctx.http.addSecret(secret);
  try {
    await ctx.http.post(url, json(body), { 'Content-Type': 'application/json' });
  } catch (e) {
    const what = e instanceof HttpError ? `HTTP ${e.status}` : 'no answer or refused';
    throw new Error(`${service}: ${what}`);
  }
}

export const discord: Notifier = {
  info: {
    key: 'discord',
    kind: 'notifier',
    name: 'Discord',
    // Webhooks allow about 30 messages a minute per channel.
    limits: { perMinute: 30 },
    termsUrl: 'https://support-dev.discord.com/hc/en-us/articles/8562894815383',
    maxLength: 2000,
  },
  validTarget: (target) =>
    /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(target),
  send: (target, text, ctx) =>
    post(ctx, target, { content: text, allowed_mentions: { parse: [] } }, 'Discord', target),
};

export const telegram: Notifier = {
  info: {
    key: 'telegram',
    kind: 'notifier',
    name: 'Telegram',
    // About one message a second per chat.
    limits: { perMinute: 60 },
    keyEnv: 'TELEGRAM_BOT_TOKEN',
    termsUrl: 'https://telegram.org/tos/bot-developers',
    maxLength: 4096,
  },
  validTarget: (target) => /^-?\d{1,20}$/.test(target),
  send: (target, text, ctx) =>
    post(
      ctx,
      `https://api.telegram.org/bot${ctx.apiKey}/sendMessage`,
      { chat_id: target, text, link_preview_options: { is_disabled: true } },
      'Telegram',
      ctx.apiKey ?? '',
    ),
};
