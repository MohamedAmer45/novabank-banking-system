import path from 'node:path';

import { ROOT_DIR } from './database.js';
import { FX, processDueScheduledItems } from './banking.js';
import { send, error, serveStatic, QA_MODE } from './lib/http.js';
import { nowIso } from './security.js';

import * as auth from './routes/auth.routes.js';
import * as banking from './routes/banking.routes.js';
import * as admin from './routes/admin.routes.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-QA-Country',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
};

async function health(req, res) {
  return send(res, 200, {
    status: 'ok',
    service: 'NovaBank QA Lab',
    time: nowIso(),
    database: 'postgresql',
    qaMode: QA_MODE,
    fx: FX
  });
}

/*
 * Route table. Each entry is [method, pattern, handler]. Patterns are matched
 * against the pathname; capture groups are passed to the handler as `params`,
 * which keeps the id extraction out of the handlers themselves.
 */
const ROUTES = [
  ['GET', /^\/api\/health$/, health],

  ['POST', /^\/api\/auth\/register$/, auth.register],
  ['POST', /^\/api\/auth\/verify-email$/, auth.verifyEmail],
  ['POST', /^\/api\/auth\/login$/, auth.login],
  ['POST', /^\/api\/auth\/mfa$/, auth.verifyMfa],
  ['POST', /^\/api\/auth\/logout$/, auth.logout],
  ['POST', /^\/api\/auth\/forgot-password$/, auth.forgotPassword],
  ['POST', /^\/api\/auth\/reset-password$/, auth.resetPassword],
  ['POST', /^\/api\/auth\/change-password$/, auth.changePassword],
  ['GET', /^\/api\/me$/, auth.me],
  ['PATCH', /^\/api\/profile$/, auth.updateProfile],

  ['GET', /^\/api\/kyc$/, banking.getKyc],
  ['GET', /^\/api\/kyc\/document$/, banking.getKycDocument],
  ['POST', /^\/api\/kyc$/, banking.submitKyc],

  ['GET', /^\/api\/accounts$/, banking.listAccounts],
  ['POST', /^\/api\/accounts$/, banking.openAccount],
  ['POST', /^\/api\/accounts\/(\d+)\/(freeze|close)$/, banking.changeAccountState],
  ['GET', /^\/api\/accounts\/(\d+)\/transactions$/, banking.accountTransactions],
  ['GET', /^\/api\/accounts\/(\d+)\/statement$/, banking.accountStatement],

  ['GET', /^\/api\/beneficiaries$/, banking.listBeneficiaries],
  ['POST', /^\/api\/beneficiaries$/, banking.addBeneficiary],
  ['POST', /^\/api\/beneficiaries\/(\d+)\/verify$/, banking.verifyBeneficiary],
  ['PATCH', /^\/api\/beneficiaries\/(\d+)$/, banking.updateBeneficiary],
  ['DELETE', /^\/api\/beneficiaries\/(\d+)$/, banking.deleteBeneficiary],

  ['GET', /^\/api\/transfers$/, banking.listTransfers],
  ['POST', /^\/api\/transfers$/, banking.createTransfer],

  ['GET', /^\/api\/cards$/, banking.listCards],
  ['POST', /^\/api\/cards$/, banking.requestCard],
  [
    'POST',
    /^\/api\/cards\/(\d+)\/(activate|freeze|unfreeze|replace|cancel|settings)$/,
    banking.cardAction
  ],

  ['GET', /^\/api\/billers$/, banking.listBillers],
  ['POST', /^\/api\/billers\/saved$/, banking.saveBiller],
  ['GET', /^\/api\/bill-payments$/, banking.listBillPayments],
  ['POST', /^\/api\/bill-payments$/, banking.createBillPayment],

  ['GET', /^\/api\/loans$/, banking.listLoans],
  ['POST', /^\/api\/loans$/, banking.applyForLoan],
  ['POST', /^\/api\/loans\/(\d+)\/pay$/, banking.repayLoan],

  ['GET', /^\/api\/notifications$/, banking.listNotifications],
  ['POST', /^\/api\/notifications\/(\d+)\/read$/, banking.markNotificationRead],

  ['GET', /^\/api\/admin\/dashboard$/, admin.dashboard],
  ['GET', /^\/api\/admin\/customers$/, admin.listCustomers],
  ['GET', /^\/api\/admin\/customers\/(\d+)$/, admin.customerDetail],
  ['GET', /^\/api\/admin\/kyc$/, admin.listKyc],
  ['GET', /^\/api\/admin\/kyc\/(\d+)\/document$/, admin.kycDocument],
  ['POST', /^\/api\/admin\/kyc\/(\d+)\/review$/, admin.reviewKyc],
  ['GET', /^\/api\/admin\/accounts$/, admin.listAccounts],
  [
    'POST',
    /^\/api\/admin\/accounts\/(\d+)\/(freeze|unfreeze|dormant|activate|limit)$/,
    admin.accountAction
  ],
  ['GET', /^\/api\/admin\/transfers$/, admin.listTransfers],
  ['POST', /^\/api\/admin\/transfers\/(\d+)\/reverse$/, admin.reverse],
  ['GET', /^\/api\/admin\/loans$/, admin.listLoans],
  ['POST', /^\/api\/admin\/loans\/(\d+)\/review$/, admin.decideLoan],
  ['GET', /^\/api\/admin\/fraud$/, admin.listFraud],
  ['PATCH', /^\/api\/admin\/fraud\/(\d+)$/, admin.updateFraud],
  ['GET', /^\/api\/admin\/audit$/, admin.listAudit],
  ['GET', /^\/api\/admin\/users$/, admin.listUsers],
  ['POST', /^\/api\/admin\/users\/(\d+)\/role$/, admin.changeRole]
];

/*
 * Scheduled transfers and bills are due-checked on API traffic rather than a
 * timer, so the behaviour is identical on a long-lived server and on a
 * serverless invocation that has no background timers.
 */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 30_000;

async function sweepScheduledItems() {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();

  try {
    await processDueScheduledItems();
  } catch (err) {
    console.error('Scheduled item sweep failed:', err);
  }
}

async function handleApi(req, res, url) {
  await sweepScheduledItems();

  for (const [method, pattern, handler] of ROUTES) {
    if (req.method !== method) continue;

    const match = url.pathname.match(pattern);
    if (!match) continue;

    return handler(req, res, match.slice(1), url);
  }

  return error(res, 404, 'API route not found.');
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url, PUBLIC_DIR);
    }
  } catch (err) {
    if (!err.status || err.status >= 500) {
      console.error(err);
    }
    if (!res.headersSent) {
      error(res, err.status || 500, err.message || 'Internal server error.');
    }
  }
}

export default handleRequest;
