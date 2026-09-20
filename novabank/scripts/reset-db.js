import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname);
for(const name of ['novabank.db','novabank.db-shm','novabank.db-wal']){
  const p=path.join(root,name); if(fs.existsSync(p)) fs.rmSync(p,{force:true});
}
const { initDatabase } = await import('../src/database.js');
initDatabase();
console.log('NovaBank database reset and reseeded.');
