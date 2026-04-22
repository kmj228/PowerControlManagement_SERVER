const net    = require('net');
const mysql  = require('mysql2/promise');
const os     = require('os');
const { execSync } = require('child_process');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const HTTP_PORT_DEFAULT = 3000;
const TCP_PORT_DEFAULT  = 5002;

const IS_PKG   = typeof process.pkg !== 'undefined';
const DATA_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;

const DEVICES_FILE = path.join(DATA_DIR, 'data', 'devices.json');
const USERS_FILE   = path.join(DATA_DIR, 'data', 'users.json');
const CONFIG_FILE  = path.join(DATA_DIR, 'data', 'config.json');
const LOG_DIR      = path.join(DATA_DIR, 'data', 'log');
const CERT_FILE    = path.join(DATA_DIR, 'data', 'cert.pem');
const KEY_FILE     = path.join(DATA_DIR, 'data', 'key.pem');
const TIMEOUT_MS        = 13 * 1000; // STATUS 10초 주기 + 여유 3초
const STATUS_INTERVAL_MS = 10 * 1000; // 장비 STATUS 전송 주기
const MAX_TIMEOUT_COUNT  = 3;         // 연속 타임아웃 허용 횟수
const SESSION_EXPIRE_MS  = 24 * 60 * 60 * 1000; // 세션 유효 시간 (24시간)
const BULK_CMD_DELAY_MS  = 80;        // 일괄 명령 채널 간 딜레이
const PENDING_TIMEOUT_MS = 30 * 1000; // 채널 명령 응답 대기 시간
const LOG_QUERY_LIMIT    = 200;       // 로그 조회 최대 건수
const WS_CLOSE_DELAY_MS  = 500;      // 서버 종료 전 응답 전송 대기
const DB_CONFIG_FILE = path.join(DATA_DIR !== __dirname ? DATA_DIR : path.dirname(process.execPath || __dirname), 'data', 'db.json');
const LOG_KEEP_DAYS = 5;

// ── 정적 파일 메모리 캐시
const STATIC_FILES = {};
['index.html', 'app.js', 'logo_ci.png'].forEach(name => {
  try {
    STATIC_FILES[name] = fs.readFileSync(path.join(__dirname, name));
    console.log('[정적파일] 로드: ' + name);
  } catch(e) {
    console.error('[정적파일] 로드 실패: ' + name, e.message);
  }
});

// ── 데이터 폴더 초기화
if (!fs.existsSync(path.join(DATA_DIR, 'data'))) fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
if (!fs.existsSync(DEVICES_FILE)) fs.writeFileSync(DEVICES_FILE, '[]', 'utf8');


// ──────────────────────────────────────────
// 사용자 관리
// ──────────────────────────────────────────
let usersCache = null;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  try { return crypto.scryptSync(password, salt, 64).toString('hex') === hash; } catch { return false; }
}

function loadUsers() {
  if (usersCache) return usersCache;
  try {
    if (fs.existsSync(USERS_FILE)) {
      usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      return usersCache;
    }
  } catch(e) {}
  // 기본 admin 계정 자동 생성
  const { hash, salt } = hashPassword('admin1234');
  usersCache = [{ username: 'admin', passwordHash: hash, salt, role: 'admin', createdAt: new Date().toISOString() }];
  saveUsers();
  console.log('');
  console.log('─────────────────────────────────────────');
  console.log('  기본 admin 계정이 생성되었습니다.');
  console.log('  아이디: admin  /  비밀번호: admin1234');
  console.log('  보안을 위해 로그인 후 변경해 주세요.');
  console.log('─────────────────────────────────────────');
  console.log('');
  return usersCache;
}
function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(usersCache, null, 2), 'utf8'); } catch(e) {}
}

// ──────────────────────────────────────────
// 세션 관리
// ──────────────────────────────────────────
const sessions = new Map(); // token → { username, role, createdAt }

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, role, createdAt: Date.now() });
  return token;
}
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([a-f0-9]{64})/);
  if (!match) return null;
  const sess = sessions.get(match[1]);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_EXPIRE_MS) { sessions.delete(match[1]); return null; }
  return sess;
}
function requireAuth(req, res) {
  const sess = getSession(req);
  if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'로그인이 필요합니다.'})); return null; }
  return sess;
}
function requireAdmin(req, res) {
  const sess = requireAuth(req, res);
  if (!sess) return null;
  if (sess.role !== 'admin') { res.writeHead(403,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'관리자 권한이 필요합니다.'})); return null; }
  return sess;
}

// ──────────────────────────────────────────
// 장비 목록
// ──────────────────────────────────────────
let devicesCache = null;

function getDevices() {
  if (devicesCache !== null) return devicesCache;
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      devicesCache = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      return devicesCache;
    }
  } catch(e) {}
  devicesCache = [];
  return devicesCache;
}
function persistDevices() {
  try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(devicesCache, null, 2), 'utf8'); }
  catch(e) { console.error('[저장 오류]', e.message); }
}

getDevices();
loadUsers();

// ──────────────────────────────────────────
// DB 연결
// ──────────────────────────────────────────
let dbPool = null;

function loadDbConfig() {
  const cfgFile = path.join(DATA_DIR, 'data', 'db.json');
  const defaults = { host:'localhost', port:3306, user:'root', password:'', database:'device_manager' };
  if (!fs.existsSync(cfgFile)) {
    fs.writeFileSync(cfgFile, JSON.stringify(defaults, null, 2), 'utf8');
    console.log('');
    console.log('─────────────────────────────────────────────────');
    console.log('  DB 설정 파일이 생성되었습니다.');
    console.log('  data/db.json 을 열어 DB 접속 정보를 입력하세요.');
    console.log('─────────────────────────────────────────────────');
    console.log('');
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    return { ...defaults, ...cfg };
  } catch(e) {
    console.error('[DB] db.json 파싱 오류:', e.message);
    return defaults;
  }
}

async function initDB() {
  const cfg = loadDbConfig();
  try {
    dbPool = mysql.createPool({
      host:     cfg.host     || 'localhost',
      port:     cfg.port     || 3306,
      user:     cfg.user     || 'root',
      password: cfg.password || '',
      database: cfg.database || 'device_manager',
      waitForConnections: true,
      connectionLimit: 10,
      timezone: '+09:00'
    });
    // 테이블 자동 생성
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS logs (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        time       DATETIME     NOT NULL,
        deviceId   VARCHAR(10)  NOT NULL,
        location   VARCHAR(100),
        dir        VARCHAR(20)  NOT NULL,
        cmdType    VARCHAR(20)  NOT NULL,
        summary    TEXT,
        user       VARCHAR(50),
        raw        VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_time     (time),
        INDEX idx_deviceId (deviceId),
        INDEX idx_dir      (dir),
        INDEX idx_user     (user)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // raw 컬럼 없으면 추가 (기존 테이블 업그레이드)
    try {
      await dbPool.execute('ALTER TABLE logs ADD COLUMN raw VARCHAR(100) AFTER user');
    } catch(e) { /* 이미 있으면 무시 */ }
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS login_failures (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        time       DATETIME     NOT NULL,
        username   VARCHAR(50)  NOT NULL,
        ip         VARCHAR(45)  NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_time     (time),
        INDEX idx_ip       (ip),
        INDEX idx_username (username)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[DB] MariaDB 연결 성공 (' + cfg.host + ':' + (cfg.port||3306) + '/' + cfg.database + ')');
    return true;
  } catch(e) {
    console.error('[DB] 연결 실패:', e.message);
    console.error('[DB] data/db.json 의 접속 정보를 확인해 주세요.');
    dbPool = null;
    return false;
  }
}

// ──────────────────────────────────────────
// 로그
// ──────────────────────────────────────────
function logEntry(dir, deviceId, cmdType, summary, user, raw) {
  const n = new Date();
  const p = v => String(v).padStart(2,'0');
  const entry = { time: p(n.getMonth()+1)+'/'+p(n.getDate())+' '+p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds()), deviceId, dir, cmdType, summary };
  if (user) entry.user = user;
  if (raw)  entry.raw  = raw;
  return entry;
}

function appendLog(entry) {
  if (!dbPool) return;
  const dev = (devicesCache || []).find(d => d.deviceId === entry.deviceId);
  const location = dev ? (dev.locationName || '') : '';
  const now = new Date();
  dbPool.execute(
    'INSERT INTO logs (time, deviceId, location, dir, cmdType, summary, user, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [now, entry.deviceId, location, entry.dir, entry.cmdType, entry.summary || '', entry.user || null, entry.raw || null]
  ).catch(e => console.error('[DB] 로그 저장 오류:', e.message));
}

// ──────────────────────────────────────────
// Config
// ──────────────────────────────────────────
function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch(e) {}
  return { tcpPort: TCP_PORT_DEFAULT };
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }

let TCP_PORT = loadConfig().tcpPort || TCP_PORT_DEFAULT;

function ts() { const n=new Date(),p=v=>String(v).padStart(2,'0'); return p(n.getHours())+':'+p(n.getMinutes())+':'+p(n.getSeconds()); }
function clog(dir, id, type, detail) { console.log('['+ts()+'] '+dir.padEnd(7)+' | '+id+' | '+type+(detail?' | '+detail:'')); }

// ──────────────────────────────────────────
// 패킷
// ──────────────────────────────────────────
let seqNum = 0x00;
function buildPacket(deviceId, ch, cmd) {
  const id = Buffer.from(deviceId, 'hex');
  const base = Buffer.from([0x23,0xDC,id[0],id[1],id[2],0x0A,0x00,0x00,0xC6,ch,cmd,0x02,0xFF,0xFF,0xFF,0xFF,0xFF]);
  let xor = 0;
  for (let i = 2; i < base.length; i++) xor ^= base[i];
  const seq = seqNum++ & 0xFF;
  return Buffer.concat([base, Buffer.from([seq, (xor ^ seq)])]);
}
function parsePacket(buf) {
  if (buf.length < 19 || buf[0] !== 0x23 || buf[1] !== 0xDC) return null;
  const deviceId = buf.slice(2,5).toString('hex').toUpperCase();
  const cmd = buf[8];
  if (cmd === 0xA6) return { type:'STATUS', deviceId, channels:[buf[9],buf[10],buf[11],buf[12]], currents:[buf[13],buf[14],buf[15],buf[16]] };
  if (cmd === 0x22) return { type:'ACK', deviceId };
  if (cmd === 0xA0) return { type:'FWVER', deviceId, fwVer:buf[9]+'.'+buf[10]+'.'+buf[11] };
  return null;
}
function calcLinkState(lastUpdate) {
  if (!lastUpdate) return 'never';
  return (Date.now() - new Date(lastUpdate).getTime()) <= TIMEOUT_MS ? 'ok' : 'timeout';
}

// ──────────────────────────────────────────
// TCP 서버
// ──────────────────────────────────────────
const tcpClients = new Map();
const timeoutTimers = new Map();
const timeoutCounts = new Map();
let tcpServerInstance = null;

function handleConnection(socket) {
  const ip = socket.remoteAddress.replace('::ffff:', '');
  const remote = ip + ':' + socket.remotePort;
  let deviceId = null;
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 19) {
      const packet = buf.slice(0, 19); buf = buf.slice(19);
      const parsed = parsePacket(packet);
      if (!parsed) continue;
      const raw = packet.toString('hex').toUpperCase();
      if (!deviceId) {
        deviceId = parsed.deviceId;
        // 같은 장치ID로 이미 연결된 소켓이 있으면 즉시 해제 처리
        const existingSocket = tcpClients.get(deviceId);
        if (existingSocket && existingSocket !== socket) {
          clog('재연결', deviceId, '이전 연결 해제 처리');
          clearTimeoutTimer(deviceId);
          broadcastToWeb({ type:'DISCONNECTED', deviceId });
          appendLog(logEntry('disconnect', deviceId, 'DISCONNECTED', '연결 해제 (재연결 감지)'));
          existingSocket.removeAllListeners();
          try { existingSocket.destroy(); } catch(e) {}
        }
        tcpClients.set(deviceId, socket);
        clog('연결', deviceId, remote);
        broadcastToWeb({ type:'CONNECT', deviceId });
        appendLog(logEntry('connect', deviceId, 'CONNECT', '연결됨 (' + ip + ')'));
        const dev = getDevices().find(d => d.deviceId === deviceId);
        if (dev) { dev.ip = ip; persistDevices(); }
      }
      if (parsed.type === 'STATUS') {
        const now = new Date().toISOString();
        const chStr = parsed.channels.map((v,i) => 'CH'+(i+1)+':'+(v===1?'ON':v===0?'OFF':'?')).join(' ');
        clog('← 상태', deviceId, chStr, raw);
        const dev = getDevices().find(d => d.deviceId === deviceId);
        if (dev) { dev.channels=parsed.channels; dev.currents=parsed.currents; dev.lastUpdate=now; dev.ip=ip; persistDevices(); }
        timeoutCounts.set(deviceId, 0);
        resetTimeoutTimer(deviceId);
        broadcastToWeb({ type:'STATUS', deviceId, channels:parsed.channels, currents:parsed.currents, lastUpdate:now, linkState:'ok', raw });
        appendLog(logEntry('status', deviceId, 'STATUS', chStr, null, raw));
      } else if (parsed.type === 'ACK') {
        clog('← ACK', deviceId, raw);
        broadcastToWeb({ type:'ACK', deviceId, raw });
        appendLog(logEntry('ack', deviceId, 'ACK', 'ACK 수신', null, raw));
      } else if (parsed.type === 'FWVER') {
        clog('← 펌웨어', deviceId, 'v' + parsed.fwVer);
        const dev = getDevices().find(d => d.deviceId === deviceId);
        if (dev) { dev.fwVer=parsed.fwVer; persistDevices(); }
        broadcastToWeb({ type:'FWVER', deviceId, fwVer:parsed.fwVer, raw });
      }
    }
  });
  socket.on('close', () => {
    if (deviceId && !socket._handled) {
      clog('해제', deviceId, remote);
      tcpClients.delete(deviceId); clearTimeoutTimer(deviceId); timeoutCounts.delete(deviceId);
      broadcastToWeb({ type:'DISCONNECTED', deviceId });
      appendLog(logEntry('disconnect', deviceId, 'DISCONNECTED', '연결 해제'));
    }
  });
  socket.on('error', err => { if (deviceId) clog('오류', deviceId, err.message); });
}

function resetTimeoutTimer(deviceId) {
  clearTimeoutTimer(deviceId);
  const t = setTimeout(() => {
    const count = (timeoutCounts.get(deviceId) || 0) + 1;
    timeoutCounts.set(deviceId, count);
    if (count > MAX_TIMEOUT_COUNT) {
      clog('해제', deviceId, `타임아웃 ${MAX_TIMEOUT_COUNT}회로 연결 해제`);
      timeoutCounts.delete(deviceId);
      clearTimeoutTimer(deviceId);
      broadcastToWeb({ type:'DISCONNECTED', deviceId });
      appendLog(logEntry('disconnect', deviceId, 'DISCONNECTED', `연결 해제 (타임아웃 ${MAX_TIMEOUT_COUNT}회)`));
      // 소켓 참조 저장 후 삭제 → close 이벤트에서 중복 처리 방지
      const sock = tcpClients.get(deviceId);
      tcpClients.delete(deviceId);
      if (sock) {
        sock._handled = true;
        try { sock.destroy(); } catch(e) {}
      }
    } else {
      clog('타임아웃', deviceId, `${count}회 연속`);
      broadcastToWeb({ type:'TIMEOUT', deviceId, count });
      appendLog(logEntry('timeout', deviceId, 'TIMEOUT', `응답 없음 (${count}회 연속)`));
      // 다음 타임아웃 대기
      resetTimeoutTimer(deviceId);
    }
  }, TIMEOUT_MS);
  timeoutTimers.set(deviceId, t);
}
function clearTimeoutTimer(deviceId) {
  if (timeoutTimers.has(deviceId)) { clearTimeout(timeoutTimers.get(deviceId)); timeoutTimers.delete(deviceId); }
}

function startTCPServer(port) {
  const srv = net.createServer(handleConnection);
  srv.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error('[TCP 오류] 포트 ' + port + ' 가 이미 사용 중입니다.');
    else console.error('[TCP 오류] ' + e.message);
  });
  srv.listen(port, () => { TCP_PORT = port; tcpServerInstance = srv; console.log('[서버 시작] TCP  :' + port); });
}
function restartTCPServer(newPort, cb) {
  for (const [id, sock] of tcpClients.entries()) { clearTimeoutTimer(id); tcpClients.delete(id); try { sock.destroy(); } catch(e) {} }
  broadcastToWeb({ type:'TCP_PORT_CHANGE', port: newPort });
  const finish = () => { saveConfig({ ...loadConfig(), tcpPort: newPort }); startTCPServer(newPort); if (cb) cb(); };
  if (tcpServerInstance) { tcpServerInstance.close(finish); tcpServerInstance = null; } else finish();
}

// ──────────────────────────────────────────
// WebSocket
// ──────────────────────────────────────────
const wsClients = new Set();

function wsHandshake(req, socket) {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}
function wsDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const masked = (buf[1]&0x80) !== 0;
  let len = buf[1]&0x7F, offset = 2;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  if (buf.length < offset + (masked?4:0) + len) return null;
  let data;
  if (masked) { const mask = buf.slice(offset, offset+4); offset += 4; data = Buffer.alloc(len); for (let i = 0; i < len; i++) data[i] = buf[offset+i] ^ mask[i%4]; }
  else { data = buf.slice(offset, offset+len); }
  return data.toString('utf8');
}
function wsEncodeFrame(msg) {
  const data = Buffer.from(msg,'utf8'), len = data.length;
  const h = len < 126 ? Buffer.from([0x81,len]) : (() => { const h=Buffer.alloc(4); h[0]=0x81; h[1]=126; h.writeUInt16BE(len,2); return h; })();
  return Buffer.concat([h, data]);
}
function broadcastToWeb(obj) {
  const frame = wsEncodeFrame(JSON.stringify(obj));
  for (const s of wsClients) { try { s.write(frame); } catch(e) {} }
}
function broadcastToUser(username, obj) {
  const frame = wsEncodeFrame(JSON.stringify(obj));
  for (const s of wsClients) {
    if (s._username === username) { try { s.write(frame); } catch(e) {} }
  }
}

// ──────────────────────────────────────────
// HTTP 요청 핸들러
// ──────────────────────────────────────────
async function requestHandler(req, res) {
  const { url, method } = req;

  // ── 공개 엔드포인트 (인증 불필요)
  if (url === '/api/login' && method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { username, password } = JSON.parse(body);
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        const clientIp = ip.replace('::ffff:', '');
        const users = loadUsers();
        const user = users.find(u => u.username === username);
        if (!user || !verifyPassword(password, user.passwordHash, user.salt)) {
          // 로그인 실패 횟수 확인 (최근 10분 내)
          if (dbPool && username) {
            try {
              const [[{ cnt }]] = await dbPool.execute(
                'SELECT COUNT(*) as cnt FROM login_failures WHERE username = ? AND time > DATE_SUB(NOW(), INTERVAL 10 MINUTE)',
                [username]
              );
              if (cnt >= 4) { // 5번째 실패
                await dbPool.execute(
                  'INSERT INTO login_failures (time, username, ip) VALUES (NOW(), ?, ?)',
                  [username, clientIp]
                );
                clog('로그인실패', username, clientIp, `누적 ${cnt+1}회`);
              } else {
                await dbPool.execute(
                  'INSERT INTO login_failures (time, username, ip) VALUES (NOW(), ?, ?)',
                  [username, clientIp]
                );
              }
            } catch(e) {}
          }
          res.writeHead(401,{'Content-Type':'application/json'});
          return res.end(JSON.stringify({error:'아이디 또는 비밀번호가 올바르지 않습니다.'}));
        }
        // 중복 로그인 방지: 기존 세션 만료
        for (const [token, s] of sessions.entries()) {
          if (s.username === username) {
            sessions.delete(token);
            // 기존 접속자에게 강제 로그아웃 신호
            broadcastToUser(username, { type:'FORCE_LOGOUT', reason:'다른 곳에서 로그인해서 연결이 끊겼어요.' });
          }
        }
        const token = createSession(username, user.role);
        clog('로그인', username, user.role, clientIp);
        res.writeHead(200, {'Content-Type':'application/json', 'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`});
        res.end(JSON.stringify({ok:true, username, role:user.role}));
      } catch(e) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'잘못된 요청입니다.'})); }
    }); return;
  }

  if (url === '/api/logout' && method === 'POST') {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/session=([a-f0-9]{64})/);
    if (match) sessions.delete(match[1]);
    res.writeHead(200, {'Content-Type':'application/json', 'Set-Cookie':'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    return res.end(JSON.stringify({ok:true}));
  }

  if (url === '/api/me' && method === 'GET') {
    const sess = getSession(req);
    if (!sess) { res.writeHead(401,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'로그인이 필요합니다.'})); }
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({username:sess.username, role:sess.role}));
  }

  // ── DB 설정 API
  if (url === '/api/db-config' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const cfg = loadDbConfig();
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({
      host:     cfg.host     || 'localhost',
      port:     cfg.port     || 3306,
      user:     cfg.user     || 'root',
      password: cfg.password ? '••••••' : '',
      database: cfg.database || 'device_manager',
      connected: !!dbPool
    }));
  }
  if (url === '/api/db-config' && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { host, port, user, password, database } = JSON.parse(body);
        const cfgFile = path.join(DATA_DIR, 'data', 'db.json');
        const existing = loadDbConfig();
        const newCfg = {
          host:     host     || existing.host,
          port:     parseInt(port) || existing.port,
          user:     user     || existing.user,
          // '••••••' 그대로면 기존 비밀번호 유지
          password: password === '••••••' ? existing.password : (password ?? ''),
          database: database || existing.database
        };
        fs.writeFileSync(cfgFile, JSON.stringify(newCfg, null, 2), 'utf8');
        // 기존 풀 종료
        if (dbPool) { try { await dbPool.end(); } catch(e) {} dbPool = null; }
        // 재연결 시도
        const ok = await initDB();
        broadcastToWeb({ type: 'DB_STATUS', connected: !!dbPool });
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok, connected: !!dbPool }));
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    }); return;
  }
  if (url === '/api/db-status' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ connected: !!dbPool }));
  }

  // ── 장비 API
  if (url === '/api/devices' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    const list = getDevices().map(d => ({ ...d, linkState: calcLinkState(d.lastUpdate) }));
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(list));
  }
  if (url === '/api/devices' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => body+=c);
    req.on('end', () => {
      const { deviceId, ip, locationName, address } = JSON.parse(body);
      if (!deviceId) { res.writeHead(400); return res.end(JSON.stringify({error:'Device ID를 입력해 주세요.'})); }
      const devs = getDevices();
      if (devs.find(d => d.deviceId===deviceId.toUpperCase())) { res.writeHead(409); return res.end(JSON.stringify({error:'이미 존재하는 Device ID 입니다.'})); }
      const newDev = { deviceId:deviceId.toUpperCase(), ip:ip||'', locationName:locationName||'', address:address||'', channels:[-1,-1,-1,-1], currents:[0,0,0,0], fwVer:'', lastUpdate:'', linkState:'never' };
      devs.push(newDev);
      persistDevices();
      broadcastToWeb({ type:'DEVICE_ADDED', device: newDev });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    }); return;
  }
  if (url === '/api/devices/reorder' && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => body+=c);
    req.on('end', () => {
      const { order } = JSON.parse(body);
      const devs = getDevices();
      const map = new Map(devs.map(d => [d.deviceId, d]));
      const reordered = order.map(id => map.get(id)).filter(Boolean);
      devs.forEach(d => { if (!order.includes(d.deviceId)) reordered.push(d); });
      devicesCache = reordered; persistDevices();
      broadcastToWeb({ type:'DEVICE_REORDERED', order: reordered.map(d => d.deviceId) });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    }); return;
  }
  if (url.startsWith('/api/devices/') && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    const oldId = decodeURIComponent(url.split('/')[3]);
    let body = ''; req.on('data', c => body+=c);
    req.on('end', () => {
      const update = JSON.parse(body);
      const devs = getDevices();
      const idx = devs.findIndex(d => d.deviceId===oldId);
      if (idx===-1) { res.writeHead(404); return res.end('{}'); }
      if (update.deviceId && update.deviceId !== oldId) {
        const newId = update.deviceId.toUpperCase();
        if (devs.find(d => d.deviceId===newId)) { res.writeHead(409); return res.end(JSON.stringify({error:'이미 존재하는 Device ID 입니다.'})); }
        update.deviceId = newId;
        const wasConnected = tcpClients.has(oldId);
        tcpClients.delete(oldId); clearTimeoutTimer(oldId);
        setTimeout(() => broadcastToWeb({ type:'ID_CHANGED', oldId, newId, wasConnected }), 100);
      }
      devs[idx] = { ...devs[idx], ...update }; persistDevices();
      broadcastToWeb({ type:'DEVICE_UPDATED', device: devs[idx] });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    }); return;
  }
  if (url.startsWith('/api/devices/') && method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(url.split('/')[3]);
    devicesCache = getDevices().filter(d => d.deviceId!==id); persistDevices();
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true}));
  }

  // ── Config API
  if (url === '/api/config' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ tcpPort: TCP_PORT }));
  }
  if (url === '/api/config' && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => body+=c);
    req.on('end', () => {
      const { tcpPort } = JSON.parse(body);
      const port = parseInt(tcpPort);
      if (!port || port < 1 || port > 65535) { res.writeHead(400); return res.end(JSON.stringify({error:'유효하지 않은 포트 번호입니다.'})); }
      restartTCPServer(port, () => { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, port})); });
    }); return;
  }

  // ── 로그 API
  if (url.startsWith('/api/logs') && method === 'GET' && url !== '/api/logs/export.csv') {
    if (!requireAuth(req, res)) return;
    if (!dbPool) { res.writeHead(503,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'DB 연결이 없습니다.'})); }
    try {
      const qs = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
      const page     = Math.max(1, parseInt(qs.get('page') || '1'));
      const limit    = Math.min(200, Math.max(1, parseInt(qs.get('limit') || '100')));
      const offset   = (page - 1) * limit;
      const deviceId = qs.get('deviceId') || '';
      const dir      = qs.get('dir') || '';
      const user     = qs.get('user') || '';
      const keyword  = qs.get('keyword') || '';
      const dateFrom = qs.get('dateFrom') || '';
      const dateTo   = qs.get('dateTo') || '';

      const where = []; const params = [];
      if (deviceId) { where.push('deviceId = ?'); params.push(deviceId); }
      if (dir)      { where.push('dir = ?');      params.push(dir); }
      if (user)     { where.push('user = ?');      params.push(user); }
      if (keyword)  { where.push('(summary LIKE ? OR location LIKE ?)'); params.push('%'+keyword+'%','%'+keyword+'%'); }
      if (dateFrom) { where.push('time >= ?'); params.push(dateFrom + ' 00:00:00'); }
      if (dateTo)   { where.push('time <= ?'); params.push(dateTo   + ' 23:59:59'); }

      const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [[{ total }]] = await dbPool.execute('SELECT COUNT(*) as total FROM logs ' + whereStr, params);
      const [rows] = await dbPool.execute(
        'SELECT id, DATE_FORMAT(time, "%m/%d %H:%i:%s") as time, deviceId, location, dir, cmdType, summary, user, raw FROM logs ' + whereStr + ' ORDER BY time DESC LIMIT ? OFFSET ?',
        [...params, limit, offset]
      );
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({ total, page, limit, rows }));
    } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:e.message})); }
  }
  if (url === '/api/logs/all' && method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    if (!dbPool) { res.writeHead(503,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'DB 연결이 없습니다.'})); }
    try {
      const [[{ total }]] = await dbPool.execute('SELECT COUNT(*) as total FROM logs');
      await dbPool.execute('TRUNCATE TABLE logs');
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, deleted:total}));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:'삭제 실패'})); }
    return;
  }
  if (url === '/api/logs/export.csv' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    if (!dbPool) { res.writeHead(503); return res.end('DB 연결 없음'); }
    try {
      const qs = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '');
      const deviceId = qs.get('deviceId') || '';
      const dir      = qs.get('dir')      || '';
      const user     = qs.get('user')     || '';
      const keyword  = qs.get('keyword')  || '';
      const dateFrom = qs.get('dateFrom') || '';
      const dateTo   = qs.get('dateTo')   || '';
      const where = []; const params = [];
      if (deviceId) { where.push('deviceId = ?'); params.push(deviceId); }
      if (dir)      { where.push('dir = ?');      params.push(dir); }
      if (user)     { where.push('user = ?');      params.push(user); }
      if (keyword)  { where.push('(summary LIKE ? OR location LIKE ?)'); params.push('%'+keyword+'%','%'+keyword+'%'); }
      if (dateFrom) { where.push('time >= ?'); params.push(dateFrom + ' 00:00:00'); }
      if (dateTo)   { where.push('time <= ?'); params.push(dateTo   + ' 23:59:59'); }
      const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [rows] = await dbPool.execute(
        'SELECT DATE_FORMAT(time,"%Y-%m-%d %H:%i:%s") as time, deviceId, location, dir, cmdType, summary, user, raw FROM logs ' + whereStr + ' ORDER BY time DESC',
        params
      );
      const esc = v => '"' + String(v||'').replace(/"/g,'""') + '"';
      const header = '시각,장비ID,위치명,방향,유형,요약,사용자';
      const csvRows = rows.map(e => [e.time,e.deviceId,e.location||'',e.dir,e.cmdType,e.summary||'',e.user||''].map(esc).join(','));
      const today = new Date().toISOString().slice(0,10);
      res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="log_export_'+today+'.csv"'});
      res.end('\uFEFF'+header+'\n'+csvRows.join('\n'));
    } catch(e) { res.writeHead(500); res.end('export failed'); }
    return;
  }

  // ── 제어 API
  if (url === '/api/control' && method === 'POST') {
    const sess = requireAuth(req, res);
    if (!sess) return;
    let body = ''; req.on('data', c => body+=c);
    req.on('end', () => {
      const { deviceId, ch, cmd } = JSON.parse(body);
      const cmdMap = { ON:0x01, OFF:0x00, RESET:0x02 };
      const sock = tcpClients.get(deviceId.toUpperCase());
      if (!sock) { res.writeHead(404,{'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'장비가 연결되어 있지 않습니다.'})); }
      const packet = buildPacket(deviceId.toUpperCase(), parseInt(ch), cmdMap[cmd]);
      sock.write(packet);
      const raw = packet.toString('hex').toUpperCase();
      clog('→ 명령', deviceId, 'CH'+(parseInt(ch)+1)+' '+cmd+' ('+sess.username+')', raw);
      appendLog(logEntry('send', deviceId, cmd, 'CH'+(parseInt(ch)+1)+' → '+cmd, sess.username, raw));
      broadcastToWeb({ type:'SEND', deviceId:deviceId.toUpperCase(), ch:parseInt(ch), cmd, user:sess.username, raw });
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true, raw}));
    }); return;
  }

  // ── 백업
  if (url === '/api/backup' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    try {
      const devicesData = fs.existsSync(DEVICES_FILE) ? JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')) : [];
      const configData  = fs.existsSync(CONFIG_FILE)  ? JSON.parse(fs.readFileSync(CONFIG_FILE,  'utf8')) : {};
      const backup = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), devices: devicesData, config: configData }, null, 2);
      const today = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="backup_${today}.json"`
      });
      return res.end(backup);
    } catch(e) {
      res.writeHead(500, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:'백업 파일을 만들지 못했어요.'}));
    }
  }

  // ── 복원
  if (url === '/api/restore' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (data.version !== 1) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'지원하지 않는 백업 버전이에요.'})); }
        if (!Array.isArray(data.devices)) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'devices 필드가 올바르지 않아요.'})); }
        if (typeof data.config !== 'object' || data.config === null) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'config 필드가 올바르지 않아요.'})); }
        fs.writeFileSync(DEVICES_FILE, JSON.stringify(data.devices, null, 2), 'utf8');
        fs.writeFileSync(CONFIG_FILE,  JSON.stringify(data.config,  null, 2), 'utf8');
        devicesCache = data.devices;
        TCP_PORT = data.config.tcpPort || TCP_PORT_DEFAULT;
        broadcastToWeb({ type: 'RESTORE_DONE' });
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({ok:true}));
      } catch(e) {
        res.writeHead(400, {'Content-Type':'application/json'});
        return res.end(JSON.stringify({error:'복원 파일을 읽지 못했어요. 올바른 백업 파일인지 확인해 주세요.'}));
      }
    }); return;
  }

  // ── 서버 종료
  if (url === '/api/shutdown' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
    console.log('[서버 종료] 브라우저 요청으로 종료');
    try { fs.writeFileSync(path.join(DATA_DIR, 'data', '.shutdown'), '', 'utf8'); } catch(e) {}
    appendServerLog('stop', '서버 종료 (브라우저 요청)');
    setTimeout(() => process.exit(0), WS_CLOSE_DELAY_MS);
    return;
  }

  // ── 사용자 관리 API (admin 전용)
  if (url === '/api/users' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const list = loadUsers().map(({ username, role, createdAt }) => ({ username, role, createdAt }));
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify(list));
  }
  if (url === '/api/users' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { username, password, role } = JSON.parse(body);
        if (!username || !password) { res.writeHead(400); return res.end(JSON.stringify({error:'아이디와 비밀번호를 입력해 주세요.'})); }
        if (username.length < 2 || username.length > 32) { res.writeHead(400); return res.end(JSON.stringify({error:'아이디는 2~32자로 입력해 주세요.'})); }
        if (password.length < 4) { res.writeHead(400); return res.end(JSON.stringify({error:'비밀번호는 4자 이상 입력해 주세요.'})); }
        const users = loadUsers();
        if (users.find(u => u.username === username)) { res.writeHead(409); return res.end(JSON.stringify({error:'이미 존재하는 아이디입니다.'})); }
        const { hash, salt } = hashPassword(password);
        users.push({ username, passwordHash: hash, salt, role: role || 'user', createdAt: new Date().toISOString() });
        saveUsers();
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'잘못된 요청입니다.'})); }
    }); return;
  }
  if (url.startsWith('/api/users/') && method === 'PUT') {
    const sess = requireAdmin(req, res);
    if (!sess) return;
    const targetUser = decodeURIComponent(url.split('/')[3]);
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { password, role } = JSON.parse(body);
        const users = loadUsers();
        const idx = users.findIndex(u => u.username === targetUser);
        if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({error:'사용자를 찾을 수 없습니다.'})); }
        if (role && role !== 'admin' && users[idx].role === 'admin') {
          const adminCount = users.filter(u => u.role === 'admin').length;
          if (adminCount <= 1) { res.writeHead(400); return res.end(JSON.stringify({error:'마지막 관리자의 권한은 변경할 수 없습니다.'})); }
        }
        if (password) {
          if (password.length < 4) { res.writeHead(400); return res.end(JSON.stringify({error:'비밀번호는 4자 이상 입력해 주세요.'})); }
          const { hash, salt } = hashPassword(password);
          users[idx].passwordHash = hash; users[idx].salt = salt;
          // 비밀번호 변경 시 해당 사용자 세션 만료 + 강제 로그아웃
          for (const [token, s] of sessions.entries()) { if (s.username === targetUser) sessions.delete(token); }
          broadcastToUser(targetUser, { type:'FORCE_LOGOUT', reason:'관리자가 비밀번호를 바꿨어요. 다시 로그인해 주세요.' });
        }
        if (role) users[idx].role = role;
        saveUsers();
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:'잘못된 요청입니다.'})); }
    }); return;
  }
  if (url.startsWith('/api/users/') && method === 'DELETE') {
    const sess = requireAdmin(req, res);
    if (!sess) return;
    const targetUser = decodeURIComponent(url.split('/')[3]);
    const users = loadUsers();
    if (targetUser === sess.username) { res.writeHead(400); return res.end(JSON.stringify({error:'자신의 계정은 삭제할 수 없습니다.'})); }
    const target = users.find(u => u.username === targetUser);
    if (target?.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
      res.writeHead(400); return res.end(JSON.stringify({error:'마지막 관리자 계정은 삭제할 수 없습니다.'}));
    }
    usersCache = users.filter(u => u.username !== targetUser); saveUsers();
    for (const [token, s] of sessions.entries()) { if (s.username === targetUser) sessions.delete(token); }
    res.writeHead(200,{'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:true}));
  }

  // ── 인증서 다운로드 (로그인 사용자 누구나)
  if (url === '/api/cert/download' && method === 'GET') {
    if (!requireAuth(req, res)) return;
    try {
      const certData = fs.readFileSync(CERT_FILE);
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="DeviceManager-CA.crt"'
      });
      return res.end(certData);
    } catch(e) {
      res.writeHead(404, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:'인증서 파일을 찾을 수 없습니다.'}));
    }
  }

  // ── 정적 파일
  const mimeMap = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.png':'image/png', '.ico':'image/x-icon' };
  const fileName = url === '/' ? 'index.html' : url.replace(/^\//, '');
  const cached = STATIC_FILES[fileName];
  if (cached) {
    res.writeHead(200, {'Content-Type': mimeMap[path.extname(fileName)] || 'text/plain'});
    return res.end(cached);
  }
  res.writeHead(404); res.end('Not Found');
}

// ──────────────────────────────────────────
// 서버 생성 (HTTPS 우선, 없으면 자동 생성 시도, 마지막엔 HTTP)
// ──────────────────────────────────────────
let httpServer;
let isHttps = false;

// ── ASN.1 DER 인코딩 헬퍼 (순수 Node.js 인증서 생성용)
function asn1Len(len) {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, len >> 8, len & 0xFF]);
}
function asn1Tag(tag, data) { return Buffer.concat([Buffer.from([tag]), asn1Len(data.length), data]); }
function asn1Seq(data)      { return asn1Tag(0x30, data); }
function asn1Set(data)      { return asn1Tag(0x31, data); }
function asn1Ctx(n, data)   { return asn1Tag(0xA0 | n, data); }
function asn1Int(val) {
  let buf = Buffer.isBuffer(val) ? val : (() => { let h = val.toString(16); if (h.length%2) h='0'+h; return Buffer.from(h,'hex'); })();
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return asn1Tag(0x02, buf);
}
function asn1OID(dotted) {
  const p = dotted.split('.').map(Number);
  const bytes = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i]; const b = [v & 0x7F]; v >>= 7;
    while (v) { b.unshift((v & 0x7F) | 0x80); v >>= 7; }
    bytes.push(...b);
  }
  return asn1Tag(0x06, Buffer.from(bytes));
}
function asn1UTF8Str(s) { return asn1Tag(0x0C, Buffer.from(s, 'utf8')); }
function asn1UTCTime(d) {
  const p = n => String(n).padStart(2,'0');
  const s = p(d.getUTCFullYear()%100)+p(d.getUTCMonth()+1)+p(d.getUTCDate())+p(d.getUTCHours())+p(d.getUTCMinutes())+p(d.getUTCSeconds())+'Z';
  return asn1Tag(0x17, Buffer.from(s));
}
function asn1BitStr(data) { return asn1Tag(0x03, Buffer.concat([Buffer.from([0x00]), data])); }
function toPem(label, der) {
  return '-----BEGIN '+label+'-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END '+label+'-----\n';
}

function getLocalIPs() {
  const ips = ['127.0.0.1'];
  try {
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
      }
    }
  } catch(e) {}
  return ips;
}

function getNetworkList() {
  const list = [];
  try {
    for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
      for (const iface of ifaces) {
        if (iface.family !== 'IPv4' || iface.internal) continue;
        list.push({ label: name, ip: iface.address });
      }
    }
  } catch(e) {}
  return list;
}

function asn1Ext(oidStr, critical, valueBytes) {
  const parts = [asn1OID(oidStr)];
  if (critical) parts.push(asn1Tag(0x01, Buffer.from([0xFF])));
  parts.push(asn1Tag(0x04, valueBytes));
  return asn1Seq(Buffer.concat(parts));
}

function generateSelfSignedCertPureJS() {
  const { privateKey: keyPem, publicKey: pubKeyDer } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const algId   = asn1Seq(Buffer.concat([asn1OID('1.2.840.113549.1.1.11'), asn1Tag(0x05, Buffer.alloc(0))]));
  const subject = asn1Seq(asn1Set(asn1Seq(Buffer.concat([asn1OID('2.5.4.3'), asn1UTF8Str('DeviceManager')]))));
  const now = new Date(), exp = new Date(now.getTime() + 10*365*24*60*60*1000);

  // v3 확장: BasicConstraints (CA:TRUE) + SubjectAltName (IP 목록)
  const basicConstraints = asn1Ext('2.5.29.19', true,
    asn1Seq(asn1Tag(0x01, Buffer.from([0xFF])))  // cA = TRUE
  );
  // IP 주소 SAN (tag 0x87) + DNS 이름 SAN (tag 0x82)
  const ipBufs  = getLocalIPs().map(ip => asn1Tag(0x87, Buffer.from(ip.split('.').map(Number))));
  const dnsBufs = ['localhost'].map(name => asn1Tag(0x82, Buffer.from(name)));
  const san = asn1Ext('2.5.29.17', false, asn1Seq(Buffer.concat([...ipBufs, ...dnsBufs])));
  const extensions = asn1Ctx(3, asn1Seq(Buffer.concat([basicConstraints, san])));

  const tbs = asn1Seq(Buffer.concat([
    asn1Ctx(0, asn1Int(2)),
    asn1Int(crypto.randomBytes(8)),
    algId, subject,
    asn1Seq(Buffer.concat([asn1UTCTime(now), asn1UTCTime(exp)])),
    subject, pubKeyDer, extensions
  ]));
  const sign = crypto.createSign('SHA256');
  sign.update(tbs);
  const certDer = asn1Seq(Buffer.concat([tbs, algId, asn1BitStr(sign.sign(keyPem))]));
  return { certPem: toPem('CERTIFICATE', certDer), keyPem };
}

function tryGenerateCert() {
  // 1단계: openssl 바이너리 탐색
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    'C:\\Windows\\System32\\openssl.exe',
    'C:\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  ];
  for (const bin of candidates) {
    try {
      const cmd = `"${bin}" req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -nodes -subj "/CN=DeviceManager"`;
      execSync(cmd, { stdio: 'pipe', timeout: 20000 });
      console.log('[HTTPS] openssl로 인증서 생성 완료.');
      return true;
    } catch(e) { continue; }
  }
  // 2단계: 순수 Node.js로 생성
  try {
    console.log('[HTTPS] Node.js 내장 crypto로 인증서를 생성합니다...');
    const { certPem, keyPem } = generateSelfSignedCertPureJS();
    fs.writeFileSync(CERT_FILE, certPem, 'utf8');
    fs.writeFileSync(KEY_FILE, keyPem, 'utf8');
    console.log('[HTTPS] 인증서 자동 생성 완료. (data/cert.pem, data/key.pem)');
    return true;
  } catch(e) {
    console.error('[HTTPS] 인증서 생성 실패:', e.message);
    return false;
  }
}

function createHttpsServer() {
  try {
    const serverOptions = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
    const srv = https.createServer(serverOptions, requestHandler);
    isHttps = true;
    console.log('[HTTPS] HTTPS 모드로 시작합니다.');
    return srv;
  } catch(e) {
    console.warn('[HTTPS] 인증서 로드 실패:', e.message);
    return null;
  }
}

if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
  // 인증서 유효성 + 현재 IP 일치 여부 확인 → 다르면 재생성
  try {
    const certPem = fs.readFileSync(CERT_FILE, 'utf8');
    const keyPem  = fs.readFileSync(KEY_FILE,  'utf8');
    require('tls').createSecureContext({ cert: certPem, key: keyPem }); // 기본 유효성

    const currentIPs = getLocalIPs().sort().join(',');
    const IP_RECORD  = path.join(DATA_DIR, 'data', 'cert_ips.txt');
    const savedIPs   = fs.existsSync(IP_RECORD) ? fs.readFileSync(IP_RECORD, 'utf8').trim() : '';

    if (currentIPs !== savedIPs) {
      console.log('[HTTPS] IP 변경 감지 → 인증서를 재생성합니다...');
      console.log('[HTTPS] 이전 IP: ' + (savedIPs || '(없음)'));
      console.log('[HTTPS] 현재 IP: ' + currentIPs);
      fs.unlinkSync(CERT_FILE); fs.unlinkSync(KEY_FILE);
      if (tryGenerateCert()) fs.writeFileSync(IP_RECORD, currentIPs, 'utf8');
    } else {
      console.log('[HTTPS] 인증서 유효 (IP 변경 없음)');
    }
  } catch(e) {
    if (fs.existsSync(CERT_FILE)) try { fs.unlinkSync(CERT_FILE); } catch(_) {}
    if (fs.existsSync(KEY_FILE))  try { fs.unlinkSync(KEY_FILE);  } catch(_) {}
    const IP_RECORD  = path.join(DATA_DIR, 'data', 'cert_ips.txt');
    const currentIPs = getLocalIPs().sort().join(',');
    if (tryGenerateCert()) fs.writeFileSync(IP_RECORD, currentIPs, 'utf8');
  }
  httpServer = createHttpsServer() || http.createServer(requestHandler);
} else {
  // 인증서 없으면 openssl로 자동 생성 시도
  console.log('[HTTPS] 인증서가 없습니다. openssl로 자동 생성을 시도합니다...');
  if (tryGenerateCert()) {
    httpServer = createHttpsServer() || http.createServer(requestHandler);
  } else {
    // openssl 없으면 HTTP로 fallback
    httpServer = http.createServer(requestHandler);
    console.log('[HTTP] openssl을 찾을 수 없어 HTTP 모드로 시작합니다.');
    console.log('[HTTP] ※ 외부 인터넷 접속 시 HTTPS를 권장합니다.');
    console.log('[HTTP] 수동 인증서 생성 명령어:');
    console.log('[HTTP] openssl req -x509 -newkey rsa:2048 -keyout data/key.pem -out data/cert.pem -days 3650 -nodes -subj "/CN=DeviceManager"');
  }
}

// ── WebSocket 업그레이드 (세션 검증)
httpServer.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] !== 'websocket') return socket.destroy();
  const sess = getSession(req);
  if (!sess) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  wsHandshake(req, socket);
  socket._username = sess.username;
  wsClients.add(socket);
  const list = getDevices().map(d => ({ ...d, linkState: calcLinkState(d.lastUpdate) }));
  socket.write(wsEncodeFrame(JSON.stringify({ type:'INIT', devices:list, tcpPort:TCP_PORT, username:sess.username, role:sess.role, dbConnected: !!dbPool })));
  let wsBuf = Buffer.alloc(0);
  socket.on('data', chunk => { wsBuf=Buffer.concat([wsBuf,chunk]); const m=wsDecodeFrame(wsBuf); if(m) wsBuf=Buffer.alloc(0); });
  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
});

function startHttpServer(port) {
  httpServer.listen(port);
  httpServer.on('listening', () => {
    const proto = isHttps ? 'https' : 'http';
    console.log('');
    console.log('─────────────────────────────────────────────────');
    console.log('  서버가 시작되었습니다. 아래 주소로 접속하세요.');
    console.log('─────────────────────────────────────────────────');
    console.log(`  로컬    : ${proto}://localhost:${port}`);
    const nets = getNetworkList();
    if (nets.length === 0) {
      console.log('  네트워크: (연결된 네트워크 없음)');
    } else {
      nets.forEach(({ label, ip }) => {
        console.log(`  ${label.padEnd(10)}: ${proto}://${ip}:${port}`);
      });
    }
    console.log('─────────────────────────────────────────────────');
    console.log('  데이터  : ' + DATA_DIR + path.sep + 'data' + path.sep);
    console.log('─────────────────────────────────────────────────');
    console.log('');
  });
  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error('[HTTP 오류] 포트 ' + port + ' 가 이미 사용 중입니다. 다른 프로그램을 종료해 주세요.');
    else console.error('[HTTP 오류] ' + e.message);
  });
}

function appendServerLog(event, summary) {
  if (!dbPool) return;
  const now = new Date();
  dbPool.execute(
    'INSERT INTO logs (time, deviceId, location, dir, cmdType, summary) VALUES (?, ?, ?, ?, ?, ?)',
    [now, 'SERVER', '서버', event, 'SERVER', summary]
  ).catch(e => console.error('[DB] 서버 로그 저장 오류:', e.message));
}

// 프로세스 종료 시 로그
function onProcessExit(signal) {
  appendServerLog('stop', `서버 종료 (${signal})`);
  setTimeout(() => process.exit(0), WS_CLOSE_DELAY_MS);
}
process.on('SIGINT',  () => onProcessExit('SIGINT'));
process.on('SIGTERM', () => onProcessExit('SIGTERM'));

initDB().then(() => {
  startTCPServer(TCP_PORT);
  startHttpServer(HTTP_PORT_DEFAULT);
  appendServerLog('start', '서버 시작');
}).catch(() => {
  startTCPServer(TCP_PORT);
  startHttpServer(HTTP_PORT_DEFAULT);
});
