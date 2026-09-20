const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
async function request(path,{method='GET',token,body,headers={}}={}){
  const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{}) ,...headers},body:body?JSON.stringify(body):undefined});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${d.error||JSON.stringify(d)}`); return d;
}
async function login(email,password,country='EG'){
  const l=await request('/api/auth/login',{method:'POST',body:{email,password}});
  if(l.mfaRequired){const m=await request('/api/auth/mfa',{method:'POST',headers:{'x-qa-country':country},body:{challenge:l.challenge,code:'123456'}});return m.token;}
  return l.token;
}
function assert(ok,msg){if(!ok)throw new Error(`ASSERTION FAILED: ${msg}`);console.log(`✓ ${msg}`);}

const customer=await login('customer@novabank.test','Demo123!');
assert(customer,'customer MFA login works');
const me=await request('/api/me',{token:customer});
assert(me.accounts.length>=3,'customer accounts load');
assert(me.kyc.status==='VERIFIED','seeded customer KYC is verified');
const beneficiaries=await request('/api/beneficiaries',{token:customer});
const sameBank=beneficiaries.find(b=>b.bank_name==='NOVABANK'&&b.verified);
assert(sameBank,'verified same-bank beneficiary exists');
const from=me.accounts.find(a=>a.currency==='EGP'&&a.status==='ACTIVE');
const before=from.balance_minor;
const transfer=await request('/api/transfers',{method:'POST',token:customer,body:{fromAccountId:from.id,beneficiaryId:sameBank.id,amount:12.34,memo:'smoke test',idempotencyKey:`smoke-${Date.now()}`}});
assert(transfer.status==='COMPLETED','same-bank transfer completes');
const afterAccounts=await request('/api/accounts',{token:customer});
assert(afterAccounts.find(a=>a.id===from.id).balance_minor===before-1234,'sender balance debited atomically');
const tx=await request(`/api/accounts/${from.id}/transactions`,{token:customer});
assert(tx.some(t=>t.transfer_id===transfer.id&&t.direction==='DEBIT'),'ledger debit created');
const debitRow=tx.find(t=>t.transfer_id===transfer.id&&t.direction==='DEBIT');
const filtered=await request(`/api/accounts/${from.id}/transactions?reference=${encodeURIComponent(debitRow.reference.slice(-6))}&type=TRANSFER&status=COMPLETED`,{token:customer});
assert(filtered.some(t=>t.transfer_id===transfer.id),'transaction reference/type/status filtering works');

const failResp=await fetch(base+'/api/transfers',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${customer}`},body:JSON.stringify({fromAccountId:from.id,beneficiaryId:beneficiaries.find(b=>b.bank_name!=='NOVABANK').id,amount:5,qaSimulation:'failure',idempotencyKey:`fail-${Date.now()}`})});
const failed=await failResp.json();
assert(failResp.status===422 && failed.status==='FAILED','fault-injected external transfer fails safely');
const afterFailed=await request('/api/accounts',{token:customer});
assert(afterFailed.find(a=>a.id===from.id).balance_minor===before-1234,'failed external transfer does not deduct funds');

const billers=await request('/api/billers',{token:customer});
const bill=await request('/api/bill-payments',{method:'POST',token:customer,body:{accountId:from.id,billerId:billers.billers[0].id,customerReference:'SMOKE-REF',amount:1}});
assert(bill.status==='COMPLETED','bill payment completes');
await request('/api/bill-payments',{method:'POST',token:customer,body:{accountId:from.id,billerId:billers.billers[0].id,customerReference:'SMOKE-REC',amount:0.5,recurringFrequency:'MONTHLY'}});
const billsAfter=await request('/api/bill-payments',{token:customer});
assert(billsAfter.some(p=>p.customer_reference==='SMOKE-REC'&&p.status==='SCHEDULED'&&p.recurring_frequency==='MONTHLY'),'recurring bill creates next scheduled occurrence');

const pending=await login('pending@novabank.test','Demo123!');
const documentData=Buffer.from('%PDF-1.4\nNovaBank smoke document').toString('base64');
await request('/api/kyc',{method:'POST',token:pending,body:{dateOfBirth:'1995-03-12',nationality:'Egyptian',address:'Giza, Egypt',employment:'Accountant',annualIncome:360000,idType:'NATIONAL_ID',idNumber:'29503121234567',documentName:'smoke-id.pdf',documentMime:'application/pdf',documentDataB64:documentData}});
const docResp=await fetch(base+'/api/kyc/document',{headers:{Authorization:`Bearer ${pending}`}});
assert(docResp.ok && (await docResp.arrayBuffer()).byteLength>0,'KYC document upload and download works');

const unusual=await login('receiver@novabank.test','Demo123!','US');
assert(unusual,'unusual-country QA login completes while generating risk signal');

const admin=await login('admin@novabank.test','Admin123!');
assert(admin,'admin MFA login works');
const dashboard=await request('/api/admin/dashboard',{token:admin});
assert(dashboard.customers>=3,'admin dashboard metrics load');
const reversed=await request(`/api/admin/transfers/${transfer.id}/reverse`,{method:'POST',token:admin,body:{}});
assert(reversed.status==='REVERSED','manager-level reversal workflow works');
const fraud=await request('/api/admin/fraud',{token:admin});
assert(fraud.some(f=>f.rule_code==='UNUSUAL_LOGIN'),'unusual-country login creates a fraud alert');
const audit=await request('/api/admin/audit',{token:admin});
assert(audit.some(a=>a.action==='REVERSE_TRANSFER'&&a.entity_id===transfer.reference),'reversal audit record created');

const loans=await request('/api/admin/loans',{token:admin});
assert(loans.length>0,'loan underwriting queue loads');
const kyc=await request('/api/admin/kyc',{token:admin});
assert(kyc.length>0,'KYC review queue loads');
const cards=await request('/api/cards',{token:customer});
assert(cards.length>0,'customer cards load');
const notes=await request('/api/notifications',{token:customer});
assert(notes.length>0,'notifications load');

console.log('\nNovaBank smoke suite passed.');
