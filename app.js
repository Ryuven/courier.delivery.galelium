// ============================================================
//  app.js — Galelium Courier · Логика курьерского приложения
//  Забони тоҷикӣ · 3-қадамаи расонидан
// ============================================================

import { auth, db, storage, COL, EPD, VEHICLE_TYPES } from './firebase.js';

import {
  onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js';

import {
  doc, getDoc, setDoc, updateDoc,
  getDocs, collection, query, where,
  orderBy, onSnapshot, serverTimestamp, limit,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js';

import {
  ref as sRef, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-storage.js';

// ─── Ҳолати барнома ──────────────────────────────────────────
let CU              = null;
let UD              = null;
let CD              = null;
let newOrders       = [];
let activeOrder     = null;
let historyOrders   = [];
let unsubNew        = null;
let unsubActive     = null;
let soundEnabled    = true;
let todayDeliveries = 0;
let todayEarnings   = 0;
let checkedItems    = new Set(); // Отмеченные товары при сборке

// ═══════════════════════════════════════════════════════════
//  КАРТА — GPS + Leaflet + Магазины + Маршруты по фазам
// ═══════════════════════════════════════════════════════════
let _map            = null;
let _markerMe       = null;
let _markerStore    = null;
let _markerClient   = null;
let _routeLine      = null;
let _storeMarkers   = [];
let _geoWatchId     = null;
let _lastPos        = null;
let _stores         = [];

// ─── Хаверсин (расстояние в км) ──────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Ближайший магазин ────────────────────────────────────
function nearestStore(lat, lng, chainFilter) {
  const list = _stores.filter(s => s.active && (!chainFilter || s.chain === chainFilter));
  if (!list.length) return null;
  return list.map(s => ({ ...s, dist: haversine(lat, lng, s.lat, s.lng) }))
             .sort((a, b) => a.dist - b.dist)[0];
}

// ─── Иконки ───────────────────────────────────────────────
function mkIcon(html, size) {
  size = size || 38;
  return window.L.divIcon({ html, className:'', iconSize:[size,size], iconAnchor:[size/2,size/2] });
}
function mkStorePin(chain) {
  const colors = { bi1:'#3b82f6', '\u041f\u0430\u0439\u043a\u0430\u0440':'#d97706', '\u0401\u0432\u0430\u0440':'#2db87a' };
  const color = colors[chain] || '#6b7280';
  const letter = (chain||'')[0] || '?';
  return window.L.divIcon({
    html: '<div style="width:20px;height:20px;border-radius:50%;background:'+color+';opacity:.75;border:2px solid rgba(255,255,255,.4);display:flex;align-items:center;justify-content:center;font-size:.55rem;color:#fff;font-weight:800;box-shadow:0 1px 5px rgba(0,0,0,.4)">'+letter+'</div>',
    className:'', iconSize:[20,20], iconAnchor:[10,10],
  });
}

// ─── Загрузка магазинов ───────────────────────────────────
async function loadStores() {
  if (_stores.length) return;
  try {
    const r = await fetch('/stores_dushanbe.json');
    const j = await r.json();
    _stores = (j.stores || []).filter(s => s.active);
  } catch(e) { console.warn('stores_dushanbe.json:', e); }
}

// ─── Фоновые точки всех магазинов ────────────────────────
function renderStoreMarkers() {
  if (!_map || !_stores.length) return;
  _storeMarkers.forEach(m => m.remove());
  _storeMarkers = [];
  _stores.forEach(s => {
    const m = window.L.marker([s.lat, s.lng], { icon: mkStorePin(s.chain), zIndexOffset: 5, interactive: true })
      .bindTooltip('<b>'+s.name+'</b><br><span style="font-size:.72em;opacity:.8">'+s.address+'</span>', { direction:'top', offset:[0,-6] })
      .addTo(_map);
    _storeMarkers.push(m);
  });
}

// ─── Инициализация карты ──────────────────────────────────
async function initMap() {
  if (_map || !window.L) return;
  const el = document.getElementById('courier-map');
  if (!el) return;
  _map = window.L.map('courier-map', {
    center:[38.562,68.776], zoom:13,
    zoomControl:true, attributionControl:false, zoomAnimation:true,
  });
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(_map);
  _map.zoomControl.setPosition('bottomright');
  setTimeout(() => _map.invalidateSize(), 300);
  await loadStores();
  renderStoreMarkers();
}

// ─── GPS ──────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) { gpsUnavailable(); return; }
  if (_geoWatchId !== null) return;
  _geoWatchId = navigator.geolocation.watchPosition(
    pos => onGPS(pos),
    err => { if (err.code === 1) gpsUnavailable(); },
    { enableHighAccuracy:true, maximumAge:5000, timeout:15000 }
  );
}
function gpsUnavailable() {
  const dot = document.getElementById('gps-pill-dot');
  const txt = document.getElementById('gps-pill-txt');
  if (dot) dot.style.background = 'var(--red)';
  if (txt) txt.textContent = 'GPS нест';
}
function onGPS(pos) {
  const lat = pos.coords.latitude, lng = pos.coords.longitude;
  const acc = Math.round(pos.coords.accuracy);
  const spd = pos.coords.speed != null ? (pos.coords.speed * 3.6).toFixed(1) : null;
  _lastPos = { lat, lng, accuracy:acc, speed:spd };
  const dot = document.getElementById('gps-pill-dot');
  const txt = document.getElementById('gps-pill-txt');
  if (dot) dot.className = 'dot on';
  if (txt) txt.innerHTML = '<span>'+acc+'м</span>' + (spd ? ' · <span>'+spd+'км/с</span>' : '');
  if (!_map) { initMap().then(() => { if (_lastPos) _map && _map.setView([lat,lng],15); }); return; }
  const icon = mkIcon('<div class="m-courier">\ud83d\udef5</div>');
  if (!_markerMe) {
    _markerMe = window.L.marker([lat,lng], { icon, zIndexOffset:1000 }).addTo(_map);
    _map.setView([lat,lng], 15);
  } else { _markerMe.setLatLng([lat,lng]).setIcon(icon); }
  if (CU && CD && CD.isOnline) {
    const now = Date.now();
    if (!onGPS._lw || now - onGPS._lw > 10000) {
      onGPS._lw = now;
      setDoc(doc(db, COL.COURIERS, CU.uid), { location:{ lat, lng, updatedAt:serverTimestamp() }, updatedAt:serverTimestamp() }, { merge:true }).catch(()=>{});
    }
  }
  if (activeOrder) updateMapRoute(activeOrder);
}

// ═══════════════════════════════════════════════════════════
//  МАРШРУТЫ ПО ФАЗАМ
//  Фаза 1 (courier_heading/courier_arrived/collecting):
//    курьер → ближайший магазин (зелёный маршрут)
//    маркер клиента серый (неактивный)
//  Фаза 2 (delivering/client_arrived):
//    курьер → клиент (синий маршрут)
//    маркер магазина убирается
// ═══════════════════════════════════════════════════════════
function updateMapRoute(order) {
  if (!_map || !_lastPos) return;
  const PHASE1 = ['courier_heading','courier_arrived','collecting'];
  const PHASE2 = ['delivering','client_arrived'];
  const phase = PHASE1.includes(order.status) ? 1 : PHASE2.includes(order.status) ? 2 : 0;
  const cLat = order.clientLat || order.deliveryLat || (order.coords && order.coords.lat);
  const cLng = order.clientLng || order.deliveryLng || (order.coords && order.coords.lng);

  // Маркер клиента (всегда)
  if (cLat && cLng) {
    const opacity = phase === 1 ? 'opacity:.45;' : '';
    const ci = mkIcon('<div class="m-client" style="'+opacity+'">\ud83d\udc64</div>', 32);
    if (!_markerClient) {
      _markerClient = window.L.marker([cLat,cLng], { icon:ci })
        .bindTooltip('<b>\u041c\u0443\u0448\u0442\u0430\u0440\u04e3</b><br>'+(order.address||''), { direction:'top', offset:[0,-6] })
        .addTo(_map);
    } else { _markerClient.setLatLng([cLat,cLng]).setIcon(ci); }
  }

  if (phase === 1) {
    const chain = order.storeChain || order.chain || null;
    const nearest = nearestStore(_lastPos.lat, _lastPos.lng, chain);
    if (nearest) {
      const si = mkIcon('<div class="m-store">\ud83c\udfea</div>', 36);
      if (!_markerStore) {
        _markerStore = window.L.marker([nearest.lat,nearest.lng], { icon:si, zIndexOffset:500 })
          .bindTooltip('<b>'+nearest.name+'</b><br>'+nearest.address+'<br><span style="color:#3ecf8e">'+Math.round(nearest.dist*1000)+'м от вас</span>', { direction:'top', permanent:false, offset:[0,-8] })
          .addTo(_map);
      } else { _markerStore.setLatLng([nearest.lat,nearest.lng]).setIcon(si); }
      drawRoute([_lastPos.lat,_lastPos.lng], [nearest.lat,nearest.lng], '#3ecf8e');
      const km = nearest.dist < 1 ? Math.round(nearest.dist*1000)+'м' : nearest.dist.toFixed(1)+'км';
      updateRoutePill('\ud83c\udfea '+nearest.name, km);
    }
  } else if (phase === 2) {
    if (_markerStore) { _markerStore.remove(); _markerStore = null; }
    if (cLat && cLng) {
      drawRoute([_lastPos.lat,_lastPos.lng], [cLat,cLng], '#3b82f6');
      const d = haversine(_lastPos.lat, _lastPos.lng, cLat, cLng);
      updateRoutePill('\ud83d\udc64 \u041c\u0443\u0448\u0442\u0430\u0440\u04e3', d < 1 ? Math.round(d*1000)+'м' : d.toFixed(1)+'км');
    }
  } else {
    clearOrderMarkers();
  }
}

function drawRoute(from, to, color) {
  const pts = [from, to];
  if (!_routeLine) {
    _routeLine = window.L.polyline(pts, { color:color, weight:3.5, opacity:.82, dashArray:'8 10' }).addTo(_map);
  } else { _routeLine.setLatLngs(pts); _routeLine.setStyle({ color:color }); }
  // НЕ фиксируем карту — пользователь может двигать её свободно
  // try { _map.fitBounds(_routeLine.getBounds(), { padding:[60,60], maxZoom:16 }); } catch(e) {}
}

function updateRoutePill(dest, dist) {
  let pill = document.getElementById('map-route-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'map-route-pill';
    pill.style.cssText = 'position:absolute;bottom:calc(var(--sheet-peek) + 58px);left:50%;transform:translateX(-50%);z-index:15;background:rgba(13,19,14,.93);backdrop-filter:blur(14px);border:1px solid var(--b1);border-radius:99px;padding:7px 16px;display:flex;align-items:center;gap:10px;font-size:.68rem;color:var(--tx);white-space:nowrap;box-shadow:0 3px 16px rgba(0,0,0,.45);pointer-events:none;';
    const dash = document.getElementById('page-dashboard') || document.getElementById('map-wrap') || document.body;
    if (dash) dash.appendChild(pill);
  }
  pill.innerHTML = '<span style="color:var(--acc2)">\u25b6</span><span style="font-weight:600">'+dest+'</span><span style="color:var(--tx3)">\u00b7</span><span style="color:var(--acc2);font-weight:700">'+dist+'</span>';
  pill.style.display = 'flex';
}
function hideRoutePill() {
  const p = document.getElementById('map-route-pill');
  if (p) p.style.display = 'none';
}

function clearOrderMarkers() {
  if (_markerStore)  { _markerStore.remove();  _markerStore  = null; }
  if (_markerClient) { _markerClient.remove(); _markerClient = null; }
  if (_routeLine)    { _routeLine.remove();    _routeLine    = null; }
  hideRoutePill();
}

window.mapCenterOnCourier = function () {
  if (!_map || !_lastPos) { toast('GPS не активно', 'err'); return; }
  _map.setView([_lastPos.lat, _lastPos.lng], 16, { animate:true });
};

function mapOnShowDashboard() {
  if (!_map) { initMap().then(startGPS); return; }
  setTimeout(() => {
    _map.invalidateSize();
    if (_lastPos) _map.setView([_lastPos.lat, _lastPos.lng], 15, { animate:false });
  }, 150);
}

// initSheetDrag — логика drag теперь в IIFE ниже (после goPage)

// ═══════════════════════════════════════════════════════════
//  ОНЛАЙН-КНОПКА В ДАШБОРДЕ
// ═══════════════════════════════════════════════════════════
window.dashToggleOnline = function() {
  const isOn = CD?.isOnline || false;
  window.toggleOnline(!isOn);
};

// ─── Обновление UI дашборда ──────────────────────────────
function updateDashUI() {
  // Аватар
  const dav  = document.getElementById('dash-av');
  if (dav) {
    const name = UD?.displayName || '';
    const init = name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?';
    dav.innerHTML = UD?.avatarUrl ? `<img src="${UD.avatarUrl}" alt="">` : init;
  }
  // Доход
  const dev  = document.getElementById('dash-earn-val');
  const des  = document.getElementById('dash-earn-sub');
  if (dev) dev.textContent = todayEarnings + ' см';
  if (des) des.textContent = todayDeliveries + ' расониш имрӯз';
  // Быстрые цифры в листе
  const qe = document.getElementById('dqs-earn');   if (qe)  qe.textContent  = todayEarnings + ' см';
  const qt = document.getElementById('dqs-today');  if (qt)  qt.textContent  = todayDeliveries;
  const qT = document.getElementById('dqs-total');  if (qT)  qT.textContent  = CD?.totalDeliveries || 0;
  const qr = document.getElementById('dqs-rating'); if (qr)  qr.textContent  = CD?.rating ? CD.rating.toFixed(1) : '—';
  // Старые id (на случай если они ещё используются где-то)
  const de = document.getElementById('d-earn');   if (de)  de.textContent  = todayEarnings + ' см';
  const dt = document.getElementById('d-today');  if (dt)  dt.textContent  = todayDeliveries;
  const dT = document.getElementById('d-total');  if (dT)  dT.textContent  = CD?.totalDeliveries || 0;
  const dr = document.getElementById('d-rating'); if (dr)  dr.textContent  = CD?.rating ? CD.rating.toFixed(1) : '—';
}

// Онлайн-кнопка в дашборде
function updateDashOnlineBtn(isOn) {
  const btn = document.getElementById('dash-online-btn');
  if (!btn) return;
  if (isOn) {
    btn.className = 'dash-online-btn online';
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Аз хат баромадан`;
  } else {
    btn.className = 'dash-online-btn offline';
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Ба хат баромадан`;
  }
}



// ─── Тарҷумаи ҳолатҳо ───────────────────────────────────────
const SL = {
  pending:         'Интизор',
  confirmed:       'Тасдиқ шуд',
  preparing:       'Омода мешавад',
  courier_heading: 'Курьер дар роҳ',
  courier_arrived: 'Расид ба дӯкон',
  collecting:      'Ҷамъоварӣ',
  delivering:      'Дар роҳ',
  client_arrived:  'Расид ба муштарӣ',
  delivered:       'Расонида шуд',
  cancelled:       'Бекор шуд',
};

// ─── Қадамҳои визуалии пайгирӣ ──────────────────────────────
const TRACK_STEPS = [
  { key: 'courier_heading', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>', label: 'Ба дӯкон' },
  { key: 'collecting',      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>', label: 'Ҷамъоварӣ' },
  { key: 'delivering',      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h11a2 2 0 012 2v3"/><rect x="9" y="11" width="14" height="10" rx="1"/><circle cx="12" cy="21" r="1"/><circle cx="20" cy="21" r="1"/></svg>', label: 'Расонидан' },
  { key: 'delivered',       icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>', label: 'Расонида шуд' },
];

// Маппинг статусов к шагам трекера
function statusToStep(status) {
  if (['pending', 'confirmed', 'preparing'].includes(status))  return -1;
  if (['courier_heading', 'courier_arrived'].includes(status)) return 0;
  if (['collecting'].includes(status))                         return 1;
  if (['delivering', 'client_arrived'].includes(status))       return 2;
  if (['delivered'].includes(status))                          return 3;
  return -1;
}

// ─── Toast ───────────────────────────────────────────────────
window.toast = function (msg, type = '') {
  const w  = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<div class="tdot"></div><span>${msg}</span>`;
  w.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

// ─── Соат ────────────────────────────────────────────────────
function tick() {
  const el = document.getElementById('tb-time');
  if (el) el.textContent = new Date().toLocaleTimeString('tg-TJ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(tick, 1000);
tick();

// ─── Auth ────────────────────────────────────────────────────
onAuthStateChanged(auth, async u => {
  if (!u) { location.href = 'login.html'; return; }
  CU = u;
  const s = await getDoc(doc(db, COL.USERS, CU.uid));
  if (!s.exists() || s.data().role !== 'courier') {
    await signOut(auth);
    location.href = 'login.html';
    return;
  }
  UD = s.data();
  const cs = await getDoc(doc(db, COL.COURIERS, CU.uid));
  CD = cs.exists()
    ? cs.data()
    : { totalDeliveries: 0, earnings: 0, rating: 0, vehicle: 'foot', isOnline: false };
  renderSB();
  renderProfile();
  calcStats();
  startListeners();
  updateDashUI();
  setTimeout(() => { initMap().then(startGPS); }, 400);
});

// ─── Проверка верификации ────────────────────────────────────
function isVerified() {
  return (CD?.verificationStatus || UD?.verificationStatus || 'unverified') === 'verified';
}

// ─── Баромадан ───────────────────────────────────────────────
window.doLogout = async function () {
  if (unsubNew)    { unsubNew();    unsubNew    = null; }
  if (unsubActive) { unsubActive(); unsubActive = null; }
  try { await setDoc(doc(db, COL.COURIERS, CU.uid), { isOnline: false, updatedAt: serverTimestamp() }, { merge: true }); } catch {}
  await signOut(auth);
  location.href = 'login.html';
};

// ─── Сайдбар ─────────────────────────────────────────────────
function renderSB() {
  const name = UD?.displayName || CU.email || 'Курьер';
  const init = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  const avatarHtml = UD?.avatarUrl ? `<img src="${UD.avatarUrl}" alt="">` : init;

  const uname = document.getElementById('sb-uname');
  if (uname) uname.textContent = name;
  const av = document.getElementById('sb-av');
  if (av) av.innerHTML = avatarHtml;

  // Дашборд аватар
  const dashAv = document.getElementById('dash-av');
  if (dashAv) dashAv.innerHTML = avatarHtml;

  updateOnlineUI(CD?.isOnline || false);
  updateEarnUI();
}

window.openSettings = function() {
  const p = document.getElementById('settings-page');
  if (p) p.classList.add('open');
};
window.closeSettings = function() {
  const p = document.getElementById('settings-page');
  if (p) p.classList.remove('open');
};
// backward-compat aliases
window.openProfileMenu  = window.openSettings;
window.closeProfileMenu = window.closeSettings;
document.addEventListener('keydown', e => { if (e.key === 'Escape') { window.closeSettings?.(); } });

// ─── Онлайн / Офлайн ─────────────────────────────────────────
window.toggleOnline = async function (v) {
  try {
    await setDoc(doc(db, COL.COURIERS, CU.uid), { isOnline: v, updatedAt: serverTimestamp() }, { merge: true });
    CD = { ...CD, isOnline: v };
    updateOnlineUI(v);
    toast(v ? 'Шумо онлайн ед' : 'Шумо офлайн ед', v ? 'ok' : '');
  } catch { toast('Хато', 'err'); }
};

function updateOnlineUI(on) {
  const tog     = document.getElementById('online-tog');     if (tog)     tog.checked = on;
  const val     = document.getElementById('sb-online-val');  if (val)     { val.textContent = on ? 'Онлайн' : 'Офлайн'; val.className = 'sb-online-val' + (on ? ' on' : ''); }
  const card    = document.getElementById('sb-online-card'); if (card)    card.className = 'sb-online' + (on ? ' is-online' : '');
  const chip    = document.getElementById('tb-chip');        if (chip)    chip.className = 'tb-chip' + (on ? ' online' : ' offline');
  const chipTxt = document.getElementById('tb-chip-txt');    if (chipTxt) chipTxt.textContent = on ? 'Онлайн' : 'Офлайн';
  // Страница настроек
  const stTog   = document.getElementById('st-online-tog');  if (stTog)   stTog.checked = on;
  const stSub   = document.getElementById('st-online-sub');  if (stSub)   stSub.textContent = on ? 'Онлайн — фармоишҳо мерасанд' : 'Офлайн — фармоишҳо нест';
  const stBlock = document.getElementById('st-online-block');if (stBlock) stBlock.className = 'settings-online-block' + (on ? ' is-online' : '');
  // Старые pms-* (если ещё остались в DOM)
  const pmsTog  = document.getElementById('pms-online-tog'); if (pmsTog)  pmsTog.checked = on;
  const pmsVal  = document.getElementById('pms-online-val'); if (pmsVal)  { pmsVal.textContent = on ? 'Онлайн' : 'Офлайн'; pmsVal.className = 'pms-online-val' + (on ? ' on' : ''); }
  const pmsCard = document.getElementById('pms-online-card');if (pmsCard) pmsCard.className = 'pms-online-row' + (on ? ' is-online' : '');
  updateDashOnlineBtn(on);
  if (!on) {
    renderNewOrdersIfOnline();
    renderDashNewIfOnline();
  }
}

function updateEarnUI() {
  const se = document.getElementById('sb-earn-val');   if (se)  se.textContent = todayEarnings + ' см';
  const pe = document.getElementById('pms-earn-val');  if (pe)  pe.textContent = todayEarnings + ' см';
  const ste= document.getElementById('st-earn-val');   if (ste) ste.textContent = todayEarnings + ' см';
  const de = document.getElementById('d-earn');        if (de)  de.textContent = todayEarnings + ' см';
  updateDashUI();
}

// ─── Садо ────────────────────────────────────────────────────
window.toggleSound = function () {
  soundEnabled = !soundEnabled;
  const b = document.getElementById('sound-btn');
  if (b) {
    b.className = 'tb-sound' + (soundEnabled ? ' on' : '');
    b.innerHTML = soundEnabled
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  }
  // Settings page sync
  const stTog = document.getElementById('st-sound-tog');
  const stSub = document.getElementById('st-sound-sub');
  if (stTog) stTog.checked = soundEnabled;
  if (stSub) stSub.textContent = soundEnabled ? 'Фаъол' : 'Хомӯш';
  toast(soundEnabled ? 'Садо фаъол шуд' : 'Бе садо', 'ok');
};

function playBeep() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 150, 300].forEach((d) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; o.type = 'sine';
      g.gain.setValueAtTime(.18, ctx.currentTime + d / 1000);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + d / 1000 + .22);
      o.start(ctx.currentTime + d / 1000);
      o.stop(ctx.currentTime + d / 1000 + .22);
    });
  } catch {}
}

// ─── Навигация ────────────────────────────────────────────────
// ─── BOTTOM SHEET + НАВИГАЦИЯ ─────────────────────────────

let _currentPage = 'dashboard';
let _sheetOpen   = false;

/** Переключить страницу: нажатие на любую кнопку нижней навигации */
window.goPage = function(page) {
  const sheet = document.getElementById('global-sheet');
  if (!sheet) return;

  _currentPage = page;

  // 1. Обновляем активную кнопку навигации
  document.querySelectorAll('.bn-item').forEach(b => {
    const id = b.id.replace('bn-', '');
    b.classList.toggle('active', id === page);
  });

  // 2. Переключаем панель контента
  document.querySelectorAll('.gs-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('gs-' + page);
  if (panel) { panel.classList.add('active'); panel.scrollTop = 0; }

  // 3. Показываем/скрываем peek
  const peek = document.getElementById('gs-peek');

  if (page === 'dashboard') {
    // Дашборд — sheet в peek, peek-контент виден
    _sheetOpen = false;
    sheet.classList.remove('open');
    if (peek) peek.style.display = '';
    renderDashNewIfOnline();
    renderDashActive();
    mapOnShowDashboard();
  } else {
    // Любая другая вкладка — sheet открыт полностью, peek скрыт
    _sheetOpen = true;
    sheet.classList.add('open');
    if (peek) peek.style.display = 'none';

    if (page === 'new-orders')  renderNewOrdersIfOnline();
    if (page === 'active')      renderActive();
    if (page === 'history')     loadHistory();
    if (page === 'profile')     renderProfile();
  }

  closeSB();
};

// Инициализируем drag на handle
(function initSheetDrag() {
  // Drag выполняется после DOM готов
  window.addEventListener('DOMContentLoaded', setupDrag);
  // На случай если DOMContentLoaded уже прошёл
  if (document.readyState !== 'loading') setupDrag();

  function setupDrag() {
    const sheet  = document.getElementById('global-sheet');
    const handle = document.getElementById('gs-handle');
    if (!sheet || !handle) return;

    let startY = 0, dragging = false, startTransY = 0;

    function getTransY() {
      const s = window.getComputedStyle(sheet);
      const m = new DOMMatrix(s.transform);
      return m.m42;
    }

    function onStart(e) {
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startTransY = getTransY();
      sheet.style.transition = 'none';
    }

    function onMove(e) {
      if (!dragging) return;
      if (e.cancelable) e.preventDefault();
      const y  = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = y - startY;
      const newY = Math.max(0, startTransY + dy);
      sheet.style.transform = `translateY(${newY}px)`;
    }

    function onEnd(e) {
      if (!dragging) return;
      dragging = false;
      sheet.style.transition = '';
      const y  = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
      const dy = y - startY;

      if (_sheetOpen) {
        // Если потянули вниз > 100px — возвращаем на дашборд
        if (dy > 100) {
          goPage('dashboard');
        } else {
          sheet.classList.add('open');
        }
      } else {
        // Если потянули вверх > 60px — открываем (показываем дашборд-панель)
        if (dy < -60) {
          sheet.classList.add('open');
          _sheetOpen = true;
          const peek = document.getElementById('gs-peek');
          if (peek) peek.style.display = 'none';
        } else {
          sheet.classList.remove('open');
        }
      }
      sheet.style.transform = '';
    }

    handle.addEventListener('touchstart', onStart, { passive: true });
    handle.addEventListener('touchmove',  onMove,  { passive: false });
    handle.addEventListener('touchend',   onEnd);
    handle.addEventListener('mousedown',  onStart);
    window.addEventListener('mousemove',  e => { if (dragging) onMove(e); });
    window.addEventListener('mouseup',    e => { if (dragging) onEnd(e); });
  }
})();

// switchTab — псевдоним для обратной совместимости
window.switchTab = window.goPage;

window.toggleSidebar = function () {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sb-overlay').classList.toggle('open');
};

window.closeSB = function () {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sb-overlay').classList.remove('open');
};

document.getElementById('sb-overlay')?.addEventListener('click', closeSB);

// ─── Омор ────────────────────────────────────────────────────
async function calcStats() {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q   = query(collection(db, COL.ORDERS), where('courierId', '==', CU.uid), where('status', '==', 'delivered'));
    const sn  = await getDocs(q);
    const all = sn.docs.map(d => d.data());
    const td  = all.filter(o => o.updatedAt?.toDate && o.updatedAt.toDate() >= today);
    todayDeliveries = td.length;
    todayEarnings   = todayDeliveries * EPD;
    const dt  = document.getElementById('d-today');   if (dt)  dt.textContent  = todayDeliveries;
    const dT  = document.getElementById('d-total');   if (dT)  dT.textContent  = CD?.totalDeliveries || 0;
    const dr  = document.getElementById('d-rating');  if (dr)  dr.textContent  = CD?.rating ? CD.rating.toFixed(1) : '—';
    updateEarnUI();
    const pst = document.getElementById('ps-total');  if (pst) pst.textContent = CD?.totalDeliveries || 0;
    const pse = document.getElementById('ps-earn');   if (pse) pse.textContent = (CD?.earnings || 0) + ' см';
    const psr = document.getElementById('ps-rating'); if (psr) psr.textContent = CD?.rating ? CD.rating.toFixed(1) : '—';
  } catch {}
}

// ─── Realtime слушатели ──────────────────────────────────────
function startListeners() {
  if (!isVerified()) return; // не слушаем заказы для неверифицированных
  listenNew();
  listenActive();
}

function listenNew() {
  if (unsubNew) { unsubNew(); unsubNew = null; }
  const q   = query(collection(db, COL.ORDERS), where('status', 'in', ['pending', 'confirmed']), where('courierId', '==', null));
  let first = true;
  unsubNew  = onSnapshot(q, sn => {
    const prev = newOrders.length;
    newOrders  = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    updateNewBadge();
    renderNewOrdersIfOnline();
    renderDashNewIfOnline();
    if (!first && newOrders.length > prev && CD?.isOnline) {
      playBeep(); toast('Фармоиши нав!', 'info'); renderNotif();
    }
    first = false;
  });
}

// Рендерит новые заказы ТОЛЬКО если курьер онлайн
function renderNewOrdersIfOnline() {
  const el = document.getElementById('new-orders-list');
  if (!el) return;
  if (!CD?.isOnline) {
    el.innerHTML = `<div class="empty"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg></div><div class="empty-t">Шумо офлайн ед</div><div class="empty-s">Барои дидани фармоишҳо онлайн шавед</div></div>`;
    return;
  }
  renderNewOrders();
}

function renderDashNewIfOnline() {
  if (!CD?.isOnline) {
    const el = document.getElementById('dash-new-orders');
    if (el) el.innerHTML = `<div class="empty" style="padding:28px 20px"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg></div><div class="empty-t">Офлайн</div><div class="empty-s">Фармоишҳо пас аз онлайн шудан намоён мешаванд</div></div>`;
    const notif = document.getElementById('notif-wrap');
    if (notif) notif.innerHTML = '';
    const title = document.getElementById('dash-new-title');
    if (title) title.style.display = 'none';
    const badge = document.getElementById('dash-badge-num');
    if (badge) badge.textContent = '0';
    return;
  }
  renderDashNew();
}

function listenActive() {
  if (unsubActive) { unsubActive(); unsubActive = null; }
  const q = query(
    collection(db, COL.ORDERS),
    where('courierId', '==', CU.uid),
    where('status', 'in', ['courier_heading', 'courier_arrived', 'collecting', 'delivering', 'client_arrived']),
    limit(1)
  );
  unsubActive = onSnapshot(q, sn => {
    activeOrder = sn.empty ? null : { id: sn.docs[0].id, ...sn.docs[0].data() };
    renderActive();
    renderDashActive();
    updateActiveBadge();
    // Карта: показываем/убираем маркеры заказа
    if (activeOrder) {
      if (_lastPos) updateMapRoute(activeOrder);
    } else {
      clearOrderMarkers();
      if (_map && _lastPos) _map.setView([_lastPos.lat, _lastPos.lng], 15, { animate: true });
    }
  });
}

// ─── Бейджи ──────────────────────────────────────────────────
function updateNewBadge() {
  const cnt = newOrders.length;
  ['new-badge', 'mob-new-badge', 'pms-new-badge', 'st-new-badge'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.style.display = cnt > 0 ? '' : 'none'; b.textContent = cnt; }
  });
  const el = document.getElementById('new-count-txt');
  if (el) el.textContent = cnt + ' фармоиш';
}

function updateActiveBadge() {
  ['active-badge', 'mob-active-badge', 'pms-active-badge', 'st-active-badge'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = activeOrder ? '' : 'none';
  });
}

// ─── Карточка нового заказа ───────────────────────────────────
function orderCard(o, withCountdown = false) {
  const items = (o.items || []).map(i => `${i.name} ×${i.quantity}`).join(', ');
  const time  = o.createdAt?.toDate ? o.createdAt.toDate().toLocaleTimeString('tg-TJ', { hour: '2-digit', minute: '2-digit' }) : '—';
  const pay   = o.paymentMethod === 'cash' ? 'Нақдӣ' : o.paymentMethod === 'card' ? 'Корт' : 'Онлайн';
  const total = o.total || 0;
  return `<div class="oc" id="oc-${o.id}">
    <div class="oc-top">
      <div class="oc-left">
        <div class="oc-meta">
          <span class="oc-num">#${o.orderNumber || o.id.slice(-6).toUpperCase()}</span>
          <span class="oc-pill">${SL[o.status] || o.status}</span>
        </div>
        <div class="oc-addr">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${o.address || 'Суроғ нест'}
        </div>
      </div>
      <div class="oc-time-wrap">
        <div class="oc-time">${time}</div>
        <div class="oc-earn-badge">${EPD} см</div>
      </div>
    </div>
    ${withCountdown ? `<div class="cd-wrap"><div class="cd-track"><div class="cd-fill" id="cd-${o.id}"></div></div><div class="cd-row"><span>Қабул кунед</span><span id="cd-txt-${o.id}">60с</span></div></div>` : ''}
    <div class="oc-items-box">
      <div class="oc-items-label">Таркиб</div>
      <div class="oc-items-text">${items}</div>
    </div>
    <div class="oc-footer">
      <div class="oc-chips">
        <span class="oc-chip"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="1"/><path d="M2 10h20"/></svg>${pay}</span>
        <span class="oc-chip"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>${total} см</span>
        ${o.comment ? `<span class="oc-chip"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>${o.comment}</span>` : ''}
      </div>
    </div>
    <div style="padding:0 0 4px">
      ${activeOrder
        ? `<div style="width:100%;padding:14px 16px;background:var(--s3);border-radius:14px;text-align:center;font-size:.74rem;color:var(--tx3);border:1.5px solid var(--b0)">Фармоиши фаъол дорад</div>`
        : `<div class="swipe-btn-wrap" id="swipe-${o.id}" data-oid="${o.id}">
            <div class="swipe-btn-fill" id="swipe-fill-${o.id}"></div>
            <div class="swipe-btn-thumb" id="swipe-thumb-${o.id}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </div>
            <div class="swipe-btn-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
              Свайп барои қабул
            </div>
          </div>`
      }
    </div>
  </div>`;
}

// ─── Обратный отсчёт ─────────────────────────────────────────
const CDS = {};
function startCD(oid) {
  if (CDS[oid]) return;
  let s = 60;
  CDS[oid] = setInterval(() => {
    s--;
    const bar = document.getElementById('cd-' + oid);
    const txt = document.getElementById('cd-txt-' + oid);
    if (bar) { bar.style.width = (s / 60 * 100) + '%'; bar.style.background = s < 15 ? 'var(--red)' : s < 30 ? 'var(--amber)' : 'var(--acc)'; }
    if (txt) txt.textContent = s + 'с';
    if (s <= 0) { clearInterval(CDS[oid]); delete CDS[oid]; }
  }, 1000);
}

// ─── Рендер новых заказов ────────────────────────────────────
function renderNewOrders() {
  const el = document.getElementById('new-orders-list');
  if (!el) return;
  const sorted = [...newOrders].sort((a, b) => (a.createdAt?.toDate?.().getTime() || 0) - (b.createdAt?.toDate?.().getTime() || 0));
  if (!sorted.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg></div><div class="empty-t">Фармоишҳои нав нест</div><div class="empty-s">Фармоишҳо автоматӣ пайдо мешаванд</div></div>`;
    return;
  }
  el.innerHTML = sorted.map((o, i) => orderCard(o, i === 0)).join('');
  if (sorted[0]) startCD(sorted[0].id);
  initSwipeButtons();
}

function renderDashNew() {
  const el = document.getElementById('dash-new-orders');
  if (!el) return;
  const sorted = [...newOrders].sort((a, b) => (a.createdAt?.toDate?.().getTime() || 0) - (b.createdAt?.toDate?.().getTime() || 0));

  // Бейдж сверху
  const badge = document.getElementById('dash-badge-num');
  if (badge) badge.textContent = sorted.length;

  // Заголовок секции
  const title = document.getElementById('dash-new-title');
  if (title) title.style.display = sorted.length ? '' : 'none';

  if (!sorted.length) {
    el.innerHTML = `<div class="empty" style="padding:28px 20px"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg></div><div class="empty-t">Фармоишҳо нест</div><div class="empty-s">Интизор ем…</div></div>`;
    renderNotif(); return;
  }
  el.innerHTML = sorted.slice(0, 2).map(o => orderCard(o)).join('');
  initSwipeButtons();
  renderNotif();
}

function renderNotif() {
  const w = document.getElementById('notif-wrap');
  if (!w) return;
  if (!newOrders.length) { w.innerHTML = ''; return; }
  w.innerHTML = `<div class="live-banner" onclick="goPage('new-orders')">
    <div class="live-pulse"></div>
    <div class="live-info"><div class="live-lbl">Фармоишҳои нав</div><div class="live-txt">${newOrders.length} фармоиш интизори курьер аст</div></div>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}

// ─── Свайп-кнопки для принятия заказов ─────────────────────
function initSwipeButtons() {
  document.querySelectorAll('.swipe-btn-wrap:not([data-swipe-init])').forEach(wrap => {
    wrap.setAttribute('data-swipe-init', '1');
    const oid   = wrap.getAttribute('data-oid');
    const thumb = wrap.querySelector('.swipe-btn-thumb');
    const fill  = wrap.querySelector('.swipe-btn-fill');
    if (!thumb || !oid) return;

    let startX = 0, dragging = false;

    function getMax() {
      return wrap.clientWidth - thumb.clientWidth - 8;
    }

    function onStart(e) {
      if (wrap.classList.contains('done')) return;
      startX   = (e.touches ? e.touches[0].clientX : e.clientX);
      dragging = true;
      thumb.style.transition = 'none';
      if (fill) fill.style.transition = 'none';
    }

    function onMove(e) {
      if (!dragging) return;
      if (e.cancelable) e.preventDefault();
      const x   = (e.touches ? e.touches[0].clientX : e.clientX);
      const dx  = Math.max(0, Math.min(x - startX, getMax()));
      thumb.style.left = (4 + dx) + 'px';
      if (fill) fill.style.width = (dx / getMax() * 100) + '%';
    }

    function onEnd(e) {
      if (!dragging) return;
      dragging = false;
      const x   = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX);
      const dx  = x - startX;
      const max = getMax();

      if (dx >= max * 0.82) {
        // Свайп завершён — принять заказ
        wrap.classList.add('done');
        thumb.style.transition = '';
        if (fill) fill.style.transition = '';
        setTimeout(() => acceptOrder(oid), 260);
      } else {
        // Вернуть в начало
        thumb.style.transition = 'left .3s var(--spring)';
        thumb.style.left = '4px';
        if (fill) { fill.style.transition = 'width .3s'; fill.style.width = '0'; }
      }
    }

    thumb.addEventListener('touchstart', onStart, { passive:true });
    thumb.addEventListener('touchmove',  onMove,  { passive:false });
    thumb.addEventListener('touchend',   onEnd);
    thumb.addEventListener('mousedown',  onStart);
    window.addEventListener('mousemove', e => dragging && onMove(e));
    window.addEventListener('mouseup',   e => dragging && onEnd(e));
  });
}

// ─── Қабули фармоиш ──────────────────────────────────────────
window.acceptOrder = async function (oid) {
  if (!isVerified()) { toast('Ҳувият тасдиқ нашудааст', 'err'); return; }
  if (activeOrder) { toast('Шумо аллакай фармоиш доред', 'err'); return; }
  const btn = document.getElementById('btn-' + oid);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin" style="width:13px;height:13px;border-color:rgba(0,0,0,.2);border-top-color:#000"></div>'; }
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), {
      courierId:   CU.uid,
      courierName: UD?.displayName || '',
      status:      'courier_heading',
      updatedAt:   serverTimestamp(),
    });
    await setDoc(doc(db, COL.COURIERS, CU.uid), {
      currentOrderId: oid, isActive: true, isOnline: true, updatedAt: serverTimestamp(),
    }, { merge: true });
    CD = { ...CD, currentOrderId: oid, isActive: true, isOnline: true };
    updateOnlineUI(true);
    checkedItems = new Set();
    toast('Фармоиш қабул шуд!', 'ok');
    // Обновляем карту с маршрутом
    if (_lastPos && activeOrder) updateMapRoute(activeOrder);
    goPage('active');
  } catch (e) {
    toast('Хато: ' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Қабул'; }
  }
};

// ═══════════════════════════════════════════════════════════
//  3-ҚАДАМАИ ФЛОУ РАСОНИДАН  —  Нав, пурра, касбӣ
// ═══════════════════════════════════════════════════════════

// Степ-бар наверху (горизонтальный, с номерами)
function renderStepBar(currentStep) {
  const steps = [
    { n: 1, label: 'Ба дӯкон',  sub: 'Қадами 1',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>` },
    { n: 2, label: 'Ҷамъоварӣ', sub: 'Қадами 2',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>` },
    { n: 3, label: 'Расонидан', sub: 'Қадами 3',
      icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h11a2 2 0 012 2v3"/><rect x="9" y="11" width="14" height="10" rx="1"/><circle cx="12" cy="21" r="1"/><circle cx="20" cy="21" r="1"/></svg>` },
  ];
  return `<div class="fsb">
    ${steps.map((s, i) => {
      const state = s.n < currentStep ? 'done' : s.n === currentStep ? 'cur' : '';
      const isDone = s.n < currentStep;
      return `<div class="fsb-step ${state}">
        <div class="fsb-dot">
          ${isDone
            ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
            : s.icon}
        </div>
        <div class="fsb-step-inner">
          <div class="fsb-lbl">${s.label}</div>
          <div class="fsb-lbl-sub">${isDone ? 'Тайёр' : s.sub}</div>
        </div>
        ${i < steps.length - 1 ? '<div class="fsb-line"></div>' : ''}
      </div>`;
    }).join('')}
  </div>`;
}

// Мини-шапка заказа (компактная, всегда видна)
function renderOrderBadge(o) {
  const pay = o.paymentMethod === 'cash' ? 'Нақдӣ' : o.paymentMethod === 'card' ? 'Корт' : 'Онлайн';
  return `<div class="ob">
    <div class="ob-left">
      <div class="ob-num">#${o.orderNumber || o.id.slice(-6).toUpperCase()}</div>
      <div class="ob-client">${o.clientName || 'Муштарӣ'}</div>
    </div>
    <div class="ob-chips">
      <span class="ob-chip pay">${pay}</span>
      <span class="ob-chip total">${o.total || 0} см</span>
      <span class="ob-chip earn">+${EPD} см</span>
    </div>
  </div>`;
}

// ─── ШАГ 1: Ба дӯкон ──────────────────────────────────────
function renderStep1(o) {
  const arrived = o.status === 'courier_arrived';
  const itemCount = (o.items || []).reduce((s, i) => s + i.quantity, 0);
  const totalItems = (o.items || []).length;

  // Превью товаров — иконки
  const itemPreviews = (o.items || []).slice(0, 4).map(item => {
    const img = item.imageUrl
      ? `<img src="${item.imageUrl}" alt="${item.name}" style="width:100%;height:100%;object-fit:cover;border-radius:9px">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.4rem;opacity:.6"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg></div>`;
    return `<div class="s1-thumb">${img}</div>`;
  }).join('');

  return `
  <div class="flow-panel">
    ${renderStepBar(1)}
    ${renderOrderBadge(o)}

    <!-- Hero блок -->
    <div class="s1-hero ${arrived ? 'arrived' : ''}">
      <div class="s1-hero-icon">${arrived ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>'}</div>
      <div class="s1-hero-body">
        <div class="s1-hero-title">${arrived ? 'Расидед ба дӯкон!' : 'Ба дӯкон равед'}</div>
        <div class="s1-hero-sub">${arrived ? 'Молҳоро ҷамъ кардан мумкин аст' : 'Galelium · Дӯкони марказӣ'}</div>
      </div>
    </div>

    <!-- Карточка магазина -->
    <div class="info-card">
      <div class="info-card-icon" style="background:var(--accd);color:var(--acc2)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </div>
      <div class="info-card-body">
        <div class="info-card-lbl">Дӯкон</div>
        <div class="info-card-val">Galelium · Дӯкони марказӣ</div>
        <div class="info-card-sub">Суроғи дӯкон дар харита</div>
      </div>
      <div class="info-card-arrow">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
    </div>

    <!-- Превью заказа -->
    <div class="s1-order-preview">
      <div class="s1-op-header">
        <div class="s1-op-title">Таркиби фармоиш</div>
        <div class="s1-op-count">${itemCount} мол · ${totalItems} навъ</div>
      </div>
      <div class="s1-thumbs">${itemPreviews}${(o.items || []).length > 4 ? `<div class="s1-thumb-more">+${(o.items||[]).length - 4}</div>` : ''}</div>
      <div class="s1-items-list">
        ${(o.items || []).map(item => `
          <div class="s1-item">
            <div class="s1-item-img">
              ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${item.name}">` : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".3"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>'}
            </div>
            <div class="s1-item-info">
              <div class="s1-item-name">${item.name}</div>
              <div class="s1-item-price">${item.price} см · ${item.quantity} дона</div>
            </div>
            <div class="s1-item-qty">×${item.quantity}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Кнопки -->
    <div class="flow-actions">
      ${arrived
        ? `<button class="btn-flow-next" onclick="advance('${o.id}','collecting')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
            Ба ҷамъоварӣ гузаред
          </button>`
        : `<button class="btn-flow-primary" onclick="advance('${o.id}','courier_arrived')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Расидам ба дӯкон
          </button>`
      }
    </div>
  </div>`;
}

// ─── ШАГ 2: Ҷамъоварӣ + Сканери штрих-код ───────────────
// Состояние сканера
let scannerActive    = false;    // открыт ли оверлей сканера
let scannerItemKey   = null;     // ключ текущего элемента (idx-q)
let scannerItemName  = '';       // название товара для UI
let scannerExpected  = null;     // ожидаемый штрихкод из Firestore
let scannerOid       = null;     // id заказа
let barcodeStream    = null;     // MediaStream камеры
let barcodeDetector  = null;     // BarcodeDetector API
let barcodeRAF       = null;     // requestAnimationFrame handle

function renderStep2(o) {
  const items   = o.items || [];
  const all     = items.reduce((s, i) => s + i.quantity, 0);
  const done    = checkedItems.size;
  const pct     = all > 0 ? Math.round(done / all * 100) : 0;
  const allDone = done >= all;

  let itemBlocks = '';
  items.forEach((item, idx) => {
    for (let q = 0; q < item.quantity; q++) {
      const key = `${idx}-${q}`;
      const chk = checkedItems.has(key);
      const imgHtml = item.imageUrl
        ? `<img src="${item.imageUrl}" alt="${item.name}">`
        : `<div class="ci-no-img"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg></div>`;
      const hasBarcode = !!item.barcode;
      itemBlocks += `
        <div class="ci-block ${chk ? 'checked' : ''}" onclick="${chk ? '' : `openScanner('${key}','${o.id}',${idx})`}">
          <div class="ci-block-img ${chk ? 'done' : ''}">${imgHtml}
            ${chk ? `<div class="ci-block-overlay"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>` : ''}
          </div>
          <div class="ci-block-body">
            <div class="ci-block-name">${item.name}</div>
            <div class="ci-block-meta">
              <span class="ci-block-price">${item.price} см</span>
              ${item.quantity > 1 ? `<span class="ci-block-badge">${q + 1} / ${item.quantity}</span>` : ''}
              ${hasBarcode ? `<span class="ci-block-barcode-chip">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <rect x="2" y="4" width="3" height="16" rx="1"/><rect x="7" y="4" width="1.5" height="16" rx=".5"/>
                  <rect x="10" y="4" width="3" height="16" rx="1"/><rect x="15" y="4" width="1.5" height="16" rx=".5"/>
                  <rect x="18" y="4" width="3" height="16" rx="1"/>
                </svg>
                Штрих-код
              </span>` : `<span class="ci-block-nobc-chip">Без штрих-кода</span>`}
            </div>
          </div>
          <div class="ci-block-check ${chk ? 'on' : ''}">
            ${chk
              ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="4" width="3" height="16" rx="1"/><rect x="7" y="4" width="1.5" height="16" rx=".5"/>
                  <rect x="10" y="4" width="3" height="16" rx="1"/><rect x="15" y="4" width="1.5" height="16" rx=".5"/>
                  <rect x="18" y="4" width="3" height="16" rx="1"/>
                </svg>`
            }
          </div>
        </div>`;
    }
  });

  return `
  <div class="flow-panel">
    ${renderStepBar(2)}
    ${renderOrderBadge(o)}

    <div class="collect-hero">
      <div class="collect-hero-left">
      <div class="collect-hero-nums">
        <span class="collect-done">${done}</span>
        <span class="collect-sep">/</span>
        <span class="collect-total">${all}</span>
      </div>
      <div class="collect-hero-lbl">мол гирифта шуд</div>
      </div>
      <div class="collect-ring-wrap">
        <svg class="collect-ring" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="28" fill="none" stroke="var(--s3)" stroke-width="5"/>
          <circle cx="32" cy="32" r="28" fill="none" stroke="var(--acc)" stroke-width="5"
            stroke-dasharray="${2 * Math.PI * 28}" stroke-dashoffset="${2 * Math.PI * 28 * (1 - pct / 100)}"
            stroke-linecap="round" transform="rotate(-90 32 32)"
            style="transition:stroke-dashoffset .5s var(--ease)"/>
        </svg>
        <div class="collect-ring-pct">${pct}%</div>
      </div>
    </div>

    <div class="ci-hint">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="4" width="3" height="16" rx="1"/><rect x="7" y="4" width="1.5" height="16" rx=".5"/>
        <rect x="10" y="4" width="3" height="16" rx="1"/><rect x="15" y="4" width="1.5" height="16" rx=".5"/>
        <rect x="18" y="4" width="3" height="16" rx="1"/>
      </svg>
      Ҳар молро пахш кунед — штрих-кодро скан мекунед
    </div>

    <div class="ci-list">${itemBlocks}</div>

    <div class="flow-actions">
      ${allDone
        ? `<button class="btn-flow-next" onclick="confirmCollect('${o.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            Ҳама гирифтам — тасдиқ
          </button>`
        : `<div class="collect-remain">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
            Ҳоло <strong>${all - done}</strong> мол монд — штрих-кодро скан кунед
          </div>`
      }
    </div>
  </div>`;
}

// ─── СКАНЕР ШТРИХ-КОДА ───────────────────────────────────

// Открыть полноэкранный экран товара
window.openScanner = async function (key, oid, itemIdx) {
  if (scannerActive) return;
  const o = activeOrder;
  if (!o) return;
  const item = (o.items || [])[itemIdx];
  if (!item) return;

  scannerItemKey  = key;
  scannerOid      = oid;
  scannerItemName = item.name;

  // Получаем штрихкод
  if (item.barcode) {
    scannerExpected = item.barcode;
  } else if (item.productId) {
    try {
      const snap = await getDoc(doc(db, COL.PRODUCTS || 'products', item.productId));
      scannerExpected = snap.exists() ? (snap.data().barcode || null) : null;
    } catch { scannerExpected = null; }
  } else {
    scannerExpected = null;
  }

  openItemDetail(item, key, o);
};

// ─── Полноэкранный экран товара ──────────────────────────
let idpStream = null;
let idpDetector = null;
let idpRAF = null;
let idpCamActive = false;

function openItemDetail(item, key, order) {
  const page = document.getElementById('item-detail-page');
  if (!page) return;

  // Прогресс
  const items = order.items || [];
  const total = items.reduce((s, i) => s + i.quantity, 0);
  const done  = checkedItems.size;
  const pct   = total > 0 ? Math.round(done / total * 100) : 0;

  // Заголовок
  const titleEl = document.getElementById('idp-title');
  if (titleEl) titleEl.textContent = 'Собрать товар';
  const chipEl = document.getElementById('idp-chip');
  if (chipEl) chipEl.textContent = `${done} / ${total}`;
  const fillEl = document.getElementById('idp-progress-fill');
  if (fillEl) fillEl.style.width = pct + '%';

  // Фото
  const imgWrap = document.getElementById('idp-img-wrap');
  const imgPh   = document.getElementById('idp-img-placeholder');
  if (imgWrap) {
    const existing = imgWrap.querySelector('img');
    if (existing) existing.remove();
    if (item.imageUrl) {
      if (imgPh) imgPh.style.display = 'none';
      const img = document.createElement('img');
      img.src = item.imageUrl;
      img.alt = item.name;
      imgWrap.appendChild(img);
    } else {
      if (imgPh) { imgPh.style.display = ''; imgPh.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".3"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>'; }
    }
  }

  // Название / цена
  const nameEl  = document.getElementById('idp-name');
  const priceEl = document.getElementById('idp-price');
  const skuEl   = document.getElementById('idp-sku');
  if (nameEl)  nameEl.textContent  = item.name || '—';
  if (priceEl) priceEl.textContent = item.price ? `${item.price} см / шт.` : '';
  if (skuEl)   skuEl.textContent   = item.sku || item.barcode || '';

  // Мета-сетка
  const metaEl = document.getElementById('idp-meta');
  if (metaEl) {
    const qty    = item.quantity || 1;
    const weight = item.weight   ? item.weight + ' кг' : '—';
    const art    = item.article  || item.productId || '—';
    const price  = item.price    ? item.price + ' см' : '—';
    metaEl.innerHTML = `
      <div class="idp-meta-cell"><div class="idp-meta-val">${price}</div><div class="idp-meta-lbl">Цена / шт</div></div>
      <div class="idp-meta-cell"><div class="idp-meta-val">${qty} шт.</div><div class="idp-meta-lbl">Кол-во</div></div>
      <div class="idp-meta-cell"><div class="idp-meta-val">${weight}</div><div class="idp-meta-lbl">Вес</div></div>
      <div class="idp-meta-cell"><div class="idp-meta-val" style="font-size:.64rem">${art}</div><div class="idp-meta-lbl">Артикул</div></div>
    `;
  }

  // Штрихкод
  const bcWrap = document.getElementById('idp-bc-wrap');
  if (bcWrap) {
    if (scannerExpected) {
      bcWrap.innerHTML = `
        <div class="idp-bc-row">
          <svg class="idp-bc-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="4" width="3" height="16" rx="1"/><rect x="7" y="4" width="1.5" height="16" rx=".5"/>
            <rect x="10" y="4" width="3" height="16" rx="1"/><rect x="15" y="4" width="1.5" height="16" rx=".5"/>
            <rect x="18" y="4" width="3" height="16" rx="1"/>
          </svg>
          <span class="idp-bc-val">${scannerExpected}</span>
          <span class="idp-bc-lbl">Штрих-код</span>
        </div>`;
    } else {
      bcWrap.innerHTML = `<div class="idp-nobc-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Штрих-код отсутствует — подтвердите вручную</div>`;
    }
  }

  // Предупреждение о сроке
  const warnEl = document.getElementById('idp-warn');
  if (warnEl) {
    if (item.expiryWarning || item.minDate) {
      warnEl.style.display = '';
      const dateEl = document.getElementById('idp-warn-date');
      if (dateEl) dateEl.textContent = item.minDate || '';
    } else {
      warnEl.style.display = 'none';
    }
  }

  // Кнопка сканирования — если нет штрихкода, меняем текст (сохраняя иконку)
  const scanBtn = document.getElementById('idp-btn-scan');
  if (scanBtn) {
    const hasBC = !!scannerExpected;
    scanBtn.innerHTML = hasBC
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="4" width="3" height="16" rx="1"/><rect x="7" y="4" width="1.5" height="16" rx=".5"/><rect x="10" y="4" width="3" height="16" rx="1"/><rect x="15" y="4" width="1.5" height="16" rx=".5"/><rect x="18" y="4" width="3" height="16" rx="1"/></svg>Сканировать товар`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Подтвердить товар`;
    scanBtn.onclick = hasBC ? openItemCamera : confirmItemManual;
  }

  page.classList.add('open');
}

window.closeItemDetail = function () {
  closeItemCamera();
  const page = document.getElementById('item-detail-page');
  if (page) page.classList.remove('open');
};

// Открыть камеру внутри экрана товара
window.openItemCamera = async function () {
  if (idpCamActive) return;
  const overlay = document.getElementById('idp-cam-overlay');
  if (!overlay) return;

  if (!('BarcodeDetector' in window)) {
    // Браузер не поддерживает — подтверждаем вручную
    toast('Камера дастгирӣ намешавад — дастӣ тасдиқ кунед', 'warn');
    confirmItemManual();
    return;
  }

  try {
    idpStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    const video = document.getElementById('idp-video');
    if (!video) return;
    video.srcObject = idpStream;
    await video.play();

    idpDetector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix']
    });
    idpCamActive = true;
    overlay.classList.add('open');
    idpDetectLoop(video);
  } catch (e) {
    toast('Камера недоступна: ' + e.message, 'warn');
  }
};

let idpLastCode = null;
let idpLastTime = 0;

function idpDetectLoop(video) {
  if (!idpCamActive || !idpDetector) return;
  idpRAF = requestAnimationFrame(async () => {
    try {
      const codes = await idpDetector.detect(video);
      if (codes.length > 0) {
        const now  = Date.now();
        const code = codes[0].rawValue;
        if (code !== idpLastCode || now - idpLastTime > 2000) {
          idpLastCode = code;
          idpLastTime = now;
          idpHandleCode(code);
          return;
        }
      }
    } catch {}
    idpDetectLoop(video);
  });
}

function idpHandleCode(code) {
  if (idpRAF) { cancelAnimationFrame(idpRAF); idpRAF = null; }
  const hint = document.getElementById('idp-cam-hint');
  const res  = document.getElementById('idp-scan-result');

  if (!scannerExpected) {
    // Нет штрихкода — любой код подтверждает
    if (res) { res.className = 'idp-scan-result ok'; res.textContent = 'Товар подтверждён'; }
    playSuccessBeep();
    if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
    setTimeout(() => { closeItemCamera(); idpMarkDone(); }, 700);
    return;
  }

  const clean    = code.trim().replace(/\s/g, '');
  const expected = String(scannerExpected).trim().replace(/\s/g, '');

  if (clean === expected) {
    if (res) { res.className = 'idp-scan-result ok'; res.textContent = 'Штрих-код совпадает!'; }
    playSuccessBeep();
    if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
    setTimeout(() => { closeItemCamera(); idpMarkDone(); }, 700);
  } else {
    if (res) { res.className = 'idp-scan-result err'; res.textContent = `Не совпадает: ${clean}`; }
    if (hint) hint.textContent = `Ожидается: ${expected}`;
    playErrorBeep();
    // Через 2с продолжаем
    setTimeout(() => {
      if (res) { res.className = 'idp-scan-result'; res.textContent = ''; }
      if (hint) hint.textContent = 'Наведите камеру на штрих-код';
      const video = document.getElementById('idp-video');
      if (video && idpCamActive) idpDetectLoop(video);
    }, 2000);
  }
}

window.closeItemCamera = function () {
  idpCamActive = false;
  if (idpRAF)    { cancelAnimationFrame(idpRAF); idpRAF = null; }
  if (idpStream) { idpStream.getTracks().forEach(t => t.stop()); idpStream = null; }
  idpDetector  = null;
  idpLastCode  = null;
  const overlay = document.getElementById('idp-cam-overlay');
  if (overlay) overlay.classList.remove('open');
};

// Подтвердить вручную (нет штрихкода / товар отсутствует)
window.confirmItemManual = function () {
  closeItemCamera();
  closeItemDetail();
  idpMarkDone();
};

function idpMarkDone() {
  const key = scannerItemKey;
  scannerActive = false;
  if (key) {
    checkedItems.add(key);
    renderActive();
    if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
  }
  closeItemDetail();
}

// (Старый closeScanner оставляем для совместимости)
window.closeScanner = function () {
  scannerActive = false;
  if (barcodeRAF)   { cancelAnimationFrame(barcodeRAF); barcodeRAF = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
  barcodeDetector = null;
  lastDetected    = null;
  const ov = document.getElementById('scanner-overlay');
  if (ov) ov.classList.remove('open');
};

// Звуки обратной связи
function playSuccessBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 1200; o.type = 'sine';
    g.gain.setValueAtTime(.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .25);
    o.start(); o.stop(ctx.currentTime + .25);
  } catch {}
}

function playErrorBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 150].forEach(d => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 300; o.type = 'sawtooth';
      g.gain.setValueAtTime(.12, ctx.currentTime + d / 1000);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + d / 1000 + .18);
      o.start(ctx.currentTime + d / 1000);
      o.stop(ctx.currentTime + d / 1000 + .18);
    });
  } catch {}
}

// ─── ШАГ 3: Расонидан ────────────────────────────────────
function renderStep3(o) {
  const atClient  = o.status === 'client_arrived';
  const itemCount = (o.items || []).reduce((s, i) => s + i.quantity, 0);
  const pay = o.paymentMethod === 'cash' ? 'Нақдӣ ба курьер' : o.paymentMethod === 'card' ? 'Корт' : 'Онлайн';

  return `
  <div class="flow-panel s3c">
    ${renderStepBar(3)}
    ${renderOrderBadge(o)}

    <!-- Статус -->
    <div class="s3c-status ${atClient ? 'green' : 'blue'}">
      <div class="s3c-status-dot"></div>
      <div class="s3c-status-txt">${atClient ? 'Расидед ба муштарӣ' : 'Дар роҳ ба муштарӣ'}</div>
    </div>

    <!-- Адрес + Оплата (одна карточка) -->
    <div class="s3c-card">
      <div class="s3c-row clickable">
        <div class="s3c-row-ico" style="background:rgba(59,130,246,.12);color:#60a5fa">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <div class="s3c-row-body">
          <div class="s3c-row-lbl">Суроға</div>
          <div class="s3c-row-val">${o.address || '—'}</div>
          ${o.comment ? `<div class="s3c-row-sub"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> ${o.comment}</div>` : ''}
        </div>
        <svg class="s3c-row-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
      <div class="s3c-row">
        <div class="s3c-row-ico" style="background:var(--amberd);color:var(--amber)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="1"/><path d="M2 10h20"/></svg>
        </div>
        <div class="s3c-row-body">
          <div class="s3c-row-lbl">Пардохт</div>
          <div class="s3c-row-val">${pay} · ${o.total || 0} см</div>
        </div>
      </div>
    </div>

    <!-- Товары (свёрнутый список) -->
    <div class="s3c-items">
      <button class="s3c-items-toggle" onclick="toggleS3Items()">
        <span class="s3c-items-toggle-lbl">Таркиби фармоиш</span>
        <span class="s3c-items-toggle-count">${itemCount} мол</span>
        <svg class="s3c-items-toggle-chev" id="s3c-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="s3c-items-body" id="s3c-items-body">
        ${(o.items || []).map(item => `
          <div class="s3c-mini-item">
            <span class="s3c-mini-name">${item.name}</span>
            <span class="s3c-mini-qty">×${item.quantity}</span>
            <span class="s3c-mini-price">${item.price * item.quantity} см</span>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Доход -->
    <div class="s3c-earn">
      <span class="s3c-earn-lbl">Даромади шумо барои ин фармоиш</span>
      <span class="s3c-earn-val">+${EPD} см</span>
    </div>

    <!-- Кнопки -->
    <div class="flow-actions">
      ${atClient
        ? `<div class="s3c-code">
            <div class="s3c-code-lbl">Рамзи тасдиқ аз муштарӣ</div>
            <input id="confirm-code-inp" class="s3c-code-inp" type="number" maxlength="4" placeholder="0000"
              oninput="this.value=this.value.slice(0,4)"/>
            <div class="s3c-code-hint">Муштарӣ рамзи 4-рақамро мегӯяд</div>
          </div>
          <button class="btn-flow-final" onclick="deliverOrder('${o.id}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            Тасдиқ ва анҷом додан
          </button>`
        : `<button class="btn-flow-primary" onclick="advance('${o.id}','client_arrived')" style="background:linear-gradient(135deg,#3b82f6,#60a5fa);box-shadow:0 4px 16px rgba(59,130,246,.3)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Расидам ба муштарӣ
          </button>`
      }
    </div>
  </div>`;
}

window.toggleS3Items = function () {
  const body = document.getElementById('s3c-items-body');
  const chev = document.getElementById('s3c-chev');
  if (!body) return;
  const open = body.classList.toggle('open');
  if (chev) chev.classList.toggle('open', open);
};

// ─── Рендер активного заказа ─────────────────────────────
function renderActive() {
  const el = document.getElementById('active-content');
  if (!el) return;
  if (!activeOrder) {
    el.innerHTML = `<div class="empty"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h11a2 2 0 012 2v3"/><rect x="9" y="11" width="14" height="10" rx="1"/><circle cx="12" cy="21" r="1"/><circle cx="20" cy="21" r="1"/></svg></div><div class="empty-t">Фармоиши фаъол нест</div><div class="empty-s">Аз рӯйхат фармоиш қабул кунед</div></div>`;
    return;
  }
  const o = activeOrder;
  let stepHtml = '';
  if (['courier_heading', 'courier_arrived'].includes(o.status)) stepHtml = renderStep1(o);
  else if (['collecting'].includes(o.status))                    stepHtml = renderStep2(o);
  else if (['delivering', 'client_arrived'].includes(o.status))  stepHtml = renderStep3(o);
  el.innerHTML = stepHtml || `<div class="empty"><div class="empty-ico"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="empty-t">Интизор…</div></div>`;
}

// toggleItem удалён — заменён на openScanner + validateBarcode

// ─── Подтвердить сборку → переход к доставке ─────────────────
window.confirmCollect = async function (oid) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: 'delivering', updatedAt: serverTimestamp() });
    toast('Молҳо ҷамъ шуданд! Ба роҳ бароед', 'ok');
  } catch { toast('Хато', 'err'); }
};

// ─── Завершить доставку ───────────────────────────────────────
window.deliverOrder = async function (oid) {
  // Проверяем код подтверждения
  const inp = document.getElementById('confirm-code-inp');
  const enteredCode = inp ? inp.value.trim() : '';
  if (!enteredCode || enteredCode.length !== 4) {
    toast('Рамзи 4-рақамро ворид кунед', 'err');
    if (inp) { inp.style.borderColor = '#ef4444'; setTimeout(() => inp.style.borderColor = 'var(--b1)', 1500); }
    return;
  }
  if (activeOrder && activeOrder.confirmCode && enteredCode !== activeOrder.confirmCode) {
    toast('Рамз нодуруст аст! Аз муштарӣ пурсед', 'err');
    if (inp) { inp.style.borderColor = '#ef4444'; inp.value = ''; setTimeout(() => inp.style.borderColor = 'var(--b1)', 1500); }
    return;
  }
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: 'delivered', updatedAt: serverTimestamp() });
    // Сбрасываем кэш истории чтобы при переходе она перезагрузилась
    historyOrders = [];
    await setDoc(doc(db, COL.COURIERS, CU.uid), {
      currentOrderId:  null,
      isActive:        false,
      totalDeliveries: (CD?.totalDeliveries || 0) + 1,
      earnings:        (CD?.earnings || 0) + EPD,
      updatedAt:       serverTimestamp(),
    }, { merge: true });
    CD = { ...CD, currentOrderId: null, isActive: false, totalDeliveries: (CD?.totalDeliveries || 0) + 1, earnings: (CD?.earnings || 0) + EPD };
    todayDeliveries++;
    todayEarnings += EPD;
    checkedItems = new Set();
    const dt = document.getElementById('d-today');  if (dt) dt.textContent = todayDeliveries;
    const dT = document.getElementById('d-total');  if (dT) dT.textContent = CD.totalDeliveries;
    const pt = document.getElementById('ps-total'); if (pt) pt.textContent = CD.totalDeliveries;
    const pe = document.getElementById('ps-earn');  if (pe) pe.textContent = CD.earnings + ' см';
    updateEarnUI();
    toast('Расонида шуд! +' + EPD + ' см', 'ok');
    goPage('dashboard');
    loadHistory();
  } catch { toast('Хато', 'err'); }
};

// ─── Продвинуть статус ───────────────────────────────────────
window.advance = async function (oid, ns) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: ns, updatedAt: serverTimestamp() });
    toast(SL[ns] ? SL[ns] + '' : 'Навсозӣ шуд', 'ok');
  } catch { toast('Хато', 'err'); }
};

// ─── Дашборд: баннер активного заказа ────────────────────────
function renderDashActive() {
  // Пилюля в топбаре карты
  const pill    = document.getElementById('dash-active-pill');
  const pillTxt = document.getElementById('dash-active-pill-txt');
  if (pill && pillTxt) {
    if (activeOrder) {
      pill.style.display = '';
      pillTxt.textContent = activeOrder.address || SL[activeOrder.status] || 'Фаъол';
    } else {
      pill.style.display = 'none';
    }
  }
  // Баннер в листе
  const w = document.getElementById('dash-active-wrap');
  if (!w) return;
  if (!activeOrder) { w.innerHTML = ''; return; }
  const o  = activeOrder;
  const si = statusToStep(o.status);
  const icon = TRACK_STEPS[si]?.icon || '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
  w.innerHTML = `<div class="dash-active-row" onclick="goPage('active')">
    <div class="dash-active-dot"></div>
    <div style="flex:1;min-width:0">
      <div style="font-size:.52rem;letter-spacing:.12em;text-transform:uppercase;color:var(--acc2);margin-bottom:2px;font-weight:700">Фармоиши фаъол</div>
      <div style="font-size:.82rem;font-weight:700;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${icon} #${o.orderNumber||o.id.slice(-6).toUpperCase()} · ${o.address||''}</div>
      <div style="font-size:.62rem;color:var(--tx3);margin-top:2px">${SL[o.status]||o.status}</div>
    </div>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc2)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}

// ─── История ─────────────────────────────────────────────────
async function loadHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  el.innerHTML = '<div class="pload"><div class="spin"></div> Боргузорӣ…</div>';
  try {
    // Только where без orderBy — не требует composite index в Firestore
    const q  = query(collection(db, COL.ORDERS), where('courierId', '==', CU.uid), where('status', '==', 'delivered'));
    const sn = await getDocs(q);
    historyOrders = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    // Сортируем на стороне клиента по дате убывания
    historyOrders.sort((a, b) => {
      const ta = a.updatedAt?.toMillis?.() || a.createdAt?.toMillis?.() || 0;
      const tb = b.updatedAt?.toMillis?.() || b.createdAt?.toMillis?.() || 0;
      return tb - ta;
    });
    // Берём последние 50
    historyOrders = historyOrders.slice(0, 50);
    renderHistory();
  } catch (e) {
    console.error('loadHistory error:', e);
    el.innerHTML = `<div class="empty"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div><div class="empty-t">Расониданиҳо нест</div><div class="empty-s">Хатои боргузорӣ: ${e.message}</div></div>`;
  }
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  const te = historyOrders.length * EPD;
  const ht = document.getElementById('hist-total-txt');
  if (ht) ht.textContent = historyOrders.length + ' расониш · ' + te + ' см';
  if (!historyOrders.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div><div class="empty-t">Расониданиҳо нест</div><div class="empty-s">Расониданиҳои иҷрошуда ин ҷо намоён мешаванд</div></div>`;
    return;
  }
  el.innerHTML = historyOrders.map(o => {
    const _dt = o.updatedAt?.toDate?.() || o.createdAt?.toDate?.();
    const d = _dt ? _dt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + ', ' + _dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
    const cnt = (o.items || []).reduce((s, i) => s + i.quantity, 0);
    return `<div class="hc">
      <div class="hc-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="hc-body">
        <div class="hc-top"><span class="hc-num">#${o.orderNumber || o.id.slice(-6).toUpperCase()}</span><span class="hc-earn">+${EPD} см</span></div>
        <div class="hc-addr">${o.address || '—'}</div>
        <div class="hc-meta">${d} · ${cnt} мол</div>
      </div>
    </div>`;
  }).join('');
}

// ─── Профил ──────────────────────────────────────────────────
function renderProfile() {
  const name = UD?.displayName || CU.displayName || '';
  const init = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';

  // Аватар (сохраняем кнопку редактирования внутри)
  const av = document.getElementById('p-av');
  if (av) {
    const editBtn = av.querySelector('.prof-av-edit');
    av.innerHTML = UD?.avatarUrl
      ? `<img src="${UD.avatarUrl}" alt="">`
      : init;
    if (editBtn) av.appendChild(editBtn);
  }

  // Также синхронизируем маленький превью в настройках (если есть)
  const avSmall = document.getElementById('st-av');
  if (avSmall) avSmall.innerHTML = UD?.avatarUrl ? `<img src="${UD.avatarUrl}" alt="">` : init;

  const pn = document.getElementById('p-name');    if (pn) pn.textContent = name || 'Курьер';
  const pe = document.getElementById('p-email');   if (pe) pe.textContent = CU.email || '';

  // Нақлиёт-чип
  const pv = document.getElementById('p-veh');
  if (pv) {
    const vLabel = VEHICLE_TYPES[CD?.vehicle || 'foot'] || '—';
    pv.textContent = vLabel;
    pv.style.display = vLabel ? '' : 'none';
  }

  // Поля формы
  const pfn = document.getElementById('pf-name');    if (pfn) pfn.value = name;
  const pfe = document.getElementById('pf-email');   if (pfe) pfe.value = CU.email || '';
  const pfp = document.getElementById('pf-phone');   if (pfp) pfp.value = UD?.phone || '';
  const pfv = document.getElementById('pf-vehicle'); if (pfv) pfv.value = CD?.vehicle || 'foot';

  // Статистика
  const pst = document.getElementById('ps-total');  if (pst) pst.textContent = CD?.totalDeliveries || 0;
  const pse = document.getElementById('ps-earn');   if (pse) pse.textContent = (CD?.earnings || 0) + ' см';
  const psr = document.getElementById('ps-rating'); if (psr) psr.textContent = CD?.rating ? CD.rating.toFixed(1) : '—';

  // — Данные для модала
  window.__verifUID   = CU.uid;
  window.__verifName  = name;
  window.__verifEmail = CU.email || '';
  window.__verifPhone = UD?.phone || '';

  // — Статус
  const vs = CD?.verificationStatus || UD?.verificationStatus || 'unverified';

  // — Pending updater
  window.__setVerifPending = async function() {
    try {
      await setDoc(doc(db, COL.USERS,    CU.uid), { verificationStatus: 'pending', updatedAt: serverTimestamp() }, { merge: true });
      await setDoc(doc(db, COL.COURIERS, CU.uid), { verificationStatus: 'pending', updatedAt: serverTimestamp() }, { merge: true });
      CD = { ...CD, verificationStatus: 'pending' };
      UD = { ...UD, verificationStatus: 'pending' };
      renderProfile();
      toast('Дархост фиристода шуд', 'ok');
    } catch { toast('Хато ҳангоми сабт', 'err'); }
  };

  // — Бейдж в шапке карточки профиля
  const badgeWrap = document.getElementById('p-verif-badge-wrap');
  if (badgeWrap) {
    const badgeCfg = {
      unverified: { cls: 'unverified', dot: true,  txt: 'Тасдиқ нашудааст' },
      pending:    { cls: 'pending',    dot: true,   txt: 'Дар баррасӣ' },
      verified:   { cls: 'verified',   dot: true,   txt: 'Тасдиқ шудааст' },
    };
    const b = badgeCfg[vs] || badgeCfg.unverified;
    badgeWrap.innerHTML = `<div class="p-verif-badge ${b.cls}"><div class="p-verif-badge-dot"></div>${b.txt}</div>`;
  }

  // — Карточка верификации (кнопка видна при unverified И pending)
  const bannerWrap = document.getElementById('verif-banner-wrap');
  if (!bannerWrap) return;

  if (vs === 'verified') {
    bannerWrap.innerHTML = `
      <div class="verif-card">
        <div class="verif-card-top">
          <div class="verif-card-icon verified"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
          <div class="verif-card-info">
            <div class="verif-card-title">Ҳувият тасдиқ шудааст</div>
            <div class="verif-card-sub verified">Шумо метавонед фармоишҳо қабул кунед</div>
          </div>
        </div>
      </div>`;
    return;
  }

  if (vs === 'pending') {
    bannerWrap.innerHTML = `
      <div class="verif-card">
        <div class="verif-card-top">
          <div class="verif-card-icon pending">
            <span class="verif-pulse-dot"></span>
          </div>
          <div class="verif-card-info">
            <div class="verif-card-title">Дар баррасӣ</div>
            <div class="verif-card-sub pending">Дархост қабул шуд · ҷавоб то 1 рӯзи кор</div>
          </div>
        </div>
        <div class="verif-card-divider"></div>
        <div class="verif-card-actions">
          <button class="verif-btn-primary" onclick="openVerifModal()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21.5 2.5L2.5 10l7 2.5M21.5 2.5L14 21.5l-4.5-9M21.5 2.5L9.5 12.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Такрор фиристодан
          </button>
          <button class="verif-btn-secondary" onclick="openVerifModal()">
            Дастур
          </button>
        </div>
      </div>`;
    return;
  }

  // unverified (default)
  bannerWrap.innerHTML = `
    <div class="verif-card">
      <div class="verif-card-top">
        <div class="verif-card-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M16 10a2 2 0 11-4 0 2 2 0 014 0z"/><path d="M8 9h2M8 13h2M14 15H8"/></svg></div>
        <div class="verif-card-info">
          <div class="verif-card-title">Тасдиқи ҳувият</div>
          <div class="verif-card-sub">Барои қабули фармоишҳо зарур аст</div>
        </div>
      </div>
      <div class="verif-card-divider"></div>
      <div class="verif-card-actions">
        <button class="verif-btn-primary" onclick="openVerifModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21.5 2.5L2.5 10l7 2.5M21.5 2.5L14 21.5l-4.5-9M21.5 2.5L9.5 12.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Тасдиқ кардан
        </button>
      </div>
    </div>`;
}

window.saveProfile = async function () {
  const name    = document.getElementById('pf-name').value.trim();
  const phone   = document.getElementById('pf-phone').value.trim();
  const vehicle = document.getElementById('pf-vehicle').value;
  try {
    await setDoc(doc(db, COL.USERS,    CU.uid), { displayName: name, phone, updatedAt: serverTimestamp() }, { merge: true });
    await setDoc(doc(db, COL.COURIERS, CU.uid), { displayName: name, phone, vehicle, updatedAt: serverTimestamp() }, { merge: true });
    UD = { ...UD, displayName: name, phone };
    CD = { ...CD, vehicle };
    renderSB(); renderProfile();
    toast('Сақл шуд', 'ok');
  } catch { toast('Хато', 'err'); }
};

window.uploadAvUI = async function (inp) {
  const f = inp.files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) { toast('Файл хеле калон аст', 'err'); return; }
  toast('Бор мекунем…');
  try {
    const sr  = sRef(storage, `avatars/${CU.uid}`);
    await uploadBytes(sr, f);
    const url = await getDownloadURL(sr);
    await setDoc(doc(db, COL.USERS, CU.uid), { avatarUrl: url, updatedAt: serverTimestamp() }, { merge: true });
    UD.avatarUrl = url;
    renderSB(); renderProfile();
    toast('Акс навсозӣ шуд', 'ok');
  } catch { toast('Хатои боргузорӣ', 'err'); }
};
