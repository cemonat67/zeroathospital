const http = require('http')
const url = require('url')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

let PORT = 5174
let DATA_DIR = path.join(__dirname, 'data')
try{ const cfg = JSON.parse(fs.readFileSync(path.join(__dirname,'config','ops.config.json'),'utf8')); const env = (process.env.ZERO_ENV||'prod').toLowerCase(); const sel = (cfg.envs&&cfg.envs[env])? cfg.envs[env] : cfg.envs?.prod; if (sel){ if (sel.port) PORT = sel.port; if (sel.dataDir) DATA_DIR = path.join(__dirname, sel.dataDir) } }catch(_){ }
const FILES_DIR = path.join(DATA_DIR, 'files')
const REPORTS_DIR = path.join(DATA_DIR, 'reports')

function ensureDirs(){ try{ fs.mkdirSync(DATA_DIR,{recursive:true}); fs.mkdirSync(FILES_DIR,{recursive:true}); fs.mkdirSync(REPORTS_DIR,{recursive:true}) }catch(_){} }
function readJson(p, def){ try{ return JSON.parse(fs.readFileSync(p,'utf8')) }catch(_){ return def } }
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj,null,2)) }
function send(res, status, data){ res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, X-API-Key', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS,DELETE' }); res.end(JSON.stringify(data)) }
function ok(res, data){ send(res,200,data) }
function bad(res, msg){ send(res,400,{ error:String(msg||'bad_request') }) }
function notf(res){ send(res,404,{ error:'not_found' }) }

function opsFilePath(){ const d=new Date(); const yyyy=d.getFullYear(), mm=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return path.join(DATA_DIR, `ops_metrics_${yyyy}${mm}${dd}.jsonl`) }
function appendOpsEntry(obj){ try{ fs.appendFileSync(opsFilePath(), JSON.stringify(obj)+'\n') }catch(_){ } }
function readOpsRecent(minutes){ try{ const txt=fs.readFileSync(opsFilePath(),'utf8'); const now=Date.now(); const lim=now - minutes*60*1000; const lines=txt.trim().split(/\n/).slice(-20000); const arr=[]; for (const l of lines){ try{ const j=JSON.parse(l); const t=new Date(j.ts).getTime(); if (!isFinite(t)||t<lim) continue; arr.push(j) }catch(_){ } } return arr }catch(_){ return [] } }
function readOpsWindow(hours){ function readDayFile(date){ try{ const yyyy=date.getFullYear(), mm=String(date.getMonth()+1).padStart(2,'0'), dd=String(date.getDate()).padStart(2,'0'); const fp=path.join(DATA_DIR, `ops_metrics_${yyyy}${mm}${dd}.jsonl`); const txt=fs.readFileSync(fp,'utf8'); return txt.trim().split(/\n/).map(l=>{ try{ return JSON.parse(l) }catch(_){ return null } }).filter(Boolean) }catch(_){ return [] } } const now=new Date(); const yesterday=new Date(now.getTime()-24*60*60*1000); const arr=readDayFile(now).concat(readDayFile(yesterday)); const lim=Date.now()-hours*60*60*1000; return arr.filter(j=>{ const t=new Date(j.ts).getTime(); return isFinite(t)&&t>=lim }) }

function parseBody(req){ return new Promise(resolve=>{ let b=''; req.on('data',c=> b+=c); req.on('end',()=>{ try{ resolve(JSON.parse(b||'{}')) }catch(_){ resolve({}) } }) }) }
function makeSimplePdfBase64(title, lines){
  const objects = []
  const add = (s)=> objects.push(s)
  add('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj')
  add('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj')
  const content = ['BT /F1 12 Tf 50 780 Td ('+title.replace(/[()]/g,'')+') Tj T*'].concat(lines.map(l=> '('+String(l).replace(/[()]/g,'')+') Tj T*')).join(' ')
  const stream = '4 0 obj<< /Length '+content.length+' >>stream\n'+content+'\nendstream endobj'
  add('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj')
  add(stream)
  add('5 0 obj<< /Type /Font /Subtype /Type1 /Name /F1 /BaseFont /Helvetica >>endobj')
  let offset = 0
  const header = '%PDF-1.4\n'
  offset += header.length
  const body = objects.map((o,i)=>{ const s = (i+1)+' 0 obj\n'+o+'\n'; const pos = offset; offset += s.length; return { s, pos } })
  const xrefPos = offset
  const xref = 'xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n' + body.map(b=> String(b.pos).padStart(10,'0')+' 00000 n \n').join('')
  const trailer = 'trailer<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xrefPos+'\n%%EOF'
  const pdf = header + body.map(b=> b.s).join('') + xref + trailer
  return Buffer.from(pdf,'utf8').toString('base64')
}
function fillTemplate(text, ctx){
  return String(text||'').replace(/\{\{(\w+)\}\}/g, (_,k)=> {
    const v = ctx[k]; return v===undefined||v===null ? '' : String(v)
  })
}
function runEscalationOnce(){
  const tp = path.join(DATA_DIR,'tasks.json')
  const rp = path.join(DATA_DIR,'escalation_rules.json')
  const gp = path.join(DATA_DIR,'notify_groups.json')
  const tp2 = path.join(DATA_DIR,'notify_templates.json')
  const ep = path.join(DATA_DIR,'emails.json')
  const tasks = readJson(tp,{ tasks:[] })
  const rules = readJson(rp,{ rules:[] }).rules
  const groups = readJson(gp,{ groups:[] }).groups
  const templates = readJson(tp2,{ templates:[] }).templates
  let escalated = 0, emailed = 0
  const now = Date.now()
  for (const t of tasks.tasks){
    if (t.status!=='open') continue
    if (!t.sla_due) continue
    const due = new Date(t.sla_due).getTime(); if (!isFinite(due)) continue
    const od = Math.floor((now - due)/(24*60*60*1000))
    for (const r of rules){
      if (r.dept && String(t.dept||'')!==String(r.dept)) continue
      if (od>=r.overdue_days){
        t.status = 'escalated'; t.escalation_count = (t.escalation_count||0)+1; if (r.assignee) t.assignee = r.assignee
        escalated++
        const g = groups.find(x=> x.name===r.group)
        const tmpl = templates.find(x=> x.name===r.template)
        if (g && tmpl){
          const ctx = { dept: t.dept||'', title: t.title||'', sla_due: t.sla_due||'', created_at: new Date(t.created_at||now).toISOString(), assignee: t.assignee||'' }
          const subj = fillTemplate(tmpl.subject, ctx)
          const body = fillTemplate(tmpl.body, ctx)
          const out = readJson(ep,{ outbox:[] })
          for (const to of g.emails){ out.outbox.push({ id:'em_'+Date.now()+Math.random().toString(36).slice(2,6), to, subject: subj, body, attachments: [], created_at: Date.now() }); emailed++ }
          writeJson(ep, out)
        }
      }
    }
  }
  writeJson(tp, tasks)
  return { escalated, emailed }
}

ensureDirs()

const USERS_PATH = path.join(DATA_DIR,'users.json')
const SESS_PATH = path.join(DATA_DIR,'auth_sessions.json')
function usersExist(){ const j = readJson(USERS_PATH,{ users:[] }); return Array.isArray(j.users) && j.users.length>0 }
function makeSalt(){ return crypto.randomBytes(16).toString('hex') }
function hashPwd(pw, salt){ return crypto.pbkdf2Sync(String(pw), String(salt), 120000, 32, 'sha256').toString('hex') }
function makeToken(){ return 'k_'+Date.now()+'_'+crypto.randomBytes(8).toString('hex') }
function saveSession(u, role){ const j = readJson(SESS_PATH,{ sessions:{} }); const sc = readJson(path.join(DATA_DIR,'security_config.json'),{ session_ttl_hours:12 }); const ttlh = +sc.session_ttl_hours || 12; const token = makeToken(); j.sessions[token] = { user:u, role, exp: Date.now()+ttlh*60*60*1000 }; writeJson(SESS_PATH, j); return token }
function getAuthRole(req){ const key = (req.headers['x-api-key']||'').toString().trim(); const s = getSession(key); return s && s.role ? s.role : 'user' }
function getSession(token){ const j = readJson(SESS_PATH,{ sessions:{} }); const s = j.sessions[token]; if (!s) return null; if (Date.now()>s.exp){ delete j.sessions[token]; writeJson(SESS_PATH,j); return null } return s }
function requireAuth(req){ const key = (req.headers['x-api-key']||'').toString().trim(); const s = getSession(key); return !!s }

const server = http.createServer(async (req,res)=>{
  const u = url.parse(req.url,true)
  const ip = (req.headers['x-forwarded-for']||'').toString().split(',')[0].trim() || req.socket.remoteAddress || 'local'
  const __ops_start = Date.now(); const _end = res.end; res.end = function(){ try{ appendOpsEntry({ ts: new Date().toISOString(), path: u.pathname||'', method: req.method||'', status: res.statusCode||0, duration_ms: Date.now()-__ops_start }) }catch(_){ } return _end.apply(res, arguments) }
  try{ fs.appendFileSync(path.join(DATA_DIR,'access.log'), `[${new Date().toISOString()}] ${ip} ${req.method} ${u.pathname}\n`) }catch(_){ }
  const SC = readJson(path.join(DATA_DIR,'security_config.json'),{ windowMs:60000, max:120, session_ttl_hours:12, password_min:8 })
  global.__rateHits = global.__rateHits || new Map()
  const now = Date.now()
  const key = ip
  let arr = global.__rateHits.get(key) || []
  arr = arr.filter(t=> now - t < SC.windowMs)
  arr.push(now)
  global.__rateHits.set(key, arr)
  if (arr.length > SC.max){ return send(res, 429, { error:'rate_limited' }) }
  if (req.method==='OPTIONS'){ res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type, X-API-Key', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS' }); return res.end() }
  if (u.pathname==='/'){
    try{
      const f = path.join(__dirname,'index.html')
      const html = fs.readFileSync(f,'utf8')
      res.writeHead(200, { 'Content-Type':'text/html', 'Access-Control-Allow-Origin':'*' })
      return res.end(html)
    }catch(e){ res.writeHead(200, { 'Content-Type':'text/plain', 'Access-Control-Allow-Origin':'*' }); return res.end('ZeroAtHospital API') }
  }
  if (u.pathname==='/logo.png' && req.method==='GET'){
    try{
      let buf
      let fp = path.join(__dirname,'images','zah_logo.PNG')
      try{ buf = fs.readFileSync(fp) }catch(_){ fp = path.join(__dirname,'images','zah_logo.png'); try{ buf = fs.readFileSync(fp) }catch(__){ fp = path.join(__dirname,'zah_logo.PNG'); try{ buf = fs.readFileSync(fp) }catch(___){ fp = path.join(__dirname,'zah_logo.png'); buf = fs.readFileSync(fp) } } }
      res.writeHead(200,{ 'Content-Type':'image/png', 'Content-Length': buf.length, 'Access-Control-Allow-Origin':'*' })
      return res.end(buf)
    }catch(e){ return notf(res) }
  }

  if (u.pathname==='/api/health' && req.method==='GET'){
    const ts = new Date().toISOString()
    let fsok=true, readable=false, writable=false, missing=[]
    try{ fs.accessSync(DATA_DIR, fs.constants.R_OK); readable=true }catch(_){ fsok=false }
    try{ fs.accessSync(DATA_DIR, fs.constants.W_OK); writable=true }catch(_){ fsok=false }
    const required = ['settings.json','alert_rules.json','tasks.json','users.json']
    for (const f of required){ try{ fs.accessSync(path.join(DATA_DIR,f), fs.constants.R_OK) }catch(_){ missing.push(f) } }
    const status = (fsok && missing.length===0)? 'ok' : 'degraded'
    const free_mb = Math.round(os.freemem()/1024/1024)
    const env = (process.env.ZERO_ENV||'prod').toLowerCase()
    return ok(res,{ status, timestamp: ts, app:{ uptime_sec: Math.round(process.uptime()), version:'v2.0.0', env }, checks:{ filesystem:{ status:'ok', free_mb }, dataFolder:{ status: fsok?'ok':'error', readable, writable }, jsonFiles:{ status: missing.length? 'missing':'ok', missing } } })
  }

  if (u.pathname==='/api/auth/register' && req.method==='POST'){
    const body = await parseBody(req)
    const users = readJson(USERS_PATH,{ users:[] })
    const u = String(body.username||'').trim(); const pw = String(body.password||'').trim(); const role = String(body.role||'user')
    if (!u || !pw) return bad(res,'missing_credentials')
    if (users.users.find(x=> x.u===u)) return bad(res,'exists')
    const salt = makeSalt(); const hash = hashPwd(pw, salt)
    users.users.push({ u, salt, hash, role })
    writeJson(USERS_PATH, users)
    return ok(res,{ ok:true })
  }
  if (u.pathname==='/api/auth/login' && req.method==='POST'){
    const body = await parseBody(req)
    const users = readJson(USERS_PATH,{ users:[] })
    const u = String(body.username||'').trim(); const pw = String(body.password||'').trim()
    const found = users.users.find(x=> x.u===u)
    if (!found) return bad(res,'invalid_user')
    const hash = hashPwd(pw, found.salt)
    if (hash!==found.hash) return bad(res,'invalid_password')
    const token = saveSession(u, found.role)
    return ok(res,{ token })
  }
  if (u.pathname==='/api/auth/logout' && req.method==='POST'){
    const key = (req.headers['x-api-key']||'').toString().trim(); const j = readJson(SESS_PATH,{ sessions:{} }); if (j.sessions[key]){ delete j.sessions[key]; writeJson(SESS_PATH,j) }
    return ok(res,{ ok:true })
  }
  if (u.pathname==='/api/auth/me' && req.method==='GET'){
    const role = getAuthRole({ headers: req.headers })
    return ok(res,{ role })
  }
  if (u.pathname==='/api/auth/permissions'){
    const p = path.join(DATA_DIR,'permissions.json')
    if (req.method==='GET'){ const j = readJson(p,{ components:{} }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      if (getAuthRole(req)!=='admin') return bad(res,'forbidden')
      const body = await parseBody(req)
      const j = readJson(p,{ components:{} })
      const comp = String(body.component||'').trim(); const roles = Array.isArray(body.roles)? body.roles : []
      if (!comp || !roles.length) return bad(res,'missing')
      j.components[comp] = roles
      writeJson(p, j); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/auth/users' && req.method==='GET'){
    const users = readJson(USERS_PATH,{ users:[] }).users
    return ok(res,{ users: users.map(u=> ({ u: u.u, role: u.role })) })
  }
  if (u.pathname==='/api/auth/role' && req.method==='POST'){
    if (!requireAuth(req)) return bad(res,'auth_required')
    if (getAuthRole(req)!=='admin') return bad(res,'forbidden')
    const body = await parseBody(req)
    const name = String(body.username||'').trim(); const role = String(body.role||'').trim()
    if (!name || !role) return bad(res,'missing')
    const j = readJson(USERS_PATH,{ users:[] })
    const idx = j.users.findIndex(x=> x.u===name)
    if (idx<0) return bad(res,'user_not_found')
    j.users[idx].role = role
    writeJson(USERS_PATH, j)
    return ok(res,{ ok:true })
  }

  if (u.pathname==='/api/models' && req.method==='GET'){ return ok(res,{ models:['claude-3.5-sonnet','claude-3-opus','claude-3-haiku'] }) }
  if (u.pathname==='/api/openai/models' && req.method==='GET'){ return ok(res,{ models:['gpt-4o','gpt-4o-mini','gpt-4.1'] }) }

  if (u.pathname==='/api/ops/summary' && req.method==='GET'){
    const windowHours = Math.max(1, Math.min(48, +(u.query.hours||24)))
    const arr = readOpsWindow(windowHours)
    const total = arr.length
    const byPath = new Map()
    let e4=0, e5=0
    for (const r of arr){ if (r.status>=400&&r.status<500) e4++; if (r.status>=500) e5++; const k=r.path||''; const a=byPath.get(k)||{ count:0, durations:[], errors:0 }; a.count++; a.durations.push(+r.duration_ms||0); if (r.status>=400) a.errors++; byPath.set(k,a) }
    function p95(vals){ if (!vals.length) return 0; const s=vals.slice().sort((a,b)=>a-b); const idx=Math.floor(0.95*(s.length-1)); return s[idx] }
    const top = Array.from(byPath.entries()).map(([p,a])=> ({ path:p, count:a.count, p95_ms: Math.round(p95(a.durations)), error_rate: +(a.errors/a.count).toFixed(3) }))
    top.sort((a,b)=> b.count - a.count)
    const topEndpoints = top.slice(0,10)
    const highP95 = top.slice().sort((a,b)=> b.p95_ms - a.p95_ms).slice(0,5)
    return ok(res,{ window_hours: windowHours, total_requests: total, top_endpoints: topEndpoints, high_latency: highP95, errors:{ '4xx': e4, '5xx': e5 } })
  }
  if (u.pathname==='/api/ops/timeseries' && req.method==='GET'){
    const minutes = Math.max(1, Math.min(720, +(u.query.minutes||60)))
    const endpoint = String(u.query.endpoint||'').trim()
    const prefix = String(u.query.prefix||'').trim()
    const arr = readOpsRecent(minutes)
    const buckets = new Map()
    for (const r of arr){
      if (endpoint && String(r.path||'')!==endpoint) continue
      if (prefix && !String(r.path||'').startsWith(prefix)) continue
      const t=new Date(r.ts).getTime(); if (!isFinite(t)) continue
      const m=Math.floor(t/60000)
      const b=buckets.get(m)||{ durs:[], total:0, errs:0 }
      b.durs.push(+r.duration_ms||0)
      b.total++
      if ((+r.status||0)>=400) b.errs++
      buckets.set(m,b)
    }
    const keys = Array.from(buckets.keys()).sort((a,b)=> a-b)
    function p95(vals){ if (!vals.length) return 0; const s=vals.slice().sort((a,b)=>a-b); const idx=Math.floor(0.95*(s.length-1)); return s[idx] }
    function ma(vals, win){ const out=[]; for (let i=0;i<vals.length;i++){ const s=Math.max(0,i-win+1); const sub=vals.slice(s,i+1); const v=sub.length? (sub.reduce((a,x)=>a+x,0)/sub.length) : 0; out.push(+v.toFixed(2)) } return out }
    const labels = keys.map(k=> new Date(k*60000).toISOString().slice(11,16))
    const p95_ms = keys.map(k=> Math.round(p95(buckets.get(k).durs)))
    const error_rate = keys.map(k=>{ const b=buckets.get(k); return b.total? +(b.errs/b.total).toFixed(3) : 0 })
    const p95_ma5 = ma(p95_ms, 5)
    const err_ma5 = ma(error_rate, 5)
    return ok(res,{ minutes, endpoint, prefix, labels, p95_ms, error_rate, p95_ma5, err_ma5 })
  }
  if (u.pathname==='/api/ops/tickets'){
    const p = path.join(DATA_DIR,'ops_tickets.json')
    if (req.method==='GET'){ const j=readJson(p,{ tickets:[] }); return ok(res, j) }
  }
  if (u.pathname==='/api/ops/prefixes' && req.method==='GET'){
    const windowHours = Math.max(1, Math.min(48, +(u.query.hours||24)))
    const arr = readOpsWindow(windowHours)
    const byPref = new Map()
    function prefOf(p){ const parts = String(p||'').split('/').filter(Boolean); if (!parts.length) return '/'; return '/'+parts.slice(0,Math.min(2,parts.length)).join('/') }
    for (const r of arr){ const k = prefOf(r.path||''); const a = byPref.get(k)||{ count:0, durs:[] }; a.count++; a.durs.push(+r.duration_ms||0); byPref.set(k,a) }
    function p95(vals){ if (!vals.length) return 0; const s=vals.slice().sort((a,b)=>a-b); const idx=Math.floor(0.95*(s.length-1)); return s[idx] }
    const list = Array.from(byPref.entries()).map(([prefix,a])=> ({ prefix, count:a.count, p95_ms: Math.round(p95(a.durs)) }))
    list.sort((a,b)=> b.count - a.count)
    return ok(res,{ window_hours: windowHours, prefixes: list.slice(0,20) })
  }

  if (u.pathname==='/api/finance/leakage' && req.method==='GET'){
    const campus = String(u.query.campus||'').trim()
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ costs:{ energy_eur_per_kwh:0.12, water_eur_per_m3:1.2, waste_eur_per_kg:0.15, medw_eur_per_kg:0.8 } })
    const c = settingsJson.costs||{}
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = dset.rows
    if (campus) rows = rows.filter(r=> String(r.campus||'')===campus)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const energy_kwh = sum(rows,'energy')
    const water_m3 = sum(rows,'water')
    const waste_kg = sum(rows,'waste')
    const medw_kg = sum(rows,'medw')
    const total_eur = +(energy_kwh*(c.energy_eur_per_kwh||0) + water_m3*(c.water_eur_per_m3||0) + waste_kg*(c.waste_eur_per_kg||0) + medw_kg*(c.medw_eur_per_kg||0)).toFixed(2)
    return ok(res,{ campus, totals:{ energy_kwh, water_m3, waste_kg, medw_kg, total_eur }, rates: c })
  }
  if (u.pathname==='/api/finance/leakage/top-depts' && req.method==='GET'){
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ costs:{ energy_eur_per_kwh:0.12, water_eur_per_m3:1.2, waste_eur_per_kg:0.15, medw_eur_per_kg:0.8 } })
    const c = settingsJson.costs||{}
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const byDept = new Map()
    for (const r of dset.rows||[]){ const k=String(r.dept||''); const a=byDept.get(k)||{ energy:0, water:0, waste:0, medw:0 }; a.energy += (+r.energy||0); a.water += (+r.water||0); a.waste += (+r.waste||0); a.medw += (+r.medw||0); byDept.set(k,a) }
    const list = Array.from(byDept.entries()).map(([dept,a])=> ({ dept, total_eur: +(a.energy*(c.energy_eur_per_kwh||0) + a.water*(c.water_eur_per_m3||0) + a.waste*(c.waste_eur_per_kg||0) + a.medw*(c.medw_eur_per_kg||0)).toFixed(2) })).filter(x=> x.total_eur>0)
    list.sort((a,b)=> b.total_eur - a.total_eur)
    return ok(res,{ top: list.slice(0,3) })
  }
  if (u.pathname==='/api/finance/leakage/by-dept' && req.method==='GET'){
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ costs:{ energy_eur_per_kwh:0.12, water_eur_per_m3:1.2, waste_eur_per_kg:0.15, medw_eur_per_kg:0.8 } })
    const c = settingsJson.costs||{}
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const byDept = new Map()
    for (const r of dset.rows||[]){ const k=String(r.dept||''); const a=byDept.get(k)||{ energy:0, water:0, waste:0, medw:0 }; a.energy += (+r.energy||0); a.water += (+r.water||0); a.waste += (+r.waste||0); a.medw += (+r.medw||0); byDept.set(k,a) }
    const list = Array.from(byDept.entries()).map(([dept,a])=> ({ dept, total_eur: +(a.energy*(c.energy_eur_per_kwh||0) + a.water*(c.water_eur_per_m3||0) + a.waste*(c.waste_eur_per_kg||0) + a.medw*(c.medw_eur_per_kg||0)).toFixed(2) }))
    list.sort((a,b)=> b.total_eur - a.total_eur)
    return ok(res,{ depts: list })
  }

  if (u.pathname==='/api/clinical/risk-heatmap' && req.method==='GET'){
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const byDept = new Map()
    for (const r of dset.rows||[]){ const k=String(r.dept||''); const a=byDept.get(k)||{ energy:0, water:0, waste:0, medw:0, co2:0, count:0 }; a.energy += (+r.energy||0); a.water += (+r.water||0); a.waste += (+r.waste||0); a.medw += (+r.medw||0); a.co2 += (+r.co2||0); a.count++; byDept.set(k,a) }
    const arr = Array.from(byDept.entries()).map(([dept,a])=>{ const norm = a.count||1; const e=a.energy/norm, w=a.water/norm, ws=a.waste/norm, m=a.medw/norm, c=a.co2/norm; const score = +( (e*0.3 + ws*0.25 + m*0.25 + w*0.2) ).toFixed(2); const risk = score>1000? 'red' : score>500? 'amber' : 'green'; return { dept, score, risk, indicators:{ energy:e, water:w, waste:ws, medw:m, co2:c } } })
    arr.sort((a,b)=> b.score - a.score)
    return ok(res,{ heatmap: arr })
  }
  if (u.pathname==='/api/clinical/volume'){
    const p = path.join(DATA_DIR,'clinical_volume.json')
    if (req.method==='GET'){ const j=readJson(p,{ volumes:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j=readJson(p,{ volumes:[] })
      const dept = String(body.dept||'').trim()
      const inpatients = +(body.inpatients||0)
      const surgeries = +(body.surgeries||0)
      const drg_weight = +(body.drg_weight||0)
      if (!dept) return bad(res,'missing')
      const idx = j.volumes.findIndex(x=> x.dept===dept)
      const item = { dept, inpatients, surgeries, drg_weight }
      if (idx>=0) j.volumes[idx]=item; else j.volumes.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/clinical/normalized' && req.method==='GET'){
    const dept = String(u.query.dept||'').trim()
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const vol = readJson(path.join(DATA_DIR,'clinical_volume.json'),{ volumes:[] }).volumes
    let rows = dset.rows
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const co2 = sum(rows,'co2')
    const v = vol.find(x=> !dept? true : x.dept===dept) || { inpatients:0, surgeries:0, drg_weight:0 }
    const per_inpatient = v.inpatients? +(co2/v.inpatients).toFixed(3) : null
    const per_surgery = v.surgeries? +(co2/v.surgeries).toFixed(3) : null
    const per_drg = v.drg_weight? +(co2/v.drg_weight).toFixed(3) : null
    return ok(res,{ dept, co2_total: +co2.toFixed(3), per_inpatient, per_surgery, per_drg })
  }

  if (u.pathname==='/api/eu/taxonomy' && req.method==='GET'){
    const campus = String(u.query.campus||'').trim()
    const dept = String(u.query.dept||'').trim()
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = dset.rows
    if (campus) rows = rows.filter(r=> String(r.campus||'')===campus)
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    const renAvg = (()=>{ const arr = rows.map(r=> +r.ren||0).filter(x=> isFinite(x)); if (!arr.length) return 0; return arr.reduce((a,x)=> a+x,0)/arr.length })()
    const recAvg = (()=>{ const arr = rows.map(r=> +r.rec||0).filter(x=> isFinite(x)); if (!arr.length) return 0; return arr.reduce((a,x)=> a+x,0)/arr.length })()
    const medw = rows.reduce((a,r)=> a + (+r.medw||0), 0)
    const waste = rows.reduce((a,r)=> a + (+r.waste||0), 0)
    const medwShare = waste>0? (medw/waste) : 0
    const aligned_pct = Math.max(0, Math.min(100, Math.round( (renAvg*0.5 + recAvg*0.4 + (1-Math.min(1,medwShare))*0.1) )))
    return ok(res,{ campus, dept, aligned_pct, inputs:{ renAvg, recAvg, medwShare:+medwShare.toFixed(2) } })
  }

  if (u.pathname==='/api/clinical/doctor'){
    const p = path.join(DATA_DIR,'doctor_perf.json')
    if (req.method==='GET'){ const j=readJson(p,{ cases:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const doctor = String(body.doctor||'').trim(); const dept = String(body.dept||'').trim(); const campus = String(body.campus||'').trim(); const co2 = +(body.co2||0)
      if (!doctor || !dept) return bad(res,'missing')
      const j=readJson(p,{ cases:[] }); j.cases.push({ id:'dc_'+Date.now(), doctor, dept, campus, co2, date: new Date().toISOString().slice(0,10) }); writeJson(p, j); return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/connectors/marketplace' && req.method==='GET'){
    return ok(res,{ connectors:[
      { name:'BMS/SCADA', protocol:'SSE/MQTT/Modbus', status:'available' },
      { name:'HL7/FHIR', protocol:'HTTP/JSON', status:'available' },
      { name:'HIS/EHR', protocol:'DB/REST', status:'available' },
      { name:'PACS', protocol:'DICOM', status:'available' },
      { name:'Pharmacy Automation', protocol:'REST/CSV', status:'available' },
    ] })
  }

  if (u.pathname==='/api/ops/ledger/status' && req.method==='GET'){
    try{
      const txt=fs.readFileSync(opsFilePath(),'utf8')
      const lines=txt.trim().split(/\n/).slice(-100)
      let hash=''
      for (const l of lines){ const h=crypto.createHash('sha256').update((hash||'')+l).digest('hex'); hash=h }
      return ok(res,{ last_hash: hash || null, entries: lines.length })
    }catch(_){ return ok(res,{ last_hash: null, entries: 0 }) }
  }
  if (u.pathname==='/api/ops/tickets/generate' && req.method==='POST'){
    const arr = readOpsWindow(24)
    const byPath = new Map()
    for (const r of arr){ const k=r.path||''; const a=byPath.get(k)||{ count:0, durations:[], errors:0 }; a.count++; a.durations.push(+r.duration_ms||0); if (r.status>=400) a.errors++; byPath.set(k,a) }
    function p95(vals){ if (!vals.length) return 0; const s=vals.slice().sort((a,b)=>a-b); const idx=Math.floor(0.95*(s.length-1)); return s[idx] }
    const p = path.join(DATA_DIR,'ops_tickets.json')
    const j = readJson(p,{ tickets:[] })
    let created = 0
    for (const [endpoint,a] of byPath.entries()){
      const p95v = Math.round(p95(a.durations))
      const errRate = a.count? (a.errors/a.count) : 0
      if (p95v>2000 && a.count>100 && errRate>0.1){
        const hasOpen = j.tickets.find(t=> t.endpoint===endpoint && t.status==='open')
        if (hasOpen) continue
        const t = { id:'ticket-ops-'+Date.now(), created_at: new Date().toISOString(), status:'open', type:'performance', endpoint, summary:'High latency and error rate', metrics:{ p95_ms:p95v, error_rate:+errRate.toFixed(3), count:a.count }, recommendation:'Review endpoint, add caching or optimize data pipeline.' }
        j.tickets.push(t); created++
      }
    }
    writeJson(p, j); return ok(res,{ ok:true, created })
  }
  if (u.pathname==='/api/ops/alerts' && req.method==='GET'){
    const p = path.join(DATA_DIR,'ops_alerts.json')
    const j = readJson(p,{ alerts:[] })
    return ok(res, j)
  }
  if (u.pathname==='/api/ops/backup/logs' && req.method==='GET'){
    try{
      const fp = path.join(__dirname,'backup','backup_log.jsonl')
      const txt = fs.readFileSync(fp,'utf8')
      const lines = txt.trim().split(/\n/).slice(-200).reverse()
      const entries = lines.map(l=>{ try{ return JSON.parse(l) }catch(_){ return null } }).filter(Boolean)
      return ok(res,{ logs: entries })
    }catch(e){ return ok(res,{ logs: [] }) }
  }
  if (u.pathname==='/api/ops/actions/create' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const body = await parseBody(req)
    const endpoint = String(body.endpoint||'').trim()
    const prefix = String(body.prefix||'').trim()
    const items = Array.isArray(body.items)? body.items: []
    const pTasks = path.join(DATA_DIR,'tasks.json')
    const jTasks = readJson(pTasks,{ tasks:[] })
    let created = 0
    for (const it of items){
      const title = String(it.title||'').trim() || 'Ops improvement'
      const due = new Date(Date.now()+7*24*60*60*1000).toISOString().slice(0,10)
      jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title, dept:'IT/Ops', assignee:'', status:'open', sla_due: due, created_at: Date.now(), closed_at: null, notes: (endpoint||prefix)? ('Target '+(endpoint||prefix)) : '' })
      created++
    }
    writeJson(pTasks, jTasks)
    return ok(res,{ ok:true, created })
  }
  if (u.pathname==='/api/ops/backups/list' && req.method==='GET'){
    try{
      const dir = path.join(__dirname,'backup')
      const files = fs.readdirSync(dir).filter(f=> /zero_hospital_.*\.tar\.gz$/.test(f)).sort().reverse()
      const metas = files.map(f=>{ let size=0; try{ size = fs.statSync(path.join(dir,f)).size }catch(_){ } return { file:f, size_bytes:size } })
      return ok(res,{ backups: metas })
    }catch(e){ return ok(res,{ backups: [] }) }
  }
  if (u.pathname==='/api/ops/advisory' && req.method==='POST'){
    const body = await parseBody(req)
    const endpoint = String(body.endpoint||'').trim()
    const prefix = String(body.prefix||'').trim()
    const arr = readOpsWindow(24)
    const vals = arr.filter(r=> {
      const p = String(r.path||'')
      if (endpoint) return p===endpoint
      if (prefix) return p.startsWith(prefix)
      return true
    })
    const dur = vals.map(v=> +v.duration_ms||0)
    function p95(a){ if (!a.length) return 0; const s=a.slice().sort((x,y)=>x-y); const idx=Math.floor(0.95*(s.length-1)); return s[idx] }
    const p95v = Math.round(p95(dur))
    const count = vals.length
    const errRate = count? +(vals.filter(v=> (v.status||0)>=400).length/count).toFixed(3) : 0
    let tips = []
    if (p95v>2000) tips.push('Investigate slow handlers; consider caching or reducing heavy computation')
    if (errRate>0.1) tips.push('Error rate high; add defensive checks and improve validation')
    if (!tips.length) tips.push('Within acceptable range')
    return ok(res,{ endpoint, prefix, p95_ms:p95v, count, error_rate: errRate, advice: tips })
  }

  if (u.pathname==='/ui' && req.method==='GET'){
    try{
      const f = path.join(__dirname,'zah.html')
      const html = fs.readFileSync(f,'utf8')
      res.writeHead(200, { 'Content-Type':'text/html', 'Access-Control-Allow-Origin':'*' })
      return res.end(html)
    }catch(e){ return notf(res) }
  }

  if (u.pathname==='/api/pdf/esrs-gap' && req.method==='GET'){
    const esrs = readJson(path.join(DATA_DIR,'esrs_checklist.json'),{ items:[] }).items
    const total = esrs.length, done = esrs.filter(x=> x.status==='done').length, pending = esrs.filter(x=> x.status!=='done').length
    const lines = [ 'ESRS Gap Analysis', 'Items: '+total, 'Done: '+done, 'Pending/In Progress: '+pending ].concat(esrs.filter(x=> x.status!=='done').slice(0,30).map(x=> x.code+' · '+x.name+' · '+(x.owner||'—')+(x.due? ' · '+x.due:'')))
    const b64 = makeSimplePdfBase64('Zero@Hospital', lines)
    const buf = Buffer.from(b64,'base64')
    res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length': buf.length, 'Access-Control-Allow-Origin':'*' })
    return res.end(buf)
  }
  if (u.pathname==='/api/pdf/dnsh' && req.method==='GET'){
    const dnsh = readJson(path.join(DATA_DIR,'dnsh_checklist.json'),{ items:[] }).items
    const lines = [ 'DNSH Checklist' ].concat(dnsh.slice(0,50).map(x=> x.area+' · '+x.name+' · '+x.status))
    const b64 = makeSimplePdfBase64('Zero@Hospital', lines)
    const buf = Buffer.from(b64,'base64')
    res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length': buf.length, 'Access-Control-Allow-Origin':'*' })
    return res.end(buf)
  }
  if (u.pathname==='/api/pdf/ceo-view' && req.method==='GET'){
    try{
      const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
      const rows = dset.rows
      const sumField = (arr,k)=> arr.reduce((a,x)=> a+(+x[k]||0),0)
      const co2 = sumField(rows,'co2') + sumField(rows,'scope3_extra')
      const energy = sumField(rows,'energy')
      const water = sumField(rows,'water')
      const waste = sumField(rows,'waste')
      const tasks = readJson(path.join(DATA_DIR,'tasks.json'),{ tasks:[] }).tasks
      const openTasks = tasks.filter(t=> t.status==='open').length
      const escalated = tasks.filter(t=> t.status==='escalated').length
      const rules = readJson(path.join(DATA_DIR,'alert_rules.json'),{ rules:[] }).rules.length
      const lines = [
        'CEO View Summary',
        'Total CO2e: '+co2,
        'Energy: '+energy+' kWh',
        'Water: '+water+' m3',
        'Waste: '+waste+' kg',
        'Alert rules: '+rules,
        'Open tasks: '+openTasks,
        'Escalated: '+escalated,
      ]
      const b64 = makeSimplePdfBase64('Zero@Hospital', lines)
      const buf = Buffer.from(b64,'base64')
      res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length': buf.length, 'Access-Control-Allow-Origin':'*' })
      return res.end(buf)
    }catch(e){ return bad(res, e.message||e) }
  }
  if (u.pathname==='/api/pdf/cfo-view' && req.method==='GET'){
    try{
      const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ factors:{}, co2Threshold:1000, scope_weights:{ s1:0.25, s2:0.6 } })
      const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
      const rows = dset.rows
      const sumField = (arr,k)=> arr.reduce((a,x)=> a+(+x[k]||0),0)
      const co2 = sumField(rows,'co2') + sumField(rows,'scope3_extra')
      const energy = sumField(rows,'energy')
      const cfg = readJson(path.join(DATA_DIR,'insurance_config.json'),{ base_rate_eur:1000, co2_threshold_t:300, bonus_pct_per_10pct_reduction:2, penalty_pct_per_10pct_excess:3 })
      const base = cfg.base_rate_eur||0
      const threshold = cfg.co2_threshold_t||0
      const redFrac = 0
      const bonusPct = 0
      const excessFrac = co2>threshold? ((co2 - threshold)/threshold) : 0
      const penaltyPct = excessFrac>0 ? (cfg.penalty_pct_per_10pct_excess * (excessFrac*10)) : 0
      const bonus_eur = base * (bonusPct/100)
      const penalty_eur = base * (penaltyPct/100)
      const new_reimb = Math.max(0, base + bonus_eur - penalty_eur)
      const qp = readJson(path.join(DATA_DIR,'carbon_quotas.json'),{ quotas:[] })
      const quota_t = qp.quotas.reduce((a,q)=> a + (+q.quota_tco2e||0), 0)
      const cp = readJson(path.join(DATA_DIR,'carbon_credits.json'),{ credits:[] })
      let credit_t = cp.credits.reduce((a,c)=> a + (+c.amount_tco2e||0), 0)
      const tp = readJson(path.join(DATA_DIR,'carbon_trades.json'),{ trades:[] })
      for (const t of tp.trades||[]){ if (t.status==='accepted'){ credit_t += (+t.amount_tco2e||0) } }
      const price = readJson(path.join(DATA_DIR,'carbon_price.json'),{ price_eur_per_t:50 }).price_eur_per_t||50
      const net_t = credit_t + (quota_t - co2)
      const value_eur = net_t * price
      const lines = [ 'CFO View', 'Base rate: €'+base, 'Threshold: '+threshold+' t', 'Reduction: '+(100*redFrac).toFixed(1)+'%', 'Bonus: €'+bonus_eur.toFixed(2), 'Penalty: €'+penalty_eur.toFixed(2), 'New reimbursement: €'+new_reimb.toFixed(2), 'Internal carbon value: €'+value_eur.toFixed(2), 'Total CO2e: '+co2.toFixed(3)+' t', 'Energy: '+energy+' kWh' ]
      const b64 = makeSimplePdfBase64('Zero@Hospital', lines)
      const buf = Buffer.from(b64,'base64')
      res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Length': buf.length, 'Access-Control-Allow-Origin':'*' })
      return res.end(buf)
    }catch(e){ return bad(res, e.message||e) }
  }

  if (u.pathname==='/api/eflib' && req.method==='GET'){
    const p = path.join(DATA_DIR,'ef_library.json')
    const def = { profiles:[ { name:'DEFRA-2025', energy_kwh_to_tco2e:0.00035, water_m3_to_tco2e:0.0003, waste_kg_to_tco2e:0.0015, medw_kg_to_tco2e:0.004 }, { name:'EEA-2025', energy_kwh_to_tco2e:0.00042, water_m3_to_tco2e:0.00034, waste_kg_to_tco2e:0.0019, medw_kg_to_tco2e:0.0045 } ] }
    const j = readJson(p, def)
    return ok(res, j)
  }
  if (u.pathname==='/api/eflib/active'){
    const p = path.join(DATA_DIR,'ef_active.json')
    if (req.method==='GET'){ const j = readJson(p,{ name:'EEA-2025' }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const name = String(body.name||'').trim(); if (!name) return bad(res,'missing')
      writeJson(p,{ name })
      return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/eflib/template' && req.method==='GET'){
    const name = String(u.query.name||'').trim().toUpperCase()
    const header = 'name,energy_kwh_to_tco2e,water_m3_to_tco2e,waste_kg_to_tco2e,medw_kg_to_tco2e\n'
    let rows = ''
    if (name==='DEFRA'){ rows = 'DEFRA-2025,0.00035,0.00030,0.00150,0.00400\n' }
    else if (name==='EEA'){ rows = 'EEA-2025,0.00042,0.00034,0.00190,0.00450\n' }
    else { rows = 'PROFILE,0.00040,0.00032,0.00180,0.00440\n' }
    const csv = header + rows
    res.writeHead(200, { 'Content-Type':'text/csv', 'Access-Control-Allow-Origin':'*' })
    return res.end(csv)
  }
  if (u.pathname==='/api/feature-matrix.csv' && req.method==='GET'){
    const header = 'Module,CEO,CFO,CTO,Bashekim,Mudur,ESG,Priority,ROI_Estimate,Owner,TargetDate\n'
    const rows = [
      ['Real-time Energy/CO2/Water','✔️','✔️','✔️','✔️','✔️','✔️','High','—','Ops','2026-06-30'],
      ['Dept KPIs & Scopes','✔️','🟡','🟡','✔️','✔️','✔️','High','—','Quality','2026-03-31'],
      ['Alerts & Auto Tasks','✔️','🟡','🟡','✔️','✔️','✔️','High','—','Ops','2026-03-31'],
      ['Trends Benchmark Sims','✔️','✔️','🟡','✔️','✔️','✔️','Medium','—','Strategy','2026-09-30'],
      ['Compliance ESRS/CSRD/DNSH','✔️','✔️','🟡','🟡','🟡','✔️','High','—','ESG','2025-12-31'],
      ['Factor Library DEFRA/EEA','🟡','🟡','🟡','✔️','✔️','✔️','High','—','ESG','2025-09-30'],
      ['Security & API','✔️','✔️','✔️','🟡','🟡','✔️','High','—','IT','2025-08-31'],
      ['Financial Modeling €/t ROI','✔️','✔️','🟡','🟡','🟡','🟡','Medium','€ impact','Finance','2026-01-31'],
      ['Clinical Quality Relation','🟡','🟡','🟡','✔️','🟡','🟡','Medium','—','Clinical','2026-06-30'],
      ['BMS/IoT/EHR Integration','✔️','🟡','✔️','✔️','✔️','🟡','High','—','IT','2026-03-31'],
    ].map(r=> r.join(',')).join('\n')
    const csv = header + rows + '\n'
    res.writeHead(200, { 'Content-Type':'text/csv', 'Access-Control-Allow-Origin':'*' })
    return res.end(csv)
  }
  if (u.pathname==='/api/feature-matrix-v2.csv' && req.method==='GET'){
    const header = 'Module,CEO,CFO,CTO,Bashekim,Mudur,ESG,AB Bakan,Priority\n'
    const rows = [
      ['Clinical Pathway CO2e','✓','✓','✓','✓','✓','✓','✓','High'],
      ['AI Benchmarking Engine','✓','✓','✓','✓','✓','✓','✓','High'],
      ['Predictive Facility Failure','✓','✓','✓','✓','✓','🟡','🟡','High'],
      ['Waste Segregation AI','🟡','✓','✓','✓','✓','✓','🟡','High'],
      ['Nurse Workflow + Sustainability','🟡','🟡','🟡','✓','✓','🟡','🟡','Medium'],
      ['Patient Journey Footprint','✓','✓','✓','✓','✓','✓','✓','High'],
      ['Green Surgery Optimization','✓','🟡','✓','✓','🟡','✓','🟡','High'],
      ['Insurance & Reimbursement Impact','✓','✓','🟡','🟡','🟡','🟡','🟡','High'],
      ['EU Accreditation Radar','✓','🟡','🟡','✓','🟡','✓','✓','High'],
      ['Group Internal Carbon Market','✓','✓','🟡','🟡','🟡','✓','🟡','High'],
      ['Drug & Consumables Footprint','🟡','✓','🟡','✓','✓','✓','🟡','High'],
      ['Multi-Campus Mode','✓','✓','✓','✓','✓','🟡','🟡','High'],
      ['Pandemic Mode & Stress Test','✓','✓','✓','✓','✓','✓','✓','High'],
      ['Sustainability Twin','✓','🟡','✓','✓','🟡','🟡','🟡','High'],
      ['Healthcare SBTi Alignment','✓','✓','🟡','🟡','🟡','✓','✓','High'],
      ['AI Chief Medical Sustainability Report','✓','🟡','✓','✓','🟡','✓','🟡','High'],
      ['Green Procurement Scorecard','✓','✓','🟡','🟡','✓','✓','🟡','High'],
      ['Patient & Community Sustainability Score','✓','🟡','🟡','✓','🟡','✓','✓','Medium'],
      ['Health Outcome x CO2e Efficiency','✓','🟡','✓','✓','🟡','✓','🟡','High'],
      ['Automated External Auditor Pack','✓','✓','✓','✓','✓','✓','✓','High'],
    ].map(r=> r.join(',')).join('\n')
    const csv = header + rows + '\n'
    res.writeHead(200, { 'Content-Type':'text/csv', 'Access-Control-Allow-Origin':'*' })
    return res.end(csv)
  }

  if (u.pathname==='/api/carbon/groups'){
    const p = path.join(DATA_DIR,'carbon_groups.json')
    if (req.method==='GET'){ const j = readJson(p,{ groups:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ groups:[] })
      const name = String(body.name||'').trim()
      const hospitals = Array.isArray(body.hospitals)? body.hospitals : String(body.hospitals||'').split(',').map(s=> s.trim()).filter(Boolean)
      if (!name || !hospitals.length) return bad(res,'missing')
      const idx = j.groups.findIndex(g=> g.name===name)
      const item = { name, hospitals }
      if (idx>=0) j.groups[idx] = item; else j.groups.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ groups:[] })
      const name = String(u.query.name||'').trim()
      const next = j.groups.filter(g=> g.name!==name)
      writeJson(p,{ groups: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/carbon/quotas'){
    const p = path.join(DATA_DIR,'carbon_quotas.json')
    if (req.method==='GET'){ const j = readJson(p,{ quotas:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ quotas:[] })
      const hospital = String(body.hospital||'').trim()
      const year = +(body.year||new Date().getFullYear())
      const quota_tco2e = +(body.quota_tco2e||0)
      if (!hospital || !isFinite(quota_tco2e)) return bad(res,'missing')
      const idx = j.quotas.findIndex(q=> q.hospital===hospital && q.year===year)
      const item = { hospital, year, quota_tco2e }
      if (idx>=0) j.quotas[idx] = item; else j.quotas.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ quotas:[] })
      const hospital = String(u.query.hospital||'').trim()
      const year = +(u.query.year||0)
      const next = j.quotas.filter(q=> !(q.hospital===hospital && (!year || q.year===year)))
      writeJson(p,{ quotas: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/carbon/credits'){
    const p = path.join(DATA_DIR,'carbon_credits.json')
    if (req.method==='GET'){ const j = readJson(p,{ credits:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ credits:[] })
      const hospital = String(body.hospital||'').trim()
      const amount_tco2e = +(body.amount_tco2e||0)
      const note = String(body.note||'')
      if (!hospital || !isFinite(amount_tco2e)) return bad(res,'missing')
      const item = { id:'cr_'+Date.now(), hospital, amount_tco2e, note, created_at: Date.now() }
      j.credits.push(item); writeJson(p, j); return ok(res,{ id: item.id })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ credits:[] })
      const id = String(u.query.id||'').trim()
      const next = j.credits.filter(c=> c.id!==id)
      writeJson(p,{ credits: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/carbon/trades'){
    const p = path.join(DATA_DIR,'carbon_trades.json')
    if (req.method==='GET'){ const j = readJson(p,{ trades:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ trades:[] })
      const from = String(body.from||'').trim()
      const to = String(body.to||'').trim()
      const amount_tco2e = +(body.amount_tco2e||0)
      const price_eur_per_t = +(body.price_eur_per_t||0)
      if (!from || !to || !isFinite(amount_tco2e) || amount_tco2e<=0) return bad(res,'missing')
      const item = { id:'tr_'+Date.now(), from, to, amount_tco2e, price_eur_per_t, status:'open', created_at: Date.now(), accepted_at: null }
      j.trades.push(item); writeJson(p, j); return ok(res,{ id: item.id })
    }
  }
  {
    const m = u.pathname.match(/^\/api\/carbon\/trades\/(tr_[0-9]+)$/)
    if (m && req.method==='PATCH'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const p = path.join(DATA_DIR,'carbon_trades.json')
      const j = readJson(p,{ trades:[] })
      const id = m[1]
      const idx = j.trades.findIndex(x=> x.id===id)
      if (idx<0) return notf(res)
      j.trades[idx].status = 'accepted'
      j.trades[idx].accepted_at = Date.now()
      writeJson(p, j); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/carbon/price' && req.method==='GET'){
    const p = path.join(DATA_DIR,'carbon_price.json')
    const j = readJson(p,{ price_eur_per_t:50 })
    return ok(res, j)
  }
  if (u.pathname==='/api/carbon/balance' && req.method==='GET'){
    const hospital = String(u.query.hospital||'').trim()
    const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = d.rows
    if (hospital) rows = rows.filter(r=> String(r.hospital||'')===hospital)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const emitted_t = sum(rows,'co2') + sum(rows,'scope3_extra')
    const qp = readJson(path.join(DATA_DIR,'carbon_quotas.json'),{ quotas:[] })
    const quotas = qp.quotas.filter(q=> !hospital || q.hospital===hospital)
    const quota_t = quotas.reduce((a,q)=> a + (+q.quota_tco2e||0), 0)
    const cp = readJson(path.join(DATA_DIR,'carbon_credits.json'),{ credits:[] })
    let credit_t = cp.credits.filter(c=> !hospital || c.hospital===hospital).reduce((a,c)=> a + (+c.amount_tco2e||0), 0)
    const tp = readJson(path.join(DATA_DIR,'carbon_trades.json'),{ trades:[] })
    for (const t of tp.trades||[]){ if (t.status==='accepted'){ if (!hospital || hospital===t.to) credit_t += (+t.amount_tco2e||0); if (!hospital || hospital===t.from) credit_t -= (+t.amount_tco2e||0) } }
    const price = readJson(path.join(DATA_DIR,'carbon_price.json'),{ price_eur_per_t:50 }).price_eur_per_t||50
    const net_t = credit_t + (quota_t - emitted_t)
    const value_eur = net_t * price
    return ok(res,{ hospital, emitted_t: +emitted_t.toFixed(3), quota_t: +quota_t.toFixed(3), credit_t: +credit_t.toFixed(3), net_t: +net_t.toFixed(3), price_eur_per_t: +price, value_eur: +value_eur.toFixed(2) })
  }

  if (u.pathname==='/api/insurance/config'){
    const p = path.join(DATA_DIR,'insurance_config.json')
    const def = { base_rate_eur: 1000, co2_threshold_t: 300, bonus_pct_per_10pct_reduction: 2, penalty_pct_per_10pct_excess: 3 }
    if (req.method==='GET'){ const j = readJson(p, def); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const cur = readJson(p, def)
      const next = {
        base_rate_eur: body.base_rate_eur!==undefined? +(body.base_rate_eur||0) : cur.base_rate_eur,
        co2_threshold_t: body.co2_threshold_t!==undefined? +(body.co2_threshold_t||0) : cur.co2_threshold_t,
        bonus_pct_per_10pct_reduction: body.bonus_pct_per_10pct_reduction!==undefined? +(body.bonus_pct_per_10pct_reduction||0) : cur.bonus_pct_per_10pct_reduction,
        penalty_pct_per_10pct_excess: body.penalty_pct_per_10pct_excess!==undefined? +(body.penalty_pct_per_10pct_excess||0) : cur.penalty_pct_per_10pct_excess
      }
      writeJson(p, next); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/pilot/init' && req.method==='POST'){
    try{
      const mdPath = path.join(__dirname,'HOSPITAL_PILOT_DEMO.MD')
      const txt = fs.readFileSync(mdPath,'utf8')
      const lines = txt.split(/\r?\n/).map(s=> s.trim()).filter(Boolean)
      const hospitals = new Set()
      for (const s of lines){
        if (/Hospital/i.test(s) && s.length<=80){
          let name = s
          const m = s.match(/\(([^)]+Hospital[^)]*)\)/i)
          if (m && m[1]) name = m[1]
          name = name.replace(/\uFEFF|\u200B|\u00A0/g,'').trim()
          if (/Overview|General Introduction|Location|Capacity|Clinical Services|Digital Infrastructure|Sustainability|Related Projects|Sources/i.test(name)) continue
          hospitals.add(name)
        }
      }
      function findNumber(re){ const m = txt.match(re); return m? +(m[1]) : NaN }
      const caps = {
        'Acıbadem Izmir Kent Hospital': { beds: findNumber(/(\d{2,4})\s*beds/i) || 272, ors: findNumber(/(\d{1,2})\s*modern operating/i) || 12, icu_beds: 40, hospital_type:'private_group', city:'Izmir' },
        'Bazekol Çiğli Hospital': { beds: 180, ors: 6, icu_beds: 20, hospital_type:'private_chain', city:'Izmir' },
        'Medical Park Izmir Hospital': { beds: 136, ors: 6, icu_beds: 18, hospital_type:'private_group', city:'Izmir' },
        'Tınaztepe Galen Hospital': { beds: 100, ors: 6, icu_beds: 25, hospital_type:'university', city:'Izmir' },
      }
      const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ factors:{ energy_kwh_to_tco2e:0.00042, water_m3_to_tco2e:0.000344, waste_kg_to_tco2e:0.0019, medw_kg_to_tco2e:0.0045 } })
      const f = settingsJson.factors||{}
      function makeRow(year, hospital, dept, energy_kwh, water_m3, waste_kg, medw_kg, renPct, recPct){
        const co2 = +(energy_kwh*(f.energy_kwh_to_tco2e||0) + water_m3*(f.water_m3_to_tco2e||0) + waste_kg*(f.waste_kg_to_tco2e||0) + medw_kg*(f.medw_kg_to_tco2e||0)).toFixed(3)
        return { year, hospital, country:'TR', dept, energy: Math.round(energy_kwh), water: Math.round(water_m3), waste: Math.round(waste_kg), medw: Math.round(medw_kg), co2, ren: Math.round(renPct), rec: Math.round(recPct) }
      }
      const rows = []
      const yearNow = new Date().getFullYear()
      const yearPrev = yearNow-1
      for (let name of hospitals){
        name = name.replace(/Acıbadem Izmir \(Kent\) Hospital/i,'Acıbadem Izmir Kent Hospital').replace(/Bazekol Health Group.*\(([^)]+)\)/i,'$1')
        const cap = caps[name] || { beds: 150, ors: 5 }
        const beds = cap.beds, ors = cap.ors
        const icu = { energy: beds*800, water: beds*5, waste: beds*20, medw: beds*6 }
        const orx = { energy: ors*25000, water: ors*200, waste: ors*1000, medw: ors*400 }
        const onk = { energy: 80000, water: 200, waste: 300, medw: 150 }
        const img = { energy: 50000, water: 100, waste: 80, medw: 20 }
        rows.push(makeRow(yearPrev, name, 'ICU', icu.energy, icu.water, icu.waste, icu.medw, 22, 32))
        rows.push(makeRow(yearPrev, name, 'OR', orx.energy, orx.water, orx.waste, orx.medw, 20, 30))
        rows.push(makeRow(yearPrev, name, 'Oncology', onk.energy, onk.water, onk.waste, onk.medw, 24, 34))
        rows.push(makeRow(yearPrev, name, 'Imaging', img.energy, img.water, img.waste, img.medw, 26, 40))
        rows.push(makeRow(yearNow, name, 'ICU', icu.energy*0.95, icu.water*0.98, icu.waste*0.96, icu.medw*0.95, 26, 36))
        rows.push(makeRow(yearNow, name, 'OR', orx.energy*0.94, orx.water*0.97, orx.waste*0.95, orx.medw*0.94, 24, 35))
        rows.push(makeRow(yearNow, name, 'Oncology', onk.energy*0.93, onk.water*0.97, onk.waste*0.95, onk.medw*0.93, 28, 38))
        rows.push(makeRow(yearNow, name, 'Imaging', img.energy*0.92, img.water*0.97, img.waste*0.95, img.medw*0.92, 30, 45))
      }
      writeJson(path.join(DATA_DIR,'dataset.json'),{ rows })
      const cp = path.join(DATA_DIR,'campus_defs.json')
      const cur = readJson(cp,{ campuses:[] })
      const added = []
      for (const h of Array.from(hospitals)){
        if (!cur.campuses.find(c=> c.name===h)){
          const meta = caps[h]||{ beds:150, ors:5, icu_beds:20, hospital_type:'private', city:'Izmir' }
          const targets = { co2_target_t: 300, energy_target_kwh: 250000, water_target_m3: 5000, insurance_threshold_t: 300, renewables_target_pct: 30, recycling_target_pct: 35 }
          cur.campuses.push({ name:h, type:'hospital', notes:'Izmir Pilot', beds: meta.beds, or_rooms: meta.ors, icu_beds: meta.icu_beds, hospital_type: meta.hospital_type, city: meta.city, targets })
          added.push(h)
        }
      }
      writeJson(cp, cur)
      const arPath = path.join(DATA_DIR,'alert_rules.json')
      const ar = readJson(arPath,{ rules:[] })
      const baseRules = [
        { name:'ICU High Energy', rule:'dept=="ICU" && energy>200000', enabled:true },
        { name:'OR High MedWaste', rule:'dept=="OR" && medw>800', enabled:true },
        { name:'Oncology Waste Alert', rule:'dept=="Oncology" && waste>400', enabled:true },
        { name:'Imaging Energy Alert', rule:'dept=="Imaging" && energy>60000', enabled:true },
        { name:'Acibadem ICU Water', rule:'hospital=="Acıbadem Izmir Kent Hospital" && dept=="ICU" && water>1500', enabled:true },
        { name:'Medical Park OR Waste', rule:'hospital=="Medical Park Izmir Hospital" && dept=="OR" && waste>1200', enabled:true },
        { name:'Bazekol Imaging Energy', rule:'hospital=="Bazekol Çiğli Hospital" && dept=="Imaging" && energy>55000', enabled:true },
        { name:'Tınaztepe Oncology MedWaste', rule:'hospital=="Tınaztepe Galen Hospital" && dept=="Oncology" && medw>200', enabled:true },
        { name:'Low Recycling Warning', rule:'rec<20', enabled:true }
      ]
      for (const r of baseRules){ if (!ar.rules.find(x=> x.name===r.name)) ar.rules.push(Object.assign({ id:'r_'+Date.now()+Math.random().toString(36).slice(2,6) }, r)) }
      writeJson(arPath, ar)
      const tp = path.join(DATA_DIR,'tasks.json')
      const tj = readJson(tp,{ tasks:[] })
      const sampleTasks = [
        { title:'Acıbadem İzmir ICU – high water usage', dept:'ICU' },
        { title:'Tınaztepe Galen Imaging – energy efficiency check', dept:'Imaging' },
        { title:'Medical Park OR – medical waste audit', dept:'OR' },
        { title:'Bazekol Çiğli Oncology – waste segregation training', dept:'Oncology' }
      ]
      for (const st of sampleTasks){ if (!tj.tasks.find(t=> t.title===st.title)){ tj.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title: st.title, dept: st.dept, assignee:'', status:'open', sla_due: new Date(Date.now()+5*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes:'' }) } }
      writeJson(tp, tj)
      return ok(res,{ ok:true, hospitals: Array.from(hospitals), rows: rows.length, campuses_added: added })
    }catch(e){ return bad(res, e.message||e) }
  }

  if (u.pathname==='/api/demo/hsp-load' && req.method==='POST'){
    try{
      const hp = path.join(DATA_DIR,'hsp_demo_data.json')
      const demo = readJson(hp,{})
      const rows = Array.isArray(demo.annual_records)? demo.annual_records : []
      const outRows = rows.map(r=> ({
        year: r.year,
        hospital: r.hospital,
        country: 'TR',
        dept: r.dept,
        energy: +r.energy_kwh||0,
        water: +r.water_m3||0,
        waste: +r.waste_kg||0,
        medw: +r.med_waste_kg||0,
        co2: +r.co2e_t||0,
        ren: +r.ren_pct||0,
        rec: +r.rec_pct||0,
        status: r.status||''
      }))
      const dsetPath = path.join(DATA_DIR,'dataset.json')
      const cur = readJson(dsetPath,{ rows:[] })
      cur.rows = Array.isArray(cur.rows)? cur.rows : []
      cur.rows = cur.rows.concat(outRows)
      writeJson(dsetPath, cur)
      const campusPath = path.join(DATA_DIR,'campus_defs.json')
      const campuses = readJson(campusPath,{ campuses:[] })
      campuses.campuses = campuses.campuses||[]
      for (const c of (demo.campuses||[])){
        const name = c.name
        if (!campuses.campuses.find(x=> x.name===name)){
          campuses.campuses.push({ campus_id: name.toLowerCase().replace(/\s+/g,'_'), name, short_name: name, city: c.city, country:'TR', type: c.type.toLowerCase().replace(/\s+/g,'_'), segment: 'tertiary_care', beds_total: c.beds, icu_beds: Math.round(c.beds*0.2), or_count: 8, has_nicu: true, owner_group: '', grid_profile:'TR-Grid-2025', tags:[], scopes:{ scope1:true, scope2:true, scope3:true } })
        }
      }
      writeJson(campusPath, campuses)
      const taxPath = path.join(DATA_DIR,'taxonomy_alignments.json')
      const tax = readJson(taxPath,{ campuses:[] })
      tax.campuses = tax.campuses||[]
      for (const t of (demo.taxonomy_align||[])){
        const id = (campuses.campuses.find(x=> x.name===t.campus)||{}).campus_id || t.campus
        const existing = tax.campuses.find(x=> x.campus_id===id)
        const rec = { campus_id: id, eligible_revenue_mtl: t.eligible_revenue_mtl, taxonomy_eligible_revenue_pct: null, taxonomy_aligned_revenue_pct: t.aligned_revenue_pct, taxonomy_aligned_capex_pct: t.aligned_capex_pct, after_dnsh_pct: t.after_dnsh_pct, esrs_gap_score: t.esrs_gap_score, dns_h_status: (t.after_dnsh_pct>=0.1? 'amber':'green') }
        if (existing){ Object.assign(existing, rec) } else { tax.campuses.push(rec) }
      }
      writeJson(taxPath, tax)
      writeJson(path.join(DATA_DIR,'alerts_log.json'), demo.alerts||{ medical_waste:[], energy_spike:[] })
      return ok(res,{ ok:true, rows_added: outRows.length, campuses: (demo.campuses||[]).length })
    }catch(e){ return bad(res, e.message||e) }
  }
  if (u.pathname==='/api/insurance/impact' && req.method==='POST'){
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const dept = String(body.dept||'').trim()
    const base_reimbursement_eur = +(body.base_reimbursement_eur||0)
    let baseline_co2_t = +(body.baseline_co2_t||NaN)
    let current_co2_t = +(body.current_co2_t||NaN)
    const cfg = readJson(path.join(DATA_DIR,'insurance_config.json'),{ base_rate_eur: 1000, co2_threshold_t: 300, bonus_pct_per_10pct_reduction: 2, penalty_pct_per_10pct_excess: 3 })
    const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = d.rows
    if (hospital) rows = rows.filter(r=> String(r.hospital||'')===hospital)
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const total_co2 = sum(rows,'co2') + sum(rows,'scope3_extra')
    if (!isFinite(baseline_co2_t)) baseline_co2_t = total_co2
    if (!isFinite(current_co2_t)) current_co2_t = total_co2
    const redFrac = baseline_co2_t>0 ? Math.max(-1, Math.min(1, (baseline_co2_t - current_co2_t)/baseline_co2_t )) : 0
    const bonusPct = redFrac>0 ? (cfg.bonus_pct_per_10pct_reduction * (redFrac*10)) : 0
    const excessFrac = current_co2_t>cfg.co2_threshold_t ? ((current_co2_t - cfg.co2_threshold_t)/cfg.co2_threshold_t) : 0
    const penaltyPct = excessFrac>0 ? (cfg.penalty_pct_per_10pct_excess * (excessFrac*10)) : 0
    const bonus_eur = base_reimbursement_eur * (bonusPct/100)
    const penalty_eur = base_reimbursement_eur * (penaltyPct/100)
    const new_reimb = Math.max(0, base_reimbursement_eur + bonus_eur - penalty_eur)
    const qp = readJson(path.join(DATA_DIR,'carbon_quotas.json'),{ quotas:[] })
    const quotas = qp.quotas.filter(q=> !hospital || q.hospital===hospital)
    const quota_t = quotas.reduce((a,q)=> a + (+q.quota_tco2e||0), 0)
    const cp = readJson(path.join(DATA_DIR,'carbon_credits.json'),{ credits:[] })
    let credit_t = cp.credits.filter(c=> !hospital || c.hospital===hospital).reduce((a,c)=> a + (+c.amount_tco2e||0), 0)
    const tp = readJson(path.join(DATA_DIR,'carbon_trades.json'),{ trades:[] })
    for (const t of tp.trades||[]){ if (t.status==='accepted'){ if (!hospital || hospital===t.to) credit_t += (+t.amount_tco2e||0); if (!hospital || hospital===t.from) credit_t -= (+t.amount_tco2e||0) } }
    const price = readJson(path.join(DATA_DIR,'carbon_price.json'),{ price_eur_per_t:50 }).price_eur_per_t||50
    const emitted_t = current_co2_t
    const net_t = credit_t + (quota_t - emitted_t)
    const credit_value_eur = net_t * price
    return ok(res,{ baseline_co2_t:+baseline_co2_t.toFixed(3), current_co2_t:+current_co2_t.toFixed(3), reduction_pct:+(100*redFrac).toFixed(1), threshold_t: cfg.co2_threshold_t, bonus_eur:+bonus_eur.toFixed(2), penalty_eur:+penalty_eur.toFixed(2), new_reimbursement_eur:+new_reimb.toFixed(2), credit_value_eur:+credit_value_eur.toFixed(2) })
  }

  if (u.pathname==='/api/waste/baselines'){
    const p = path.join(DATA_DIR,'waste_baselines.json')
    if (req.method==='GET'){ const j = readJson(p,{ baselines:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ baselines:[] })
      const dept = String(body.dept||'').trim(); const share = Math.max(0, Math.min(1, +(body.share||0)))
      if (!dept) return bad(res,'missing')
      const idx = j.baselines.findIndex(b=> b.dept===dept)
      const item = { dept, share }
      if (idx>=0) j.baselines[idx] = item; else j.baselines.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/waste/segregation' && req.method==='GET'){
    const dept = String(u.query.dept||'').trim()
    const hospital = String(u.query.hospital||'').trim()
    const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = d.rows
    if (hospital) rows = rows.filter(r=> String(r.hospital||'')===hospital)
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const w = sum(rows,'waste')
    const m = sum(rows,'medw')
    const total = w + m
    const share = total>0 ? (m/total) : 0
    const b = readJson(path.join(DATA_DIR,'waste_baselines.json'),{ baselines:[] }).baselines
    const base = (b.find(x=> x.dept===(dept||'') )||{}).share
    const baseline = base!==undefined ? base : 0.25
    const over = share - baseline
    const tips = []
    if (over>0.1){ tips.push('Medical waste share significantly above baseline; review segregation practices') }
    else if (over>0.05){ tips.push('Medical waste share above baseline; audit specific streams') }
    else { tips.push('Medical vs general waste ratio within expected range') }
    return ok(res,{ dept, hospital, share_pct:+(100*share).toFixed(1), baseline_pct:+(100*baseline).toFixed(1), over_pct:+(100*Math.max(0,over)).toFixed(1), tips })
  }
  if (u.pathname==='/api/waste/segregation/analyze' && req.method==='POST'){
    const body = await parseBody(req)
    const dept = String(body.dept||'').trim()
    const w = +(body.waste_kg||0)
    const m = +(body.medw_kg||0)
    const total = Math.max(0, w + m)
    const share = total>0 ? (m/total) : 0
    const b = readJson(path.join(DATA_DIR,'waste_baselines.json'),{ baselines:[] }).baselines
    const base = (b.find(x=> x.dept===dept)||{}).share
    const baseline = base!==undefined ? base : 0.25
    const over = share - baseline
    const tips = []
    if (over>0.1){ tips.push('Reduce medical waste streams by separating non-infectious items') }
    else if (over>0.05){ tips.push('Targeted training on waste segregation for staff') }
    else { tips.push('Segregation performance OK') }
    return ok(res,{ dept, share_pct:+(100*share).toFixed(1), baseline_pct:+(100*baseline).toFixed(1), over_pct:+(100*Math.max(0,over)).toFixed(1), tips })
  }
  if (u.pathname==='/api/waste/segregation/create-tasks' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const dept = String(body.dept||'').trim()
    const slaDays = Math.max(1, Math.min(30, +(body.sla_days||7)))
    const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = d.rows
    if (hospital) rows = rows.filter(r=> String(r.hospital||'')===hospital)
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const w = sum(rows,'waste')
    const m = sum(rows,'medw')
    const total = w + m
    const share = total>0 ? (m/total) : 0
    const b = readJson(path.join(DATA_DIR,'waste_baselines.json'),{ baselines:[] }).baselines
    const base = dept ? (b.find(x=> x.dept===dept)||{}).share : undefined
    const baseline = base!==undefined ? base : 0.25
    const over = share - baseline
    let tips = []
    if (over>0.1){ tips.push('Medical waste share significantly above baseline; review segregation practices') }
    else if (over>0.05){ tips.push('Medical waste share above baseline; audit specific streams') }
    else { tips.push('Segregation performance OK') }
    const pTasks = path.join(DATA_DIR,'tasks.json')
    const jTasks = readJson(pTasks,{ tasks:[] })
    let created = 0
    for (const tip of tips){ if (/OK/i.test(tip)) continue; jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title:'Waste segregation improvement', dept: dept||'', assignee:'', status:'open', sla_due: new Date(Date.now()+slaDays*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes: tip }); created++ }
    writeJson(pTasks, jTasks)
    return ok(res,{ ok:true, created, share_pct:+(100*share).toFixed(1), baseline_pct:+(100*baseline).toFixed(1) })
  }

  if (u.pathname==='/api/pandemic/config'){
    const p = path.join(DATA_DIR,'pandemic_config.json')
    const def = { energy_kwh_per_day:120000, water_m3_per_day:500, oxygen_l_per_day:80000, waste_kg_per_day:1500, ppe_units_per_day:5000, energy_threshold_kwh:200000, oxygen_threshold_l:120000 }
    if (req.method==='GET'){ const j = readJson(p, def); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const next = {
        energy_kwh_per_day: +(body.energy_kwh_per_day||0),
        water_m3_per_day: +(body.water_m3_per_day||0),
        oxygen_l_per_day: +(body.oxygen_l_per_day||0),
        waste_kg_per_day: +(body.waste_kg_per_day||0),
        ppe_units_per_day: +(body.ppe_units_per_day||0),
        energy_threshold_kwh: +(body.energy_threshold_kwh||0),
        oxygen_threshold_l: +(body.oxygen_threshold_l||0)
      }
      writeJson(p, next); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/pandemic/simulate' && req.method==='POST'){
    const body = await parseBody(req)
    const cfg = readJson(path.join(DATA_DIR,'pandemic_config.json'),{ energy_kwh_per_day:120000, water_m3_per_day:500, oxygen_l_per_day:80000, waste_kg_per_day:1500, ppe_units_per_day:5000, energy_threshold_kwh:200000, oxygen_threshold_l:120000 })
    const surge = Math.max(1, +(body.surge_factor||1))
    const hours = Math.max(1, +(body.duration_hours||24))
    const scale = surge * (hours/24)
    const totals = {
      energy_kwh: +(cfg.energy_kwh_per_day * scale).toFixed(0),
      water_m3: +(cfg.water_m3_per_day * scale).toFixed(0),
      oxygen_l: +(cfg.oxygen_l_per_day * scale).toFixed(0),
      waste_kg: +(cfg.waste_kg_per_day * scale).toFixed(0),
      ppe_units: +(cfg.ppe_units_per_day * scale).toFixed(0)
    }
    const risks = []
    if (totals.energy_kwh > cfg.energy_threshold_kwh) risks.push('Energy demand exceeds threshold')
    if (totals.oxygen_l > cfg.oxygen_threshold_l) risks.push('Oxygen demand exceeds threshold')
    return ok(res,{ surge_factor: surge, duration_hours: hours, totals, risks })
  }
  if (u.pathname==='/api/pandemic/create-tasks' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const dept = String(body.dept||'').trim()
    const surge = Math.max(1, +(body.surge_factor||1))
    const hours = Math.max(1, +(body.duration_hours||24))
    const cfg = readJson(path.join(DATA_DIR,'pandemic_config.json'),{ energy_kwh_per_day:120000, water_m3_per_day:500, oxygen_l_per_day:80000, waste_kg_per_day:1500, ppe_units_per_day:5000, energy_threshold_kwh:200000, oxygen_threshold_l:120000 })
    const scale = surge * (hours/24)
    const totals = {
      energy_kwh: +(cfg.energy_kwh_per_day * scale).toFixed(0),
      oxygen_l: +(cfg.oxygen_l_per_day * scale).toFixed(0)
    }
    const pTasks = path.join(DATA_DIR,'tasks.json')
    const jTasks = readJson(pTasks,{ tasks:[] })
    let created = 0
    if (totals.energy_kwh > cfg.energy_threshold_kwh){ jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title:'Pandemic energy preparedness', dept, assignee:'', status:'open', sla_due: new Date(Date.now()+3*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes:`Hospital ${hospital} surge ${surge}× ${hours}h` }); created++ }
    if (totals.oxygen_l > cfg.oxygen_threshold_l){ jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title:'Oxygen supply contingency', dept, assignee:'', status:'open', sla_due: new Date(Date.now()+3*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes:`Hospital ${hospital} surge ${surge}× ${hours}h` }); created++ }
    writeJson(pTasks, jTasks)
    return ok(res,{ ok:true, created })
  }

  if (u.pathname==='/api/twin/config'){
    const p = path.join(DATA_DIR,'twin_config.json')
    const def = { hvac_kwh_per_day:90000, airflow_m3ph:120000, or_rooms:6, comfort_risk_threshold:0.2 }
    if (req.method==='GET'){ const j = readJson(p, def); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const next = { hvac_kwh_per_day:+(body.hvac_kwh_per_day||0), airflow_m3ph:+(body.airflow_m3ph||0), or_rooms:+(body.or_rooms||0), comfort_risk_threshold:+(body.comfort_risk_threshold||0.2) }
      writeJson(p, next); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/twin/simulate' && req.method==='POST'){
    const body = await parseBody(req)
    const cfg = readJson(path.join(DATA_DIR,'twin_config.json'),{ hvac_kwh_per_day:90000, airflow_m3ph:120000, or_rooms:6, comfort_risk_threshold:0.2 })
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ factors:{ energy_kwh_to_tco2e:0.00042 } })
    const f = settingsJson.factors||{}
    const hvac_reduction_pct = Math.max(0, Math.min(50, +(body.hvac_reduction_pct||0)))
    const airflow_m3ph = +(body.airflow_m3ph||cfg.airflow_m3ph)
    const or_rooms = +(body.or_rooms||cfg.or_rooms)
    const baseline_kwh = +(cfg.hvac_kwh_per_day||0)
    const saved_kwh = +(baseline_kwh * (hvac_reduction_pct/100)).toFixed(0)
    const tco2e_saved = +(saved_kwh * (f.energy_kwh_to_tco2e||0)).toFixed(3)
    const comfort_risk = Math.max(0, Math.min(1, (hvac_reduction_pct/100) * (or_rooms>0? 0.6 + (airflow_m3ph/(cfg.airflow_m3ph||1))*0.2 : 0.5)))
    const risk_flag = comfort_risk > (cfg.comfort_risk_threshold||0.2)
    const tips = []
    if (risk_flag){ tips.push('Increase air changes/hour in ORs or reduce setpoint delta') }
    else { tips.push('Comfort risk acceptable for proposed reduction') }
    return ok(res,{ hvac_reduction_pct, saved_kwh, tco2e_saved, comfort_risk:+comfort_risk.toFixed(2), tips })
  }
  if (u.pathname==='/api/twin/create-tasks' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const body = await parseBody(req)
    const hvac_reduction_pct = Math.max(0, Math.min(50, +(body.hvac_reduction_pct||0)))
    const pTasks = path.join(DATA_DIR,'tasks.json')
    const jTasks = readJson(pTasks,{ tasks:[] })
    jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title:'Implement HVAC reduction '+hvac_reduction_pct+'%', dept: String(body.dept||'Facilities'), assignee:'', status:'open', sla_due: new Date(Date.now()+7*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes:'Coordinate with clinical to ensure comfort and infection control' })
    writeJson(pTasks, jTasks)
    return ok(res,{ ok:true })
  }

  if (u.pathname==='/api/campus/defs'){
    const p = path.join(DATA_DIR,'campus_defs.json')
    if (req.method==='GET'){ const j = readJson(p,{ campuses:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ campuses:[] })
      const name = String(body.name||'').trim(); const type = String(body.type||'').trim(); const notes = String(body.notes||'')
      if (!name) return bad(res,'missing')
      const idx = j.campuses.findIndex(c=> c.name===name)
      const item = { name, type, notes }
      if (idx>=0) j.campuses[idx] = item; else j.campuses.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ campuses:[] })
      const name = String(u.query.name||'').trim()
      const next = j.campuses.filter(c=> c.name!==name)
      writeJson(p,{ campuses: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/campus/metrics'){
    const p = path.join(DATA_DIR,'campus_metrics.json')
    if (req.method==='GET'){
      const j = readJson(p,{ metrics:[] })
      const campus = String(u.query.campus||'').trim()
      const arr = campus? (j.metrics||[]).filter(m=> String(m.campus||'')===campus) : (j.metrics||[])
      return ok(res,{ metrics: arr.slice(-200).reverse() })
    }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ metrics:[] })
      const campus = String(body.campus||'').trim()
      const date = String(body.date||new Date().toISOString().slice(0,10))
      const m = { id:'cm_'+Date.now(), campus, date, energy_kwh:+(body.energy_kwh||0), water_m3:+(body.water_m3||0), waste_kg:+(body.waste_kg||0), medw_kg:+(body.medw_kg||0), cytotoxic_kg:+(body.cytotoxic_kg||0) }
      if (!campus) return bad(res,'missing')
      j.metrics.push(m); writeJson(p, j); return ok(res,{ id: m.id })
    }
  }
  if (u.pathname==='/api/campus/aggregate' && req.method==='GET'){
    const campus = String(u.query.campus||'').trim()
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ factors:{ energy_kwh_to_tco2e:0.00042, water_m3_to_tco2e:0.000344, waste_kg_to_tco2e:0.0019, medw_kg_to_tco2e:0.0045 } })
    const f = settingsJson.factors||{}
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = dset.rows
    if (campus) rows = rows.filter(r=> String(r.campus||'')===campus)
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const baseTotals = { energy_kwh: sum(rows,'energy'), water_m3: sum(rows,'water'), waste_kg: sum(rows,'waste'), medw_kg: sum(rows,'medw'), co2_t: sum(rows,'co2') }
    const cp = readJson(path.join(DATA_DIR,'campus_metrics.json'),{ metrics:[] })
    const cms = (cp.metrics||[]).filter(m=> !campus || m.campus===campus)
    const addTotals = { energy_kwh: sum(cms,'energy_kwh'), water_m3: sum(cms,'water_m3'), waste_kg: sum(cms,'waste_kg'), medw_kg: sum(cms,'medw_kg'), cytotoxic_kg: sum(cms,'cytotoxic_kg') }
    const allEnergy = baseTotals.energy_kwh + addTotals.energy_kwh
    const allWater = baseTotals.water_m3 + addTotals.water_m3
    const allWaste = baseTotals.waste_kg + addTotals.waste_kg
    const allMedw = baseTotals.medw_kg + addTotals.medw_kg
    const tCO2e = +(allEnergy*(f.energy_kwh_to_tco2e||0) + allWater*(f.water_m3_to_tco2e||0) + allWaste*(f.waste_kg_to_tco2e||0) + allMedw*(f.medw_kg_to_tco2e||0)).toFixed(3)
    return ok(res,{ campus, totals:{ energy_kwh: allEnergy, water_m3: allWater, waste_kg: allWaste, medw_kg: allMedw, cytotoxic_kg: addTotals.cytotoxic_kg, tCO2e } })
  }

  if (u.pathname==='/api/drugs/library'){
    const p = path.join(DATA_DIR,'drugs_library.json')
    if (req.method==='GET'){ const j = readJson(p,{ drugs:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ drugs:[] })
      const name = String(body.name||'').trim()
      const atc = String(body.atc||'').trim()
      const supplier = String(body.supplier||'').trim()
      const kgco2e_per_unit = +(body.kgco2e_per_unit||0)
      const alts = Array.isArray(body.alternatives)? body.alternatives : String(body.alternatives||'').split(',').map(s=> s.trim()).filter(Boolean)
      if (!name) return bad(res,'missing')
      const idx = j.drugs.findIndex(d=> d.name===name)
      const item = { name, atc, supplier, kgco2e_per_unit, alternatives: alts }
      if (idx>=0) j.drugs[idx] = item; else j.drugs.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ drugs:[] })
      const name = String(u.query.name||'').trim()
      const next = j.drugs.filter(d=> d.name!==name)
      writeJson(p,{ drugs: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/drugs/usage' && req.method==='POST'){
    const body = await parseBody(req)
    const rows = Array.isArray(body.rows)? body.rows: []
    const lib = readJson(path.join(DATA_DIR,'drugs_library.json'),{ drugs:[] }).drugs
    let totalKg = 0
    for (const r of rows){ const d = lib.find(x=> x.name===String(r.name||'')); const unitKg = d? +(d.kgco2e_per_unit||0): 0; totalKg += unitKg * (+(r.qty||0)) }
    const tCO2e = +(totalKg/1000).toFixed(3)
    return ok(res,{ total_kgco2e:+totalKg.toFixed(2), tCO2e })
  }
  if (u.pathname==='/api/drugs/compare' && req.method==='POST'){
    const body = await parseBody(req)
    const atc = String(body.atc||'').trim()
    const name = String(body.name||'').trim()
    const lib = readJson(path.join(DATA_DIR,'drugs_library.json'),{ drugs:[] }).drugs
    let pool = lib
    if (atc) pool = pool.filter(d=> String(d.atc||'')===atc)
    if (name) pool = pool.filter(d=> String(d.name||'')!==name)
    pool.sort((a,b)=> a.kgco2e_per_unit - b.kgco2e_per_unit)
    const tips = pool.slice(0,5)
    return ok(res,{ tips })
  }

  if (u.pathname==='/api/esrs/checklist'){
    const p = path.join(DATA_DIR,'esrs_checklist.json')
    if (req.method==='GET'){ const j = readJson(p,{ items:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ items:[] })
      const code = String(body.code||'').trim(); const name = String(body.name||'').trim(); const status = String(body.status||'pending'); const owner = String(body.owner||''); const due = String(body.due||'')
      if (!code || !name) return bad(res,'missing')
      const idx = j.items.findIndex(x=> x.code===code)
      const item = { code, name, status, owner, due }
      if (idx>=0) j.items[idx] = item; else j.items.push(item)
      writeJson(p, j)
      return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ items:[] })
      const code = String(u.query.code||'').trim(); const next = j.items.filter(x=> x.code!==code)
      writeJson(p,{ items: next })
      return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/dnsh/checklist'){
    const p = path.join(DATA_DIR,'dnsh_checklist.json')
    if (req.method==='GET'){ const j = readJson(p,{ items:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ items:[] })
      const area = String(body.area||'').trim(); const name = String(body.name||'').trim(); const status = String(body.status||'pending'); const owner = String(body.owner||''); const due = String(body.due||'')
      if (!area || !name) return bad(res,'missing')
      const code = `${area}:${name}`
      const idx = j.items.findIndex(x=> x.code===code)
      const item = { code, area, name, status, owner, due }
      if (idx>=0) j.items[idx] = item; else j.items.push(item)
      writeJson(p, j)
      return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ items:[] })
      const code = String(u.query.code||'').trim(); const next = j.items.filter(x=> x.code!==code)
      writeJson(p,{ items: next })
      return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/eflib/import' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const p = path.join(DATA_DIR,'ef_library.json')
    const body = await parseBody(req)
    const profiles = Array.isArray(body.profiles)? body.profiles : []
    if (!profiles.length) return bad(res,'empty')
    writeJson(p,{ profiles })
    return ok(res,{ ok:true, count: profiles.length })
  }
  if (u.pathname==='/api/eflib/validate' && req.method==='POST'){
    const body = await parseBody(req)
    const rows = Array.isArray(body.rows)? body.rows : []
    const reqCols = ['name','energy_kwh_to_tco2e','water_m3_to_tco2e','waste_kg_to_tco2e','medw_kg_to_tco2e']
    let issues = []
    rows.forEach((r,i)=>{ reqCols.forEach(c=>{ if (r[c]===undefined||r[c]===null||r[c]===''){ issues.push({ row:i, col:c, msg:'missing' }) } }) })
    return ok(res,{ valid: issues.length===0, issues })
  }

  if (u.pathname==='/api/icao/factors' && req.method==='GET'){
    return ok(res,{ modes:[ { mode:'air', kg_per_km:0.15, haul:{ short:1.0, long:0.9 }, class:{ economy:1.0, business:1.6 } }, { mode:'train', kg_per_km:0.04 }, { mode:'bus', kg_per_km:0.09 }, { mode:'car', kg_per_km:0.12 } ] })
  }
  if (u.pathname==='/api/icao/calc' && req.method==='POST'){
    const body = await parseBody(req)
    const km = +(body.distance_km||0)
    const passengers = Math.max(1, +(body.passengers||1))
    const mode = String(body.mode||'air')
    const haul = String(body.haul||'short')
    const klass = String(body.class||'economy')
    const base = { air:0.15, train:0.04, bus:0.09, car:0.12 }[mode] || 0.15
    const haulMul = haul==='long' ? 0.9 : 1.0
    const classMul = klass==='business' ? 1.6 : 1.0
    const kg = km * base * haulMul * classMul * passengers
    const t = kg/1000
    return ok(res,{ tCO2e: +t.toFixed(3) })
  }

  if (u.pathname==='/api/connectors/bacnet'){
    const p = path.join(DATA_DIR,'bacnet_sources.json')
    if (req.method==='GET'){ const j = readJson(p,{ sources:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ sources:[] })
      const item = { device:String(body.device||''), object:String(body.object||''), hospital:String(body.hospital||''), dept:String(body.dept||''), enabled: !!body.enabled }
      if (!item.device || !item.object) return bad(res,'missing')
      j.sources.push(item); writeJson(p,j); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/connectors/modbus'){
    const p = path.join(DATA_DIR,'modbus_sources.json')
    if (req.method==='GET'){ const j = readJson(p,{ sources:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ sources:[] })
      const item = { host:String(body.host||''), register:+(body.register||0), hospital:String(body.hospital||''), dept:String(body.dept||''), enabled: !!body.enabled }
      if (!item.host || !item.register) return bad(res,'missing')
      j.sources.push(item); writeJson(p,j); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/connectors/ehr'){
    const p = path.join(DATA_DIR,'ehr_messages.json')
    if (req.method==='GET'){ const j = readJson(p,{ messages:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ messages:[] })
      const msg = { type:String(body.type||'FHIR'), data: body.data||{}, received_at: Date.now() }
      j.messages.push(msg); writeJson(p,j); return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/audit/logs' && req.method==='GET'){
    try{ const txt = fs.readFileSync(path.join(DATA_DIR,'access.log'),'utf8'); const lines = txt.trim().split(/\n/).slice(-200).reverse(); return ok(res,{ lines }) }catch(e){ return ok(res,{ lines: [] }) }
  }

  if (u.pathname==='/api/sbti/trajectory' && req.method==='POST'){
    const body = await parseBody(req)
    const base = +(body.base_co2||0)
    const startYear = +(body.start_year||new Date().getFullYear())
    const targetYear = +(body.target_year||startYear+5)
    const targetPct = +(body.target_pct||50)
    const years = []
    const n = Math.max(1, targetYear - startYear)
    for (let i=0;i<=n;i++){ const y = startYear + i; const frac = i/n; const t = base * (1 - targetPct/100 * frac); years.push({ year: y, target_co2: +t.toFixed(2) }) }
    return ok(res,{ trajectory: years })
  }
  if (u.pathname==='/api/finance/roi' && req.method==='POST'){
    const body = await parseBody(req)
    const cost = +(body.investment_cost||0)
    const saveKwh = +(body.energy_saved_kwh_per_year||0)
    const price = +(body.cost_per_kwh||0)
    const annualSavings = saveKwh * price
    const paybackYears = cost>0 ? (cost/annualSavings) : 0
    return ok(res,{ annual_savings: +annualSavings.toFixed(2), payback_years: +paybackYears.toFixed(2) })
  }

  if (u.pathname==='/api/procedures/profiles'){
    const p = path.join(DATA_DIR,'procedures.json')
    if (req.method==='GET'){ const j = readJson(p,{ profiles:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ profiles:[] })
      const name = String(body.name||'').trim()
      const dept = String(body.dept||'').trim()
      const factors = body.factors||{}
      if (!name) return bad(res,'missing')
      const idx = j.profiles.findIndex(x=> x.name===name)
      const item = { name, dept, factors }
      if (idx>=0) j.profiles[idx] = item; else j.profiles.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ profiles:[] })
      const name = String(u.query.name||'').trim()
      const next = j.profiles.filter(x=> x.name!==name)
      writeJson(p,{ profiles: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/procedures/benchmarks' && req.method==='GET'){
    return ok(res,{ benchmarks:[ { name:'Appendectomy', tCO2e: 0.12 }, { name:'C-Section', tCO2e: 0.35 }, { name:'Knee Arthroscopy', tCO2e: 0.28 }, { name:'Colonoscopy', tCO2e: 0.08 }, { name:'MRI', tCO2e: 0.02 } ] })
  }
  if (u.pathname==='/api/procedures/calc' && req.method==='POST'){
    const body = await parseBody(req)
    const settingsPath = path.join(DATA_DIR,'settings.json')
    const settingsJson = readJson(settingsPath,{ factors:{ energy_kwh_to_tco2e: 0.00042 }, scope_weights:{ s1:0.25, s2:0.6 } })
    const f = settingsJson.factors||{}
    const energy_kwh = +(body.energy_kwh||0)
    const steril_cycles = +(body.sterilization_cycles||0)
    const staff_hours = +(body.staff_hours||0)
    const staff_factor = +(body.staff_factor_kgco2e_per_hour||0.0)
    const steril_factor = +(body.sterilization_factor_kgco2e_per_cycle||0.5)
    const cons = Array.isArray(body.consumables)? body.consumables : []
    const tEnergy = energy_kwh * (f.energy_kwh_to_tco2e||0)
    const tSteril = (steril_cycles * steril_factor) / 1000.0
    const tStaff = (staff_hours * staff_factor) / 1000.0
    const tCons = cons.reduce((a,x)=> a + ((+(x.kgco2e||0) * (+(x.qty||1))) / 1000.0), 0)
    const total = +(tEnergy + tSteril + tStaff + tCons).toFixed(3)
    return ok(res,{ tCO2e: total, breakdown:{ energy:tEnergy, steril:tSteril, staff:tStaff, consumables:tCons } })
  }
  if (u.pathname==='/api/journeys'){
    const p = path.join(DATA_DIR,'journeys.json')
    if (req.method==='GET'){ const j = readJson(p,{ journeys:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ journeys:[] })
      const item = { id:'j_'+Date.now(), patient: String(body.patient||''), hospital: String(body.hospital||''), dept: String(body.dept||''), steps: Array.isArray(body.steps)? body.steps: [], tCO2e: +(body.tCO2e||0), created_at: Date.now() }
      j.journeys.push(item); writeJson(p, j); return ok(res,{ id: item.id })
    }
  }
  if (u.pathname==='/api/journeys/calc' && req.method==='POST'){
    const body = await parseBody(req)
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ factors:{ energy_kwh_to_tco2e: 0.00042, water_m3_to_tco2e: 0.000344, waste_kg_to_tco2e: 0.0019, medw_kg_to_tco2e: 0.0045 } })
    const f = settingsJson.factors||{}
    const steps = Array.isArray(body.steps)? body.steps: []
    let tEnergy=0, tWater=0, tWaste=0, tMedw=0, tTravel=0
    for (const s of steps){
      if (s.type==='energy_kwh') tEnergy += (+s.value||0) * (f.energy_kwh_to_tco2e||0)
      else if (s.type==='water_m3') tWater += (+s.value||0) * (f.water_m3_to_tco2e||0)
      else if (s.type==='waste_kg') tWaste += (+s.value||0) * (f.waste_kg_to_tco2e||0)
      else if (s.type==='medw_kg') tMedw += (+s.value||0) * (f.medw_kg_to_tco2e||0)
      else if (s.type==='travel'){
        const mode = String(s.mode||'air')
        const km = +(s.distance_km||0)
        const base = { air:0.15, train:0.04, bus:0.09, car:0.12 }[mode] || 0.15
        const haulMul = String(s.haul||'short')==='long' ? 0.9 : 1.0
        const classMul = String(s.class||'economy')==='business' ? 1.6 : 1.0
        tTravel += (km * base * haulMul * classMul)/1000.0
      }
    }
    const total = +(tEnergy + tWater + tWaste + tMedw + tTravel).toFixed(3)
    return ok(res,{ tCO2e: total, breakdown:{ energy:tEnergy, water:tWater, waste:tWaste, medw:tMedw, travel:tTravel } })
  }
  if (u.pathname==='/api/predict/failure' && req.method==='GET'){
    const rp = path.join(DATA_DIR,'meter_readings.json')
    const j = readJson(rp,{ readings:[] })
    const window = Math.max(5, Math.min(500, +(u.query.window||50)))
    const zthr = +(u.query.z||2.0)
    const byMeter = new Map()
    for (let i=j.readings.length-1; i>=0 && byMeter.size<1000; i--){ const r = j.readings[i]; const arr = byMeter.get(r.meter)||[]; arr.push(r.value||0); byMeter.set(r.meter, arr.slice(0,window)) }
    function stats(arr){ const n=arr.length; if (!n) return { m:0,s:0 }; const m=arr.reduce((a,x)=>a+x,0)/n; const v=arr.reduce((a,x)=>a+(x-m)*(x-m),0)/n; return { m, s: Math.sqrt(v) } }
    const out = []
    for (const [meter, arr] of byMeter.entries()){
      const { m, s } = stats(arr)
      const last = arr[0]||0
      const z = s>0 ? Math.abs((last - m)/s) : 0
      const risk = z<=zthr ? 0.1*z : 0.2*z
      out.push({ meter, mean:+m.toFixed(2), std:+s.toFixed(2), last:+last.toFixed(2), z:+z.toFixed(2), risk: Math.max(0, Math.min(1, +risk.toFixed(2))) })
    }
    out.sort((a,b)=> b.risk - a.risk)
    return ok(res,{ predictions: out.slice(0,20) })
  }
  if (u.pathname==='/api/benchmark/peers' && req.method==='GET'){
    const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const dept = String(u.query.dept||'').trim()
    const metric = String(u.query.metric||'co2').trim()
    const country = String(u.query.country||'').trim()
    let rows = d.rows
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    if (country) rows = rows.filter(r=> String(r.country||'')===country)
    const byHosp = new Map()
    for (const r of rows){
      const h = String(r.hospital||'')
      const arr = byHosp.get(h)||[]
      arr.push(r)
      byHosp.set(h, arr)
    }
    function agg(arr){
      const n = arr.length
      const sum = (k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
      const mean = (k)=> n? (arr.reduce((a,x)=> a + (+x[k]||0), 0)/n) : 0
      const vmap = { co2: sum('co2') + sum('scope3_extra'), energy: sum('energy'), water: sum('water'), waste: sum('waste'), medw: sum('medw'), ren: mean('ren'), rec: mean('rec') }
      return vmap[metric]!==undefined ? vmap[metric] : vmap['co2']
    }
    const peers = []
    for (const [h, arr] of byHosp.entries()){ peers.push({ hospital:h, value: agg(arr) }) }
    peers.sort((a,b)=> b.value - a.value)
    const N = peers.length || 1
    for (let i=0;i<peers.length;i++){ peers[i].rank = i+1; peers[i].percentile = +(100*(1 - (i)/(N))).toFixed(1) }
    const summary = { count:N }
    return ok(res,{ peers, summary })
  }
  if (u.pathname==='/api/benchmark/recommendations' && req.method==='POST'){
    const body = await parseBody(req)
    const dept = String(body.dept||'').trim()
    const hospital = String(body.hospital||'').trim()
    const metric = String(body.metric||'co2').trim()
    const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = d.rows
    if (dept) rows = rows.filter(r=> String(r.dept||'')===dept)
    const byHosp = new Map()
    for (const r of rows){ const h = String(r.hospital||''); const arr = byHosp.get(h)||[]; arr.push(r); byHosp.set(h, arr) }
    function agg(arr){ const n=arr.length; const sum=(k)=> arr.reduce((a,x)=> a+(+x[k]||0),0); const mean=(k)=> n? sum(k)/n:0; const vmap={ co2: sum('co2')+sum('scope3_extra'), energy: sum('energy'), water: sum('water'), waste: sum('waste'), medw: sum('medw'), ren: mean('ren'), rec: mean('rec') }; return vmap[metric]!==undefined? vmap[metric]: vmap['co2'] }
    const peers = []
    for (const [h, arr] of byHosp.entries()){ peers.push({ hospital:h, value: agg(arr) }) }
    peers.sort((a,b)=> b.value - a.value)
    const values = peers.map(p=> p.value)
    const mean = values.length? (values.reduce((a,x)=> a+x,0)/values.length) : 0
    const my = peers.find(p=> p.hospital===hospital)
    const better = peers.slice(-Math.max(1, Math.floor(values.length*0.1)))
    const tip = my ? (metric==='ren'||metric==='rec' ? (my.value < mean ? 'Increase '+metric+' towards top decile average' : 'Maintain current '+metric+' performance') : (my.value > mean ? 'Reduce '+metric+' towards top decile average' : 'Maintain current '+metric+' performance')) : 'Select a hospital'
    const target = better.length? +(better.reduce((a,x)=> a+x.value,0)/better.length).toFixed(3) : 0
    return ok(res,{ tip, target, peers })
  }
  if (u.pathname==='/api/procurement/suppliers'){
    const p = path.join(DATA_DIR,'procurement.json')
    if (req.method==='GET'){ const j = readJson(p,{ suppliers:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ suppliers:[] })
      const name = String(body.name||'').trim()
      const co2e_score = +(body.co2e_score||0)
      const certificates = Array.isArray(body.certificates)? body.certificates : String(body.certificates||'').split(',').map(s=> s.trim()).filter(Boolean)
      const items = Array.isArray(body.items)? body.items : []
      if (!name) return bad(res,'missing')
      const idx = j.suppliers.findIndex(s=> s.name===name)
      const item = { name, co2e_score, certificates, items }
      if (idx>=0) j.suppliers[idx] = item; else j.suppliers.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ suppliers:[] })
      const name = String(u.query.name||'').trim()
      const next = j.suppliers.filter(s=> s.name!==name)
      writeJson(p,{ suppliers: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/procurement/scores' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'procurement.json'),{ suppliers:[] })
    const arr = j.suppliers.map(s=>{ const certScore = (s.certificates||[]).length; const base = +(s.co2e_score||0); const score = Math.max(0, base - 0.01*certScore); return { name:s.name, score:+score.toFixed(3), co2e: base, certs: certScore } })
    arr.sort((a,b)=> a.score - b.score)
    return ok(res,{ scores: arr })
  }
  if (u.pathname==='/api/procurement/recommendations' && req.method==='POST'){
    const body = await parseBody(req)
    const cat = String(body.category||'').trim()
    const j = readJson(path.join(DATA_DIR,'procurement.json'),{ suppliers:[] })
    const pool = []
    for (const s of j.suppliers){ for (const it of (s.items||[])){ if (!cat || String(it.category||'')===cat) pool.push({ supplier:s.name, item:it.name, kgco2e:+(it.kgco2e||0) }) } }
    pool.sort((a,b)=> a.kgco2e - b.kgco2e)
    const tips = pool.slice(0,5)
    return ok(res,{ tips })
  }
  if (u.pathname==='/api/radar/scores' && req.method==='GET'){
    const campus = String(u.query.campus||'').trim()
    const esrs = readJson(path.join(DATA_DIR,'esrs_checklist.json'),{ items:[] }).items
    const dnsh = readJson(path.join(DATA_DIR,'dnsh_checklist.json'),{ items:[] }).items
    const reportsFiles = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR).filter(f=> f.endsWith('.json')) : []
    function pct(items){ const total = items.length; const done = items.filter(x=> x.status==='done').length; return total? +(100*done/total).toFixed(1) : 0 }
    const score_esrs = pct(esrs)
    const score_dnsh = pct(dnsh)
    const score_csrd = reportsFiles.length? Math.min(100, 30 + reportsFiles.length*5) : 20
    const settingsJson = readJson(path.join(DATA_DIR,'settings.json'),{ scope_weights:{ s1:0.25, s2:0.6 } })
    const score_iso14001 = settingsJson.scope_weights? 60 : 40
    const score_iso50001 = settingsJson.factors? 55 : 35
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = dset.rows
    if (campus) rows = rows.filter(r=> String(r.campus||'')===campus)
    const score_who = rows.length? 50 : 30
    return ok(res,{ campus, frameworks:[
      { name:'ESRS', score: score_esrs },
      { name:'DNSH', score: score_dnsh },
      { name:'CSRD', score: score_csrd },
      { name:'ISO 14001', score: score_iso14001 },
      { name:'ISO 50001', score: score_iso50001 },
      { name:'WHO', score: score_who },
    ] })
  }
  if (u.pathname==='/api/radar/actions'){
    const p = path.join(DATA_DIR,'radar_actions.json')
    if (req.method==='GET'){ const j = readJson(p,{ actions:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ actions:[] })
      const a = { id:'ra_'+Date.now(), framework:String(body.framework||''), action:String(body.action||''), owner:String(body.owner||''), due:String(body.due||''), created_at: Date.now() }
      j.actions.push(a); writeJson(p, j); return ok(res,{ id: a.id })
    }
  }
  if (u.pathname==='/api/radar/recommendations' && req.method==='GET'){
    const r = readJson(path.join(DATA_DIR,'radar_actions.json'),{ actions:[] })
    const s = await (async ()=>{ const tmpReq = { method:'GET', url:'/api/radar/scores' }; return readJson(path.join(DATA_DIR,'esrs_checklist.json'),{ items:[] }) })
    const scores = readJson(path.join(DATA_DIR,'esrs_checklist.json'),{ items:[] })
    const frameworks = readJson(path.join(DATA_DIR,'radar_last_scores.json'),{ frameworks:[] }).frameworks
    const tips = []
    for (const f of frameworks||[]){ if (+f.score<70){ tips.push({ framework:f.name, tip:`Improve ${f.name} score above 70` }) } }
    return ok(res,{ tips })
  }

  if (u.pathname==='/api/connectors/stream' && req.method==='GET'){
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive', 'Access-Control-Allow-Origin':'*' })
    const timer = setInterval(()=>{
      try{
        const meter = 'energy_main'
        const value = Math.round(5000 + Math.random()*500)
        const unit = 'kWh'
        const t = Date.now()
        const json = JSON.stringify({ meter, value, unit, t })
        res.write(`data: ${json}\n\n`)
      }catch(_){ }
    }, 2000)
    req.on('close', ()=>{ clearInterval(timer) })
    return
  }

  if (u.pathname==='/api/connectors/meter-readings'){
    const p = path.join(DATA_DIR,'meter_readings.json')
    if (req.method==='GET'){ const j = readJson(p,{ readings:[] }); const lim = Math.max(1, Math.min(200, +(u.query.limit||50))); return ok(res,{ readings: j.readings.slice(-lim).reverse() }) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ readings:[] })
      const it = { id:'mr_'+Date.now(), t: Date.now(), meter:String(body.meter||''), value:+(body.value||0), unit:String(body.unit||'kWh'), hospital:String(body.hospital||''), dept:String(body.dept||'') }
      j.readings.push(it); writeJson(p, j)
      try{
        const rules = readJson(path.join(DATA_DIR,'alert_rules.json'),{ rules:[] }).rules
        function clauseOk(clause, row){
          clause = clause.trim()
          let m
          m = clause.match(/^dept=="([^"]+)"$/)
          if (m) return String(row.dept||'')===m[1]
          m = clause.match(/^hospital=="([^"]+)"$/)
          if (m) return String(row.hospital||'')===m[1]
          m = clause.match(/^(year|energy|water|waste|medw|co2|ren|rec)\s*(>=|<=|==|!=|>|<)\s*([0-9]+(?:\.[0-9]+)?)$/)
          if (m){ const field = m[1], op = m[2], val = +m[3]; const rv = +row[field]; if (Number.isNaN(rv)) return false; if (op==='>') return rv>val; if (op==='>=') return rv>=val; if (op==='<') return rv<val; if (op==='<=') return rv<=val; if (op==='==') return rv==val; if (op==='!=') return rv!=val; return false }
          return false
        }
        function ruleMatch(rule, row){ const parts = String(rule||'').split('&&').map(x=>x.trim()).filter(Boolean); return parts.every(p=> clauseOk(p, row)) }
        const row = { hospital: it.hospital, dept: it.dept, energy: it.unit==='kWh'? it.value: 0, water: it.unit==='m3'? it.value: 0, waste: it.unit==='kg'? it.value: 0, medw: 0, co2: 0, ren: 0, rec: 0 }
        let created = 0
        const pTasks = path.join(DATA_DIR,'tasks.json')
        const jTasks = readJson(pTasks,{ tasks:[] })
        for (const r of rules){ if (ruleMatch(r.rule, row)){ jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title:`${r.name} triggered`, dept: row.dept||'', assignee:'', status:'open', sla_due: new Date(Date.now()+7*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes:`Meter ${it.meter}=${it.value} ${it.unit}` }); created++ } }
        if (created){ writeJson(pTasks, jTasks) }
      }catch(_){ }
      return ok(res,{ id: it.id })
    }
  }

  if (u.pathname==='/api/connectors/sources'){
    const p = path.join(DATA_DIR,'bms_sources.json')
    if (req.method==='GET'){ const j = readJson(p,{ sources:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ sources:[] })
      const meter = String(body.meter||'').trim()
      const unit = String(body.unit||'kWh')
      const hospital = String(body.hospital||'').trim()
      const dept = String(body.dept||'').trim()
      const base = +(body.base||0)
      const variance = +(body.variance||0)
      const enabled = !!body.enabled
      if (!meter) return bad(res,'missing')
      const idx = j.sources.findIndex(x=> x.meter===meter)
      const item = { meter, unit, hospital, dept, base, variance, enabled }
      if (idx>=0) j.sources[idx] = item; else j.sources.push(item)
      writeJson(p, j); return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (!requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ sources:[] })
      const meter = String(u.query.meter||'').trim()
      const next = j.sources.filter(x=> x.meter!==meter)
      writeJson(p,{ sources: next }); return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/alert-rules'){
    const p = path.join(DATA_DIR,'alert_rules.json')
    if (req.method==='GET'){ const j = readJson(p,{ rules:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req); const j = readJson(p,{ rules:[] }); const rule = { id: 'r_'+Date.now(), name: String(body.name||''), rule: String(body.rule||''), enabled: !!body.enabled }; j.rules.push(rule); writeJson(p,j); return ok(res,{ ok:true, id: rule.id })
    }
  }

  if (u.pathname==='/api/actions/log' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const p = path.join(DATA_DIR,'actions.json'); const body = await parseBody(req)
    const j = readJson(p,{ logs:[] }); j.logs.push({ action:String(body.action||''), meta: body.meta||{}, t: Date.now() }); writeJson(p,j); return ok(res,{ ok:true })
  }
  if (u.pathname.startsWith('/api/actions/logs') && req.method==='GET'){
    const p = path.join(DATA_DIR,'actions.json'); const j = readJson(p,{ logs:[] }); const lim = Math.max(1, Math.min(100, +(u.query.limit||10))); return ok(res,{ logs: j.logs.slice(-lim).reverse() })
  }

  if (u.pathname.startsWith('/api/files')){
    const indexPath = path.join(DATA_DIR,'files_index.json')
    const idx = readJson(indexPath,{ files:{} })
    if (u.pathname==='/api/files/save' && req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const id = 'f_'+Date.now()+'_'+Math.random().toString(36).slice(2,8)
      const buf = Buffer.from(String(body.data||''),'base64')
      const fpath = path.join(FILES_DIR, id)
      fs.writeFileSync(fpath, buf)
      idx.files[id] = { id, name: String(body.name||id), type: String(body.mime||'application/octet-stream'), path: fpath, size: buf.length }
      writeJson(indexPath, idx)
      return ok(res,{ id })
    }
    if (u.pathname==='/api/files/list' && req.method==='GET'){
      const list = Object.values(idx.files)
      return ok(res,{ files: list.map(f=> ({ id: f.id, name: f.name, type: f.type, size: f.size })) })
    }
    const m = u.pathname.match(/^\/api\/files\/([^/]+)$/)
    if (m && req.method==='GET'){
      const id = m[1]; const meta = idx.files[id]
      if (!meta) return notf(res)
      try{
        const buf = fs.readFileSync(meta.path)
        const isText = /^text\//.test(meta.type) || /\.(txt|md|csv|json)$/i.test(meta.name)
        const text = isText ? buf.toString('utf8') : ''
        return ok(res,{ id, name: meta.name, type: meta.type, size: meta.size, text })
      }catch(e){ return bad(res, e.message||e) }
    }
  }

  if (u.pathname==='/api/chat' && req.method==='POST'){
    const body = await parseBody(req)
    const reply = 'Demo response (Claude): '+ (body.messages && body.messages.length ? 'OK' : 'No input')
    return ok(res,{ content:[{ type:'text', text: reply }] })
  }
  if (u.pathname==='/api/openai/chat' && req.method==='POST'){
    const body = await parseBody(req)
    const reply = 'Demo response (OpenAI): '+ (body.messages && body.messages.length ? 'OK' : 'No input')
    return ok(res,{ content:[{ type:'text', text: reply }] })
  }

  if (u.pathname==='/api/session/save' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const p = path.join(DATA_DIR,'sessions.json'); const body = await parseBody(req)
    const j = readJson(p,[])
    const item = { id: 's_'+Date.now(), title: String(body.title||body.message||'—'), mode: String(body.mode||'hospital'), created_at: Date.now(), payload: body }
    j.push(item); writeJson(p,j); return ok(res,{ ok:true, id: item.id })
  }
  if (u.pathname.startsWith('/api/session/list') && req.method==='GET'){
    const p = path.join(DATA_DIR,'sessions.json'); const j = readJson(p,[]); const lim = Math.max(1, Math.min(100, +(u.query.limit||10))); return ok(res, j.slice(-lim).reverse())
  }

  if (u.pathname==='/api/tasks' && req.method==='GET'){
    const p = path.join(DATA_DIR,'tasks.json'); const j = readJson(p,{ tasks:[] }); const lim = Math.max(1, Math.min(200, +(u.query.limit||50))); return ok(res,{ tasks: j.tasks.slice(-lim).reverse() })
  }
  if (u.pathname==='/api/tasks' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const p = path.join(DATA_DIR,'tasks.json'); const body = await parseBody(req)
    const j = readJson(p,{ tasks:[] })
    const t = { id:'t_'+Date.now(), title:String(body.title||''), dept:String(body.dept||''), assignee:String(body.assignee||''), status:String(body.status||'open'), sla_due: body.sla_due||null, created_at: Date.now(), closed_at: null, notes: String(body.notes||'') }
    j.tasks.push(t); writeJson(p,j); return ok(res,{ id: t.id })
  }
  {
    const m = u.pathname.match(/^\/api\/tasks\/(t_[0-9]+)$/)
    if (m && req.method==='PATCH'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const p = path.join(DATA_DIR,'tasks.json'); const body = await parseBody(req)
      const j = readJson(p,{ tasks:[] })
      const id = m[1]
      const idx = j.tasks.findIndex(x=> x.id===id)
      if (idx<0) return notf(res)
      const cur = j.tasks[idx]
      if (body.status) cur.status = String(body.status)
      if (body.status==='done' && !cur.closed_at) cur.closed_at = Date.now()
      if (body.notes!==undefined) cur.notes = String(body.notes||'')
      writeJson(p,j); return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/alert-evaluate' && req.method==='POST'){
    const indexPath = path.join(DATA_DIR,'alert_rules.json')
    const rules = readJson(indexPath,{ rules:[] }).rules
    const body = await parseBody(req)
    const rows = Array.isArray(body.rows) ? body.rows : []
    const tests = rules.map(r=>({ id:r.id, name:r.name, rule:String(r.rule||'') }))
    function clauseOk(clause, row){
      clause = clause.trim()
      let m
      m = clause.match(/^dept=="([^"]+)"$/)
      if (m) return String(row.dept||'')===m[1]
      m = clause.match(/^hospital=="([^"]+)"$/)
      if (m) return String(row.hospital||'')===m[1]
      m = clause.match(/^(year|energy|water|waste|medw|co2|ren|rec)\s*(>=|<=|==|!=|>|<)\s*([0-9]+(?:\.[0-9]+)?)$/)
      if (m){
        const field = m[1], op = m[2], val = +m[3]; const rv = +row[field]
        if (Number.isNaN(rv)) return false
        if (op==='>') return rv>val
        if (op==='>=') return rv>=val
        if (op==='<' ) return rv<val
        if (op==='<=') return rv<=val
        if (op==='==') return rv==val
        if (op==='!=') return rv!=val
        return false
      }
      return false
    }
    function ruleMatch(rule, row){
      const parts = String(rule||'').split('&&').map(x=>x.trim()).filter(Boolean)
      return parts.every(p=> clauseOk(p, row))
    }
    const triggers = tests.map(t=>{
      const matches = []
      for (let i=0;i<rows.length;i++){ if (ruleMatch(t.rule, rows[i])) matches.push(i) }
      return { id:t.id, name:t.name, rule:t.rule, count: matches.length, sample: matches.slice(0,3).map(i=> rows[i]) }
    }).filter(x=> x.count>0)
    return ok(res,{ triggers })
  }

  if (u.pathname==='/api/alerts/autotask' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const indexPath = path.join(DATA_DIR,'alert_rules.json')
    const rules = readJson(indexPath,{ rules:[] }).rules
    const body = await parseBody(req)
    const rows = Array.isArray(body.rows) ? body.rows : []
    const pTasks = path.join(DATA_DIR,'tasks.json')
    const jTasks = readJson(pTasks,{ tasks:[] })
    function clauseOk(clause, row){
      clause = clause.trim()
      let m
      m = clause.match(/^dept=="([^"]+)"$/)
      if (m) return String(row.dept||'')===m[1]
      m = clause.match(/^hospital=="([^"]+)"$/)
      if (m) return String(row.hospital||'')===m[1]
      m = clause.match(/^(year|energy|water|waste|medw|co2|ren|rec)\s*(>=|<=|==|!=|>|<)\s*([0-9]+(?:\.[0-9]+)?)$/)
      if (m){
        const field = m[1], op = m[2], val = +m[3]; const rv = +row[field]
        if (Number.isNaN(rv)) return false
        if (op==='>') return rv>val
        if (op==='>=') return rv>=val
        if (op==='<' ) return rv<val
        if (op==='<=') return rv<=val
        if (op==='==') return rv==val
        if (op==='!=') return rv!=val
        return false
      }
      return false
    }
    function ruleMatch(rule, row){
      const parts = String(rule||'').split('&&').map(x=>x.trim()).filter(Boolean)
      return parts.every(p=> clauseOk(p, row))
    }
    let created = 0
    const slaDays = Math.max(1, Math.min(30, +(body.sla_days||7)))
    for (const r of rules){
      for (const row of rows){
        if (ruleMatch(r.rule, row)){
          const title = `${r.name} triggered`
          const dept = String(row.dept||'')
          const notes = `Rule: ${r.rule}; Row: ${JSON.stringify(row)}`
          jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title, dept, assignee:'', status:'open', sla_due: new Date(Date.now()+slaDays*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes })
          created++
        }
      }
    }
    writeJson(pTasks, jTasks)
    return ok(res,{ ok:true, created })
  }

  if (u.pathname==='/api/settings' && req.method==='GET'){
    const p = path.join(DATA_DIR,'settings.json')
    const def = { factors: { energy_kwh_to_tco2e: 0.00042, water_m3_to_tco2e: 0.000344, waste_kg_to_tco2e: 0.0019, medw_kg_to_tco2e: 0.0045 }, co2Threshold: 1000, scope_weights: { s1: 0.25, s2: 0.6 } }
    const j = readJson(p, def)
    return ok(res, j)
  }
  if (u.pathname==='/api/settings' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const p = path.join(DATA_DIR,'settings.json')
    const body = await parseBody(req)
    const def = { factors: { energy_kwh_to_tco2e: 0.00042, water_m3_to_tco2e: 0.000344, waste_kg_to_tco2e: 0.0019, medw_kg_to_tco2e: 0.0045 }, co2Threshold: 1000, scope_weights: { s1: 0.25, s2: 0.6 } }
    const cur = readJson(p, def)
    const next = {
      factors: Object.assign({}, cur.factors||{}, body.factors||{}),
      co2Threshold: body.co2Threshold!==undefined ? body.co2Threshold : (cur.co2Threshold||1000),
      scope_weights: Object.assign({}, cur.scope_weights||{}, body.scope_weights||{})
    }
    writeJson(p, next)
    return ok(res,{ ok:true })
  }

  if (u.pathname==='/api/factors'){
    const p = path.join(DATA_DIR,'factors.json')
    if (req.method==='GET'){
      const j = readJson(p,{ profiles:[] })
      const hospital = String(u.query.hospital||'').trim()
      const dept = String(u.query.dept||'').trim()
      if (hospital || dept){
        const arr = j.profiles.filter(x=> (!hospital || x.hospital===hospital) && (!dept || x.dept===dept))
        return ok(res,{ profiles: arr })
      }
      return ok(res, j)
    }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ profiles:[] })
      const hospital = String(body.hospital||'').trim()
      const dept = String(body.dept||'').trim()
      const factors = body.factors||{}
      const scope_weights = body.scope_weights||{}
      if (!hospital || !dept) return bad(res,'missing_keys')
      const idx = j.profiles.findIndex(x=> x.hospital===hospital && x.dept===dept)
      const item = { hospital, dept, factors, scope_weights }
      if (idx>=0){ j.profiles[idx] = item } else { j.profiles.push(item) }
      writeJson(p, j)
      return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ profiles:[] })
      const hospital = String(u.query.hospital||'').trim()
      const dept = String(u.query.dept||'').trim()
      if (!hospital || !dept) return bad(res,'missing_keys')
      const next = j.profiles.filter(x=> !(x.hospital===hospital && x.dept===dept))
      writeJson(p,{ profiles: next })
      return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/dataset'){
    const p = path.join(DATA_DIR,'dataset.json')
    if (req.method==='GET'){ const j = readJson(p,{ rows:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const rows = Array.isArray(body.rows)? body.rows : []
      writeJson(p,{ rows })
      return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/reports/generate' && req.method==='POST'){
    const settingsPath = path.join(DATA_DIR,'settings.json')
    const settingsJson = readJson(settingsPath,{ factors:{}, co2Threshold:1000, scope_weights:{ s1:0.25, s2:0.6 } })
    const body = await parseBody(req)
    let rows = Array.isArray(body.rows)? body.rows : []
    if (!rows.length){ const d = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] }); rows = d.rows }
    const sumField = (arr,k)=> arr.reduce((a,x)=> a+(+x[k]||0),0)
    const meanField = (arr,k)=> arr.length? sumField(arr,k)/arr.length : 0
    const co2 = sumField(rows,'co2')
    const energy = sumField(rows,'energy')
    const water = sumField(rows,'water')
    const waste = sumField(rows,'waste')
    const medw = sumField(rows,'medw')
    const ren = meanField(rows,'ren')
    const rec = meanField(rows,'rec')
    const w = settingsJson.scope_weights || { s1:0.25, s2:0.6 }
    const s1 = co2*(w.s1||0.25), s2 = co2*(w.s2||0.6), s3 = Math.max(0, co2 - s1 - s2)
    const tpl = String(body.template||'csrd')
    const report = { id:'rep_'+Date.now(), template: tpl, created_at: Date.now(), summary:{ co2, energy, water, waste, medw, ren, rec, scope:{ s1, s2, s3 } }, settings: settingsJson }
    const p = path.join(REPORTS_DIR, report.id+'.json')
    writeJson(p, report)
    return ok(res,{ id: report.id })
  }
  if (u.pathname==='/api/reports/list' && req.method==='GET'){
    const files = fs.readdirSync(REPORTS_DIR).filter(f=> f.endsWith('.json')).sort().reverse()
    const lim = Math.max(1, Math.min(200, +(u.query.limit||20)))
    const arr = files.slice(0,lim).map(f=>{ const j = readJson(path.join(REPORTS_DIR,f),{}); return { id:j.id||f.replace('.json',''), template:j.template||'unknown', created_at:j.created_at||Date.now() } })
    return ok(res,{ reports: arr })
  }
  {
    const m = u.pathname.match(/^\/api\/reports\/([^/]+)$/)
    if (m && req.method==='GET'){
      const id = m[1]; const p = path.join(REPORTS_DIR, id+'.json')
      try{ const j = readJson(p, null); if (!j) return notf(res); return ok(res, j) }catch(e){ return notf(res) }
    }
  }

  if (u.pathname==='/api/reports/schedule'){
    const p = path.join(DATA_DIR,'report_schedules.json')
    if (req.method==='GET'){ const j = readJson(p,{ schedules:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ schedules:[] })
      const tpl = String(body.template||'csrd')
      const freq = String(body.frequency||'weekly')
      const next_run = String(body.next_run||new Date(Date.now()+24*60*60*1000).toISOString())
      const email_group = String(body.email_group||'').trim()
      const email_template = String(body.email_template||'').trim()
      const item = { id:'sch_'+Date.now(), template: tpl, frequency: freq, next_run, email_group, email_template }
      j.schedules.push(item); writeJson(p,j); return ok(res,{ id: item.id })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ schedules:[] })
      const id = String(u.query.id||'').trim()
      const next = j.schedules.filter(s=> s.id!==id)
      writeJson(p,{ schedules: next })
      return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/email/send' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const p = path.join(DATA_DIR,'emails.json')
    const body = await parseBody(req)
    const j = readJson(p,{ outbox:[] })
    const item = { id:'em_'+Date.now(), to:String(body.to||''), subject:String(body.subject||''), body:String(body.body||''), attachments: Array.isArray(body.attachments)? body.attachments: [], created_at: Date.now() }
    j.outbox.push(item)
    writeJson(p,j)
    return ok(res,{ id: item.id })
  }

  if (u.pathname==='/api/notify/groups'){
    const p = path.join(DATA_DIR,'notify_groups.json')
    if (req.method==='GET'){ const j = readJson(p,{ groups:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ groups:[] })
      const name = String(body.name||'').trim(); const emails = Array.isArray(body.emails)? body.emails : String(body.emails||'').split(',').map(s=> s.trim()).filter(Boolean)
      if (!name || !emails.length) return bad(res,'missing')
      const idx = j.groups.findIndex(g=> g.name===name)
      const item = { name, emails }
      if (idx>=0) j.groups[idx] = item; else j.groups.push(item)
      writeJson(p, j)
      return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ groups:[] })
      const name = String(u.query.name||'').trim()
      const next = j.groups.filter(g=> g.name!==name)
      writeJson(p,{ groups: next })
      return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/notify/send-group' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const gp = path.join(DATA_DIR,'notify_groups.json')
    const ep = path.join(DATA_DIR,'emails.json')
    const groups = readJson(gp,{ groups:[] }).groups
    const body = await parseBody(req)
    const name = String(body.name||'').trim()
    const g = groups.find(x=> x.name===name)
    if (!g) return bad(res,'group_not_found')
    const out = readJson(ep,{ outbox:[] })
    let count = 0
    for (const to of g.emails){ out.outbox.push({ id:'em_'+Date.now()+Math.random().toString(36).slice(2,6), to, subject:String(body.subject||''), body:String(body.body||''), attachments: Array.isArray(body.attachments)? body.attachments: [], created_at: Date.now() }); count++ }
    writeJson(ep, out)
    return ok(res,{ ok:true, sent: count })
  }

  if (u.pathname==='/api/email/outbox'){
    const p = path.join(DATA_DIR,'emails.json')
    if (req.method==='GET'){ const j = readJson(p,{ outbox:[] }); return ok(res, j) }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ outbox:[] }); const id = String(u.query.id||'').trim(); const next = (j.outbox||[]).filter(x=> x.id!==id); writeJson(p,{ outbox: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/email/sent' && req.method==='GET'){
    const p = path.join(DATA_DIR,'emails_sent.json'); const j = readJson(p,{ sent:[] }); return ok(res, j)
  }
  if (u.pathname==='/api/email/send-outbox' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const op = path.join(DATA_DIR,'emails.json')
    const sp = path.join(DATA_DIR,'emails_sent.json')
    const out = readJson(op,{ outbox:[] })
    const sent = readJson(sp,{ sent:[] })
    const items = out.outbox||[]
    items.forEach(x=> sent.sent.push(Object.assign({}, x, { sent_at: Date.now() })))
    writeJson(sp, sent)
    writeJson(op, { outbox: [] })
    return ok(res,{ ok:true, sent: items.length })
  }
  if (u.pathname==='/api/email/smtp-config'){
    const p = path.join(DATA_DIR,'smtp_config.json')
    if (req.method==='GET'){ const j = readJson(p,{ host:'', port:0, user:'', pass:'' }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const next = { host: String(body.host||''), port: +(body.port||0), user: String(body.user||''), pass: String(body.pass||'') }
      writeJson(p, next); return ok(res,{ ok:true })
    }
  }

  if (u.pathname==='/api/notify/templates'){
    const p = path.join(DATA_DIR,'notify_templates.json')
    if (req.method==='GET'){ const j = readJson(p,{ templates:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ templates:[] })
      const name = String(body.name||'').trim(); const subject = String(body.subject||''); const bodyText = String(body.body||'')
      if (!name || !subject || !bodyText) return bad(res,'missing')
      const idx = j.templates.findIndex(t=> t.name===name)
      const item = { name, subject, body: bodyText }
      if (idx>=0) j.templates[idx] = item; else j.templates.push(item)
      writeJson(p, j)
      return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ templates:[] }); const name = String(u.query.name||'').trim(); const next = j.templates.filter(t=> t.name!==name); writeJson(p,{ templates: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/escalation/rules'){
    const p = path.join(DATA_DIR,'escalation_rules.json')
    if (req.method==='GET'){ const j = readJson(p,{ rules:[] }); return ok(res, j) }
    if (req.method==='POST'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const body = await parseBody(req)
      const j = readJson(p,{ rules:[] })
      const name = String(body.name||'').trim()
      const dept = String(body.dept||'').trim()
      const overdue_days = Math.max(0, +(body.overdue_days||0))
      const group = String(body.group||'').trim()
      const template = String(body.template||'').trim()
      const assignee = String(body.assignee||'').trim()
      if (!name || !group || !template) return bad(res,'missing')
      const idx = j.rules.findIndex(r=> r.name===name)
      const item = { name, dept, overdue_days, group, template, assignee }
      if (idx>=0) j.rules[idx] = item; else j.rules.push(item)
      writeJson(p, j)
      return ok(res,{ ok:true })
    }
    if (req.method==='DELETE'){
      if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
      const j = readJson(p,{ rules:[] }); const name = String(u.query.name||'').trim(); const next = j.rules.filter(r=> r.name!==name); writeJson(p,{ rules: next }); return ok(res,{ ok:true })
    }
  }
  if (u.pathname==='/api/escalation/run' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const out = runEscalationOnce()
    return ok(res,{ ok:true, escalated: out.escalated, emailed: out.emailed })
  }


  if (u.pathname==='/api/case-mix' && req.method==='GET'){
    const p = path.join(DATA_DIR,'case_mix.json')
    const j = readJson(p,{ campuses:[] })
    return ok(res, j)
  }

  if (u.pathname==='/api/dept/profiles' && req.method==='GET'){
    const p = path.join(DATA_DIR,'dept_profiles.json')
    const def = { profiles:[ { dept:'ICU', dept_type:'clinical', risk_level:'high', scope_weights:{ s1:0.5, s2:0.4, s3:0.1 }, occupancy_sensitivity:0.9, baseline_energy:300000, baseline_water:6000 }, { dept:'OR', dept_type:'clinical', risk_level:'high', scope_weights:{ s1:0.4, s2:0.5, s3:0.1 }, occupancy_sensitivity:0.8, baseline_energy:260000, baseline_water:5100 }, { dept:'Oncology', dept_type:'clinical', risk_level:'medium', scope_weights:{ s1:0.3, s2:0.5, s3:0.2 }, occupancy_sensitivity:0.7, baseline_energy:180000, baseline_water:2000 }, { dept:'Imaging', dept_type:'support', risk_level:'medium', scope_weights:{ s1:0.2, s2:0.6, s3:0.2 }, occupancy_sensitivity:0.5, baseline_energy:60000, baseline_water:1200 } ] }
    const j = readJson(p, def)
    return ok(res, j)
  }

  if (u.pathname==='/api/ecp/calc' && req.method==='POST'){
    const body = await parseBody(req)
    const pathway_id = String(body.pathway_id||'').trim()
    const p = path.join(DATA_DIR,'ecp_profiles.json')
    const profs = readJson(p,{ pathways:[] }).pathways
    const pf = profs.find(x=> x.pathway_id===pathway_id)
    if (!pf) return bad(res,'not_found')
    const consLib = readJson(path.join(DATA_DIR,'consumables_factors.json'),{ items:[] }).items
    let total = 0
    const per_step = []
    for (const s of pf.steps||[]){
      const base = +s.base_co2||0
      let cons = 0
      for (const it of (s.consumables_profile||[])){ const f = consLib.find(x=> x.item_code===it.item_code); const kg = (f? +f.kg_co2e_per_unit: 0) * (+it.qty||0); cons += kg/1000.0 }
      const step_total = +(base + cons).toFixed(3)
      total += step_total
      per_step.push({ dept:s.dept, total_co2: step_total })
    }
    const per_patient = total
    return ok(res,{ pathway_id, total_co2:+total.toFixed(3), per_step, per_patient:+per_patient.toFixed(3) })
  }

  if (u.pathname==='/api/consumables' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'consumables_factors.json'),{ items:[] })
    return ok(res, j)
  }
  if (u.pathname==='/api/consumables/usage' && req.method==='POST'){
    const body = await parseBody(req)
    const items = Array.isArray(body.items)? body.items : [{ item_code:String(body.item_code||''), qty:+(body.qty||0) }]
    const lib = readJson(path.join(DATA_DIR,'consumables_factors.json'),{ items:[] }).items
    let kg=0
    for (const it of items){ const f = lib.find(x=> x.item_code===String(it.item_code||'')); if (f) kg += (+f.kg_co2e_per_unit||0) * (+it.qty||0) }
    return ok(res,{ total_kgco2e:+kg.toFixed(2), tCO2e:+(kg/1000).toFixed(3) })
  }

  if (u.pathname==='/api/finance/tariffs'){
    const p = path.join(DATA_DIR,'tariffs.json')
    if (req.method==='GET'){ const j = readJson(p,{ tariffs:{} }); return ok(res, j) }
    if (req.method==='POST'){ if (usersExist() && !requireAuth(req)) return bad(res,'auth_required'); const body = await parseBody(req); writeJson(p, body||{}); return ok(res,{ ok:true }) }
  }
  if (u.pathname==='/api/finance/apply-tariffs' && req.method==='POST'){
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = dset.rows
    if (hospital) rows = rows.filter(r=> String(r.hospital||'')===hospital)
    const tjson = readJson(path.join(DATA_DIR,'tariffs.json'),{ tariffs:{} })
    const tz = tjson.tariffs||{}
    const elect = tz.electricity_tr_2025 || { currency:'TRY', unit:'kWh', price:0.75 }
    const water = tz.water_tr_2025 || { currency:'TRY', unit:'m3', price:10 }
    const wgen = tz.waste_general_tr_2025 || { currency:'TRY', unit:'kg', price:0.8 }
    const wmed = tz.waste_medical_tr_2025 || { currency:'TRY', unit:'kg', price:3.5 }
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const energy_cost = sum(rows,'energy') * (+elect.price||0)
    const water_cost = sum(rows,'water') * (+water.price||0)
    const waste_cost = sum(rows,'waste') * (+wgen.price||0) + sum(rows,'medw') * (+wmed.price||0)
    const total = energy_cost + water_cost + waste_cost
    return ok(res,{ currency: String(elect.currency||'TRY'), energy_cost:+energy_cost.toFixed(2), water_cost:+water_cost.toFixed(2), waste_cost:+waste_cost.toFixed(2), total:+total.toFixed(2) })
  }
  if (u.pathname==='/api/finance/savings' && req.method==='POST'){
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const r = await (async ()=>{ const resp = { currency:'TRY', current_cost:0, potential_savings:0, scenarios:[] }; const applied = await (async ()=>{ const b = JSON.stringify({ hospital }); return await new Promise(resolve=>{ const req2 = http.request({ hostname:'localhost', port: PORT, path:'/api/finance/apply-tariffs', method:'POST', headers:{ 'Content-Type':'application/json' } }, res2=>{ let data=''; res2.on('data',c=> data+=c); res2.on('end',()=>{ try{ resolve(JSON.parse(data)) }catch(_){ resolve({}) } }) }); req2.on('error',()=>resolve({})); req2.write(b); req2.end() }) })(); const cur = +applied.total||0; const pot10 = +(cur*0.1).toFixed(2); resp.currency = applied.currency||'TRY'; resp.current_cost = +cur.toFixed(2); resp.potential_savings = pot10; resp.scenarios = [ { name:'Reduce energy 10%', savings:+(applied.energy_cost*0.1).toFixed(2) }, { name:'Reduce water 10%', savings:+(applied.water_cost*0.1).toFixed(2) }, { name:'Reduce waste 10%', savings:+(applied.waste_cost*0.1).toFixed(2) } ]; return resp })()
    return ok(res, r)
  }

  if (u.pathname==='/api/risk/matrix' && req.method==='GET'){
    const cp = readJson(path.join(DATA_DIR,'campus_defs.json'),{ campuses:[] }).campuses
    const align = readJson(path.join(DATA_DIR,'taxonomy_alignments.json'),{ campuses:[] }).campuses
    const out = (cp||[]).map(c=>{ const a = align.find(x=> x.campus_id===(c.campus_id||c.name)); const esrs = a? ((+a.esrs_gap_score||0)>50? 'amber' : (+a.esrs_gap_score||0)>35? 'amber':'green') : 'amber'; const dnsh = a? (String(a.dns_h_status||'amber')) : 'amber'; return { campus_id: c.campus_id||c.name, jci:'green', esrs, dnsh } })
    return ok(res,{ campuses: out })
  }

  if (u.pathname==='/api/eu/taxonomy/alignments' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'taxonomy_alignments.json'),{ campuses:[] })
    return ok(res, j)
  }
  if (u.pathname==='/api/eu/taxonomy' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'taxonomy_alignments.json'),{ campuses:[] })
    return ok(res, j)
  }

  if (u.pathname==='/api/gd/projects' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'ecp_profiles.json'),{ projects:[] })
    return ok(res, j)
  }

  if (u.pathname==='/api/clinical/normalized2' && req.method==='GET'){
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const vol = readJson(path.join(DATA_DIR,'clinical_volume.json'),{ volumes:[] }).volumes
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const co2 = sum(dset.rows,'co2') + sum(dset.rows,'scope3_extra')
    const inpatients = sum(vol,'inpatients')
    const surgeries = sum(vol,'surgeries')
    const icu_days = sum(vol,'icu_days')
    const per_patient = inpatients? +(co2/inpatients).toFixed(3) : null
    const per_surgery = surgeries? +(co2/surgeries).toFixed(3) : null
    const per_icu_day = icu_days? +(co2/icu_days).toFixed(3) : null
    return ok(res,{ co2_total:+co2.toFixed(3), per_patient, per_surgery, per_icu_day })
  }

  if (u.pathname==='/api/facility/autotask-from-event' && req.method==='POST'){
    if (usersExist() && !requireAuth(req)) return bad(res,'auth_required')
    const body = await parseBody(req)
    const eventRow = body.row||{}
    const rules = readJson(path.join(DATA_DIR,'alert_rules.json'),{ rules:[] }).rules
    function clauseOk(clause, row){ clause=String(clause||'').trim(); let m; m=clause.match(/^dept=="([^"]+)"$/); if (m) return String(row.dept||'')===m[1]; m=clause.match(/^hospital=="([^"]+)"$/); if (m) return String(row.hospital||'')===m[1]; m=clause.match(/^(year|energy|water|waste|medw|co2|ren|rec)\s*(>=|<=|==|!=|>|<)\s*([0-9]+(?:\.[0-9]+)?)$/); if (m){ const field=m[1],op=m[2],val=+m[3]; const rv=+row[field]; if (Number.isNaN(rv)) return false; if (op==='>') return rv>val; if (op==='>=') return rv>=val; if (op==='<') return rv<val; if (op==='<=') return rv<=val; if (op==='==') return rv==val; if (op==='!=') return rv!=val; return false } return false }
    function ruleMatch(rule,row){ const parts=String(rule||'').split('&&').map(x=> x.trim()).filter(Boolean); return parts.every(p=> clauseOk(p,row)) }
    const pTasks = path.join(DATA_DIR,'tasks.json')
    const jTasks = readJson(pTasks,{ tasks:[] })
    let created=0
    for (const r of rules){ if (ruleMatch(r.rule, eventRow)){ jTasks.tasks.push({ id:'t_'+Date.now()+Math.random().toString(36).slice(2,6), title:`${r.name} triggered`, dept: String(eventRow.dept||''), assignee:'', status:'open', sla_due: new Date(Date.now()+7*24*60*60*1000).toISOString().slice(0,10), created_at: Date.now(), closed_at: null, notes: JSON.stringify(eventRow) }); created++ } }
    writeJson(pTasks, jTasks)
    return ok(res,{ ok:true, created })
  }
  if (u.pathname==='/api/seasonality/apply' && req.method==='POST'){
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const metric = String(body.metric||'energy')
    const annual = +(body.annual_value||0)
    const cp = readJson(path.join(DATA_DIR,'campus_defs.json'),{ campuses:[] }).campuses
    const c = cp.find(x=> String(x.name||'')===hospital)
    const id = c? (x=> x.campus_id||x.name)(c) : ''
    const sj = readJson(path.join(DATA_DIR,'seasonality.json'),{ seasonality:[] })
    const prof = (sj.seasonality||[]).find(x=> x.campus_id===id && String(x.metric||'')===metric)
    const weights = prof && Array.isArray(prof.monthly_weights)? prof.monthly_weights : []
    if (!weights.length || annual<=0) return ok(res,{ campus_id:id||null, metric, monthly: [] })
    const sumw = weights.reduce((a,x)=> a + (+x||0), 0) || 1
    const monthly = weights.map(w=> +((annual * (w/sumw))).toFixed(3))
    return ok(res,{ campus_id:id, metric, monthly })
  }

  if (u.pathname.startsWith('/api/demo/csv/') && req.method==='GET'){
    try{
      const name = u.pathname.replace('/api/demo/csv/','')
      const map = {
        'hsp_records': 'hsp_records.csv',
        'departments_energy': 'departments_energy.csv',
        'departments_waste': 'departments_waste.csv',
        'monthly_co2_trend': 'monthly_co2_trend.csv',
        'taxonomy_izmir': 'taxonomy_izmir.csv'
      }
      const fn = map[name]
      if (!fn) return notf(res)
      const p = path.join(DATA_DIR,'hsp_csv',fn)
      const txt = fs.readFileSync(p,'utf8')
      res.writeHead(200,{ 'Content-Type':'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fn}"`, 'Access-Control-Allow-Origin':'*' })
      return res.end(txt)
    }catch(_){ return notf(res) }
  }

  if (u.pathname==='/api/demo/import-all-csv' && req.method==='POST'){
    try{
      const dir = path.join(DATA_DIR,'hsp_csv')
      function readCsv(fn){ const p = path.join(dir,fn); const txt = fs.readFileSync(p,'utf8'); const lines = txt.split(/\r?\n/).filter(x=> x.trim().length>0); const header = lines.shift().split(',').map(s=> s.trim()); return lines.map(line=>{ const cols = []; let cur=''; let inq=false; for (let i=0;i<line.length;i++){ const ch=line[i]; if (ch==='"'){ inq=!inq; continue } if (ch===',' && !inq){ cols.push(cur); cur=''; } else { cur+=ch } } cols.push(cur); const obj={}; for (let i=0;i<header.length;i++){ obj[header[i]] = (cols[i]||'').trim() } return obj }) }
      const recs = readCsv('hsp_records.csv')
      const dsetPath = path.join(DATA_DIR,'dataset.json')
      let cur = readJson(dsetPath,{ rows:[] })
      const key = (r)=> `${r.year}|${r.hospital}|${r.department}`
      const seen = new Set(cur.rows.map(r=> `${r.year}|${r.hospital}|${r.dept}`))
      for (const r of recs){ if (!seen.has(key(r))){ cur.rows.push({ year:+r.year, hospital:r.hospital, country:'TR', dept:r.department, energy:+r.energy_kwh||0, water:+r.water_m3||0, waste:+r.waste_kg||0, medw:+r.medical_waste_kg||0, co2:+r.co2e_ton||0, ren:+r.renewables_pct||0, rec:+r.recycling_pct||0, status:r.status||'' }) } }
      writeJson(dsetPath, cur)
      const taxCsv = readCsv('taxonomy_izmir.csv')
      const campusPath = path.join(DATA_DIR,'campus_defs.json')
      const campuses = readJson(campusPath,{ campuses:[] })
      campuses.campuses = campuses.campuses||[]
      for (const t of taxCsv){ const name = t.campus; if (!campuses.campuses.find(x=> x.name===name)){ campuses.campuses.push({ campus_id: name.toLowerCase().replace(/\s+/g,'_'), name, short_name:name, city:t.city, country:'TR', type:'private_chain', segment:'tertiary_care', beds_total:250, icu_beds:50, or_count:10, has_nicu:true, owner_group:'', grid_profile:'TR-Grid-2025', tags:[], scopes:{ scope1:true, scope2:true, scope3:true } }) } }
      writeJson(campusPath, campuses)
      const taxPath = path.join(DATA_DIR,'taxonomy_alignments.json')
      const tax = readJson(taxPath,{ campuses:[] })
      tax.campuses = tax.campuses||[]
      for (const t of taxCsv){ const id = (campuses.campuses.find(x=> x.name===t.campus)||{}).campus_id || t.campus; const rec = { campus_id:id, eligible_revenue_mtl:+t.eligible_revenue_mtl||0, taxonomy_aligned_revenue_pct:+t.aligned_revenue_pct/100||0, taxonomy_aligned_capex_pct:+t.capex_aligned_pct/100||0, after_dnsh_pct:+t.after_dnsh_pct/100||0, esrs_gap_score:+t.esrs_score||0, dns_h_status: (+t.after_dnsh_pct>=10? 'amber':'green') }; const ex = tax.campuses.find(x=> x.campus_id===id); if (ex){ Object.assign(ex, rec) } else { tax.campuses.push(rec) } }
      writeJson(taxPath, tax)
      return ok(res,{ ok:true, rows: cur.rows.length, campuses: campuses.campuses.length, taxonomy: tax.campuses.length })
    }catch(e){ return bad(res, e.message||e) }
  }

  if (u.pathname==='/api/demo/import-csv-dir' && req.method==='POST'){
    try{
      const body = await parseBody(req)
      const dir = String(body.dir||'').trim()
      if (!dir) return bad(res,'dir_required')
      function readCsvAbs(pth){ const txt = fs.readFileSync(pth,'utf8'); const lines = txt.split(/\r?\n/).filter(x=> x.trim().length>0); const header = lines.shift().split(',').map(s=> s.trim()); return lines.map(line=>{ const cols = []; let cur=''; let inq=false; for (let i=0;i<line.length;i++){ const ch=line[i]; if (ch==='"'){ inq=!inq; continue } if (ch===',' && !inq){ cols.push(cur); cur=''; } else { cur+=ch } } cols.push(cur); const obj={}; for (let i=0;i<header.length;i++){ obj[header[i]] = (cols[i]||'').trim() } return obj }) }
      const names = Object.assign({ records:'hsp_records.csv', energy:'departments_energy.csv', waste:'departments_waste.csv', monthly:'monthly_co2_trend.csv', taxonomy:'taxonomy_izmir.csv' }, body.map||{})
      const recs = readCsvAbs(path.resolve(dir, names.records))
      const dsetPath = path.join(DATA_DIR,'dataset.json')
      let cur = readJson(dsetPath,{ rows:[] })
      const key = (r)=> `${r.year}|${r.hospital}|${r.department}`
      const seen = new Set(cur.rows.map(r=> `${r.year}|${r.hospital}|${r.dept}`))
      for (const r of recs){ if (!seen.has(key(r))){ cur.rows.push({ year:+r.year, hospital:r.hospital, country:'TR', dept:r.department, energy:+r.energy_kwh||0, water:+r.water_m3||0, waste:+r.waste_kg||0, medw:+r.medical_waste_kg||0, co2:+r.co2e_ton||0, ren:+r.renewables_pct||0, rec:+r.recycling_pct||0, status:r.status||'' }) } }
      writeJson(dsetPath, cur)
      const taxCsv = readCsvAbs(path.resolve(dir, names.taxonomy))
      const campusPath = path.join(DATA_DIR,'campus_defs.json')
      const campuses = readJson(campusPath,{ campuses:[] })
      campuses.campuses = campuses.campuses||[]
      for (const t of taxCsv){ const name = t.campus; if (!campuses.campuses.find(x=> x.name===name)){ campuses.campuses.push({ campus_id: name.toLowerCase().replace(/\s+/g,'_'), name, short_name:name, city:t.city, country:'TR', type:'private_chain', segment:'tertiary_care', beds_total:250, icu_beds:50, or_count:10, has_nicu:true, owner_group:'', grid_profile:'TR-Grid-2025', tags:[], scopes:{ scope1:true, scope2:true, scope3:true } }) } }
      writeJson(campusPath, campuses)
      const taxPath = path.join(DATA_DIR,'taxonomy_alignments.json')
      const tax = readJson(taxPath,{ campuses:[] })
      tax.campuses = tax.campuses||[]
      for (const t of taxCsv){ const id = (campuses.campuses.find(x=> x.name===t.campus)||{}).campus_id || t.campus; const rec = { campus_id:id, eligible_revenue_mtl:+t.eligible_revenue_mtl||0, taxonomy_aligned_revenue_pct:+t.aligned_revenue_pct/100||0, taxonomy_aligned_capex_pct:+t.capex_aligned_pct/100||0, after_dnsh_pct:+t.after_dnsh_pct/100||0, esrs_gap_score:+t.esrs_score||0, dns_h_status: (+t.after_dnsh_pct>=10? 'amber':'green') }; const ex = tax.campuses.find(x=> x.campus_id===id); if (ex){ Object.assign(ex, rec) } else { tax.campuses.push(rec) } }
      writeJson(taxPath, tax)
      return ok(res,{ ok:true, rows: cur.rows.length, campuses: campuses.campuses.length, taxonomy: tax.campuses.length })
    }catch(e){ return bad(res, e.message||e) }
  }

  return notf(res)
})

server.listen(PORT, ()=>{ console.log('ZeroAtHospital API on http://localhost:'+PORT) })

setInterval(()=>{
  try{
    const p = path.join(DATA_DIR,'report_schedules.json')
    const j = readJson(p,{ schedules:[] })
    const now = Date.now()
    let changed = false
    const nextOf = (frequency, prev)=>{
      const d = new Date(prev)
      if (frequency==='daily'){ d.setDate(d.getDate()+1) }
      else if (frequency==='weekly'){ d.setDate(d.getDate()+7) }
      else if (frequency==='monthly'){ d.setMonth(d.getMonth()+1) }
      else { d.setDate(d.getDate()+7) }
      return d.toISOString()
    }
    for (const s of j.schedules){
      const due = new Date(s.next_run).getTime()
      if (!isFinite(due)) continue
      if (due<=now){
        const r = url.parse('/api/reports/generate')
        const settingsPath = path.join(DATA_DIR,'settings.json')
        const settingsJson = readJson(settingsPath,{ factors:{}, co2Threshold:1000, scope_weights:{ s1:0.25, s2:0.6 } })
        const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
        const rows = dset.rows
        const sumField = (arr,k)=> arr.reduce((a,x)=> a+(+x[k]||0),0)
        const meanField = (arr,k)=> arr.length? sumField(arr,k)/arr.length : 0
        const co2 = sumField(rows,'co2')
        const energy = sumField(rows,'energy')
        const water = sumField(rows,'water')
        const waste = sumField(rows,'waste')
        const medw = sumField(rows,'medw')
        const ren = meanField(rows,'ren')
        const rec = meanField(rows,'rec')
        const w = settingsJson.scope_weights || { s1:0.25, s2:0.6 }
        const s1v = co2*(w.s1||0.25), s2v = co2*(w.s2||0.6), s3v = Math.max(0, co2 - s1v - s2v)
        const report = { id:'rep_'+Date.now(), template: s.template, created_at: Date.now(), summary:{ co2, energy, water, waste, medw, ren, rec, scope:{ s1: s1v, s2: s2v, s3: s3v } }, settings: settingsJson }
        writeJson(path.join(REPORTS_DIR, report.id+'.json'), report)
        try{
          if (s.email_group){
            const gp = path.join(DATA_DIR,'notify_groups.json')
            const tp = path.join(DATA_DIR,'notify_templates.json')
            const groups = readJson(gp,{ groups:[] }).groups
            const templates = readJson(tp,{ templates:[] }).templates
            const g = groups.find(x=> x.name===s.email_group)
            const tmpl = templates.find(x=> x.name===s.email_template)
            const ep = path.join(DATA_DIR,'emails.json')
            const out = readJson(ep,{ outbox:[] })
            const ctx = { template: s.template, id: report.id, co2: co2, energy: energy }
            const subj = tmpl ? (String(tmpl.subject||'').replace(/\{\{(\w+)\}\}/g, (_,k)=> String(ctx[k]||''))) : `Report ${report.id}`
            const body = tmpl ? (String(tmpl.body||'').replace(/\{\{(\w+)\}\}/g, (_,k)=> String(ctx[k]||''))) : `Template ${s.template}`
            const lines = [ 'Scheduled Report', 'Template: '+s.template, 'ID: '+report.id, 'CO2: '+co2, 'Energy: '+energy ]
            const pdfB64 = makeSimplePdfBase64('Zero@Hospital', lines)
            for (const to of (g? g.emails: [s.email_group])){
              out.outbox.push({ id:'em_'+Date.now()+Math.random().toString(36).slice(2,6), to, subject: subj, body, attachments:[{ name: report.id+'.pdf', type:'application/pdf', data: pdfB64 }], created_at: Date.now() })
            }
            writeJson(ep, out)
          }
        }catch(_){ }
        s.next_run = nextOf(s.frequency, s.next_run)
        changed = true
      }
    }
    if (changed) writeJson(p, j)
  }catch(_){ }
}, 30000)

setInterval(()=>{ try{ runEscalationOnce() }catch(_){ } }, 60000)

setInterval(()=>{
  try{
    const arr = readOpsRecent(5)
    const byPath = new Map()
    let slowCount = 0, err5Count = 0
    for (const r of arr){ if ((+r.duration_ms||0)>2000) slowCount++; if ((+r.status||0)>=500) err5Count++; const k=r.path||''; const a=byPath.get(k)||[]; a.push(+r.duration_ms||0); byPath.set(k,a) }
    if (slowCount>20 || err5Count>10){
      let worst = { path:'', p95:0 }
      for (const [p,durs] of byPath.entries()){ if (!durs.length) continue; const s=durs.slice().sort((a,b)=>a-b); const idx=Math.floor(0.95*(s.length-1)); const v=s[idx]; if (v>(worst.p95||0)) worst={ path:p, p95:v } }
      const ap = path.join(DATA_DIR,'ops_alerts.json')
      const j = readJson(ap,{ alerts:[] })
      j.alerts.push({ id:'ops-'+Date.now(), created_at: new Date().toISOString(), severity: (err5Count>10?'high':'medium'), type: (slowCount>20?'api_slow':'api_errors'), message: (slowCount>20?'High latency':'High 5xx error rate'), data:{ path: worst.path||'', p95_ms: Math.round(worst.p95||0), count: arr.length, window_min: 5 } })
      writeJson(ap, j)
    }
  }catch(_){ }
}, 300000)

// BMS sources auto poller
setInterval(()=>{
  try{
    const p = path.join(DATA_DIR,'bms_sources.json')
    const j = readJson(p,{ sources:[] })
    const rp = path.join(DATA_DIR,'meter_readings.json')
    const readings = readJson(rp,{ readings:[] })
    for (const s of j.sources){
      if (!s.enabled) continue
      const val = Math.round((s.base||1000) + Math.random()*(s.variance||100))
      readings.readings.push({ id:'mr_'+Date.now()+Math.random().toString(36).slice(2,6), t: Date.now(), meter: s.meter||'unknown', value: val, unit: s.unit||'kWh', hospital: s.hospital||'', dept: s.dept||'' })
    }
    writeJson(rp, readings)
  }catch(_){ }
}, 15000)

  
async function UNUSED_BLOCK(){
  if (u.pathname==='/api/case-mix' && req.method==='GET'){
    const p = path.join(DATA_DIR,'case_mix.json')
    const j = readJson(p,{ campuses:[] })
    return ok(res, j)
  }

  if (u.pathname==='/api/dept/profiles' && req.method==='GET'){
    const p = path.join(DATA_DIR,'dept_profiles.json')
    const def = { profiles:[ { dept:'ICU', dept_type:'clinical', risk_level:'high', scope_weights:{ s1:0.5, s2:0.4, s3:0.1 }, occupancy_sensitivity:0.9, baseline_energy:300000, baseline_water:6000 }, { dept:'OR', dept_type:'clinical', risk_level:'high', scope_weights:{ s1:0.4, s2:0.5, s3:0.1 }, occupancy_sensitivity:0.8, baseline_energy:260000, baseline_water:5100 }, { dept:'Oncology', dept_type:'clinical', risk_level:'medium', scope_weights:{ s1:0.3, s2:0.5, s3:0.2 }, occupancy_sensitivity:0.7, baseline_energy:180000, baseline_water:2000 }, { dept:'Imaging', dept_type:'support', risk_level:'medium', scope_weights:{ s1:0.2, s2:0.6, s3:0.2 }, occupancy_sensitivity:0.5, baseline_energy:60000, baseline_water:1200 } ] }
    const j = readJson(p, def)
    return ok(res, j)
  }

  if (u.pathname==='/api/ecp/calc' && req.method==='POST'){
    const body = await parseBody(req)
    const pathway_id = String(body.pathway_id||'').trim()
    const p = path.join(DATA_DIR,'ecp_profiles.json')
    const profs = readJson(p,{ pathways:[] }).pathways
    const pf = profs.find(x=> x.pathway_id===pathway_id)
    if (!pf) return bad(res,'not_found')
    const consLib = readJson(path.join(DATA_DIR,'consumables_factors.json'),{ items:[] }).items
    let total = 0
    const per_step = []
    for (const s of pf.steps||[]){
      const base = +s.base_co2||0
      let cons = 0
      for (const it of (s.consumables_profile||[])){ const f = consLib.find(x=> x.item_code===it.item_code); const kg = (f? +f.kg_co2e_per_unit: 0) * (+it.qty||0); cons += kg/1000.0 }
      const step_total = +(base + cons).toFixed(3)
      total += step_total
      per_step.push({ dept:s.dept, total_co2: step_total })
    }
    const per_patient = total
    return ok(res,{ pathway_id, total_co2:+total.toFixed(3), per_step, per_patient:+per_patient.toFixed(3) })
  }

  if (u.pathname==='/api/consumables' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'consumables_factors.json'),{ items:[] })
    return ok(res, j)
  }
  if (u.pathname==='/api/consumables/usage' && req.method==='POST'){
    const body = await parseBody(req)
    const items = Array.isArray(body.items)? body.items : [{ item_code:String(body.item_code||''), qty:+(body.qty||0) }]
    const lib = readJson(path.join(DATA_DIR,'consumables_factors.json'),{ items:[] }).items
    let kg=0
    for (const it of items){ const f = lib.find(x=> x.item_code===String(it.item_code||'')); if (f) kg += (+f.kg_co2e_per_unit||0) * (+it.qty||0) }
    return ok(res,{ total_kgco2e:+kg.toFixed(2), tCO2e:+(kg/1000).toFixed(3) })
  }

  if (u.pathname==='/api/finance/tariffs'){
    const p = path.join(DATA_DIR,'tariffs.json')
    if (req.method==='GET'){ const j = readJson(p,{ tariffs:{} }); return ok(res, j) }
    if (req.method==='POST'){ if (usersExist() && !requireAuth(req)) return bad(res,'auth_required'); const body = await parseBody(req); writeJson(p, body||{}); return ok(res,{ ok:true }) }
  }
  if (u.pathname==='/api/finance/apply-tariffs' && req.method==='POST'){
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    let rows = dset.rows
    if (hospital) rows = rows.filter(r=> String(r.hospital||'')===hospital)
    const tjson = readJson(path.join(DATA_DIR,'tariffs.json'),{ tariffs:{} })
    const tz = tjson.tariffs||{}
    const elect = tz.electricity_tr_2025 || { currency:'TRY', unit:'kWh', price:0.75 }
    const water = tz.water_tr_2025 || { currency:'TRY', unit:'m3', price:10 }
    const wgen = tz.waste_general_tr_2025 || { currency:'TRY', unit:'kg', price:0.8 }
    const wmed = tz.waste_medical_tr_2025 || { currency:'TRY', unit:'kg', price:3.5 }
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const energy_cost = sum(rows,'energy') * (+elect.price||0)
    const water_cost = sum(rows,'water') * (+water.price||0)
    const waste_cost = sum(rows,'waste') * (+wgen.price||0) + sum(rows,'medw') * (+wmed.price||0)
    const total = energy_cost + water_cost + waste_cost
    return ok(res,{ currency: String(elect.currency||'TRY'), energy_cost:+energy_cost.toFixed(2), water_cost:+water_cost.toFixed(2), waste_cost:+waste_cost.toFixed(2), total:+total.toFixed(2) })
  }
  if (u.pathname==='/api/finance/savings' && req.method==='POST'){
    const body = await parseBody(req)
    const hospital = String(body.hospital||'').trim()
    const r = await (async ()=>{ const resp = { currency:'TRY', current_cost:0, potential_savings:0, scenarios:[] }; const applied = await (async ()=>{ const b = JSON.stringify({ hospital }); return await new Promise(resolve=>{ const req2 = http.request({ hostname:'localhost', port: PORT, path:'/api/finance/apply-tariffs', method:'POST', headers:{ 'Content-Type':'application/json' } }, res2=>{ let data=''; res2.on('data',c=> data+=c); res2.on('end',()=>{ try{ resolve(JSON.parse(data)) }catch(_){ resolve({}) } }) }); req2.on('error',()=>resolve({})); req2.write(b); req2.end() }) })(); const cur = +applied.total||0; const pot10 = +(cur*0.1).toFixed(2); resp.currency = applied.currency||'TRY'; resp.current_cost = +cur.toFixed(2); resp.potential_savings = pot10; resp.scenarios = [ { name:'Reduce energy 10%', savings:+(applied.energy_cost*0.1).toFixed(2) }, { name:'Reduce water 10%', savings:+(applied.water_cost*0.1).toFixed(2) }, { name:'Reduce waste 10%', savings:+(applied.waste_cost*0.1).toFixed(2) } ]; return resp })()
    return ok(res, r)
  }

  if (u.pathname==='/api/risk/matrix' && req.method==='GET'){
    const cp = readJson(path.join(DATA_DIR,'campus_defs.json'),{ campuses:[] }).campuses
    const align = readJson(path.join(DATA_DIR,'taxonomy_alignments.json'),{ campuses:[] }).campuses
    const out = (cp||[]).map(c=>{ const a = align.find(x=> x.campus_id===(c.campus_id||c.name)); const esrs = a? ((+a.esrs_gap_score||0)>50? 'amber' : (+a.esrs_gap_score||0)>35? 'amber':'green') : 'amber'; const dnsh = a? (String(a.dns_h_status||'amber')) : 'amber'; return { campus_id: c.campus_id||c.name, jci:'green', esrs, dnsh } })
    return ok(res,{ campuses: out })
  }

  if (u.pathname==='/api/eu/taxonomy/alignments' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'taxonomy_alignments.json'),{ campuses:[] })
    return ok(res, j)
  }
  if (u.pathname==='/api/eu/taxonomy' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'taxonomy_alignments.json'),{ campuses:[] })
    return ok(res, j)
  }

  if (u.pathname==='/api/gd/projects' && req.method==='GET'){
    const j = readJson(path.join(DATA_DIR,'ecp_profiles.json'),{ projects:[] })
    return ok(res, j)
  }

  if (u.pathname==='/api/clinical/normalized2' && req.method==='GET'){
    const dset = readJson(path.join(DATA_DIR,'dataset.json'),{ rows:[] })
    const vol = readJson(path.join(DATA_DIR,'clinical_volume.json'),{ volumes:[] }).volumes
    const sum = (arr,k)=> arr.reduce((a,x)=> a + (+x[k]||0), 0)
    const co2 = sum(dset.rows,'co2') + sum(dset.rows,'scope3_extra')
    const inpatients = sum(vol,'inpatients')
    const surgeries = sum(vol,'surgeries')
    const icu_days = sum(vol,'icu_days')
    const per_patient = inpatients? +(co2/inpatients).toFixed(3) : null
    const per_surgery = surgeries? +(co2/surgeries).toFixed(3) : null
    const per_icu_day = icu_days? +(co2/icu_days).toFixed(3) : null
    return ok(res,{ co2_total:+co2.toFixed(3), per_patient, per_surgery, per_icu_day })
  }

  if (u.pathname==='/api/seasonality'){
    const p = path.join(DATA_DIR,'seasonality.json')
    const j = readJson(p,{ profiles:[] })
    if (req.method==='GET'){
      const hospital = String(u.query.hospital||'').trim()
      const cp = readJson(path.join(DATA_DIR,'campus_defs.json'),{ campuses:[] }).campuses
      const c = cp.find(x=> String(x.name||'')===hospital)
      const id = c? (c.campus_id||c.name) : ''
      const prof = j.profiles.find(x=> x.campus_id===id)
      return ok(res,{ campus_id:id||null, weights: prof? prof.weights: null })
    }
  }

  if (u.pathname==='/api/facility/hvac-analyze' && req.method==='POST'){
    const body = await parseBody(req)
    const readings = readJson(path.join(DATA_DIR,'meter_readings.json'),{ readings:[] }).readings
    const campus = String(body.campus||'').trim()
    const hvac = readings.filter(r=> /hvac/i.test(r.meter) && (!campus || r.hospital===campus)).slice(-500)
    const mean = hvac.length? hvac.reduce((a,x)=> a + (+x.value||0), 0)/hvac.length : 0
    const night = hvac.filter(r=>{ const h=new Date(r.t).getHours(); return h>=0&&h<6 }).reduce((a,x)=> a+(+x.value||0),0)/(hvac.filter(r=>{ const h=new Date(r.t).getHours(); return h>=0&&h<6 }).length||1)
    const flag = night > mean*0.8
    return ok(res,{ campus, anomaly: flag, summary:{ mean:+mean.toFixed(2), night:+night.toFixed(2) } })
  }
  if (u.pathname==='/api/facility/or-idle' && req.method==='POST'){
    const body = await parseBody(req)
    const readings = readJson(path.join(DATA_DIR,'meter_readings.json'),{ readings:[] }).readings
    const campus = String(body.campus||'').trim()
    const orx = readings.filter(r=> /OR_|OR|operating/i.test(r.meter) && (!campus || r.hospital===campus)).slice(-500)
    const idle = orx.filter(r=>{ const h=new Date(r.t).getHours(); return h>=22||h<6 }).reduce((a,x)=> a+(+x.value||0),0)/(orx.filter(r=>{ const h=new Date(r.t).getHours(); return h>=22||h<6 }).length||1)
    const flag = idle > 1000
    return ok(res,{ campus, anomaly: flag, summary:{ idle:+idle.toFixed(2) } })
  }
}
