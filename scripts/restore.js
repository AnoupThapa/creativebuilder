'use strict';
/* Restore a backup:  npm run restore -- latest      (or a backup name, e.g. 2026-09-28_031500)
   STOP THE APP FIRST. The current database is kept as postforge.db.before-restore-<time>. */
process.env.BACKUP_ENABLED = 'false';
const config = require('../server/config');
const b = require('../server/backup');
const name = process.argv[2];
if (!name) {
  console.log('Available backups (newest first):');
  for (const x of b.listBackups()) console.log(`  ${x.name}   users:${x.counts.users} designs:${x.counts.designs} files:${x.counts.media}`);
  console.log('\nUsage: npm run restore -- latest   (stop the app first)');
  process.exit(0);
}
const r = b.restoreInto(name, config.DATA_DIR);
console.log(`Restored ${r.backup} into ${config.DATA_DIR} (${r.filesRestored} files copied back). Start the app again.`);
