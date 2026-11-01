// Server entry point: `npm start` / systemd ExecStart.

import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './log.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger({ level: config.logLevel });
  const app = createApp({ config, log });

  let shuttingDown = false;
  const shutdown = async (reason, exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { reason });
    const force = setTimeout(() => {
      log.error('shutdown timed out; exiting');
      process.exit(exitCode || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close();
      log.info('shutdown complete');
      process.exit(exitCode);
    } catch (err) {
      log.error('shutdown failed', { err });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('unhandledRejection', (reason) => log.error('unhandled promise rejection', { err: reason }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });

  const address = await app.listen();
  log.info('server listening', {
    host: address.address,
    port: address.port,
    publicUrl: config.publicUrl,
    dataDir: config.dataDir,
    version: config.version,
    node: process.version,
    apns: app.apns.status(),
  });
  if (!app.apns.configured) {
    log.warn('APNs is not configured: Live Activity pushes are disabled', { reason: app.apns.error });
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
