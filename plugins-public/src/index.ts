// Public plug-ins (official APIs). The template in `template/` is not loaded.
import type { BarSource, CalendarSource, FxSource, Notifier, SeriesSource } from '@saku/plugin-sdk';
import { calendars as holidayCalendars } from './calendars';
import { alpaca } from './alpaca';
import { ecb } from './ecb';
import { fredFx, fredSeries } from './fred';
import { massive } from './massive';
import { discord, telegram } from './notifiers';
import { tiingo } from './tiingo';

export const bars: BarSource[] = [tiingo, alpaca, massive];
export const series: SeriesSource[] = [fredSeries];
export const fx: FxSource[] = [ecb, fredFx];
export const calendars: CalendarSource[] = [holidayCalendars];
export const notifiers: Notifier[] = [discord, telegram];
