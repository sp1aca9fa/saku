// Public plug-ins (official APIs). The template in `template/` is not loaded.
import type { BarSource, FxSource, SeriesSource } from '@saku/plugin-sdk';
import { alpaca } from './alpaca';
import { ecb } from './ecb';
import { fredFx, fredSeries } from './fred';
import { massive } from './massive';
import { tiingo } from './tiingo';

export const bars: BarSource[] = [tiingo, alpaca, massive];
export const series: SeriesSource[] = [fredSeries];
export const fx: FxSource[] = [ecb, fredFx];
