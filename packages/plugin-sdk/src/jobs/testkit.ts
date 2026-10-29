// Shared by the job tests: in-memory plug-ins and a fake alert channel (no network).
import { type TradingDate, zonedInstant } from '@saku/core';
import type { Sessions } from '@saku/data';
import type { Notifier, PluginInfo, SeriesSource } from '../types';

export const quiet = { info() {}, warn() {} };

/** A plug-in description; the source keyed `p` suggests itself as the primary. */
export const testInfo = (key: string, kind: PluginInfo['kind'], extra: Partial<PluginInfo> = {}) =>
  ({
    key,
    kind,
    name: key,
    provides: {},
    suggestedRole: key === 'p' ? 'primary' : 'secondary',
    termsUrl: 'https://example.test',
    ...extra,
  }) as PluginInfo;

/** The USD cash rate (4%) for each date before `until`, published 18:00 New York the next session. */
export function cashRates(
  sessions: Sessions,
  dates: TradingDate[],
  until: TradingDate,
): SeriesSource {
  return {
    info: testInfo('rates', 'series', {
      suggestedRole: 'primary',
      provides: { series: ['CASH'], cashRates: { USD: 'CASH' } },
    }),
    async fetchSeries(_id, from, to) {
      return dates
        .filter((d) => d >= from && d <= to && d < until)
        .map((date) => ({
          date,
          value: 4,
          publishedAt: zonedInstant(sessions.after(date), '18:00', 'America/New_York'),
        }));
    },
  };
}

/** A channel that keeps what it is sent; targets in `down` fail. */
export function fakeNotifier(down: string[] = []) {
  const sent: { target: string; text: string }[] = [];
  const notifier: Notifier = {
    info: { key: 'fake', kind: 'notifier', name: 'Fake', termsUrl: 'x', maxLength: 4000 },
    validTarget: () => true,
    send: async (target, text) => {
      if (down.includes(target)) throw new Error('Fake: HTTP 500');
      sent.push({ target, text });
    },
  };
  return { notifier, sent };
}
