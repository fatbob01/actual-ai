import cron from 'node-cron';
import { cronSchedule, isFeatureEnabled } from './src/config';
import actualAi, { actualApiService } from './src/container';

// Node does not run pending finally/cleanup code for an unhandled SIGTERM/SIGINT — the
// process just dies, which is exactly how `docker restart`/`docker stop` was leaving the
// dataDir lock file behind and blocking every subsequent run. Release it explicitly here.
let isShuttingDown = false;
function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, releasing dataDir lock and exiting`);
  try {
    actualApiService.releaseLock();
  } catch (error) {
    console.error('Error releasing dataDir lock during shutdown:', error);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (!isFeatureEnabled('classifyOnStartup') && !cron.validate(cronSchedule)) {
  console.error('classifyOnStartup not set or invalid cron schedule:', cronSchedule);
  process.exit(1);
}

if (cron.validate(cronSchedule)) {
  cron.schedule(cronSchedule, async () => {
    await actualAi.classify();
  });
}

console.log('Application started');
if (isFeatureEnabled('classifyOnStartup')) {
  (async () => {
    await actualAi.classify();
  })();
} else {
  console.log('Application started, waiting for cron schedule:', cronSchedule);
}
