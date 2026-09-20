import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase, queryAll, queryOne, execute, withTransaction, ROOT_DIR } from './src/database.js';
import { hashPassword, verifyPassword, randomToken, randomDigits, nowIso, addHours } from './src/security.js';
import { audit, notify, publicUser, userSnapshot, executeTransfer, reverseTransfer, processBillPayment, processDueScheduledItems, calculateLoanPayment, reviewLoan, payLoan, FX } from './src/banking.js';

initDatabase();
const PORT = Number(process.env.PORT || 3000);
const QA_MODE = String(process.env.QA_MODE || 'true').toLowerCase() === 'true';
const publicDir = path.join(ROOT_DIR, 'public');

const rolePermissions = {
  CUSTOMER: [],
  SUPPORT: ['READ_CUSTOMERS','READ_ACCOUNTS','READ_TRANSFERS'],
  AUDITOR: ['READ_CUSTOMERS','READ_ACCOUNTS','READ_TRANSFERS','READ_AUDIT','READ_FRAUD'],
  EMPLOYEE: ['READ_CUSTOMERS','READ_ACCOUNTS','READ_TRANSFERS','REVIEW_KYC'],
  MANAGER: ['READ_CUSTOMERS','READ_ACCOUNTS','READ_TRANSFERS','READ_AUDIT','READ_FRAUD','REVIEW_KYC','MANAGE_ACCOUNTS','MANAGE_LIMITS','REVERSE_TRANSFER','REVIEW_LOANS','MANAGE_FRAUD'],
  ADMIN: ['*']
};

function send(res,status,data,headers={}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
  res.end(body);
}
function error(res,status,message,details) { send(res,status,{error:message,...(details?{details}:{})}); }
async function bodyJson(req) {
  return await new Promise((resolve,reject)=>{
    let data='';
    req.on('data',c=>{ data+=c; if(data.length>1_000_000) reject(new Error('Request too large')); });
    req.on('end',()=>{ if(!data) return resolve({}); try{resolve(JSON.parse(data));}catch{reject(Object.assign(new Error('Invalid JSON body'),{status:400}));} });
    req.on('error',reject);
  });
}
function bearer(req) {
  const h=req.headers.authorization||'';
  return h.startsWith('Bearer ')?h.slice(7):null;
}
function auth(req) {
  const token=bearer(req); if(!token) return null;
  const session=queryOne(`SELECT s.*,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`,token,nowIso());
  return session?publicUser(session):null;
}
function requireAuth(req,res) { const u=auth(req); if(!u){error(res,401,'Authentication required.');return null;} return u; }
function hasPermission(user,perm){ const p=rolePermissions[user.role]||[]; return p.includes('*')||p.includes(perm); }
function requirePermission(req,res,perm){ const u=requireAuth(req,res); if(!u)return null; if(!hasPermission(u,perm)){error(res,403,'You do not have permission to perform this action.');return null;} return u; }
function ownAccount(userId,id){ return queryOne('SELECT * FROM accounts WHERE id=? AND user_id=?',Number(id),userId); }
function moneyMinor(value){ const n=Number(value); if(!Number.isFinite(n)) return NaN; return Math.round(n*100); }
function uniqueAccountNumber(){ return String(1000000000 + Math.floor(Math.random()*8999999999)); }
function uniqueIban(accountNumber){ return `EG38${String(Math.floor(Math.random()*9999)).padStart(4,'0')}${accountNumber.padStart(20,'0').slice(-20)}`; }
function clientIp(req){ return (req.headers['x-forwarded-for']||req.socket.remoteAddress||'').toString().split(',')[0].trim(); }
function sanitizeIdNumber(row){ if(!row)return row; const {document_data_b64,...safe}=row; return {...safe,id_number:row.id_number?`**********${row.id_number.slice(-4)}`:null,has_document:!!row.document_data_b64}; }

async function handleApi(req,res,url){
  try { processDueScheduledItems(); } catch (e) { console.error('scheduler',e); }
  const pathname=url.pathname;

  if(req.method==='GET' && pathname==='/api/health') return send(res,200,{status:'ok',service:'NovaBank QA Lab',time:nowIso(),database:'sqlite-demo',fx:FX});

  if(req.method==='POST' && pathname==='/api/auth/register'){
    const b=await bodyJson(req);
    if(!b.email||!b.password||!b.firstName||!b.lastName) return error(res,400,'email, password, firstName and lastName are required.');
    if(String(b.password).length<8) return error(res,400,'Password must contain at least 8 characters.');
    if(queryOne('SELECT id FROM users WHERE email=?',b.email)) return error(res,409,'Email is already registered.');
    const created=withTransaction(()=>{
      const r=execute(`INSERT INTO users (email,password_hash,first_name,last_name,phone,role,status,email_verified,mfa_enabled,mfa_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,b.email,hashPassword(b.password),b.firstName,b.lastName,b.phone||'', 'CUSTOMER','ACTIVE',0,1,'123456',nowIso());
      const id=Number(r.lastInsertRowid);
      execute(`INSERT INTO kyc_profiles (user_id,status,updated_at) VALUES (?,?,?)`,id,'NOT_STARTED',nowIso());
      const token=randomDigits(6); execute(`INSERT INTO verification_tokens (token,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)`,token,id,'EMAIL',addHours(1),nowIso());
      audit(id,'REGISTER','USER',id,'SUCCESS',{},clientIp(req));
      return {id,token};
    });
    return send(res,201,{message:'Registration successful. Verify the email before using banking services.',...(QA_MODE?{demoVerificationCode:created.token}:{})});
  }

  if(req.method==='POST' && pathname==='/api/auth/verify-email'){
    const b=await bodyJson(req); const t=queryOne(`SELECT * FROM verification_tokens WHERE token=? AND kind='EMAIL' AND used_at IS NULL AND expires_at>?`,b.code,nowIso());
    if(!t)return error(res,400,'Verification code is invalid or expired.');
    execute('UPDATE users SET email_verified=1 WHERE id=?',t.user_id); execute('UPDATE verification_tokens SET used_at=? WHERE token=?',nowIso(),t.token); audit(t.user_id,'VERIFY_EMAIL','USER',t.user_id);
    return send(res,200,{message:'Email verified.'});
  }

  if(req.method==='POST' && pathname==='/api/auth/login'){
    const b=await bodyJson(req); const user=queryOne('SELECT * FROM users WHERE email=?',b.email||'');
    if(!user) return error(res,401,'Invalid email or password.');
    if(user.locked_until && user.locked_until>nowIso()) return error(res,423,`Account locked until ${user.locked_until}.`);
    if(user.status!=='ACTIVE') return error(res,403,`User is ${user.status}.`);
    if(!verifyPassword(b.password||'',user.password_hash)){
      const attempts=Number(user.failed_attempts)+1; const locked=attempts>=5?new Date(Date.now()+15*60000).toISOString():null;
      execute('UPDATE users SET failed_attempts=?,locked_until=? WHERE id=?',attempts,locked,user.id); audit(user.id,'LOGIN','USER',user.id,'FAILED',{attempts},clientIp(req));
      return error(res,401,locked?'Account locked for 15 minutes after repeated failures.':'Invalid email or password.');
    }
    execute('UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=?',user.id);
    if(!user.email_verified) return error(res,403,'Email verification required.');
    if(user.mfa_enabled){
      const challenge=randomToken(12); execute(`INSERT INTO verification_tokens (token,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)`,challenge,user.id,'MFA',new Date(Date.now()+5*60000).toISOString(),nowIso());
      return send(res,200,{mfaRequired:true,challenge,demoCode:QA_MODE?user.mfa_code:undefined});
    }
    const session=randomToken(); execute('INSERT INTO sessions (token,user_id,expires_at,created_at) VALUES (?,?,?,?)',session,user.id,addHours(b.rememberDevice?24*30:8),nowIso()); execute('UPDATE users SET last_login=? WHERE id=?',nowIso(),user.id); audit(user.id,'LOGIN','USER',user.id,'SUCCESS',{},clientIp(req));
    return send(res,200,{token:session,user:publicUser(user)});
  }

  if(req.method==='POST' && pathname==='/api/auth/mfa'){
    const b=await bodyJson(req); const challenge=queryOne(`SELECT * FROM verification_tokens WHERE token=? AND kind='MFA' AND used_at IS NULL AND expires_at>?`,b.challenge||'',nowIso());
    if(!challenge)return error(res,400,'MFA challenge is invalid or expired.'); const user=queryOne('SELECT * FROM users WHERE id=?',challenge.user_id);
    if(String(b.code)!==String(user.mfa_code)) { audit(user.id,'MFA_VERIFY','USER',user.id,'FAILED',{},clientIp(req)); return error(res,401,'Invalid one-time code.'); }
    execute('UPDATE verification_tokens SET used_at=? WHERE token=?',nowIso(),challenge.token); const session=randomToken(); execute('INSERT INTO sessions (token,user_id,expires_at,created_at) VALUES (?,?,?,?)',session,user.id,addHours(b.rememberDevice?24*30:8),nowIso()); execute('UPDATE users SET last_login=? WHERE id=?',nowIso(),user.id);
    const qaCountry=String(req.headers['x-qa-country']||'EG').toUpperCase();
    notify(user.id,'NEW_LOGIN','New sign-in',`A sign-in was completed from ${qaCountry} / ${clientIp(req)}.`);
    if(qaCountry!=='EG') execute(`INSERT INTO fraud_alerts (user_id,rule_code,severity,status,description,created_at) VALUES (?,?,?,?,?,?)`,user.id,'UNUSUAL_LOGIN','MEDIUM','Login originated outside the configured home country (EG).','OPEN',nowIso());
    audit(user.id,'LOGIN','USER',user.id,'SUCCESS',{mfa:true,country:qaCountry},clientIp(req));
    return send(res,200,{token:session,user:publicUser(user)});
  }

  if(req.method==='POST' && pathname==='/api/auth/logout'){
    const token=bearer(req); if(token) execute('DELETE FROM sessions WHERE token=?',token); return send(res,200,{message:'Logged out.'});
  }

  if(req.method==='POST' && pathname==='/api/auth/forgot-password'){
    const b=await bodyJson(req); const user=queryOne('SELECT * FROM users WHERE email=?',b.email||'');
    let token=null; if(user){ token=randomToken(16); execute(`INSERT INTO verification_tokens (token,user_id,kind,expires_at,created_at) VALUES (?,?,?,?,?)`,token,user.id,'PASSWORD_RESET',addHours(1),nowIso()); notify(user.id,'PASSWORD_RESET','Password reset requested','A password reset was requested for your NovaBank profile.','EMAIL'); audit(user.id,'FORGOT_PASSWORD','USER',user.id); }
    return send(res,200,{message:'If the email exists, a reset link has been issued.',...(QA_MODE&&token?{demoResetToken:token}:{})});
  }

  if(req.method==='POST' && pathname==='/api/auth/reset-password'){
    const b=await bodyJson(req); const t=queryOne(`SELECT * FROM verification_tokens WHERE token=? AND kind='PASSWORD_RESET' AND used_at IS NULL AND expires_at>?`,b.token||'',nowIso());
    if(!t)return error(res,400,'Reset token is invalid or expired.'); if(String(b.password||'').length<8)return error(res,400,'Password must contain at least 8 characters.');
    execute('UPDATE users SET password_hash=?,failed_attempts=0,locked_until=NULL WHERE id=?',hashPassword(b.password),t.user_id); execute('UPDATE verification_tokens SET used_at=? WHERE token=?',nowIso(),t.token); execute('DELETE FROM sessions WHERE user_id=?',t.user_id); notify(t.user_id,'PASSWORD_CHANGED','Password changed','Your password was reset successfully.'); audit(t.user_id,'RESET_PASSWORD','USER',t.user_id);
    return send(res,200,{message:'Password reset successfully.'});
  }

  if(req.method==='GET' && pathname==='/api/me'){
    const user=requireAuth(req,res); if(!user)return; return send(res,200,userSnapshot(user.id));
  }

  if(req.method==='POST' && pathname==='/api/auth/change-password'){
    const user=requireAuth(req,res); if(!user)return; const b=await bodyJson(req); const raw=queryOne('SELECT * FROM users WHERE id=?',user.id);
    if(!verifyPassword(b.currentPassword||'',raw.password_hash))return error(res,401,'Current password is incorrect.'); if(String(b.newPassword||'').length<8)return error(res,400,'New password must contain at least 8 characters.');
    execute('UPDATE users SET password_hash=? WHERE id=?',hashPassword(b.newPassword),user.id); notify(user.id,'PASSWORD_CHANGED','Password changed','Your NovaBank password was changed.'); audit(user.id,'CHANGE_PASSWORD','USER',user.id); return send(res,200,{message:'Password changed.'});
  }

  if(req.method==='PATCH' && pathname==='/api/profile'){
    const user=requireAuth(req,res); if(!user)return; const b=await bodyJson(req); execute('UPDATE users SET first_name=?,last_name=?,phone=? WHERE id=?',b.firstName||user.first_name,b.lastName||user.last_name,b.phone??user.phone,user.id); audit(user.id,'UPDATE_PROFILE','USER',user.id); return send(res,200,{user:publicUser(queryOne('SELECT * FROM users WHERE id=?',user.id))});
  }

  if(req.method==='GET' && pathname==='/api/kyc'){
    const user=requireAuth(req,res); if(!user)return; return send(res,200,sanitizeIdNumber(queryOne('SELECT * FROM kyc_profiles WHERE user_id=?',user.id)));
  }
  if(req.method==='GET' && pathname==='/api/kyc/document'){
    const user=requireAuth(req,res); if(!user)return; const k=queryOne('SELECT document_name,document_mime,document_data_b64 FROM kyc_profiles WHERE user_id=?',user.id); if(!k?.document_data_b64)return error(res,404,'No uploaded KYC document is stored.');
    const buf=Buffer.from(k.document_data_b64,'base64'); res.writeHead(200,{'Content-Type':k.document_mime||'application/octet-stream','Content-Disposition':`attachment; filename="${String(k.document_name||'kyc-document').replaceAll('"','')}"`,'Cache-Control':'no-store'}); return res.end(buf);
  }

  if(req.method==='POST' && pathname==='/api/kyc'){
    const user=requireAuth(req,res); if(!user)return; const b=await bodyJson(req); const profile=queryOne('SELECT * FROM kyc_profiles WHERE user_id=?',user.id);
    const status='UNDER_REVIEW';
    if(profile) execute(`UPDATE kyc_profiles SET status=?,date_of_birth=?,nationality=?,address=?,employment=?,annual_income_minor=?,id_type=?,id_number=?,document_name=?,document_mime=COALESCE(?,document_mime),document_data_b64=COALESCE(?,document_data_b64),reviewer_note=NULL,reviewed_by=NULL,updated_at=? WHERE user_id=?`,status,b.dateOfBirth||'',b.nationality||'',b.address||'',b.employment||'',moneyMinor(b.annualIncome||0),b.idType||'NATIONAL_ID',b.idNumber||'',b.documentName||profile.document_name||'uploaded-document.pdf',b.documentMime||null,b.documentDataB64||null,nowIso(),user.id);
    else execute(`INSERT INTO kyc_profiles (user_id,status,date_of_birth,nationality,address,employment,annual_income_minor,id_type,id_number,document_name,document_mime,document_data_b64,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,user.id,status,b.dateOfBirth,b.nationality,b.address,b.employment,moneyMinor(b.annualIncome||0),b.idType,b.idNumber,b.documentName||'uploaded-document.pdf',b.documentMime||null,b.documentDataB64||null,nowIso());
    notify(user.id,'KYC_SUBMITTED','Identity verification submitted','Your KYC profile is under review.'); audit(user.id,'SUBMIT_KYC','KYC',user.id); return send(res,200,{message:'KYC submitted for review.',kyc:sanitizeIdNumber(queryOne('SELECT * FROM kyc_profiles WHERE user_id=?',user.id))});
  }

  if(req.method==='GET' && pathname==='/api/accounts'){
    const user=requireAuth(req,res); if(!user)return; return send(res,200,queryAll('SELECT * FROM accounts WHERE user_id=? ORDER BY id',user.id));
  }
  if(req.method==='POST' && pathname==='/api/accounts'){
    const user=requireAuth(req,res); if(!user)return; const kyc=queryOne('SELECT status FROM kyc_profiles WHERE user_id=?',user.id); if(kyc?.status!=='VERIFIED')return error(res,403,'Verified KYC is required to open an account.'); const b=await bodyJson(req); const type=['CURRENT','SAVINGS'].includes(b.accountType)?b.accountType:'SAVINGS'; const currency=['EGP','USD','EUR','GBP'].includes(b.currency)?b.currency:'EGP'; const number=uniqueAccountNumber(); const iban=uniqueIban(number); const r=execute(`INSERT INTO accounts (user_id,account_number,iban,account_type,currency,balance_minor,available_minor,status,daily_limit_minor,daily_transferred_minor,daily_counter_date,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,user.id,number,iban,type,currency,0,0,'ACTIVE',currency==='EGP'?25000000:500000,0,nowIso().slice(0,10),nowIso()); audit(user.id,'OPEN_ACCOUNT','ACCOUNT',r.lastInsertRowid,'SUCCESS',{type,currency}); return send(res,201,queryOne('SELECT * FROM accounts WHERE id=?',Number(r.lastInsertRowid)));
  }
  let m=pathname.match(/^\/api\/accounts\/(\d+)\/(freeze|close)$/);
  if(req.method==='POST' && m){ const user=requireAuth(req,res); if(!user)return; const account=ownAccount(user.id,m[1]); if(!account)return error(res,404,'Account not found.'); if(m[2]==='close'&&account.balance_minor!==0)return error(res,409,'Account balance must be zero before closure.'); const status=m[2]==='freeze'?'FROZEN':'CLOSED'; execute('UPDATE accounts SET status=?,closed_at=? WHERE id=?',status,status==='CLOSED'?nowIso():null,account.id); audit(user.id,m[2]==='freeze'?'FREEZE_OWN_ACCOUNT':'CLOSE_ACCOUNT','ACCOUNT',account.id); return send(res,200,queryOne('SELECT * FROM accounts WHERE id=?',account.id)); }
  m=pathname.match(/^\/api\/accounts\/(\d+)\/transactions$/);
  if(req.method==='GET' && m){ const user=requireAuth(req,res); if(!user)return; const account=ownAccount(user.id,m[1]); if(!account)return error(res,404,'Account not found.'); const from=url.searchParams.get('from'),to=url.searchParams.get('to'),type=url.searchParams.get('type'),status=url.searchParams.get('status'),reference=url.searchParams.get('reference'),minAmount=url.searchParams.get('minAmount'),maxAmount=url.searchParams.get('maxAmount'); let sql='SELECT * FROM transactions WHERE account_id=?',p=[account.id]; if(from){sql+=' AND created_at>=?';p.push(from);} if(to){sql+=' AND created_at<=?';p.push(to+'T23:59:59.999Z');} if(type){sql+=' AND transaction_type=?';p.push(type);} if(status){sql+=' AND status=?';p.push(status);} if(reference){sql+=' AND reference LIKE ?';p.push('%'+reference+'%');} if(minAmount){sql+=' AND amount_minor>=?';p.push(moneyMinor(minAmount));} if(maxAmount){sql+=' AND amount_minor<=?';p.push(moneyMinor(maxAmount));} sql+=' ORDER BY created_at DESC LIMIT 500'; return send(res,200,queryAll(sql,...p)); }
  m=pathname.match(/^\/api\/accounts\/(\d+)\/statement$/);
  if(req.method==='GET' && m){ const user=requireAuth(req,res); if(!user)return; const account=ownAccount(user.id,m[1]); if(!account)return error(res,404,'Account not found.'); const from=url.searchParams.get('from')||'1970-01-01',to=url.searchParams.get('to')||'2999-12-31'; const tx=queryAll('SELECT * FROM transactions WHERE account_id=? AND created_at>=? AND created_at<=? ORDER BY created_at ASC',account.id,from,to+'T23:59:59.999Z'); const opening=tx.length?tx[0].balance_after_minor-(tx[0].direction==='CREDIT'?tx[0].amount_minor:-(tx[0].amount_minor+tx[0].fee_minor)):account.balance_minor; const credits=tx.filter(x=>x.direction==='CREDIT').reduce((s,x)=>s+x.amount_minor,0); const debits=tx.filter(x=>x.direction==='DEBIT').reduce((s,x)=>s+x.amount_minor,0); const fees=tx.reduce((s,x)=>s+x.fee_minor,0); const statement={account,from,to,opening_balance_minor:opening,credits_minor:credits,debits_minor:debits,fees_minor:fees,closing_balance_minor:opening+credits-debits-fees,transactions:tx}; if(url.searchParams.get('format')==='csv'){ const rows=['Date,Reference,Type,Direction,Description,Amount,Fee,Currency,Balance',...tx.map(x=>[x.created_at,x.reference,x.transaction_type,x.direction,JSON.stringify(x.description),(x.amount_minor/100).toFixed(2),(x.fee_minor/100).toFixed(2),x.currency,(x.balance_after_minor/100).toFixed(2)].join(','))]; res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':`attachment; filename="statement-${account.account_number}.csv"`}); return res.end(rows.join('\n')); } return send(res,200,statement); }

  if(req.method==='GET' && pathname==='/api/beneficiaries'){ const user=requireAuth(req,res);if(!user)return;return send(res,200,queryAll('SELECT * FROM beneficiaries WHERE user_id=? ORDER BY created_at DESC',user.id)); }
  if(req.method==='POST' && pathname==='/api/beneficiaries'){ const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);if(!b.name||!b.bankName||!b.accountIdentifier||!b.currency)return error(res,400,'name, bankName, accountIdentifier and currency are required.');try{const r=execute(`INSERT INTO beneficiaries (user_id,name,bank_name,account_identifier,currency,nickname,status,verified,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,user.id,b.name,String(b.bankName).toUpperCase(),b.accountIdentifier,b.currency,b.nickname||'', 'ACTIVE',0,nowIso()); notify(user.id,'BENEFICIARY_ADDED','Beneficiary added',`${b.name} was added and requires OTP verification.`); audit(user.id,'ADD_BENEFICIARY','BENEFICIARY',r.lastInsertRowid); return send(res,201,{...queryOne('SELECT * FROM beneficiaries WHERE id=?',Number(r.lastInsertRowid)),demoOtp:QA_MODE?'123456':undefined});}catch(e){if(String(e).includes('UNIQUE'))return error(res,409,'This beneficiary already exists.');throw e;} }
  m=pathname.match(/^\/api\/beneficiaries\/(\d+)\/verify$/); if(req.method==='POST'&&m){const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);const ben=queryOne('SELECT * FROM beneficiaries WHERE id=? AND user_id=?',Number(m[1]),user.id);if(!ben)return error(res,404,'Beneficiary not found.');if(String(b.code)!=='123456')return error(res,401,'Invalid verification code.');execute('UPDATE beneficiaries SET verified=1 WHERE id=?',ben.id);audit(user.id,'VERIFY_BENEFICIARY','BENEFICIARY',ben.id);return send(res,200,queryOne('SELECT * FROM beneficiaries WHERE id=?',ben.id));}
  m=pathname.match(/^\/api\/beneficiaries\/(\d+)$/); if(req.method==='PATCH'&&m){const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);const ben=queryOne('SELECT * FROM beneficiaries WHERE id=? AND user_id=?',Number(m[1]),user.id);if(!ben)return error(res,404,'Beneficiary not found.');execute('UPDATE beneficiaries SET name=?,nickname=?,status=? WHERE id=?',b.name??ben.name,b.nickname??ben.nickname,b.status??ben.status,ben.id);audit(user.id,'UPDATE_BENEFICIARY','BENEFICIARY',ben.id);return send(res,200,queryOne('SELECT * FROM beneficiaries WHERE id=?',ben.id));} if(req.method==='DELETE'&&m){const user=requireAuth(req,res);if(!user)return;const ben=queryOne('SELECT * FROM beneficiaries WHERE id=? AND user_id=?',Number(m[1]),user.id);if(!ben)return error(res,404,'Beneficiary not found.');execute("UPDATE beneficiaries SET status='DELETED' WHERE id=?",ben.id);audit(user.id,'DELETE_BENEFICIARY','BENEFICIARY',ben.id);return send(res,200,{message:'Beneficiary deleted.'});}

  if(req.method==='GET' && pathname==='/api/transfers'){ const user=requireAuth(req,res);if(!user)return;return send(res,200,queryAll(`SELECT t.*,b.name beneficiary_name,b.bank_name FROM transfers t LEFT JOIN beneficiaries b ON b.id=t.beneficiary_id WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 300`,user.id)); }
  if(req.method==='POST' && pathname==='/api/transfers'){ const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);const result=executeTransfer({userId:user.id,fromAccountId:Number(b.fromAccountId),beneficiaryId:b.beneficiaryId?Number(b.beneficiaryId):null,toOwnAccountId:b.toOwnAccountId?Number(b.toOwnAccountId):null,amountMinor:moneyMinor(b.amount),memo:b.memo||'',idempotencyKey:b.idempotencyKey||req.headers['idempotency-key']||randomToken(10),scheduleFor:b.scheduleFor||null,qaSimulation:QA_MODE?b.qaSimulation:null});return send(res,result.status==='FAILED'?422:201,result); }

  if(req.method==='GET' && pathname==='/api/cards'){ const user=requireAuth(req,res);if(!user)return;return send(res,200,queryAll('SELECT * FROM cards WHERE user_id=? ORDER BY id DESC',user.id)); }
  if(req.method==='POST' && pathname==='/api/cards'){ const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);const account=ownAccount(user.id,b.accountId);if(!account)return error(res,404,'Account not found.');if(account.status!=='ACTIVE')return error(res,409,'Card can only be requested for an active account.');const r=execute(`INSERT INTO cards (user_id,account_id,last4,cardholder_name,card_type,status,expiry_month,expiry_year,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,user.id,account.id,String(Math.floor(1000+Math.random()*9000)),`${user.first_name} ${user.last_name}`.toUpperCase(),'DEBIT','PENDING_ACTIVATION',12,new Date().getFullYear()+4,nowIso());audit(user.id,'REQUEST_CARD','CARD',r.lastInsertRowid);return send(res,201,queryOne('SELECT * FROM cards WHERE id=?',Number(r.lastInsertRowid))); }
  m=pathname.match(/^\/api\/cards\/(\d+)\/(activate|freeze|unfreeze|replace|cancel|settings)$/); if(req.method==='POST'&&m){const user=requireAuth(req,res);if(!user)return;const card=queryOne('SELECT * FROM cards WHERE id=? AND user_id=?',Number(m[1]),user.id);if(!card)return error(res,404,'Card not found.');const action=m[2],b=await bodyJson(req);if(action==='activate')execute("UPDATE cards SET status='ACTIVE' WHERE id=?",card.id);else if(action==='freeze')execute("UPDATE cards SET status='FROZEN' WHERE id=?",card.id);else if(action==='unfreeze'){if(card.status!=='FROZEN')return error(res,409,'Only frozen cards can be unfrozen.');execute("UPDATE cards SET status='ACTIVE' WHERE id=?",card.id);}else if(action==='cancel')execute("UPDATE cards SET status='CANCELLED',cancelled_at=? WHERE id=?",nowIso(),card.id);else if(action==='settings')execute(`UPDATE cards SET atm_enabled=?,online_enabled=?,international_enabled=?,contactless_enabled=?,atm_limit_minor=?,purchase_limit_minor=?,online_limit_minor=? WHERE id=?`,b.atmEnabled?1:0,b.onlineEnabled?1:0,b.internationalEnabled?1:0,b.contactlessEnabled?1:0,moneyMinor(b.atmLimit||card.atm_limit_minor/100),moneyMinor(b.purchaseLimit||card.purchase_limit_minor/100),moneyMinor(b.onlineLimit||card.online_limit_minor/100),card.id);else if(action==='replace'){execute("UPDATE cards SET status='REPLACED' WHERE id=?",card.id);const r=execute(`INSERT INTO cards (user_id,account_id,last4,cardholder_name,card_type,status,expiry_month,expiry_year,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,user.id,card.account_id,String(Math.floor(1000+Math.random()*9000)),card.cardholder_name,card.card_type,'PENDING_ACTIVATION',12,new Date().getFullYear()+4,nowIso());execute('UPDATE cards SET replaced_by_card_id=? WHERE id=?',Number(r.lastInsertRowid),card.id);}audit(user.id,action.toUpperCase()+'_CARD','CARD',card.id,'SUCCESS',b);return send(res,200,queryAll('SELECT * FROM cards WHERE user_id=? ORDER BY id DESC',user.id));}

  if(req.method==='GET' && pathname==='/api/billers'){ const user=requireAuth(req,res);if(!user)return;return send(res,200,{billers:queryAll('SELECT * FROM billers ORDER BY category,name'),saved:queryAll(`SELECT s.*,b.name,b.category,b.customer_reference_label FROM saved_billers s JOIN billers b ON b.id=s.biller_id WHERE s.user_id=? ORDER BY s.created_at DESC`,user.id)}); }
  if(req.method==='POST' && pathname==='/api/billers/saved'){const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);try{const r=execute(`INSERT INTO saved_billers (user_id,biller_id,alias,customer_reference,created_at) VALUES (?,?,?,?,?)`,user.id,Number(b.billerId),b.alias||'',b.customerReference||'',nowIso());audit(user.id,'SAVE_BILLER','SAVED_BILLER',r.lastInsertRowid);return send(res,201,queryOne('SELECT * FROM saved_billers WHERE id=?',Number(r.lastInsertRowid)));}catch(e){if(String(e).includes('UNIQUE'))return error(res,409,'This biller reference is already saved.');throw e;}}
  if(req.method==='GET' && pathname==='/api/bill-payments'){const user=requireAuth(req,res);if(!user)return;return send(res,200,queryAll(`SELECT p.*,b.name biller_name,b.category FROM bill_payments p JOIN billers b ON b.id=p.biller_id WHERE p.user_id=? ORDER BY p.created_at DESC`,user.id));}
  if(req.method==='POST' && pathname==='/api/bill-payments'){const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);const result=processBillPayment({userId:user.id,accountId:Number(b.accountId),billerId:Number(b.billerId),savedBillerId:b.savedBillerId?Number(b.savedBillerId):null,customerReference:b.customerReference||'',amountMinor:moneyMinor(b.amount),scheduledFor:b.scheduleFor||null,recurringFrequency:b.recurringFrequency||null});return send(res,201,result);}

  if(req.method==='GET' && pathname==='/api/loans'){const user=requireAuth(req,res);if(!user)return;return send(res,200,queryAll('SELECT * FROM loans WHERE user_id=? ORDER BY applied_at DESC',user.id));}
  if(req.method==='POST' && pathname==='/api/loans'){const user=requireAuth(req,res);if(!user)return;const kyc=queryOne('SELECT status FROM kyc_profiles WHERE user_id=?',user.id);if(kyc?.status!=='VERIFIED')return error(res,403,'Verified KYC is required to apply for a loan.');const b=await bodyJson(req),amount=moneyMinor(b.amount),months=Number(b.termMonths),rate=b.loanType==='AUTO'?15.5:18;if(!Number.isInteger(amount)||amount<100000)return error(res,400,'Loan amount must be at least 1,000.');if(![12,24,36,48,60].includes(months))return error(res,400,'Term must be 12, 24, 36, 48 or 60 months.');const account=ownAccount(user.id,b.disbursementAccountId);if(!account)return error(res,404,'Disbursement account not found.');const monthly=calculateLoanPayment(amount,rate,months);const r=execute(`INSERT INTO loans (user_id,loan_type,amount_minor,interest_rate,term_months,monthly_payment_minor,remaining_principal_minor,purpose,status,disbursement_account_id,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,user.id,b.loanType||'PERSONAL',amount,rate,months,monthly,amount,b.purpose||'','SUBMITTED',account.id,nowIso());notify(user.id,'LOAN_SUBMITTED','Loan application submitted',`Loan #${r.lastInsertRowid} is awaiting review.`);audit(user.id,'APPLY_LOAN','LOAN',r.lastInsertRowid,'SUCCESS',{amount,months,rate});return send(res,201,queryOne('SELECT * FROM loans WHERE id=?',Number(r.lastInsertRowid)));}
  m=pathname.match(/^\/api\/loans\/(\d+)\/pay$/);if(req.method==='POST'&&m){const user=requireAuth(req,res);if(!user)return;const b=await bodyJson(req);return send(res,200,payLoan(user.id,Number(m[1]),Number(b.accountId),moneyMinor(b.amount)));}

  if(req.method==='GET' && pathname==='/api/notifications'){const user=requireAuth(req,res);if(!user)return;return send(res,200,queryAll('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200',user.id));}
  m=pathname.match(/^\/api\/notifications\/(\d+)\/read$/);if(req.method==='POST'&&m){const user=requireAuth(req,res);if(!user)return;execute('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?',nowIso(),Number(m[1]),user.id);return send(res,200,{message:'Notification marked read.'});}

  // Back-office routes
  if(req.method==='GET' && pathname==='/api/admin/dashboard'){const staff=requirePermission(req,res,'READ_CUSTOMERS');if(!staff)return;const metrics={customers:Number(queryOne("SELECT COUNT(*) count FROM users WHERE role='CUSTOMER'").count),activeAccounts:Number(queryOne("SELECT COUNT(*) count FROM accounts WHERE status='ACTIVE'").count),pendingKyc:Number(queryOne("SELECT COUNT(*) count FROM kyc_profiles WHERE status IN ('PENDING','UNDER_REVIEW','NEEDS_MORE_INFORMATION')").count),openFraud:Number(queryOne("SELECT COUNT(*) count FROM fraud_alerts WHERE status IN ('OPEN','INVESTIGATING')").count),pendingLoans:Number(queryOne("SELECT COUNT(*) count FROM loans WHERE status IN ('SUBMITTED','UNDER_REVIEW')").count),transferVolumeMinor:Number(queryOne("SELECT COALESCE(SUM(amount_minor),0) total FROM transfers WHERE status='COMPLETED'").total)};return send(res,200,metrics);}
  if(req.method==='GET' && pathname==='/api/admin/customers'){const staff=requirePermission(req,res,'READ_CUSTOMERS');if(!staff)return;const q=`%${url.searchParams.get('q')||''}%`;return send(res,200,queryAll(`SELECT u.id,u.email,u.first_name,u.last_name,u.phone,u.status,u.email_verified,u.created_at,u.last_login,k.status kyc_status FROM users u LEFT JOIN kyc_profiles k ON k.user_id=u.id WHERE u.role='CUSTOMER' AND (u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?) ORDER BY u.created_at DESC LIMIT 200`,q,q,q));}
  m=pathname.match(/^\/api\/admin\/customers\/(\d+)$/);if(req.method==='GET'&&m){const staff=requirePermission(req,res,'READ_CUSTOMERS');if(!staff)return;const id=Number(m[1]);return send(res,200,{snapshot:userSnapshot(id),kyc:sanitizeIdNumber(queryOne('SELECT * FROM kyc_profiles WHERE user_id=?',id)),beneficiaries:queryAll('SELECT * FROM beneficiaries WHERE user_id=?',id),transfers:queryAll('SELECT * FROM transfers WHERE user_id=? ORDER BY created_at DESC LIMIT 50',id),loans:queryAll('SELECT * FROM loans WHERE user_id=? ORDER BY applied_at DESC',id)});}
  if(req.method==='GET' && pathname==='/api/admin/kyc'){const staff=requirePermission(req,res,'READ_CUSTOMERS');if(!staff)return;return send(res,200,queryAll(`SELECT k.id,k.user_id,k.status,k.date_of_birth,k.nationality,k.address,k.employment,k.annual_income_minor,k.id_type,k.id_number,k.document_name,k.document_mime,CASE WHEN k.document_data_b64 IS NOT NULL THEN 1 ELSE 0 END has_document,k.reviewer_note,k.reviewed_by,k.updated_at,u.email,u.first_name,u.last_name FROM kyc_profiles k JOIN users u ON u.id=k.user_id ORDER BY CASE k.status WHEN 'UNDER_REVIEW' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,k.updated_at DESC`));}
  m=pathname.match(/^\/api\/admin\/kyc\/(\d+)\/document$/); if(req.method==='GET'&&m){const staff=requirePermission(req,res,'READ_CUSTOMERS');if(!staff)return;const k=queryOne('SELECT document_name,document_mime,document_data_b64 FROM kyc_profiles WHERE id=?',Number(m[1]));if(!k?.document_data_b64)return error(res,404,'No uploaded KYC document is stored.');const buf=Buffer.from(k.document_data_b64,'base64');res.writeHead(200,{'Content-Type':k.document_mime||'application/octet-stream','Content-Disposition':`attachment; filename="${String(k.document_name||'kyc-document').replaceAll('"','')}"`,'Cache-Control':'no-store'});return res.end(buf);}
  m=pathname.match(/^\/api\/admin\/kyc\/(\d+)\/review$/);if(req.method==='POST'&&m){const staff=requirePermission(req,res,'REVIEW_KYC');if(!staff)return;const b=await bodyJson(req);const allowed=['VERIFIED','REJECTED','NEEDS_MORE_INFORMATION','SUSPENDED'];if(!allowed.includes(b.status))return error(res,400,'Invalid KYC review status.');execute('UPDATE kyc_profiles SET status=?,reviewer_note=?,reviewed_by=?,updated_at=? WHERE id=?',b.status,b.note||'',staff.id,nowIso(),Number(m[1]));const k=queryOne('SELECT * FROM kyc_profiles WHERE id=?',Number(m[1]));if(!k)return error(res,404,'KYC profile not found.');notify(k.user_id,'KYC_REVIEW','Identity verification updated',`Your KYC status is now ${b.status}.`);audit(staff.id,'REVIEW_KYC','KYC',k.id,'SUCCESS',{status:b.status});return send(res,200,k);}
  if(req.method==='GET' && pathname==='/api/admin/accounts'){const staff=requirePermission(req,res,'READ_ACCOUNTS');if(!staff)return;return send(res,200,queryAll(`SELECT a.*,u.email,u.first_name,u.last_name FROM accounts a JOIN users u ON u.id=a.user_id ORDER BY a.opened_at DESC LIMIT 300`));}
  m=pathname.match(/^\/api\/admin\/accounts\/(\d+)\/(freeze|unfreeze|dormant|activate|limit)$/);if(req.method==='POST'&&m){const staff=requirePermission(req,res,m[2]==='limit'?'MANAGE_LIMITS':'MANAGE_ACCOUNTS');if(!staff)return;const account=queryOne('SELECT * FROM accounts WHERE id=?',Number(m[1]));if(!account)return error(res,404,'Account not found.');const b=await bodyJson(req);if(m[2]==='freeze')execute("UPDATE accounts SET status='FROZEN' WHERE id=?",account.id);else if(['unfreeze','activate'].includes(m[2]))execute("UPDATE accounts SET status='ACTIVE' WHERE id=?",account.id);else if(m[2]==='dormant')execute("UPDATE accounts SET status='DORMANT' WHERE id=?",account.id);else execute('UPDATE accounts SET daily_limit_minor=? WHERE id=?',moneyMinor(b.dailyLimit),account.id);notify(account.user_id,'ACCOUNT_STATUS','Account updated',`Account ending ${account.account_number.slice(-4)} was updated by bank operations.`);audit(staff.id,m[2].toUpperCase()+'_ACCOUNT','ACCOUNT',account.id,'SUCCESS',b);return send(res,200,queryOne('SELECT * FROM accounts WHERE id=?',account.id));}
  if(req.method==='GET' && pathname==='/api/admin/transfers'){const staff=requirePermission(req,res,'READ_TRANSFERS');if(!staff)return;return send(res,200,queryAll(`SELECT t.*,u.email,b.name beneficiary_name FROM transfers t JOIN users u ON u.id=t.user_id LEFT JOIN beneficiaries b ON b.id=t.beneficiary_id ORDER BY t.created_at DESC LIMIT 300`));}
  m=pathname.match(/^\/api\/admin\/transfers\/(\d+)\/reverse$/);if(req.method==='POST'&&m){const staff=requirePermission(req,res,'REVERSE_TRANSFER');if(!staff)return;return send(res,200,reverseTransfer(staff.id,Number(m[1])));}
  if(req.method==='GET' && pathname==='/api/admin/loans'){const staff=requirePermission(req,res,'READ_CUSTOMERS');if(!staff)return;return send(res,200,queryAll(`SELECT l.*,u.email,u.first_name,u.last_name FROM loans l JOIN users u ON u.id=l.user_id ORDER BY l.applied_at DESC`));}
  m=pathname.match(/^\/api\/admin\/loans\/(\d+)\/review$/);if(req.method==='POST'&&m){const staff=requirePermission(req,res,'REVIEW_LOANS');if(!staff)return;const b=await bodyJson(req);return send(res,200,reviewLoan(staff.id,Number(m[1]),b.decision,b.note||''));}
  if(req.method==='GET' && pathname==='/api/admin/fraud'){const staff=requirePermission(req,res,'READ_FRAUD');if(!staff)return;return send(res,200,queryAll(`SELECT f.*,u.email,t.reference transfer_reference FROM fraud_alerts f LEFT JOIN users u ON u.id=f.user_id LEFT JOIN transfers t ON t.id=f.transfer_id ORDER BY f.created_at DESC`));}
  m=pathname.match(/^\/api\/admin\/fraud\/(\d+)$/);if(req.method==='PATCH'&&m){const staff=requirePermission(req,res,'MANAGE_FRAUD');if(!staff)return;const b=await bodyJson(req);const allowed=['OPEN','INVESTIGATING','CLEARED','CONFIRMED'];if(!allowed.includes(b.status))return error(res,400,'Invalid fraud status.');execute('UPDATE fraud_alerts SET status=?,assigned_to=?,resolution_note=?,resolved_at=? WHERE id=?',b.status,staff.id,b.note||'',['CLEARED','CONFIRMED'].includes(b.status)?nowIso():null,Number(m[1]));audit(staff.id,'UPDATE_FRAUD_ALERT','FRAUD_ALERT',m[1],'SUCCESS',b);return send(res,200,queryOne('SELECT * FROM fraud_alerts WHERE id=?',Number(m[1])));}
  if(req.method==='GET' && pathname==='/api/admin/audit'){const staff=requirePermission(req,res,'READ_AUDIT');if(!staff)return;const action=url.searchParams.get('action'),actor=url.searchParams.get('actor');let sql=`SELECT a.*,u.email actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE 1=1`,p=[];if(action){sql+=' AND a.action=?';p.push(action);}if(actor){sql+=' AND a.actor_user_id=?';p.push(Number(actor));}sql+=' ORDER BY a.created_at DESC LIMIT 500';return send(res,200,queryAll(sql,...p));}
  if(req.method==='GET' && pathname==='/api/admin/users'){const staff=requireAuth(req,res);if(!staff)return;if(staff.role!=='ADMIN')return error(res,403,'Administrator role required.');return send(res,200,queryAll(`SELECT id,email,first_name,last_name,phone,role,status,email_verified,mfa_enabled,created_at,last_login FROM users ORDER BY created_at DESC`));}
  m=pathname.match(/^\/api\/admin\/users\/(\d+)\/role$/);if(req.method==='POST'&&m){const staff=requireAuth(req,res);if(!staff)return;if(staff.role!=='ADMIN')return error(res,403,'Administrator role required.');const b=await bodyJson(req),allowed=['CUSTOMER','SUPPORT','AUDITOR','EMPLOYEE','MANAGER','ADMIN'];if(!allowed.includes(b.role))return error(res,400,'Invalid role.');execute('UPDATE users SET role=? WHERE id=?',b.role,Number(m[1]));audit(staff.id,'CHANGE_ROLE','USER',m[1],'SUCCESS',{role:b.role});return send(res,200,publicUser(queryOne('SELECT * FROM users WHERE id=?',Number(m[1]))));}

  return error(res,404,'API route not found.');
}

function serveStatic(req,res,url){
  let pathname=decodeURIComponent(url.pathname); if(pathname==='/') pathname='/index.html';
  let file=path.join(publicDir,pathname); if(!file.startsWith(publicDir)) return error(res,403,'Forbidden.');
  if(!fs.existsSync(file)||fs.statSync(file).isDirectory()) file=path.join(publicDir,'index.html');
  const ext=path.extname(file); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
  res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-store':'public, max-age=300'}); fs.createReadStream(file).pipe(res);
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization, Idempotency-Key','Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS'});return res.end();}
  try{ if(url.pathname.startsWith('/api/')) await handleApi(req,res,url); else serveStatic(req,res,url); }
  catch(e){ console.error(e); error(res,e.status||500,e.message||'Internal server error.'); }
});

setInterval(()=>{ try{ processDueScheduledItems(); }catch(e){ console.error('scheduled-job',e); } },30000).unref();
server.listen(PORT,()=>console.log(`NovaBank QA Lab running at http://localhost:${PORT}`));
