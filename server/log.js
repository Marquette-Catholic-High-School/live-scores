// Structured logging: one JSON object per line. debug/info go to stdout,
// warn/error to stderr (journald tags stderr lines with a higher priority).

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  const out = { message: err.message, name: err.name };
  if (err.code !== undefined) out.code = err.code;
  if (err.stack) out.stack = err.stack;
  return out;
}

function normalizeFields(fields) {
  if (!fields) return {};
  if (fields instanceof Error) return { err: serializeError(fields) };
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function stringify(entry) {
  const seen = new WeakSet();
  return JSON.stringify(entry, (_key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

export function createLogger({ level = 'info', stdout = process.stdout, stderr = process.stderr, base = {} } = {}) {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  function write(lvl, msg, fields) {
    if (LOG_LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...base, ...normalizeFields(fields) };
    const stream = LOG_LEVELS[lvl] >= LOG_LEVELS.warn ? stderr : stdout;
    try {
      stream.write(stringify(entry) + '\n');
    } catch {
      // A closed stdout/stderr must never take the server down.
    }
  }

  return {
    level,
    enabled: (lvl) => LOG_LEVELS[lvl] >= threshold,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level, stdout, stderr, base: { ...base, ...extra } }),
  };
}
