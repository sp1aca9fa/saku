import { stateDir } from '@saku/db/env';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../types';

/** Logs to the console and as JSON lines to `<state>/logs/<job>.log`. */
export function jobLogger(job: string, dir: string = join(stateDir(), 'logs')): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${job}.log`);
  const write = (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => {
    const at = new Date().toISOString();
    appendFileSync(file, `${JSON.stringify({ at, level, job, message, ...data })}\n`);
    const line = `${at} ${level === 'warn' ? 'WARN ' : ''}${message}`;
    if (level === 'warn') console.warn(line, data ? JSON.stringify(data) : '');
    else console.log(line, data ? JSON.stringify(data) : '');
  };
  return {
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
  };
}
