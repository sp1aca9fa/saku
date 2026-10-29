# Trust review

Instructions for a fresh reviewer who looks at pages showing a signal, a backtest, a range, a
price, a money value, a data-health state or a risk setting, and asks one question: could anything
here lead a person to trade, or to skip a trade, on a wrong reading? Layout and wording polish are
the UX review's job (`docs/ux-review.md`). The reviewer gets what the UX reviewer gets:
screenshots (phone, wide, dark, each install language) and one line per page on what it is for.

## What to look for

1. **Certainty.** Results and backtests shown as a range, not one number. Is it obvious how sure
   the page is, and how much is luck?
2. **Past versus estimate.** Can you tell historical data from an estimate or simulation (a
   backtest from forward records, synthetic history from real)?
3. **Money terms.** Amounts in the base currency, with the currency, the period and "compared with
   what" (a benchmark, the starting amount). After-tax where tax applies, and saying so.
4. **Data doubt.** When the data behind a signal is yellow or red, does the page say so right next
   to the signal, in a way that cannot be missed? On red, is the safe state shown with exact
   instructions instead of a normal signal?
5. **Risk settings.** Before a risky setting takes effect (leverage, size, a threshold), are its
   risks and worst case shown?
6. **Contradictions.** Numbers that disagree on one page or across pages, totals that do not match
   their items, a signal whose label and color disagree, units that change silently.
7. **Missing states.** What would the page show with no data, one data point, a failed refresh or
   a stale day? Would it still look confident?
8. **Call to action.** Is it clear whether the signal asks for a trade, which one, by how much and
   when (Saku trades at the next session by default)?

## How to report

- At most 10 findings per page, most important first. Each: where (page, part), the wrong reading
  a person could take, its possible cost, one concrete change. Mark each **fix**, **bug** or
  **ask** (say which option you would pick).
- Anything that could cause a wrong trade or a skipped trade is marked **TOP**.
- End each page with the one change that would help most.
- Up to 3 short **ideas**, apart from the findings.
- Plain words. No praise, no summaries, no restating the screenshots.
