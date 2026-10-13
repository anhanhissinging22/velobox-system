import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.VELOBOX_DB || path.join(root, 'velobox.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT DEFAULT '', role TEXT NOT NULL, building TEXT DEFAULT '', apartment TEXT DEFAULT '', password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stations(id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'online', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cells(id TEXT PRIMARY KEY, station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE, label TEXT NOT NULL, size TEXT NOT NULL DEFAULT 'M', status TEXT NOT NULL DEFAULT 'empty', order_id TEXT, UNIQUE(station_id,label));
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, tracking_code TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL, phone TEXT DEFAULT '', apartment TEXT DEFAULT '', building TEXT DEFAULT '', carrier TEXT DEFAULT '', station_id TEXT REFERENCES stations(id), cell_id TEXT REFERENCES cells(id), status TEXT NOT NULL DEFAULT 'processing', amount INTEGER NOT NULL DEFAULT 0, resident_id TEXT REFERENCES users(id), otp_hash TEXT, otp_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', station_id TEXT REFERENCES stations(id), cell_id TEXT REFERENCES cells(id), reporter_id TEXT REFERENCES users(id), priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), amount INTEGER NOT NULL, provider TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', external_reference TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);`);
try { db.exec('ALTER TABLE orders ADD COLUMN assigned_shipper_id TEXT REFERENCES users(id)'); } catch {}

const roles = new Set(['SYSTEM_ADMIN','BUILDING_ADMIN','SHIPPER','RESIDENT']);
const roleLabels = {SYSTEM_ADMIN:'Admin hệ thống', BUILDING_ADMIN:'Quản trị viên / BQL', SHIPPER:'Shipper / Đối tác', RESIDENT:'Cư dân / Khách hàng'};
const now = () => new Date().toISOString();
const tokenHash = t => createHash('sha256').update(t).digest('hex');
const otpHash = (id, otp) => createHash('sha256').update(`${id}:${otp}`).digest('hex');
const send = (res, code, body, headers={}) => { res.writeHead(code, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers}); res.end(JSON.stringify(body)); };
const cookie = (token, age=86400*7) => `velobox_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
function audit(user, action, entity, id='', details='') {
  db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),now(),user?.id||null,user?.name||'System',action,entity,id,details);
}
function parseBody(req) { return new Promise((resolve,reject)=>{ let raw=''; req.on('data',c=>{raw+=c;if(raw.length>1_000_000) req.destroy();}); req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch{reject(new Error('JSON không hợp lệ'));}}); req.on('error',reject); }); }
function currentUser(req) {
  const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('velobox_session='))?.slice('velobox_session='.length);
  if(!token) return null;
  const s=db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(tokenHash(token),now());
  return s ? db.prepare('SELECT id,name,email,phone,role,building,apartment,active FROM users WHERE id=? AND active=1').get(s.user_id) : null;
}
function requireUser(user,res,allowed=null) { if(!user){send(res,401,{error:'Vui lòng đăng nhập'});return false;} if(allowed&&!allowed.includes(user.role)){send(res,403,{error:'Vai trò hiện tại không được phép thực hiện thao tác này'});return false;} return true; }
const adminRoles=['SYSTEM_ADMIN','BUILDING_ADMIN'];
const q=(sql,...args)=>db.prepare(sql).all(...args);
function dashboard(){
 const count=table=>db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
 const sum=db.prepare("SELECT COALESCE(sum(amount),0) n FROM payments WHERE status='paid'").get().n;
 return {orders:count('orders'), residents:db.prepare("SELECT count(*) n FROM users WHERE role='RESIDENT'").get().n, users:count('users'), stations:count('stations'), cells:count('cells'), incidents:db.prepare("SELECT count(*) n FROM incidents WHERE status!='resolved'").get().n, overdue:db.prepare("SELECT count(*) n FROM orders WHERE status='overdue'").get().n, payments:sum};
}
async function route(req,res){
 const url=new URL(req.url,'http://localhost'); const p=url.pathname; const method=req.method;
 if(method==='GET'&&p==='/api/health') return send(res,200,{ok:true,service:'VELOBOX API',database:path.basename(dbPath)});
 if(p==='/api/setup-status'&&method==='GET') return send(res,200,{required:db.prepare('SELECT count(*) n FROM users').get().n===0});
 if(p==='/api/setup'&&method==='POST'){
  if(db.prepare('SELECT count(*) n FROM users').get().n!==0) return send(res,409,{error:'Thiết lập ban đầu đã hoàn tất'});
  const b=await parseBody(req); if(!b.name||!b.email||!b.password||String(b.password).length<10) return send(res,400,{error:'Cần họ tên, email và mật khẩu tối thiểu 10 ký tự'});
  const id=randomUUID(),salt=randomBytes(16).toString('hex'),hash=scryptSync(String(b.password),salt,64).toString('hex');
  db.prepare('INSERT INTO users(id,name,email,phone,role,password_hash,created_at) VALUES(?,?,?,?,?,?,?)').run(id,b.name,String(b.email).toLowerCase(),'', 'SYSTEM_ADMIN',`${salt}:${hash}`,now());
  const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token),id,new Date(Date.now()+7*864e5).toISOString());audit({id,name:b.name},'setup.completed','user',id,'Tạo quản trị viên đầu tiên');
  return send(res,201,{user:db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(id)},{'set-cookie':cookie(token)});
 }
 if(p==='/api/login'&&method==='POST'){
  const b=await parseBody(req),u=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(b.email||'').toLowerCase());
  if(!u) return send(res,401,{error:'Email hoặc mật khẩu không đúng'});
  const [salt,expected]=u.password_hash.split(':');const actual=scryptSync(String(b.password||''),salt,64);if(!timingSafeEqual(actual,Buffer.from(expected,'hex')))return send(res,401,{error:'Email hoặc mật khẩu không đúng'});
  const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token),u.id,new Date(Date.now()+7*864e5).toISOString());audit(u,'auth.login','user',u.id,'Đăng nhập');return send(res,200,{user:{id:u.id,name:u.name,email:u.email,role:u.role,roleLabel:roleLabels[u.role]}},{'set-cookie':cookie(token)});
 }
 if(p==='/api/logout'&&method==='POST'){const u=currentUser(req);const t=(req.headers.cookie||'').match(/velobox_session=([^;]+)/)?.[1];if(t)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(t));if(u)audit(u,'auth.logout','user',u.id,'Đăng xuất');return send(res,200,{ok:true},{'set-cookie':cookie('',0)});}
 const user=currentUser(req);
 if(p==='/api/me'&&method==='GET'){if(!requireUser(user,res))return;return send(res,200,{user:{...user,roleLabel:roleLabels[user.role]}});}
 if(!p.startsWith('/api/')){
  const name=p==='/'?'velobox_system.html':p.slice(1);const file=path.resolve(root,name);if(!file.startsWith(root+path.sep)&&file!==path.join(root,'velobox_system.html'))return send(res,403,{error:'Forbidden'});
  if(!fs.existsSync(file))return send(res,404,{error:'Not found'});const type=file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream';res.writeHead(200,{'content-type':type,'cache-control':'no-cache'});return fs.createReadStream(file).pipe(res);
 }
 if(!requireUser(user,res))return;
 if(p==='/api/dashboard'&&method==='GET'){if(!requireUser(user,res,adminRoles))return;return send(res,200,dashboard());}
 const match=p.match(/^\/api\/(orders|stations|cells|incidents|payments|users|integrations|audit)(?:\/([^/]+))?(?:\/(deposit|pickup|remote-unlock))?$/);
 if(!match)return send(res,404,{error:'API endpoint không tồn tại'});
 const [,resource,id,action]=match;
 if(resource==='users'&&user.role!=='SYSTEM_ADMIN')return send(res,403,{error:'Chỉ Admin hệ thống được quản lý tài khoản'});
 if(resource==='audit'&& !adminRoles.includes(user.role))return send(res,403,{error:'Không có quyền xem audit log'});
 const tables={orders:'orders',stations:'stations',cells:'cells',incidents:'incidents',payments:'payments',users:'users',integrations:'integrations',audit:'audit'};
 if(method==='GET'&&!id){let rows=q(`SELECT * FROM ${tables[resource]} ORDER BY ${resource==='audit'?'occurred_at':resource==='cells'?'label':'created_at'} DESC LIMIT 500`);if(resource==='users')rows=rows.map(({password_hash,...u})=>u);if(resource==='orders'&&user.role==='RESIDENT')rows=rows.filter(o=>o.resident_id===user.id);if(resource==='orders'&&user.role==='SHIPPER')rows=rows.filter(o=>o.assigned_shipper_id===user.id);return send(res,200,{items:rows});}
 if(resource==='orders'&&action==='deposit'&&method==='POST'){
  if(!requireUser(user,res,['SYSTEM_ADMIN','BUILDING_ADMIN','SHIPPER']))return;const o=db.prepare("SELECT * FROM orders WHERE id=?").get(id);if(!o)return send(res,404,{error:'Đơn hàng không tồn tại'});if(!['processing','in_transit'].includes(o.status))return send(res,409,{error:'Trạng thái đơn không cho phép gửi vào locker'});
  const b=await parseBody(req);if(!b.cell_id)return send(res,400,{error:'Chọn ngăn locker trước'});const c=db.prepare("SELECT * FROM cells WHERE id=? AND status='empty'").get(b.cell_id);if(!c)return send(res,409,{error:'Ngăn không tồn tại hoặc đang được sử dụng'});
  const otp=String(randomBytes(4).readUInt32BE(0)%1_000_000).padStart(6,'0'),expiry=new Date(Date.now()+48*3600e3).toISOString();db.exec('BEGIN');try{db.prepare("UPDATE cells SET status='occupied',order_id=? WHERE id=?").run(id,c.id);db.prepare("UPDATE orders SET status='at_locker',cell_id=?,station_id=?,otp_hash=?,otp_expires_at=?,updated_at=? WHERE id=?").run(c.id,c.station_id,otpHash(id,otp),expiry,now(),id);audit(user,'order.deposited','order',id,`cell=${c.label}`);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return send(res,200,{order:db.prepare('SELECT * FROM orders WHERE id=?').get(id),otp,otp_expires_at:expiry,note:'Mã OTP chỉ hiển thị một lần. Chưa gửi SMS/Zalo do chưa cấu hình nhà cung cấp.'});
 }
 if(resource==='orders'&&action==='pickup'&&method==='POST'){
  if(!requireUser(user,res,['SYSTEM_ADMIN','BUILDING_ADMIN','RESIDENT']))return;const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!o)return send(res,404,{error:'Đơn hàng không tồn tại'});const b=await parseBody(req);if(o.status!=='at_locker')return send(res,409,{error:'Đơn hàng chưa sẵn sàng nhận'});if(!o.otp_hash||o.otp_expires_at<now()||otpHash(id,String(b.otp||''))!==o.otp_hash)return send(res,400,{error:'OTP không hợp lệ hoặc đã hết hạn'});if(o.amount>0&&!db.prepare("SELECT 1 FROM payments WHERE order_id=? AND status='paid'").get(id))return send(res,402,{error:'Đơn còn phí cần thanh toán'});db.exec('BEGIN');try{db.prepare("UPDATE orders SET status='picked_up',otp_hash=NULL,otp_expires_at=NULL,updated_at=? WHERE id=?").run(now(),id);if(o.cell_id)db.prepare("UPDATE cells SET status='empty',order_id=NULL WHERE id=?").run(o.cell_id);audit(user,'order.picked_up','order',id,'OTP valid');db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return send(res,200,{order:db.prepare('SELECT * FROM orders WHERE id=?').get(id)});
 }
 if(resource==='cells'&&action==='remote-unlock'&&method==='POST'){
  if(!requireUser(user,res,adminRoles))return;const c=db.prepare('SELECT * FROM cells WHERE id=?').get(id);if(!c)return send(res,404,{error:'Ngăn locker không tồn tại'});audit(user,'locker.remote_unlock.requested','cell',id,'Đã ghi nhận yêu cầu; cần gateway IoT để điều khiển khóa vật lý');return send(res,202,{accepted:true,note:'Đã ghi nhận yêu cầu. Chưa có gateway IoT kết nối nên khóa vật lý chưa được điều khiển.'});
 }
 if(method==='POST'&&!id){const b=await parseBody(req),newId=randomUUID(),at=now();
  if(resource==='orders'){
   if(!requireUser(user,res,['SYSTEM_ADMIN','BUILDING_ADMIN','SHIPPER']))return;if(!b.tracking_code||!b.recipient)return send(res,400,{error:'Mã đơn và người nhận là bắt buộc'});
   db.prepare('INSERT INTO orders(id,tracking_code,recipient,phone,apartment,building,carrier,status,amount,resident_id,created_at,updated_at,assigned_shipper_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(newId,b.tracking_code,b.recipient,b.phone||'',b.apartment||'',b.building||'',b.carrier||'','processing',Math.max(0,Number(b.amount)||0),b.resident_id||null,at,at,b.assigned_shipper_id||null);audit(user,'order.created','order',newId,b.tracking_code);return send(res,201,{item:db.prepare('SELECT * FROM orders WHERE id=?').get(newId)});
  }
  if(resource==='stations'){
   if(!requireUser(user,res,adminRoles))return;if(!b.name)return send(res,400,{error:'Tên trạm là bắt buộc'});db.prepare('INSERT INTO stations VALUES(?,?,?,?,?)').run(newId,b.name,b.address||'','online',at);const total=Math.min(300,Math.max(0,Number(b.cell_count)||0));const ins=db.prepare('INSERT INTO cells VALUES(?,?,?,?,?,?)');for(let i=1;i<=total;i++)ins.run(randomUUID(),newId,`A-${String(i).padStart(2,'0')}`,['S','M','L'][i%3],'empty',null);audit(user,'station.created','station',newId,`${total} cells`);return send(res,201,{item:db.prepare('SELECT * FROM stations WHERE id=?').get(newId)});
  }
  if(resource==='users'){
   if(!requireUser(user,res,['SYSTEM_ADMIN']))return;if(!b.name||!b.email||!b.password||String(b.password).length<10||!roles.has(b.role))return send(res,400,{error:'Thông tin tài khoản không hợp lệ; mật khẩu tối thiểu 10 ký tự'});const salt=randomBytes(16).toString('hex');db.prepare('INSERT INTO users(id,name,email,phone,role,building,apartment,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(newId,b.name,String(b.email).toLowerCase(),b.phone||'',b.role,b.building||'',b.apartment||'',`${salt}:${scryptSync(String(b.password),salt,64).toString('hex')}`,at);audit(user,'user.created','user',newId,b.role);return send(res,201,{item:db.prepare('SELECT id,name,email,phone,role,building,apartment,active,created_at FROM users WHERE id=?').get(newId)});
  }
  if(resource==='incidents'){
   if(!requireUser(user,res,['SYSTEM_ADMIN','BUILDING_ADMIN','SHIPPER','RESIDENT']))return;if(!b.title)return send(res,400,{error:'Mô tả sự cố là bắt buộc'});db.prepare('INSERT INTO incidents VALUES(?,?,?,?,?,?,?,?,?,?)').run(newId,b.title,b.description||'',b.station_id||null,b.cell_id||null,user.id,b.priority||'normal','open',at,at);audit(user,'incident.created','incident',newId,b.title);return send(res,201,{item:db.prepare('SELECT * FROM incidents WHERE id=?').get(newId)});
  }
  if(resource==='payments'){
   if(!requireUser(user,res,['SYSTEM_ADMIN','BUILDING_ADMIN']))return;if(!b.order_id||Number(b.amount)<=0)return send(res,400,{error:'Đơn hàng và số tiền hợp lệ là bắt buộc'});db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?)').run(newId,b.order_id,Number(b.amount),b.provider||'unconfigured','pending','',at,at);audit(user,'payment.intent.created','payment',newId,'pending; chưa kết nối payment gateway');return send(res,201,{item:db.prepare('SELECT * FROM payments WHERE id=?').get(newId),note:'Payment intent được tạo; cần cấu hình cổng thanh toán để thu tiền thật.'});
  }
  if(resource==='integrations'){
   if(!requireUser(user,res,['SYSTEM_ADMIN']))return;if(!b.name||!b.kind)return send(res,400,{error:'Tên và loại tích hợp là bắt buộc'});db.prepare('INSERT INTO integrations VALUES(?,?,?,?,?,?)').run(newId,b.name,b.kind,b.endpoint||'',0,at);audit(user,'integration.created','integration',newId,'Đang tắt đến khi cấu hình credentials');return send(res,201,{item:db.prepare('SELECT * FROM integrations WHERE id=?').get(newId)});
  }
  return send(res,405,{error:'Không hỗ trợ tạo loại dữ liệu này'});
 }
 if(method==='PATCH'&&id){const b=await parseBody(req);let entity=resource.slice(0,-1);if(resource==='audit')return send(res,405,{error:'Audit log chỉ đọc'});if(['orders','stations','cells','incidents','payments','users','integrations'].includes(resource)){
  const row=db.prepare(`SELECT * FROM ${tables[resource]} WHERE id=?`).get(id);if(!row)return send(res,404,{error:'Không tìm thấy dữ liệu'});
  if(resource==='orders'){if(!requireUser(user,res,adminRoles))return;if(!['processing','in_transit','overdue','returned','cancelled'].includes(b.status||''))return send(res,400,{error:'Trạng thái không hợp lệ'});db.prepare('UPDATE orders SET status=?,updated_at=? WHERE id=?').run(b.status,now(),id);}
  else if(resource==='incidents'){if(!requireUser(user,res,adminRoles))return;if(!['open','in_progress','resolved'].includes(b.status||''))return send(res,400,{error:'Trạng thái không hợp lệ'});db.prepare('UPDATE incidents SET status=?,updated_at=? WHERE id=?').run(b.status,now(),id);}
  else if(resource==='stations'){if(!requireUser(user,res,adminRoles))return;db.prepare('UPDATE stations SET name=COALESCE(?,name),address=COALESCE(?,address),status=COALESCE(?,status) WHERE id=?').run(b.name??null,b.address??null,b.status??null,id);}
  else if(resource==='cells'){if(!requireUser(user,res,adminRoles))return;if(!['empty','maintenance','offline'].includes(b.status||''))return send(res,400,{error:'Trạng thái ngăn không hợp lệ'});if(row.order_id&&b.status==='empty')return send(res,409,{error:'Ngăn đang chứa đơn. Hãy hoàn tất giao nhận/thu hồi trước'});db.prepare('UPDATE cells SET status=? WHERE id=?').run(b.status,id);}
  else if(resource==='users'){if(!requireUser(user,res,['SYSTEM_ADMIN']))return;if(id===user.id&&b.active===false)return send(res,400,{error:'Không thể tự vô hiệu hóa tài khoản đang dùng'});db.prepare('UPDATE users SET active=COALESCE(?,active),role=COALESCE(?,role),building=COALESCE(?,building) WHERE id=?').run(b.active===false?0:b.active===true?1:null,b.role||null,b.building??null,id);}
  else if(resource==='integrations'){if(!requireUser(user,res,['SYSTEM_ADMIN']))return;db.prepare('UPDATE integrations SET enabled=? WHERE id=?').run(b.enabled?1:0,id);}
  else return send(res,405,{error:'Không hỗ trợ cập nhật loại dữ liệu này'});
  audit(user,`${entity}.updated`,entity,id,JSON.stringify(b));return send(res,200,{item:db.prepare(`SELECT * FROM ${tables[resource]} WHERE id=?`).get(id)});
 }}
 if(method==='DELETE'&&id){if(!requireUser(user,res,['SYSTEM_ADMIN']))return;const existed=db.prepare(`SELECT id FROM ${tables[resource]} WHERE id=?`).get(id);if(!existed)return send(res,404,{error:'Không tìm thấy dữ liệu'});if(resource==='orders'){const o=db.prepare('SELECT cell_id FROM orders WHERE id=?').get(id);db.prepare('UPDATE cells SET status=\'empty\',order_id=NULL WHERE id=?').run(o.cell_id);}db.prepare(`DELETE FROM ${tables[resource]} WHERE id=?`).run(id);audit(user,`${resource}.deleted`,resource,id,'');return send(res,200,{ok:true});}
 return send(res,405,{error:'Phương thức không được hỗ trợ'});
}

const server=http.createServer((req,res)=>{route(req,res).catch(err=>{console.error(err);if(!res.headersSent)send(res,500,{error:'Lỗi máy chủ',detail:process.env.NODE_ENV==='development'?err.message:undefined});});});
const port=Number(process.env.PORT)||4173;const host=process.env.HOST||'127.0.0.1';server.listen(port,host,()=>console.log(`VELOBOX đang chạy tại http://${host}:${port}`));
process.on('SIGINT',()=>{server.close(()=>{db.close();process.exit(0);});});
