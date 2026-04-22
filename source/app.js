// ─── 상태 ────────────────────────────────
let devices    = [];
let selectedId = null;
let modalMode  = 'add';
let ws         = null;
let logEntries = [];
let logSeq     = 0;
let logTotal   = 0;
let logPage    = 1;
let logFilters = { deviceId:'', dir:'', user:'', keyword:'', dateFrom:'', dateTo:'' };
let logLoading = false;
let alarmEntries = [];
let activeFilters = new Set(['send','ack','status','connect','disconnect','timeout']);
const pendingChannels = new Map(); // deviceId → Map(chIndex → {target,cmd,timer})
let currentUser = null; // { username, role }
let dbConnected  = false; // DB 연결 상태

const LINK_LABEL = { ok:'연결됨', timeout:'타임아웃', disconnected:'연결 끊김', never:'미연결' };

// ─── 드래그 리사이즈 (마우스 + 터치 지원) ───────────────
(function(){
  let active = null; // { handle, onMove }

  function getClientY(e) {
    return e.touches ? e.touches[0].clientY : e.clientY;
  }

  function startDrag(handle, onMove) {
    active = { handle, onMove };
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  }

  function endDrag() {
    if (!active) return;
    active.handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    active = null;
  }

  function onMove(e) {
    if (active) active.onMove(e);
  }

  document.addEventListener('mouseup', endDrag);
  document.addEventListener('touchend', endDrag);
  document.addEventListener('touchcancel', endDrag);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', e => {
    if (active) { e.preventDefault(); onMove(e); }
  }, { passive: false });

  // 로그 리사이즈
  const logHandle = document.getElementById('resizeHandle');
  const logSec    = document.getElementById('logSection');
  let logSY, logSH;

  function logDragStart(e) {
    logSY = getClientY(e); logSH = logSec.offsetHeight;
    startDrag(logHandle, ev => {
      const rightCol = logSec.parentElement;
      const maxH = Math.floor(rightCol.offsetHeight / 2);
      logSec.style.height = Math.min(Math.max(logSH + (logSY - getClientY(ev)), 80), maxH) + 'px';
    });
  }
  logHandle.addEventListener('mousedown', logDragStart);
  logHandle.addEventListener('touchstart', e => { e.preventDefault(); logDragStart(e); }, { passive: false });

  // 알림 리사이즈
  const alarmHandle = document.getElementById('alarmResize');
  const alarmPanel  = document.querySelector('.alarm-panel');
  let alarmSY, alarmSH;

  function alarmDragStart(e) {
    alarmSY = getClientY(e); alarmSH = alarmPanel.offsetHeight;
    startDrag(alarmHandle, ev => {
      const leftCol = alarmPanel.parentElement;
      const maxH = Math.floor(leftCol.offsetHeight / 2);
      alarmPanel.style.height = Math.min(Math.max(alarmSH + (alarmSY - getClientY(ev)), 60), maxH) + 'px';
    });
  }
  alarmHandle.addEventListener('mousedown', alarmDragStart);
  alarmHandle.addEventListener('touchstart', e => { e.preventDefault(); alarmDragStart(e); }, { passive: false });
})();

// ─── 커스텀 알림/확인 ─────────────────────
function showAlert(msg, type='info') {
  const icons = { info:'ℹ️', warn:'⚠️', error:'❌', success:'✅' };
  document.getElementById('alertIcon').textContent = icons[type]||icons.info;
  document.getElementById('alertMsg').textContent = msg;
  document.getElementById('alertBtns').innerHTML = `<button class="btn-alert-ok" onclick="document.getElementById('alertModal').classList.remove('show')">확인</button>`;
  document.getElementById('alertModal').classList.add('show');
}
let _pendingConfirm = null;
function showConfirm(msg, onOk) {
  _pendingConfirm = onOk;
  document.getElementById('alertIcon').textContent = '❓';
  document.getElementById('alertMsg').textContent = msg;
  document.getElementById('alertBtns').innerHTML = `
    <button class="btn-alert-cancel" onclick="document.getElementById('alertModal').classList.remove('show')">취소</button>
    <button class="btn-alert-ok danger" onclick="document.getElementById('alertModal').classList.remove('show');if(_pendingConfirm){_pendingConfirm();_pendingConfirm=null;}">확인</button>`;
  document.getElementById('alertModal').classList.add('show');
}

// ─── 알림 패널 ────────────────────────────
function addAlarm(type, deviceId, msg) {
  const dev = devices.find(d => d.deviceId === deviceId);
  const name = dev?.locationName || deviceId;
  const icons = { connect:'🟢', disconnect:'🔴', timeout:'🟡' };
  alarmEntries.unshift({ type, icon: icons[type]||'●', msg, name, deviceId, time: new Date().toLocaleTimeString('ko-KR',{hour12:false}) });
  if (alarmEntries.length > 50) alarmEntries.pop();
  renderAlarms();
}
function renderAlarms() {
  const list  = document.getElementById('alarmList');
  const empty = document.getElementById('alarmEmpty');
  const badge = document.getElementById('alarmBadge');
  list.querySelectorAll('.alarm-item').forEach(e => e.remove());
  if (!alarmEntries.length) { empty.style.display='block'; badge.classList.remove('show'); return; }
  empty.style.display='none';
  badge.textContent = alarmEntries.length;
  badge.classList.add('show');
  const frag = document.createDocumentFragment();
  alarmEntries.forEach(a => {
    const el = document.createElement('div');
    el.className = `alarm-item ${a.type}`;
    const idx = alarmEntries.indexOf(a);
    el.innerHTML = `<div class="alarm-content">
        <div class="alarm-msg">${a.msg}</div>
        <div class="alarm-sub">${a.name}${a.name!==a.deviceId?' ('+a.deviceId+')':''}</div>
        <div class="alarm-time">${a.time}</div>
      </div>
      <button class="alarm-del" onclick="deleteAlarm(${idx})" title="삭제">✕</button>`;
    frag.appendChild(el);
  });
  list.appendChild(frag);
}
function deleteAllAlarms() {
  if (!alarmEntries.length) return;
  const cnt = alarmEntries.length;
  showConfirm(`알림 ${cnt}건을 모두 삭제할까요?`, function() {
    alarmEntries = [];
    renderAlarms();
  });
}

function deleteAlarm(idx) {
  const a = alarmEntries[idx];
  if (!a) return;
  showConfirm(`이 알림을 삭제할까요?\n\n${a.msg}`, function() {
    alarmEntries.splice(idx, 1);
    renderAlarms();
  });
}

// ─── WebSocket ────────────────────────────
function setPending(deviceId, ch, cmd) {
  if (!pendingChannels.has(deviceId)) pendingChannels.set(deviceId, new Map());
  const devMap = pendingChannels.get(deviceId);
  const existing = devMap.get(ch);
  if (existing?.timer) clearTimeout(existing.timer);
  const target = (cmd === 'ON' || cmd === 'RESET') ? 1 : 0;
  const timer = setTimeout(() => {
    if (!pendingChannels.get(deviceId)?.has(ch)) return;
    pendingChannels.get(deviceId).delete(ch);
    if (pendingChannels.get(deviceId).size === 0) pendingChannels.delete(deviceId);
    const chName = typeof ch === 'string' ? ch : `CH${parseInt(ch)+1}`;
    addAlarm('timeout', deviceId, `${chName} ${cmd} 명령 — 30초 이내 응답이 없어요. 전송이 제대로 안 된 것 같아요.`);
    if (selectedId === deviceId) renderCtrl();
  }, 30000);
  devMap.set(ch, { target, cmd, timer });
  // 카드 즉시 업데이트
  const dev = devices.find(d => d.deviceId === deviceId);
  if (dev) renderCard(dev);
}

function connectWS() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}`);
  ws.onopen  = () => { document.getElementById('wsDot').classList.add('on'); document.getElementById('wsStatus').textContent='연결됨'; };
  ws.onclose = () => {
    document.getElementById('wsDot').classList.remove('on');
    document.getElementById('wsStatus').textContent='연결 끊김';
    devices.forEach(dev => { dev.linkState='timeout'; renderCard(dev); });
    if(selectedId) renderCtrl();
    setTimeout(connectWS,2000);
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type==='ID_CHANGED') {
      // 실제로 연결되어 있었던 경우에만 알림
      const oldDev = devices.find(d => d.deviceId===msg.oldId);
      const newDev = devices.find(d => d.deviceId===msg.newId);
      if (newDev) { newDev.linkState = 'never'; renderCard(newDev); }
      if (msg.wasConnected) addAlarm('disconnect', msg.newId, '장비 연결이 끊겼어요.');
      return;
    }
    if (msg.type==='INIT') {
      devices=msg.devices; renderList(); if(selectedId) renderCtrl();
      if (msg.tcpPort) document.getElementById('tcpPort').value = msg.tcpPort;
      if (msg.username && !currentUser) { currentUser={username:msg.username,role:msg.role}; applyUserRole(); }
      if (msg.dbConnected !== undefined) { dbConnected = msg.dbConnected; updateDbUI(); }
      checkAndShowOnboarding();
      return;
    }
    if (msg.type==='TCP_PORT_CHANGE') {
      const el = document.getElementById('tcpPort');
      if (el) el.value = msg.port;
      return;
    }
    if (msg.type==='DB_STATUS') {
      dbConnected = msg.connected;
      updateDbUI();
      return;
    }
    if (msg.type==='FORCE_LOGOUT') {
      currentUser = null;
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      devices = []; selectedId = null; logEntries = []; alarmEntries = [];
      renderList(); renderAlarms(); renderLog();
      document.getElementById('ctrlEmpty').style.display = 'flex';
      document.getElementById('ctrlContent').style.display = 'none';
      document.getElementById('wsDot').classList.remove('on');
      document.getElementById('wsStatus').textContent = '연결 중';
      showLoginOverlay();
      document.getElementById('loginErr').textContent = msg.reason || '세션이 만료됐어요.';
      return;
    }
    const dev = devices.find(d => d.deviceId===msg.deviceId);
    if (msg.type==='STATUS') {
      if(dev) Object.assign(dev, {channels:msg.channels,currents:msg.currents,lastUpdate:msg.lastUpdate,linkState:'ok'});
      updateSummaryCards();
      const devMap = pendingChannels.get(msg.deviceId);
      if (devMap) {
        msg.channels.forEach((val, i) => {
          const p = devMap.get(i);
          if (p && val === p.target) { clearTimeout(p.timer); devMap.delete(i); }
        });
        if (devMap.size === 0) pendingChannels.delete(msg.deviceId);
      }
      addPacketLog('status', msg.deviceId, 'STATUS', msg);
    } else if (msg.type==='SEND') {
      setPending(msg.deviceId, msg.ch, msg.cmd);
      addPacketLog('send', msg.deviceId, msg.cmd, { ch:msg.ch, cmd:msg.cmd, deviceId:msg.deviceId, raw:msg.raw||'', user:msg.user||'' });
    } else if (msg.type==='ACK') {
      addPacketLog('ack', msg.deviceId, 'ACK', msg);
    } else if (msg.type==='FWVER') {
      if(dev) dev.fwVer=msg.fwVer;
      addPacketLog('fwver', msg.deviceId, 'FWVER', msg);
    } else if (msg.type==='CONNECT') {
      if(dev) dev.linkState='ok';
      updateSummaryCards();
      addAlarm('connect', msg.deviceId, '장비가 연결됐어요.');
      addPacketLog('connect', msg.deviceId, 'CONNECT', { summary:'연결됨' });
    } else if (msg.type==='TIMEOUT') {
      if(dev) dev.linkState='timeout';
      updateSummaryCards();
      pendingChannels.delete(msg.deviceId);
      const countStr = msg.count ? `${msg.count}회 연속` : '';
      addPacketLog('timeout', msg.deviceId, 'TIMEOUT', { summary:`응답 없음 ${countStr}` });
    } else if (msg.type==='DISCONNECTED') {
      if(dev) dev.linkState = dev.lastUpdate ? 'disconnected' : 'never';
      updateSummaryCards();
      pendingChannels.delete(msg.deviceId);
      addPacketLog('disconnect', msg.deviceId, 'DISCONNECTED', { summary:'연결 해제' });
      addAlarm('disconnect', msg.deviceId, '장비 연결이 끊겼어요.');
    } else if (msg.type==='RESTORE_DONE') {
      showAlert('설정을 복원했어요. 페이지를 새로 고침할게요.', 'success');
      setTimeout(() => location.reload(), 1500);
      return;
    } else if (msg.type==='DEVICE_ADDED') {
      if (!devices.find(d => d.deviceId === msg.device.deviceId)) {
        devices.push(msg.device);
        renderList();
      }
      return;
    } else if (msg.type==='DEVICE_UPDATED') {
      const idx = devices.findIndex(d => d.deviceId === msg.device.deviceId);
      if (idx !== -1) {
        devices[idx] = { ...devices[idx], ...msg.device };
        renderList();
        if (selectedId === msg.device.deviceId) renderCtrl();
      }
      return;
    } else if (msg.type==='DEVICE_DELETED') {
      devices = devices.filter(d => d.deviceId !== msg.deviceId);
      if (selectedId === msg.deviceId) {
        selectedId = null;
        document.getElementById('ctrlEmpty').style.display = 'flex';
        document.getElementById('ctrlContent').style.display = 'none';
      }
      renderList();
      return;
    } else if (msg.type==='DEVICE_REORDERED') {
      const map = new Map(devices.map(d => [d.deviceId, d]));
      devices = msg.order.map(id => map.get(id)).filter(Boolean);
      renderList();
      if (selectedId) { const el = document.getElementById('card-'+selectedId); if(el) el.classList.add('selected'); }
      return;
    }
    if(dev) { renderCard(dev); if(selectedId===msg.deviceId) renderCtrl(); }
  };
}

// ─── 유틸 ─────────────────────────────────
function chClass(v) { return v===1?'on':v===0?'off':'unknown'; }
function chLabel(v) { return v===1?'ON':v===0?'OFF':'-'; }
function fmtTime(iso) { return iso ? new Date(iso).toLocaleString('ko-KR'):'-'; }
function shortTime() {
  const n = new Date();
  const p = v => String(v).padStart(2,'0');
  return `${p(n.getMonth()+1)}/${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

// ─── 멀티탭 SVG ───────────────────────────
function multitapSVG(channels, linkState, pendMap) {
  const chs = channels || [-1,-1,-1,-1];
  const connected = linkState === 'ok';

  // 전원 스위치
  const swGlow  = connected ? '<rect x="8" y="7" width="40" height="54" rx="5" fill="#dc2626" opacity=".18"/>' : '';
  const swFill  = connected ? '#dc2626' : '#374151';
  const swTop   = connected ? '#ef4444' : '#4b5563';
  const ledFill = connected ? '#ef4444' : '#1e293b';
  const ledStr  = connected ? 'stroke="#fca5a5" stroke-width=".5"' : '';
  const swTxtC  = connected ? '#fca5a5' : '#6b7280';
  const pwr = `
    <rect x="7" y="6" width="42" height="56" rx="5" fill="#111827"/>
    ${swGlow}
    <circle cx="28" cy="13" r="4" fill="${ledFill}" ${ledStr}/>
    <rect x="11" y="22" width="32" height="30" rx="3" fill="${swFill}"/>
    <rect x="11" y="22" width="32" height="8" rx="3" fill="${swTop}" opacity=".55"/>
    <text x="27" y="43" fill="${swTxtC}" font-size="7" text-anchor="middle" font-family="monospace" font-weight="bold">${connected ? 'ON' : 'OFF'}</text>`;

  // 콘센트 - 연결 안 됨이면 물음표 + 점선
  const oxs = [108, 196, 290, 380];
  const outlets = chs.map((v, i) => {
    const cx = oxs[i], cy = 27;
    if (!connected) {
      return `
        <circle cx="${cx}" cy="${cy}" r="14" fill="#1a1e2a" stroke="#4b5563" stroke-width="1.2" stroke-dasharray="3 2.5"/>
        <text x="${cx}" y="${cy+4}" fill="#4b5563" font-size="11" text-anchor="middle" font-weight="600">?</text>
        <text x="${cx}" y="${cy+22}" fill="#4b5563" font-size="7" text-anchor="middle" font-family="monospace">CH${i+1}</text>`;
    }
    const pend = pendMap ? pendMap.get(i) : null;
    if (pend) {
      const targetOn = pend.target === 1;
      const sc  = targetOn ? '#22c55e' : '#dc2626';
      const gl  = targetOn ? `<circle cx="${cx}" cy="${cy}" r="16" fill="#22c55e" opacity=".15"/>` : `<circle cx="${cx}" cy="${cy}" r="16" fill="#dc2626" opacity=".15"/>`;
      return `<g class="svg-pending">
        ${gl}
        <circle cx="${cx}" cy="${cy}" r="16" fill="#1e2530" stroke="${sc}" stroke-width="2"/>
        <circle cx="${cx-5}" cy="${cy-1}" r="2.8" fill="#2d3748"/>
        <circle cx="${cx+5}" cy="${cy-1}" r="2.8" fill="#2d3748"/>
        <rect x="${cx-1.5}" y="${cy+6}" width="3" height="6" rx="1" fill="#2d3748"/>
        <text x="${cx}" y="${cy+26}" fill="${sc}" font-size="7.5" text-anchor="middle" font-family="monospace">CH${i+1}</text>
      </g>`;
    }
    const on = v === 1;
    const sc  = on ? '#22c55e' : '#dc2626';
    const gl  = on ? `<circle cx="${cx}" cy="${cy}" r="16" fill="#22c55e" opacity=".15"/>` : `<circle cx="${cx}" cy="${cy}" r="16" fill="#dc2626" opacity=".15"/>`;
    return `${gl}
      <circle cx="${cx}" cy="${cy}" r="16" fill="#1e2530" stroke="${sc}" stroke-width="${on ? 2 : 1.2}"/>
      <circle cx="${cx-5}" cy="${cy-1}" r="2.8" fill="${on ? '#2d3748' : '#0f172a'}"/>
      <circle cx="${cx+5}" cy="${cy-1}" r="2.8" fill="${on ? '#2d3748' : '#0f172a'}"/>
      <rect x="${cx-1.5}" y="${cy+6}" width="3" height="6" rx="1" fill="${on ? '#2d3748' : '#0f172a'}"/>
      <text x="${cx}" y="${cy+26}" fill="${sc}" font-size="7.5" text-anchor="middle" font-family="monospace">CH${i+1}</text>`;
  }).join('');

  return `<svg viewBox="0 0 440 70" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMaxYMid meet">
    <rect x="0" y="3" width="440" height="64" rx="9" fill="#2d3748"/>
    <rect x="0" y="3" width="440" height="64" rx="9" fill="none" stroke="#4a5568" stroke-width=".8"/>
    ${pwr}${outlets}
  </svg>`;
}


// ─── 대시보드 요약 카드 ───────────────────
function updateSummaryCards() {
  const total = devices.length;
  const connected = devices.filter(d => d.linkState === 'ok').length;
  const onChannels = devices.reduce((sum, d) => {
    if (!d.channels) return sum;
    return sum + d.channels.filter(v => v === 1).length;
  }, 0);
  const elTotal = document.getElementById('summaryTotal');
  const elConn  = document.getElementById('summaryConnected');
  const elCh    = document.getElementById('summaryOnChannels');
  if (elTotal) elTotal.textContent = total;
  if (elConn)  elConn.textContent  = connected;
  if (elCh)    elCh.textContent    = onChannels;
}

// ─── 장비 목록 ────────────────────────────
function renderList() {
  const c = document.getElementById('deviceList');
  c.innerHTML = '';
  if (!devices.length) { c.innerHTML=`<div style="text-align:center;padding:40px;color:var(--text3);font-size:13px;">등록된 장비가 없어요.<br>추가 버튼으로 등록해 주세요.</div>`; return; }
  devices.forEach(dev => c.appendChild(buildCard(dev)));
  updateSummaryCards();
}
function buildCard(dev) {
  const div = document.createElement('div');
  div.className = 'device-card'+(dev.deviceId===selectedId?' selected':'');
  div.id = `card-${dev.deviceId}`;
  div.onclick = () => selectDevice(dev.deviceId);
  div.innerHTML = cardHTML(dev);
  return div;
}
function cardHTML(dev) {
  const link = dev.linkState||'never';
  return `
    <div class="card-layout">
      <div class="card-left">
        <div class="card-top">
          <div class="card-led ${link}" title="${LINK_LABEL[link]}"></div>
          <div class="card-name">${dev.locationName||'(위치명 없음)'}</div>
        </div>
        <div class="card-id">${dev.deviceId}</div>
        <div class="card-meta">${dev.ip||'-'}</div>
        <div class="card-meta">${fmtTime(dev.lastUpdate)}</div>
      </div>
      <div class="card-right">
        <div class="card-multitap">${multitapSVG(dev.channels, dev.linkState, pendingChannels.get(dev.deviceId))}</div>
      </div>
    </div>`;
}
function renderCard(dev) {
  const el = document.getElementById(`card-${dev.deviceId}`);
  if (el) el.innerHTML = cardHTML(dev);
}

// ─── 제어 패널 ────────────────────────────
function selectDevice(id) {
  selectedId = id;
  document.querySelectorAll('.device-card').forEach(c=>c.classList.remove('selected'));
  const card = document.getElementById(`card-${id}`);
  if(card) card.classList.add('selected');
  renderCtrl();
}
function renderCtrl() {
  const dev = devices.find(d=>d.deviceId===selectedId);
  if(!dev) return;
  document.getElementById('ctrlEmpty').style.display='none';
  document.getElementById('ctrlContent').style.display='flex';
  const link = dev.linkState||'never';
  document.getElementById('ctrlLinkLed').className=`ctrl-link-led ${link}`;
  document.getElementById('ctrlLinkText').className=`ctrl-link-text ${link}`;
  document.getElementById('ctrlLinkText').textContent=LINK_LABEL[link];
  document.getElementById('ctrlName').textContent=dev.locationName||'(위치명 없음)';
  document.getElementById('ctrlDeviceId').textContent=dev.deviceId;
  document.getElementById('ctrlAddress').textContent=dev.address||'';
  document.getElementById('ctrlTime').textContent=`최종 업데이트: ${fmtTime(dev.lastUpdate)}`;
  document.getElementById('ctrlFwVer').textContent=dev.fwVer?`FW ${dev.fwVer}`:'';
  const canCtrl = link==='ok';
  const chs = link==='ok' ? (dev.channels||[-1,-1,-1,-1]) : [-1,-1,-1,-1];
  const pendMap = pendingChannels.get(dev.deviceId) || new Map();
  document.getElementById('ctrlChannels').innerHTML = chs.map((v,i) => {
    const pend = pendMap.get(i);
    const bc = pend ? `${pend.target===1?'on':'off'} pending-blink` : chClass(v);
    const bt = pend ? (pend.target===1?'ON':'OFF') : chLabel(v);
    return `
    <div class="ch-row">
      <div class="ch-top">
        <span class="ch-label">CH${i+1}</span>
        <span class="ch-status-badge ${bc}">${bt}</span>
        <div class="ch-btns">
          <button class="btn btn-on"  ${!canCtrl?'disabled':''} onclick="sendCmd('${dev.deviceId}',${i},'ON')">ON</button>
          <button class="btn btn-off" ${!canCtrl?'disabled':''} onclick="sendCmd('${dev.deviceId}',${i},'OFF')">OFF</button>
          <button class="btn btn-rst" ${!canCtrl?'disabled':''} onclick="sendCmd('${dev.deviceId}',${i},'RESET')"><span class="abbr-l">RESET</span><span class="abbr-m">RST</span><span class="abbr-s">R</span></button>
        </div>
      </div>
    </div>`;
  }).join('');
  ['bulkOn','bulkOff','bulkRst'].forEach(id=>{document.getElementById(id).disabled=!canCtrl;});
}

// ─── 명령 전송 ────────────────────────────
async function sendCmd(deviceId, ch, cmd) {
  setPending(deviceId, ch, cmd);
  if (selectedId === deviceId) renderCtrl();
  await postControl(deviceId, ch, cmd);
  // 로그는 서버 WebSocket broadcast(SEND)로 수신
}
async function sendBulk(cmd) {
  if(!selectedId) return;
  const dev = devices.find(d=>d.deviceId===selectedId);
  if(!dev||dev.linkState!=='ok') return;
  [0,1,2,3].forEach(ch => setPending(selectedId, ch, cmd));
  renderCtrl();
  const BULK_DELAY_MS = 80; // 일괄 명령 채널 간 딜레이
  for(let ch=0;ch<4;ch++) { await postControl(selectedId,ch,cmd); await new Promise(r=>setTimeout(r,BULK_DELAY_MS)); }
}
async function postControl(deviceId, ch, cmd) {
  try {
    const res=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,ch,cmd})});
    if(res.status===401) { doLogoutQuiet(); return null; }
    const data=await res.json();
    if(!res.ok) { showAlert(data.error||'명령을 전송하지 못했어요.','error'); return null; }
    return data;
  } catch { showAlert('서버와 통신하지 못했어요.','error'); return null; }
}

function doLogoutQuiet() {
  currentUser = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  devices = []; selectedId = null; logEntries = []; alarmEntries = [];
  renderList(); renderAlarms(); renderLog();
  document.getElementById('ctrlEmpty').style.display = 'flex';
  document.getElementById('ctrlContent').style.display = 'none';
  document.getElementById('wsDot').classList.remove('on');
  document.getElementById('wsStatus').textContent = '연결 중';
  showLoginOverlay();
  showAlert('세션이 만료됐어요. 다시 로그인해 주세요.', 'warn');
}

// ─── 필터 ─────────────────────────────────
function toggleFilter(type, el) {
  if(activeFilters.has(type)) { activeFilters.delete(type); el.classList.remove('active'); }
  else { activeFilters.add(type); el.classList.add('active'); }
  renderLog();
}
function entryMatchesFilter(entry) {
  if(activeFilters.size===0) return true;
  // timeout은 항상 표시
  if (entry.dir === 'timeout') return true;
  const map = { send:'send', ack:'ack', status:'status', fwver:'status', connect:'connect', disconnect:'disconnect' };
  return activeFilters.has(map[entry.dir]||entry.dir);
}

// ─── 패킷 로그 ────────────────────────────
function addPacketLog(dir, deviceId, cmdType, data) {
  const dev = devices.find(d=>d.deviceId===deviceId);
  logEntries.unshift({ seq:++logSeq, time:shortTime(), dir, deviceId, cmdType, location:dev?.locationName||'', data });
  if (logEntries.length > 1000) logEntries.pop();
  renderLog();
}
function renderLog() {
  const body=document.getElementById('logBody'), empty=document.getElementById('logEmpty');
  document.getElementById('logCount').textContent=logEntries.length;
  body.querySelectorAll('.log-row').forEach(e=>e.remove());
  const filtered = logEntries.filter(entryMatchesFilter).slice(0,200);
  if(!filtered.length) { empty.style.display='block'; return; }
  empty.style.display='none';
  const frag=document.createDocumentFragment();
  filtered.forEach(entry => {
    const typeMap = {
      status:     {cls:'tp-st',  txt:'상태'},
      send:       {cls:'tp-on',  txt:'송신'},
      ack:        {cls:'tp-ack', txt:'ACK'},
      timeout:    {cls:'tp-to',  txt:'타임아웃'},
      fwver:      {cls:'tp-fw',  txt:'FW'},
      connect:    {cls:'tp-conn',txt:'연결'},
      disconnect: {cls:'tp-disc',txt:'해제'},
    };
    const tc = typeMap[entry.dir] || {cls:'tp-fw', txt:entry.dir};
    const row=document.createElement('div');
    const rowBg = entry.dir==='connect' ? 'row-connect' : entry.dir==='disconnect' ? 'row-disconnect' : entry.dir==='timeout' ? 'row-timeout' : '';
    row.className='log-row' + (rowBg ? ' '+rowBg : '');
    row.onclick=()=>openDetail(entry.seq);
    row.innerHTML=`
      <span class="log-time">${entry.time}</span>
      <span class="log-name col-name">${entry.location||'-'}</span>
      <span class="log-devid col-id">${entry.deviceId}</span>
      <span><span class="log-type-pill ${tc.cls}">${tc.txt}</span></span>
      <span class="log-summary">${summaryText(entry)}</span>
      <span class="log-dot">···</span>`;
    frag.appendChild(row);
  });
  body.querySelector('.log-col-header').after(frag);
}
function summaryText(entry) {
  // DB에서 온 로그 (summary 필드 직접 사용)
  if (entry._summary !== undefined) {
    const userStr = entry._user ? ` (${entry._user})` : '';
    return (entry._summary || '') + (entry.dir === 'send' ? userStr : '');
  }
  const d=entry.data||{};
  if(entry.cmdType==='STATUS') return (d.channels||[]).map((v,i)=>`CH${i+1}:${v===1?'ON':'OFF'}`).join(' ');
  if(entry.cmdType==='ACK')    return 'ACK 수신';
  if(entry.cmdType==='FWVER')  return `FW ${d.fwVer}`;
  if(['ON','OFF','RESET'].includes(entry.cmdType)) {
    const userStr = d.user ? ` (${d.user})` : '';
    return `CH${parseInt(d.ch)+1} → ${entry.cmdType}${userStr}`;
  }
  if(entry.cmdType==='TIMEOUT')      return d.summary || '응답 없음';
  if(entry.cmdType==='CONNECT')      return '연결됨';
  if(entry.cmdType==='DISCONNECTED') return '연결 해제';
  return d.summary || '';
}

// ─── 상세 보기 ────────────────────────────
function renderDetailEntry(entry) {
  document.getElementById('detailTitle').textContent = `${entry.time} / ${entry.deviceId} / 로그 상세`;
  const body = document.getElementById('detailBody');
  body.innerHTML = '';
  const d = entry.data || {};
  const rows = [
    ['시각', entry.time], ['장비 ID', entry.deviceId], ['위치명', entry.location || '-'],
    ['방향', entry.dir === 'send' ? '송신 (PC → 장비)' : '수신 (장비 → PC)'],
    ['유형', entry.cmdType],
  ];
  if (entry.dir === 'send' && (entry.data?.user || d.user)) rows.push(['사용자', entry.data?.user || d.user]);
  if (entry.cmdType === 'STATUS') {
    const chs = d.channels || [];
    rows.push(['채널 상태', chs.map((v,i)=>`<span class="detail-ch ${v===1?'on':'off'}">CH${i+1} ${v===1?'ON':'OFF'}</span>`).join('')]);
  } else if (['ON','OFF','RESET'].includes(entry.cmdType)) {
    if (d.ch !== undefined) rows.push(['대상 채널', `CH${parseInt(d.ch)+1}`]);
    rows.push(['명령', entry.cmdType]);
  } else if (entry.cmdType === 'FWVER') {
    rows.push(['버전', d.fwVer]);
  }
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'detail-row';
    const isMono = ['장비 ID'].includes(label);
    if (label === '채널 상태') {
      row.innerHTML = `<span class="detail-label">${label}</span><div class="detail-channels">${value}</div>`;
    } else {
      row.innerHTML = `<span class="detail-label">${label}</span><span class="detail-value${isMono?' mono':''}">${value}</span>`;
    }
    body.appendChild(row);
  });
  if (d.raw) body.appendChild(buildHexTable(d.raw, entry.cmdType));
  document.getElementById('detailModal').classList.add('show');
}

function openDetail(seq) {
  const entry = logEntries.find(e => e.seq === seq);
  if (!entry) return;
  renderDetailEntry(entry);
}

function openDetailFromSearch(entry) {
  renderDetailEntry(entry);
}

function buildHexTable(raw, cmdType) {
  const bytes = raw.match(/.{1,2}/g) || [];
  const cmd = bytes[8] || '';

  // 패킷 유형별 구조 (색으로만 구분)
  const sections = cmd === 'A6'
    ? [
        { label:'HEADER',  cls:'hdr', bytes:bytes.slice(0,8)  },
        { label:'CMD',     cls:'cmd', bytes:bytes.slice(8,9)  },
        { label:'CHANNEL', cls:'dat', bytes:bytes.slice(9,13) },
        { label:'EXT',     cls:'ext', bytes:bytes.slice(13,17)},
        { label:'CS',      cls:'cs',  bytes:bytes.slice(17)   },
      ]
    : [
        { label:'HEADER',  cls:'hdr', bytes:bytes.slice(0,8)  },
        { label:'CMD',     cls:'cmd', bytes:bytes.slice(8,9)  },
        { label:'DATA',    cls:'dat', bytes:bytes.slice(9,17) },
        { label:'CS',      cls:'cs',  bytes:bytes.slice(17)   },
      ];
  const wrap = document.createElement('div');
  const labelRow = document.createElement('div');
  labelRow.className = 'detail-row';
  labelRow.innerHTML = '<span class="detail-label">RAW HEX</span>';
  wrap.appendChild(labelRow);
  const box = document.createElement('div');
  box.className = 'hex-clean';
  sections.forEach(sec => {
    if (!sec.bytes.length) return;
    const row = document.createElement('div');
    row.className = 'hex-row';
    row.innerHTML = `
      <span class="hex-lbl ${sec.cls}">${sec.label}</span>
      <div class="hex-val">
        <div class="hex-bgroup">${sec.bytes.map(b=>`<span class="hex-b ${sec.cls}">${b}</span>`).join('')}</div>
      </div>`;
    box.appendChild(row);
  });
  wrap.appendChild(box);
  return wrap;
}
function closeDetailModal() { document.getElementById('detailModal').classList.remove('show'); }

// ─── 모달 ─────────────────────────────────
function openAddModal() {
  modalMode='add';
  document.getElementById('modalTitle').textContent='장비 추가';
  ['fDeviceId','fIp','fLocationName','fAddress'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('modal').classList.add('show');
  document.getElementById('fLocationName').focus();
}
function openEditModal() {
  if(!selectedId) return showAlert('수정할 장비를 선택해 주세요.', 'warn');
  const dev=devices.find(d=>d.deviceId===selectedId);
  if(!dev) return;
  modalMode='edit';
  document.getElementById('modalTitle').textContent='장비 수정';
  document.getElementById('fLocationName').value=dev.locationName||'';
  document.getElementById('fDeviceId').value=dev.deviceId;
  document.getElementById('fIp').value=dev.ip||'';
  document.getElementById('fAddress').value=dev.address||'';
  document.getElementById('modal').classList.add('show');
  document.getElementById('fLocationName').focus();
}
function closeModal() { document.getElementById('modal').classList.remove('show'); }

async function submitModal() {
  const locationName=document.getElementById('fLocationName').value.trim();
  const deviceId=document.getElementById('fDeviceId').value.trim().toUpperCase();
  const ip=document.getElementById('fIp').value.trim();
  const address=document.getElementById('fAddress').value.trim();
  if(!locationName) return showAlert('함체 위치명을 입력해 주세요.','warn');
  if(!deviceId||deviceId.length!==6) return showAlert('Device ID는 6자리 HEX를 입력해 주세요.','warn');
  if(modalMode==='add') {
    const res=await fetch('/api/devices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,ip,locationName,address})});
    const data=await res.json();
    if(!res.ok) return showAlert(data.error||'장비를 추가하지 못했어요.','error');
    devices.push({deviceId,ip,locationName,address,channels:[-1,-1,-1,-1],currents:[0,0,0,0],fwVer:'',lastUpdate:'',linkState:'never'});
    renderList();
  } else {
    const res=await fetch(`/api/devices/${selectedId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({deviceId,ip,locationName,address})});
    const data=await res.json();
    if(!res.ok) return showAlert(data.error||'장비를 수정하지 못했어요.','error');
    const dev=devices.find(d=>d.deviceId===selectedId);
    if(dev) {
      if(dev.deviceId!==deviceId) {
        const oldCard=document.getElementById(`card-${dev.deviceId}`);
        if(oldCard) oldCard.id=`card-${deviceId}`;
        dev.deviceId=deviceId; selectedId=deviceId;
      }
      Object.assign(dev,{ip,locationName,address});
    }
    renderList(); renderCtrl();
  }
  closeModal();
}

async function deleteDevice() {
  if(!selectedId) return showAlert('삭제할 장비를 선택해 주세요.','warn');
  const dev=devices.find(d=>d.deviceId===selectedId);
  showConfirm(`[${dev?.locationName||selectedId}] 장비를 삭제할까요?`, async function() {
    const res=await fetch(`/api/devices/${selectedId}`,{method:'DELETE'});
    if(!res.ok) return showAlert('장비를 삭제하지 못했어요.','error');
    devices=devices.filter(d=>d.deviceId!==selectedId);
    selectedId=null; renderList();
    document.getElementById('ctrlEmpty').style.display='flex';
    document.getElementById('ctrlContent').style.display='none';
  });
}

document.addEventListener('keydown', e => { if(e.key==='Escape') { closeModal(); closeDetailModal(); closeLogSearch(); document.getElementById('alertModal').classList.remove('show'); } });

async function changeTCPPort() {
  const val = document.getElementById('tcpPort').value.trim();
  const port = parseInt(val);
  if (!port || port < 1 || port > 65535) return showAlert('올바른 포트 번호를 입력해 주세요. (1 ~ 65535)','warn');
  showConfirm(`TCP 포트를 ${port}번으로 바꿀까요?\n기존 연결된 장비들이 재연결돼요.`, async function() {
    try {
      const res = await fetch('/api/config', {
        method: 'PUT', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ tcpPort: port })
      });
      const data = await res.json();
      if (!res.ok) return showAlert(data.error || '포트를 바꾸지 못했어요.', 'error');
      showAlert(`TCP 포트를 ${data.port}번으로 바꿨어요.`, 'success');
    } catch { showAlert('서버와 통신하지 못했어요.', 'error'); }
  });
}
// 초기 높이 동기화 (로그·알림 동일 height)
(function initSizes() {
  const setHalf = () => {
    const logSec     = document.getElementById('logSection');
    const alarmPanel = document.querySelector('.alarm-panel');
    const rightCol   = logSec?.parentElement;
    const leftCol    = alarmPanel?.parentElement;
    if (!rightCol || !leftCol) return;
    const h = Math.floor(Math.min(rightCol.offsetHeight, leftCol.offsetHeight) / 2);
    logSec.style.height    = h + 'px';
    alarmPanel.style.height = h + 'px';
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setHalf);
  } else {
    requestAnimationFrame(setHalf);
  }
})();

init();

// ─── 로그 DB 조회 / 삭제 ──────────────────────────────────
// ─── 로그 검색 모달 ────────────────────────────────────────
let dbLogEntries = []; // DB에서 조회한 로그 (검색 모달용)

function openLogSearch() {
  if (!dbConnected) {
    showAlert('DB가 연결돼 있지 않아요.\n설정 메뉴 > DB 설정에서 연결 정보를 입력해 주세요.', 'warn');
    return;
  }
  document.getElementById('logSearchModal').classList.add('show');
  initFilterStyles();
  fetchLogs(1);
}
function closeLogSearch() {
  document.getElementById('logSearchModal').classList.remove('show');
}

async function fetchLogs(page) {
  if (logLoading) return;
  logLoading = true;
  logPage = page || 1;
  try {
    const params = new URLSearchParams({ page: logPage, limit: 100 });
    if (logFilters.deviceId) params.set('deviceId', logFilters.deviceId);
    if (logFilters.dir)      params.set('dir',      logFilters.dir);
    if (logFilters.user)     params.set('user',      logFilters.user);
    if (logFilters.keyword)  params.set('keyword',  logFilters.keyword);
    if (logFilters.dateFrom) params.set('dateFrom', logFilters.dateFrom);
    if (logFilters.dateTo)   params.set('dateTo',   logFilters.dateTo);
    const res = await fetch('/api/logs?' + params.toString());
    if (res.status === 401) { doLogoutQuiet(); return; }
    const data = await res.json();
    logTotal = data.total || 0;
    dbLogEntries = (data.rows || []).map((r, i) => ({
      seq: logTotal - (logPage-1)*100 - i,
      time: r.time, deviceId: r.deviceId, location: r.location || '',
      dir: r.dir, cmdType: r.cmdType,
      data: { summary: r.summary, user: r.user, raw: r.raw || '' },
      _summary: r.summary, _user: r.user
    }));
    renderSearchLog();
    renderLogPager();
  } catch(e) { /* 로그 조회 실패 — 무시 */ }
  logLoading = false;
}

function updateSelectStyle(el) {
  if (!el) return;
  el.classList.toggle('placeholder-active', el.value === '');
}
function initFilterStyles() {
  updateSelectStyle(document.getElementById('lfDir'));
  document.getElementById('lfDir')?.addEventListener('change', () => updateSelectStyle(document.getElementById('lfDir')));
  updateDateLabel('lfDateFrom','lbDateFrom');
  updateDateLabel('lfDateTo','lbDateTo');
}

function applyLogFilter() {
  logFilters.deviceId = document.getElementById('lfDeviceId')?.value.trim() || '';
  logFilters.dir      = document.getElementById('lfDir')?.value || '';
  logFilters.user     = document.getElementById('lfUser')?.value.trim() || '';
  logFilters.keyword  = document.getElementById('lfKeyword')?.value.trim() || '';
  logFilters.dateFrom = document.getElementById('lfDateFrom')?.value || '';
  logFilters.dateTo   = document.getElementById('lfDateTo')?.value || '';
  updateSelectStyle(document.getElementById('lfDir'));
  fetchLogs(1);
}

function resetLogFilter() {
  ['lfDeviceId','lfDir','lfUser','lfKeyword','lfDateFrom','lfDateTo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  updateSelectStyle(document.getElementById('lfDir'));
  [['lfDateFrom','lbDateFrom'],['lfDateTo','lbDateTo']].forEach(([inputId, labelId]) => {
    const el = document.getElementById(inputId);
    if (el) el.value = '';
    updateDateLabel(inputId, labelId);
  });
  logFilters = { deviceId:'', dir:'', user:'', keyword:'', dateFrom:'', dateTo:'' };
  fetchLogs(1);
}

function renderSearchLog() {
  const rows = document.getElementById('logSearchRows');
  const empty = document.getElementById('logSearchEmpty');
  const totalNote = document.getElementById('logTotalNote');
  if (!rows) return;
  if (totalNote) totalNote.textContent = logTotal > 0 ? `전체 ${logTotal.toLocaleString()}건` : '';
  rows.innerHTML = '';
  if (!dbLogEntries.length) { if(empty) empty.style.display='block'; return; }
  if(empty) empty.style.display='none';
  const frag = document.createDocumentFragment();
  dbLogEntries.forEach(entry => {
    const typeMap = {
      status:     {cls:'tp-st',  txt:'상태'},
      send:       {cls:'tp-on',  txt:'송신'},
      ack:        {cls:'tp-ack', txt:'ACK'},
      timeout:    {cls:'tp-to',  txt:'타임아웃'},
      fwver:      {cls:'tp-fw',  txt:'FW'},
      connect:    {cls:'tp-conn',txt:'연결'},
      disconnect: {cls:'tp-disc',txt:'해제'},
    };
    const tc = typeMap[entry.dir] || {cls:'tp-fw', txt:entry.dir};
    const rowBg = entry.dir==='connect' ? 'row-connect' : entry.dir==='disconnect' ? 'row-disconnect' : entry.dir==='timeout' ? 'row-timeout' : '';
    const row = document.createElement('div');
    row.className = 'log-row' + (rowBg ? ' '+rowBg : '');
    row.style.cursor = 'pointer';
    const entryRef = entry;
    row.onclick = () => openDetailFromSearch(entryRef);
    row.innerHTML = `
      <span class="log-time">${entry.time}</span>
      <span class="log-name col-name">${entry.location||'-'}</span>
      <span class="log-devid col-id">${entry.deviceId}</span>
      <span><span class="log-type-pill ${tc.cls}">${tc.txt}</span></span>
      <span class="log-summary">${summaryText(entry)}</span>
      <span class="log-dot">···</span>`;
    frag.appendChild(row);
  });
  rows.appendChild(frag);
}

function renderLogPager() {
  const el = document.getElementById('logPager');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(logTotal / 100));
  el.innerHTML = '';
  if (totalPages <= 1) return;
  const mkBtn = (label, page, disabled) => {
    const b = document.createElement('button');
    b.className = 'log-page-btn' + (page === logPage ? ' active' : '');
    b.textContent = label; b.disabled = disabled;
    b.onclick = () => fetchLogs(page);
    return b;
  };
  el.appendChild(mkBtn('◀', logPage-1, logPage <= 1));
  const start = Math.max(1, logPage-2), end = Math.min(totalPages, logPage+2);
  for (let p = start; p <= end; p++) el.appendChild(mkBtn(p, p, false));
  el.appendChild(mkBtn('▶', logPage+1, logPage >= totalPages));
}

async function deleteAllLogs() {
  showConfirm(`DB의 모든 로그 ${logTotal.toLocaleString()}건을 삭제할까요?`, async function() {
    try {
      const res = await fetch('/api/logs/all', { method:'DELETE' });
      const d = await res.json();
      if (d.ok) {
        logEntries = []; logTotal = 0; logPage = 1;
        renderLog(); renderLogPager();
        showAlert(`로그 ${d.deleted.toLocaleString()}건을 삭제했어요.`, 'success');
      } else { showAlert('로그를 삭제하지 못했어요.', 'error'); }
    } catch { showAlert('서버와 통신하지 못했어요.', 'error'); }
  });
}

// ─── 드래그 순서 변경 ─────────────────────────────────
let dragSrcId = null;

function enableDragReorder() {
  const list = document.getElementById('deviceList');
  list.addEventListener('dragstart', e => {
    const card = e.target.closest('.device-card');
    if (!card) return;
    dragSrcId = card.dataset.id;
    setTimeout(() => card.classList.add('dragging'), 0);
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.target.closest('.device-card');
    if (!card || card.dataset.id === dragSrcId) return;
    list.querySelectorAll('.device-card').forEach(c => c.classList.remove('drag-over'));
    card.classList.add('drag-over');
  });
  list.addEventListener('dragleave', e => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      list.querySelectorAll('.device-card').forEach(c => c.classList.remove('drag-over'));
    }
  });
  list.addEventListener('drop', async e => {
    e.preventDefault();
    const card = e.target.closest('.device-card');
    list.querySelectorAll('.device-card').forEach(c => { c.classList.remove('drag-over'); c.classList.remove('dragging'); });
    if (!card || !dragSrcId || card.dataset.id === dragSrcId) return;
    const srcIdx = devices.findIndex(d => d.deviceId === dragSrcId);
    const tgtIdx = devices.findIndex(d => d.deviceId === card.dataset.id);
    if (srcIdx === -1 || tgtIdx === -1) return;
    const [moved] = devices.splice(srcIdx, 1);
    devices.splice(tgtIdx, 0, moved);
    renderList();
    if (selectedId) { const el = document.getElementById('card-' + selectedId); if (el) el.classList.add('selected'); }
    try {
      await fetch('/api/devices/reorder', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ order: devices.map(d => d.deviceId) })
      });
    } catch(e) {}
  });
  list.addEventListener('dragend', () => {
    list.querySelectorAll('.device-card').forEach(c => { c.classList.remove('dragging'); c.classList.remove('drag-over'); });
  });
}

// buildCard에 draggable 및 data-id 주입 (renderList 이후 호출)
const _origRenderList = renderList;
renderList = function() {
  _origRenderList();
  document.querySelectorAll('.device-card').forEach(card => {
    const id = card.id.replace('card-', '');
    card.draggable = true;
    card.dataset.id = id;
  });
};

// 초기화 시 드래그 활성화
document.addEventListener('DOMContentLoaded', enableDragReorder);
if (document.readyState !== 'loading') enableDragReorder();

// ─── CSV 내보내기 ──────────────────────────────────────
function exportLogsCSV() {
  const a = document.createElement('a');
  a.href = '/api/logs/export.csv';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── 서버 종료 ─────────────────────────────────────────
function confirmShutdown() {
  showConfirm('서버를 종료할까요?\n브라우저 창도 함께 닫혀요.', async function() {
    try { await fetch('/api/shutdown', { method:'POST' }); } catch(e) {}
    setTimeout(() => window.close(), 400);
  });
}

// ─── 패널 접기/펼치기 ──────────────────────────────────
function toggleAlarmPanel() {
  const panel  = document.querySelector('.alarm-panel');
  const handle = document.getElementById('alarmResize');
  const btn    = document.getElementById('alarmToggle');
  const collapsed = panel.classList.toggle('collapsed');
  handle.classList.toggle('panel-hidden', collapsed);
  btn.textContent = collapsed ? '▲' : '▼';
  btn.title       = collapsed ? '펼치기' : '접기';
}

function toggleLogPanel() {
  const panel  = document.getElementById('logSection');
  const handle = document.getElementById('resizeHandle');
  const btn    = document.getElementById('logToggle');
  const collapsed = panel.classList.toggle('collapsed');
  handle.classList.toggle('panel-hidden', collapsed);
  btn.textContent = collapsed ? '▲' : '▼';
  btn.title       = collapsed ? '펼치기' : '접기';
  if (collapsed) {
    panel._savedHeight = panel.style.height;
    panel.style.height = '';
  } else {
    panel.style.height = panel._savedHeight || '';
  }
}

// ─── 인증 / 로그인 / 로그아웃 ─────────────────────────

function showLoginOverlay() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginErr').textContent = '';
  setTimeout(() => document.getElementById('loginUser').focus(), 100);
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay').classList.add('hidden');
}

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginErr');
  const btn = document.getElementById('loginBtn');
  if (!username || !password) { errEl.textContent = '아이디와 비밀번호를 입력해 주세요.'; return; }
  btn.disabled = true; btn.textContent = '로그인 중...';
  errEl.textContent = '';
  try {
    const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password}) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || '로그인하지 못했어요.'; btn.disabled=false; btn.textContent='로그인'; return; }
    currentUser = { username: data.username, role: data.role };
    applyUserRole();
    hideLoginOverlay();
    connectWS();
  } catch {
    errEl.textContent = '서버에 연결하지 못했어요.';
    btn.disabled = false; btn.textContent = '로그인';
  }
}

async function doLogout() {
  showConfirm('로그아웃 할까요?', async function() {
    try { await fetch('/api/logout', { method:'POST' }); } catch(e) {}
    currentUser = null;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    devices = []; selectedId = null; logEntries = []; alarmEntries = [];
    renderList(); renderAlarms(); renderLog();
    document.getElementById('ctrlEmpty').style.display = 'flex';
    document.getElementById('ctrlContent').style.display = 'none';
    document.getElementById('wsDot').classList.remove('on');
    document.getElementById('wsStatus').textContent = '연결 중';
    showLoginOverlay();
  });
}

function applyUserRole() {
  if (!currentUser) return;
  document.getElementById('headerUsername').textContent = currentUser.username;
  if (currentUser.role === 'admin') {
    document.body.classList.add('is-admin');
  } else {
    document.body.classList.remove('is-admin');
  }
}

// ─── 앱 초기화 ─────────────────────────────────────
async function init() {
  try {
    const res = await fetch('/api/me');
    if (res.status === 401) { showLoginOverlay(); return; }
    const data = await res.json();
    currentUser = { username: data.username, role: data.role };
    applyUserRole();
    hideLoginOverlay();
    connectWS();
  } catch {
    showLoginOverlay();
  }
}

// ─── 사용자 관리 ──────────────────────────────────────
let userEditMode = 'add';
let userEditTarget = null;

async function openUserModal() {
  const res = await fetch('/api/users');
  if (!res.ok) return;
  const users = await res.json();
  const list = document.getElementById('userList');
  list.innerHTML = '';
  if (!users.length) { list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px;">사용자가 없어요.</div>'; }
  users.forEach(u => {
    const row = document.createElement('div');
    row.className = 'user-row';
    const isSelf = u.username === currentUser?.username;
    row.innerHTML = `
      <div class="user-row-info">
        <div class="user-row-name">${u.username}${isSelf?' <span style="font-size:10px;color:var(--text3)">(나)</span>':''}</div>
        <div class="user-row-meta">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('ko-KR') : ''}</div>
      </div>
      <span class="user-role-badge ${u.role}">${u.role === 'admin' ? '관리자' : '일반'}</span>
      <div class="user-row-btns">
        <button class="btn-user-edit" onclick="openUserEditModal('edit','${u.username}','${u.role}')">수정</button>
        <button class="btn-user-del" onclick="deleteUser('${u.username}')" ${isSelf?'disabled title="자신의 계정은 삭제할 수 없어요."':''}>삭제</button>
      </div>`;
    list.appendChild(row);
  });
  document.getElementById('userModal').classList.add('show');
}

function closeUserModal() { document.getElementById('userModal').classList.remove('show'); }

function openUserEditModal(mode, username, role) {
  userEditMode = mode;
  userEditTarget = username || null;
  const isEdit = mode === 'edit';
  document.getElementById('userEditTitle').textContent = isEdit ? '사용자 수정' : '사용자 추가';
  document.getElementById('fUserUsername').value = username || '';
  document.getElementById('fUserUsername').disabled = isEdit;
  document.getElementById('fUserPassword').value = '';
  document.getElementById('fUserPwLabel').innerHTML = isEdit ? '새 비밀번호 <span style="font-size:11px;color:var(--text3)">(변경 시에만 입력)</span>' : '비밀번호 <span class="required">*</span>';
  document.getElementById('fUserPwHint').textContent = isEdit ? '비워두면 기존 비밀번호 유지' : '';
  document.getElementById('fUserRole').value = role || 'user';
  document.getElementById('userEditModal').classList.add('show');
}

function closeUserEditModal() { document.getElementById('userEditModal').classList.remove('show'); }

async function submitUserModal() {
  const username = document.getElementById('fUserUsername').value.trim();
  const password = document.getElementById('fUserPassword').value;
  const role = document.getElementById('fUserRole').value;
  if (userEditMode === 'add') {
    if (!username) return showAlert('아이디를 입력해 주세요.', 'warn');
    if (!password) return showAlert('비밀번호를 입력해 주세요.', 'warn');
    const res = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password, role}) });
    const data = await res.json();
    if (!res.ok) return showAlert(data.error || '계정을 추가하지 못했어요.', 'error');
    closeUserEditModal();
    closeUserModal();
    showAlert(`[${username}] 계정을 추가했어요.`, 'success');
  } else {
    const body = { role };
    if (password) body.password = password;
    const res = await fetch(`/api/users/${encodeURIComponent(userEditTarget)}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return showAlert(data.error || '정보를 수정하지 못했어요.', 'error');
    closeUserEditModal();
    closeUserModal();
    showAlert(password ? `[${userEditTarget}] 비밀번호를 바꿨어요.` : `[${userEditTarget}] 정보를 수정했어요.`, 'success');
  }
}

async function deleteUser(username) {
  showConfirm(`[${username}] 계정을 삭제할까요?`, async function() {
    const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method:'DELETE' });
    const data = await res.json();
    if (!res.ok) return showAlert(data.error || '계정을 삭제하지 못했어요.', 'error');
    showAlert(`[${username}] 계정을 삭제했어요.`, 'success');
    openUserModal();
  });
}

// ─── 온보딩 체크리스트 ────────────────────────────────
// ─── 온보딩 가이드 ────────────────────────────────────
function shouldShowOnboarding() {
  if (!currentUser || currentUser.role !== 'admin') return false;
  if (localStorage.getItem('onboarding_dismissed') === '1') return false;
  return !dbConnected || devices.length === 0;
}

function renderOnboardingItems() {
  const list = document.getElementById('onboardingList');
  if (!list) return;
  const certDone = localStorage.getItem('cert_installed') === '1';
  const items = [
    {
      done: dbConnected,
      icon: dbConnected ? '✅' : '❌',
      cls: dbConnected ? 'done' : 'todo',
      title: 'DB 연결',
      sub: dbConnected ? 'MariaDB가 연결돼 있어요.' : '로그 기록을 위해 MariaDB 연결 정보를 입력해 주세요.',
      btnLabel: 'DB 설정 열기',
      btnAction: () => { closeOnboarding(); openDbConfigModal(); }
    },
    {
      done: devices.length > 0,
      icon: devices.length > 0 ? '✅' : '❌',
      cls: devices.length > 0 ? 'done' : 'todo',
      title: '장비 등록',
      sub: devices.length > 0 ? `장비 ${devices.length}대가 등록돼 있어요.` : '제어할 장비를 1개 이상 등록해 주세요.',
      btnLabel: '장비 추가',
      btnAction: () => { closeOnboarding(); openAddModal(); }
    },
    {
      done: certDone,
      icon: certDone ? '✅' : '🔒',
      cls: certDone ? 'done' : 'optional',
      title: 'HTTPS 인증서 설치 (권장)',
      sub: certDone ? '이 브라우저에 인증서를 설치했어요.' : '브라우저 보안 경고를 없애려면 인증서를 설치하세요.',
      btnLabel: '설치 안내 보기',
      btnAction: () => { closeOnboarding(); document.getElementById('certModal').classList.add('show'); }
    },
  ];
  list.innerHTML = '';
  items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = `onboarding-item ${item.cls}`;
    el.innerHTML = `
      <div class="onboarding-icon">${item.icon}</div>
      <div class="onboarding-body">
        <div class="onboarding-title">${i + 1}. ${item.title}</div>
        <div class="onboarding-sub">${item.sub}</div>
      </div>`;
    if (!item.done) {
      const btn = document.createElement('button');
      btn.className = 'btn-onboarding';
      btn.textContent = item.btnLabel;
      btn.onclick = item.btnAction;
      el.querySelector('.onboarding-body').appendChild(btn);
    }
    list.appendChild(el);
  });
}

function openOnboarding() {
  renderOnboardingItems();
  document.getElementById('onboardingModal').classList.add('show');
}

function closeOnboarding() {
  document.getElementById('onboardingModal').classList.remove('show');
}

function dismissOnboarding() {
  localStorage.setItem('onboarding_dismissed', '1');
  closeOnboarding();
}

function checkAndShowOnboarding() {
  if (!shouldShowOnboarding()) return;
  openOnboarding();
}

// ─── 인증서 다운로드 ──────────────────────────────────
function downloadCert() {
  const a = document.createElement('a');
  a.href = '/api/cert/download';
  a.download = 'DeviceManager-CA.crt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  localStorage.setItem('cert_installed', '1');
}

// ─── DB 상태 UI ───────────────────────────────────────
function updateDbUI() {
  const badge   = document.getElementById('dbBadge');
  const dot     = document.getElementById('dbDot');
  const text    = document.getElementById('dbStatus');
  const searchBtn = document.getElementById('logSearchBtn');
  const csvBtn    = document.getElementById('csvExportBtn');
  const noDbNote  = document.getElementById('logNoDbNote');

  if (!badge) return;

  if (dbConnected) {
    badge.className = 'db-badge db-ok';
    badge.title = 'DB 연결됨';
    if (text) text.textContent = 'DB';
    if (searchBtn) { searchBtn.disabled = false; searchBtn.title = ''; }
    if (csvBtn)    { csvBtn.disabled    = false; csvBtn.title    = ''; }
    if (noDbNote)  noDbNote.style.display = 'none';
  } else {
    badge.className = 'db-badge db-err';
    badge.title = 'DB 미연결 — 설정 > DB 설정에서 연결 정보를 입력해 주세요';
    if (text) text.textContent = 'DB 없음';
    if (searchBtn) { searchBtn.disabled = true;  searchBtn.title = 'DB를 연결해야 사용할 수 있어요'; }
    if (csvBtn)    { csvBtn.disabled    = true;  csvBtn.title    = 'DB를 연결해야 사용할 수 있어요'; }
    if (noDbNote)  noDbNote.style.display = 'inline';
  }
}

// ─── DB 설정 모달 ─────────────────────────────────────
async function openDbConfigModal() {
  const resultEl = document.getElementById('dbConnResult');
  if (resultEl) { resultEl.className = 'db-conn-result'; resultEl.textContent = ''; }
  try {
    const res = await fetch('/api/db-config');
    if (!res.ok) return;
    const cfg = await res.json();
    document.getElementById('dbHost').value     = cfg.host     || '';
    document.getElementById('dbPort').value     = cfg.port     || '';
    document.getElementById('dbUser').value     = cfg.user     || '';
    document.getElementById('dbPassword').value = '';
    document.getElementById('dbDatabase').value = cfg.database || '';
    if (resultEl) {
      resultEl.className   = 'db-conn-result ' + (cfg.connected ? 'ok' : 'err');
      resultEl.textContent = cfg.connected ? '✅ 현재 DB 연결됨' : '❌ 현재 DB 미연결 상태예요';
    }
  } catch(e) {}
  document.getElementById('dbConfigModal').classList.add('show');
}

function closeDbConfigModal() {
  document.getElementById('dbConfigModal').classList.remove('show');
}

async function saveDbConfig() {
  const btn = document.getElementById('dbSaveBtn');
  const resultEl = document.getElementById('dbConnResult');
  btn.disabled = true; btn.textContent = '연결 중...';
  if (resultEl) { resultEl.className = 'db-conn-result'; resultEl.textContent = ''; }
  try {
    const body = {
      host:     document.getElementById('dbHost').value.trim(),
      port:     document.getElementById('dbPort').value.trim(),
      user:     document.getElementById('dbUser').value.trim(),
      password: document.getElementById('dbPassword').value,
      database: document.getElementById('dbDatabase').value.trim(),
    };
    const res  = await fetch('/api/db-config', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await res.json();
    if (resultEl) {
      if (data.connected) {
        resultEl.className   = 'db-conn-result ok';
        resultEl.textContent = '✅ DB에 연결했어요!';
      } else {
        resultEl.className   = 'db-conn-result err';
        resultEl.textContent = '❌ 연결하지 못했어요 — 연결 정보를 확인해 주세요';
      }
    }
    dbConnected = !!data.connected;
    updateDbUI();
  } catch(e) {
    if (resultEl) { resultEl.className = 'db-conn-result err'; resultEl.textContent = '❌ 서버와 통신하지 못했어요.'; }
  }
  btn.disabled = false; btn.textContent = '저장 및 연결';
}

// ─── 백업 / 복원 ──────────────────────────────────────
function downloadBackup() {
  const a = document.createElement('a');
  a.href = '/api/backup';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function triggerRestoreFile() {
  document.getElementById('restoreFileInput').click();
}

async function handleRestoreFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  showConfirm('지금 설정을 백업 파일로 덮어쓸게요. 계속할까요?', async function() {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (!res.ok) return showAlert(result.error || '복원하지 못했어요.', 'error');
      showAlert('복원했어요. 페이지를 새로 고침할게요.', 'success');
      setTimeout(() => location.reload(), 1500);
    } catch(e) {
      showAlert('파일을 읽지 못했어요. 올바른 백업 파일인지 확인해 주세요.', 'error');
    }
  });
}

// ─── 설정 드롭다운 ────────────────────────────────────
function toggleSettingsMenu() {
  const menu = document.getElementById('settingsMenu');
  menu.classList.toggle('show');
}
function closeSettingsMenu() {
  document.getElementById('settingsMenu')?.classList.remove('show');
}
document.addEventListener('click', e => {
  if (!e.target.closest('#settingsWrap')) closeSettingsMenu();
});

// ─── 필터 스타일 초기화 ────────────────────────────────────
function updateDateStyle(inputId) {
  // type=date 고정 방식 - 라벨로 처리
}

function updateDateLabel(inputId, labelId) {
  const el = document.getElementById(inputId);
  const lb = document.getElementById(labelId);
  if (!el || !lb) return;
  if (el.value) lb.classList.add('has-value');
  else lb.classList.remove('has-value');
}

document.addEventListener('DOMContentLoaded', () => {
  // select 스타일
  updateSelectStyle(document.getElementById('lfDir'));
  document.getElementById('lfDir')?.addEventListener('change', () => updateSelectStyle(document.getElementById('lfDir')));
  // date 스타일
  ['lfDateFrom','lfDateTo'].forEach(id => {
    updateDateStyle(id);
    document.getElementById(id)?.addEventListener('change', () => updateDateStyle(id));
    document.getElementById(id)?.addEventListener('input',  () => updateDateStyle(id));
  });
});
