// A plug-in package's entry point: one array per kind it provides.
import { exampleBars } from './example-bars';
import { exampleTaxFx } from './example-tax-fx';
import { exampleTaxRegime } from './example-tax-regime';

export const bars = [exampleBars];
export const taxFx = [exampleTaxFx];
export const taxRegimes = [exampleTaxRegime];
