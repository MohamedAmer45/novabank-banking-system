import 'dotenv/config';
import http from 'node:http';

import { handleRequest } from './src/app.js';
import { checkDatabaseConnection, closePool } from './src/database.js';

const PORT = Number(process.env.PORT || 3000);

const health = await checkDatabaseConnection();

if (!health.connected) {
  console.error('Could not reach PostgreSQL:', health.error);
  console.error('Set DATABASE_URL, then run: npm run db:migrate && npm run db:seed');
  process.exit(1);
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`NovaBank QA Lab running at http://localhost:${PORT}`);
  console.log(`Health endpoint:  http://localhost:${PORT}/api/health`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
