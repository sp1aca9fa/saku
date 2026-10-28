import { fixtureContext } from '@saku/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { discord, telegram } from '../src/notifiers';

const hook = 'https://discord.com/api/webhooks/123/abc-DEF_9';

describe('notifiers', () => {
  it('posts plain text to a Discord webhook with mentions off', async () => {
    const ctx = fixtureContext(() => '');
    await discord.send(hook, 'hello @everyone', ctx);
    expect(ctx.requested).toEqual([hook]);
    expect(JSON.parse(ctx.bodies[0]!)).toEqual({
      content: 'hello @everyone',
      allowed_mentions: { parse: [] },
    });
  });

  it('posts to Telegram with the install bot token', async () => {
    const ctx = fixtureContext(() => ({ ok: true }), { apiKey: 'T0KEN' });
    await telegram.send('-1001', 'hi', ctx);
    expect(ctx.requested).toEqual(['https://api.telegram.org/botT0KEN/sendMessage']);
    expect(JSON.parse(ctx.bodies[0]!)).toMatchObject({ chat_id: '-1001', text: 'hi' });
  });

  it('keeps the address and token out of errors', async () => {
    const ctx = fixtureContext(() => undefined, { apiKey: 'T0KEN' });
    await expect(discord.send(hook, 'x', ctx)).rejects.toThrow(/^Discord: HTTP 404$/);
    await expect(telegram.send('1', 'x', ctx)).rejects.toThrow(/^Telegram: HTTP 404$/);
  });

  it('checks targets before they are stored', () => {
    expect(discord.validTarget(hook)).toBe(true);
    expect(discord.validTarget('https://example.test/api/webhooks/1/x')).toBe(false);
    expect(telegram.validTarget('-1001234')).toBe(true);
    expect(telegram.validTarget('@name')).toBe(false);
  });
});
