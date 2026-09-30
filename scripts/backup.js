'use strict';
/* npm run backup            → make a backup now
   npm run backup:verify     → restore the latest backup into a temp folder and check it (restore test) */
process.env.BACKUP_ENABLED = 'false';
const b = require('../server/backup');
(async () => {
  if (process.argv.includes('--verify')) {
    const r = b.verifyBackup(process.argv[3] || 'latest');
    require('../server/db').metaSet('last_backup_verify', JSON.stringify(r));
    console.log(JSON.stringify(r, null, 2));
    console.log(r.ok ? '\nRestore test PASSED - the backup is complete and readable.' : '\nRestore test FAILED - see details above.');
    process.exit(r.ok ? 0 : 1);
  }
  const r = await b.runBackup('manual');
  console.log(`Backup created: ${r.dir}  (off-site: ${r.offsite})`);
})().catch(e => { console.error(e.message); process.exit(1); });
