// Drizzle schema, Stage A1 tables (system design section 5). Prices and returns are `real`
// (float64); money is decimal text with its currency; trading dates are `YYYY-MM-DD` text
// (America/New_York); timestamps are ISO 8601 UTC text. Migrations are add-only.
import {
  CHECK_LAYERS,
  FX_KINDS,
  HEALTH_STATUSES,
  JOB_STATUSES,
  JOB_TYPES,
  PLUGIN_KINDS,
  QUOTA_WINDOWS,
  RAW_BAR_FIELDS,
  SOURCE_ROLES,
} from '@saku/core';
import { type SQL, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const nowIso = () => new Date().toISOString();

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const serial = () => integer('id').primaryKey({ autoIncrement: true });

const createdAt = () => text('created_at').notNull().$defaultFn(nowIso);

/** `column IN ('a', 'b', ...)`; values are compile-time constants, so inlining is safe. */
function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
  return sql`${column} IN (${sql.raw(list)})`;
}

// ---------------------------------------------------------------------------------------------
// Accounts and auth

export const users = sqliteTable(
  'users',
  {
    id: id(),
    username: text('username').notNull(),
    /** Null until the account is set up (password chosen through the setup link or the CLI). */
    passwordHash: text('password_hash'),
    /** TOTP secret, encrypted with AUTH_SECRET. Null until the authenticator is set up. */
    totpSecretEnc: text('totp_secret_enc'),
    /** Last accepted TOTP time step; codes at or before it are refused (replay protection). */
    totpLastStep: integer('totp_last_step'),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    disabledAt: text('disabled_at'),
    /** The user's language (a language code); null follows the install's primary language. */
    language: text('language'),
    /** Hash of the one-time setup link's token, and when it stops working (24 hours). */
    setupTokenHash: text('setup_token_hash'),
    setupExpiresAt: text('setup_expires_at'),
    createdAt: createdAt(),
    updatedAt: text('updated_at').notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

export const userDevices = sqliteTable(
  'user_devices',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    label: text('label'),
    createdAt: createdAt(),
    lastSeenAt: text('last_seen_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('user_devices_user_idx').on(t.userId, t.revokedAt)],
);

export const backupCodes = sqliteTable(
  'backup_codes',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    usedAt: text('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('backup_codes_user_idx').on(t.userId)],
);

export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: serial(),
    ipHash: text('ip_hash').notNull(),
    usernameHash: text('username_hash'),
    attemptedAt: text('attempted_at').notNull(),
    success: integer('success', { mode: 'boolean' }).notNull(),
  },
  (t) => [
    index('login_attempts_ip_idx').on(t.ipHash, t.attemptedAt),
    index('login_attempts_user_idx').on(t.usernameHash, t.attemptedAt),
    index('login_attempts_time_idx').on(t.attemptedAt),
  ],
);

// ---------------------------------------------------------------------------------------------
// Settings

/** Install-wide admin settings (base currency, time zone, languages, regime, ...), JSON values. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
});

export const userSettings = sqliteTable('user_settings', {
  ownerId: text('owner_id')
    .primaryKey()
    .references(() => users.id),
  /** Decimal text; null uses the install's default example amount. */
  exampleAmount: text('example_amount'),
  exampleCurrency: text('example_currency'),
  defaults: text('defaults', { mode: 'json' }).$type<Record<string, unknown>>(),
  updatedAt: text('updated_at').notNull().$defaultFn(nowIso).$onUpdateFn(nowIso),
});

// ---------------------------------------------------------------------------------------------
// Plug-ins and sources

/** Each plug-in's self-description (`PluginInfo`), saved by every job run. */
export const pluginInfo = sqliteTable(
  'plugin_info',
  {
    key: text('key').notNull(),
    kind: text('kind', { enum: PLUGIN_KINDS }).notNull(),
    description: text('description', { mode: 'json' }).notNull(),
    savedAt: text('saved_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.kind] }),
    check('plugin_info_kind_check', oneOf(t.kind, PLUGIN_KINDS)),
  ],
);

/** The admin's choice of sources per data kind ('bars', 'fx', 'series', ...), in order. */
export const sourceRoles = sqliteTable(
  'source_roles',
  {
    dataKind: text('data_kind').notNull(),
    pluginKey: text('plugin_key').notNull(),
    role: text('role', { enum: SOURCE_ROLES }).notNull(),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.dataKind, t.pluginKey] }),
    check('source_roles_role_check', oneOf(t.role, SOURCE_ROLES)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Market data (global; only jobs write it)

export const symbols = sqliteTable(
  'symbols',
  {
    id: serial(),
    ticker: text('ticker').notNull(),
    tier: integer('tier').notNull(),
    assetClass: text('asset_class').notNull(),
    currency: text('currency').notNull(),
    exchange: text('exchange'),
    /** Daily leverage against the underlying (2 for SSO); 1 for unleveraged funds. */
    leverageFactor: real('leverage_factor').notNull().default(1),
    underlyingSymbolId: integer('underlying_symbol_id').references(
      (): AnySQLiteColumn => symbols.id,
    ),
    issuer: text('issuer'),
    inceptionDate: text('inception_date'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('symbols_ticker_uq').on(t.ticker)],
);

/** Every bar as each source sent it. Never deleted; changes to raw fields go to `bar_revisions`. */
export const barsRaw = sqliteTable(
  'bars_raw',
  {
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id),
    date: text('date').notNull(),
    source: text('source').notNull(),
    open: real('open'),
    high: real('high'),
    low: real('low'),
    close: real('close').notNull(),
    /** True when the source's close is already split-adjusted (Yahoo); un-split before comparing. */
    closeIsSplitAdjusted: integer('close_is_split_adjusted', { mode: 'boolean' })
      .notNull()
      .default(false),
    volume: real('volume'),
    divCash: real('div_cash').notNull().default(0),
    splitFactor: real('split_factor').notNull().default(1),
    /** The provider's adjusted close: latest snapshot, for return comparisons only. */
    providerAdjClose: real('provider_adj_close'),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.symbolId, t.date, t.source] })],
);

/** Canonical bars: the primary's values (or a stand-in's), with our adjusted series. */
export const bars = sqliteTable(
  'bars',
  {
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id),
    date: text('date').notNull(),
    open: real('open'),
    high: real('high'),
    low: real('low'),
    close: real('close').notNull(),
    volume: real('volume'),
    divCash: real('div_cash').notNull().default(0),
    splitFactor: real('split_factor').notNull().default(1),
    /** Ours: forward-accumulated total-return index, 1.0 on the first date. */
    adjClose: real('adj_close'),
    source: text('source').notNull(),
    standIn: integer('stand_in', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: HEALTH_STATUSES }),
  },
  (t) => [
    primaryKey({ columns: [t.symbolId, t.date] }),
    check('bars_status_check', sql`${t.status} IS NULL OR ${oneOf(t.status, HEALTH_STATUSES)}`),
  ],
);

export const barRevisions = sqliteTable(
  'bar_revisions',
  {
    id: serial(),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id),
    date: text('date').notNull(),
    source: text('source').notNull(),
    field: text('field', { enum: RAW_BAR_FIELDS }).notNull(),
    oldValue: real('old_value'),
    newValue: real('new_value'),
    detectedAt: text('detected_at').notNull(),
    runId: text('run_id').references(() => jobRuns.id),
  },
  (t) => [
    index('bar_revisions_symbol_idx').on(t.symbolId, t.date),
    check('bar_revisions_field_check', oneOf(t.field, RAW_BAR_FIELDS)),
  ],
);

/** One row per provider re-adjustment of its adjusted values (one per refetch, not per day). */
export const readjustments = sqliteTable(
  'readjustments',
  {
    id: serial(),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id),
    source: text('source').notNull(),
    fromDate: text('from_date').notNull(),
    toDate: text('to_date').notNull(),
    factor: real('factor').notNull(),
    detectedAt: text('detected_at').notNull(),
    runId: text('run_id').references(() => jobRuns.id),
  },
  (t) => [index('readjustments_symbol_idx').on(t.symbolId, t.source)],
);

/**
 * Exchange rates. A changed value for a date is a new row (the old one stays), so `asOf` can
 * return what was known at any moment: a value counts from `published_at`, or from `fetched_at`
 * when the source does not say when it was published.
 */
export const fxRates = sqliteTable(
  'fx_rates',
  {
    pair: text('pair').notNull(),
    date: text('date').notNull(),
    source: text('source').notNull(),
    kind: text('kind', { enum: FX_KINDS }).notNull(),
    rate: real('rate').notNull(),
    publishedAt: text('published_at'),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pair, t.date, t.source, t.kind, t.fetchedAt] }),
    check('fx_rates_kind_check', oneOf(t.kind, FX_KINDS)),
  ],
);

/** Dated series (rates, index levels, later macro). Kept by vintage like `fx_rates`. */
export const series = sqliteTable(
  'series',
  {
    series: text('series').notNull(),
    date: text('date').notNull(),
    source: text('source').notNull(),
    value: real('value').notNull(),
    publishedAt: text('published_at'),
    fetchedAt: text('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.series, t.date, t.source, t.fetchedAt] })],
);

// ---------------------------------------------------------------------------------------------
// Checks and health

export const checkResults = sqliteTable(
  'check_results',
  {
    id: serial(),
    runId: text('run_id')
      .notNull()
      .references(() => jobRuns.id),
    layer: text('layer', { enum: CHECK_LAYERS }).notNull(),
    checkName: text('check_name').notNull(),
    symbolId: integer('symbol_id').references(() => symbols.id),
    date: text('date').notNull(),
    status: text('status', { enum: HEALTH_STATUSES }).notNull(),
    observed: real('observed'),
    expected: real('expected'),
    tolerance: real('tolerance'),
    message: text('message'),
  },
  (t) => [
    index('check_results_run_idx').on(t.runId),
    index('check_results_date_idx').on(t.date, t.symbolId),
    check('check_results_layer_check', oneOf(t.layer, CHECK_LAYERS)),
    check('check_results_status_check', oneOf(t.status, HEALTH_STATUSES)),
  ],
);

/** Weekly full-history passes: one row per (run, layer, check). */
export const checkSummaries = sqliteTable(
  'check_summaries',
  {
    runId: text('run_id')
      .notNull()
      .references(() => jobRuns.id),
    layer: text('layer', { enum: CHECK_LAYERS }).notNull(),
    checkName: text('check_name').notNull(),
    checked: integer('checked').notNull(),
    passed: integer('passed').notNull(),
    maxDeviation: real('max_deviation'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.layer, t.checkName] }),
    check('check_summaries_layer_check', oneOf(t.layer, CHECK_LAYERS)),
  ],
);

/** Health per trading date and symbol (null symbol = overall), as each run found it. */
export const dataHealth = sqliteTable(
  'data_health',
  {
    id: serial(),
    runId: text('run_id')
      .notNull()
      .references(() => jobRuns.id),
    date: text('date').notNull(),
    symbolId: integer('symbol_id').references(() => symbols.id),
    status: text('status', { enum: HEALTH_STATUSES }).notNull(),
    reasons: text('reasons', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => [
    index('data_health_date_idx').on(t.date, t.symbolId),
    check('data_health_status_check', oneOf(t.status, HEALTH_STATUSES)),
  ],
);

// ---------------------------------------------------------------------------------------------
// Jobs and operations

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: id(),
    jobType: text('job_type', { enum: JOB_TYPES }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    status: text('status', { enum: JOB_STATUSES }).notNull(),
    datesProcessed: text('dates_processed', { mode: 'json' }).$type<string[]>(),
    error: text('error'),
    heartbeatSent: integer('heartbeat_sent', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('job_runs_started_idx').on(t.jobType, t.startedAt),
    check('job_runs_type_check', oneOf(t.jobType, JOB_TYPES)),
    check('job_runs_status_check', oneOf(t.status, JOB_STATUSES)),
  ],
);

/** Requests per provider and window, for the quota guard (never above 80% of a limit). */
export const providerUsage = sqliteTable(
  'provider_usage',
  {
    provider: text('provider').notNull(),
    windowType: text('window_type', { enum: QUOTA_WINDOWS }).notNull(),
    windowStart: text('window_start').notNull(),
    requestCount: integer('request_count').notNull().default(0),
    /** Distinct symbols requested in the window (for per-month symbol limits). */
    symbols: text('symbols', { mode: 'json' }).$type<string[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.windowType, t.windowStart] }),
    check('provider_usage_window_check', oneOf(t.windowType, QUOTA_WINDOWS)),
  ],
);

/** Admin tasks, updates, resets. `actor` is a user id, or 'cli' / 'system'. */
export const activityLog = sqliteTable(
  'activity_log',
  {
    id: serial(),
    at: text('at').notNull().$defaultFn(nowIso),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: text('detail', { mode: 'json' }),
  },
  (t) => [index('activity_log_at_idx').on(t.at)],
);
