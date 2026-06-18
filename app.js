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
  { key: 'courier_heading', icon: '🏪', label: 'Ба дӯкон' },
  { key: 'collecting',      icon: '🛒', label: 'Ҷамъоварӣ' },
  { key: 'delivering',      icon: '🛵', label: 'Расонидан' },
  { key: 'delivered',       icon: '✅', label: 'Расонида шуд' },
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
});

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
  const uname = document.getElementById('sb-uname');
  if (uname) uname.textContent = name;
  const av = document.getElementById('sb-av');
  if (av) av.innerHTML = UD?.avatarUrl ? `<img src="${UD.avatarUrl}" alt="">` : init;
  updateOnlineUI(CD?.isOnline || false);
  updateEarnUI();
}

// ─── Онлайн / Офлайн ─────────────────────────────────────────
window.toggleOnline = async function (v) {
  try {
    await setDoc(doc(db, COL.COURIERS, CU.uid), { isOnline: v, updatedAt: serverTimestamp() }, { merge: true });
    CD = { ...CD, isOnline: v };
    updateOnlineUI(v);
    toast(v ? 'Шумо онлайн ед 🟢' : 'Шумо офлайн ед', v ? 'ok' : '');
  } catch { toast('Хато', 'err'); }
};

function updateOnlineUI(on) {
  const tog     = document.getElementById('online-tog');     if (tog)     tog.checked = on;
  const val     = document.getElementById('sb-online-val');  if (val)     { val.textContent = on ? 'Онлайн' : 'Офлайн'; val.className = 'sb-online-val' + (on ? ' on' : ''); }
  const card    = document.getElementById('sb-online-card'); if (card)    card.className = 'sb-online' + (on ? ' is-online' : '');
  const chip    = document.getElementById('tb-chip');        if (chip)    chip.className = 'tb-chip' + (on ? ' online' : ' offline');
  const chipTxt = document.getElementById('tb-chip-txt');    if (chipTxt) chipTxt.textContent = on ? 'Онлайн' : 'Офлайн';
}

function updateEarnUI() {
  const se = document.getElementById('sb-earn-val'); if (se) se.textContent = todayEarnings + ' см';
  const de = document.getElementById('d-earn');      if (de) de.textContent = todayEarnings + ' см';
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
window.goPage = function (page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ni,.mn-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  document.querySelectorAll(`.ni[data-page="${page}"],.mn-item[data-page="${page}"]`).forEach(n => n.classList.add('active'));
  const titles = {
    dashboard:    'Дашборд',
    'new-orders': 'Фармоишҳои нав',
    active:       'Фармоиши фаъол',
    history:      'Таърих',
    profile:      'Профил',
  };
  const tb = document.getElementById('tb-title');
  if (tb) tb.textContent = titles[page] || 'Galelium Courier';
  if (page === 'history')   loadHistory();
  if (page === 'active')    renderActive();
  if (page === 'dashboard') { renderDashNew(); renderDashActive(); }
  closeSB();
  const pages = document.getElementById('pages');
  if (pages) pages.scrollTop = 0;
};

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
    renderNewOrders();
    renderDashNew();
    if (!first && newOrders.length > prev) { playBeep(); toast('🔔 Фармоиши нав!', 'info'); renderNotif(); }
    first = false;
  });
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
  });
}

// ─── Бейджи ──────────────────────────────────────────────────
function updateNewBadge() {
  const cnt = newOrders.length;
  ['new-badge', 'mob-new-badge'].forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.style.display = cnt > 0 ? '' : 'none'; b.textContent = cnt; }
  });
  const el = document.getElementById('new-count-txt');
  if (el) el.textContent = cnt + ' фармоиш';
}

function updateActiveBadge() {
  ['active-badge', 'mob-active-badge'].forEach(id => {
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
          <span class="oc-num">#${o.id.slice(-6).toUpperCase()}</span>
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
        ${o.comment ? `<span class="oc-chip">💬 ${o.comment}</span>` : ''}
      </div>
      <button class="btn-take" onclick="acceptOrder('${o.id}')" id="btn-${o.id}" ${activeOrder ? 'disabled title="Фармоиши фаъол дорад"' : ''}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Қабул
      </button>
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
    el.innerHTML = `<div class="empty"><div class="empty-ico">📭</div><div class="empty-t">Фармоишҳои нав нест</div><div class="empty-s">Фармоишҳо автоматӣ пайдо мешаванд</div></div>`;
    return;
  }
  el.innerHTML = sorted.map((o, i) => orderCard(o, i === 0)).join('');
  if (sorted[0]) startCD(sorted[0].id);
}

function renderDashNew() {
  const el = document.getElementById('dash-new-orders');
  if (!el) return;
  const sorted = [...newOrders].sort((a, b) => (a.createdAt?.toDate?.().getTime() || 0) - (b.createdAt?.toDate?.().getTime() || 0));
  if (!sorted.length) {
    el.innerHTML = `<div class="empty" style="padding:28px 20px"><div class="empty-ico">📭</div><div class="empty-t">Фармоишҳо нест</div><div class="empty-s">Интизор ем…</div></div>`;
    renderNotif(); return;
  }
  el.innerHTML = sorted.slice(0, 2).map(o => orderCard(o)).join('');
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

// ─── Қабули фармоиш ──────────────────────────────────────────
window.acceptOrder = async function (oid) {
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
    toast('Фармоиш қабул шуд! 🚀', 'ok');
    goPage('active');
  } catch (e) {
    toast('Хато: ' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Қабул'; }
  }
};

// ─── 3-ҚАДАМАИ ФЛОУ РАСОНИДАН ────────────────────────────────

// Трекер прогресса вверху страницы активного заказа
function renderTracker(o) {
  const si = statusToStep(o.status);
  return `<div class="tracker">
    ${TRACK_STEPS.map((s, i) => `
      <div class="tr-step ${i < si ? 'done' : i === si ? 'cur' : ''}">
        <div class="tr-dot">${i <= si ? s.icon : ''}</div>
        ${i < TRACK_STEPS.length - 1 ? '<div class="tr-line"></div>' : ''}
        <div class="tr-lbl">${s.label}</div>
      </div>
    `).join('')}
  </div>`;
}

// Общая шапка карточки активного заказа
function renderOrderHead(o) {
  const pay  = o.paymentMethod === 'cash' ? '💵 Нақдӣ' : o.paymentMethod === 'card' ? '💳 Корт' : '🌐 Онлайн';
  const time = o.createdAt?.toDate ? o.createdAt.toDate().toLocaleString('tg-TJ') : '—';
  return `
    <div class="ao-header">
      <div class="ao-num-row">
        <span class="ao-num">#${o.id.slice(-6).toUpperCase()}</span>
        <span class="ao-status-pill">${SL[o.status] || o.status}</span>
      </div>
      <div class="ao-meta-grid">
        <div class="ao-meta-item">
          <div class="ao-meta-lbl">Муштарӣ</div>
          <div class="ao-meta-val">${o.clientName || '—'}</div>
        </div>
        <div class="ao-meta-item">
          <div class="ao-meta-lbl">Пардохт</div>
          <div class="ao-meta-val">${pay}</div>
        </div>
        <div class="ao-meta-item">
          <div class="ao-meta-lbl">Вақт</div>
          <div class="ao-meta-val">${time}</div>
        </div>
        <div class="ao-meta-item">
          <div class="ao-meta-lbl">Маблағ</div>
          <div class="ao-meta-val" style="color:var(--acc);font-weight:700">${o.total || 0} см</div>
        </div>
      </div>
    </div>`;
}

// ШАГ 1: Едем в магазин
function renderStep1(o) {
  const arrived = o.status === 'courier_arrived';
  return `
    <div class="step-card">
      <div class="step-card-icon">🏪</div>
      <div class="step-card-title">Ба дӯкон раед</div>
      <div class="step-card-sub">Ба дӯкон расед ва тугмаро пахш кунед</div>
      <div class="step-card-addr">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        Дӯкони Galelium
      </div>
      ${arrived
        ? `<div class="arrived-chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Расидед!</div>
           <button class="btn-step-next" onclick="advance('${o.id}','collecting')">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
             Ба ҷамъоварии мол равед
           </button>`
        : `<button class="btn-step-primary" onclick="advance('${o.id}','courier_arrived')">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
             Расидам ба дӯкон
           </button>`
      }
    </div>`;
}

// ШАГ 2: Сборка товаров
function renderStep2(o) {
  const items = o.items || [];
  const all   = items.reduce((s, i) => s + i.quantity, 0);
  const done  = checkedItems.size;
  const pct   = all > 0 ? Math.round(done / all * 100) : 0;
  const allDone = done >= all;
  return `
    <div class="step-card">
      <div class="step-card-icon">🛒</div>
      <div class="step-card-title">Молҳоро ҷамъ кунед</div>
      <div class="step-card-sub">Ҳар молро аз рӯйхат гирифта галочка занед</div>
      <div class="collect-progress">
        <div class="collect-bar"><div class="collect-fill" style="width:${pct}%"></div></div>
        <div class="collect-pct">${done} / ${all} мол</div>
      </div>
      <div class="collect-list" id="collect-list">
        ${items.map((item, idx) => {
          const rows = [];
          for (let q = 0; q < item.quantity; q++) {
            const key = `${idx}-${q}`;
            const chk = checkedItems.has(key);
            rows.push(`<div class="collect-item ${chk ? 'checked' : ''}" onclick="toggleItem('${key}','${o.id}')">
              <div class="collect-check ${chk ? 'on' : ''}">
                ${chk ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
              </div>
              <div class="collect-item-info">
                <div class="collect-item-name">${item.name}</div>
                <div class="collect-item-price">${item.price} см / дона</div>
              </div>
              ${item.quantity > 1 ? `<div class="collect-item-badge">${q + 1}/${item.quantity}</div>` : ''}
            </div>`);
          }
          return rows.join('');
        }).join('')}
      </div>
      ${allDone
        ? `<button class="btn-step-next" onclick="confirmCollect('${o.id}')">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
             Ҳама гирифтам — тасдиқ
           </button>`
        : `<button class="btn-step-primary" disabled style="opacity:.4;cursor:not-allowed">
             Ҳоло ${all - done} мол монд
           </button>`
      }
    </div>`;
}

// ШАГ 3: Везём клиенту
function renderStep3(o) {
  const atClient = o.status === 'client_arrived';
  return `
    <div class="step-card">
      <div class="step-card-icon">🛵</div>
      <div class="step-card-title">Фармоишро расонед</div>
      <div class="step-card-sub">Ба суроғи муштарӣ раед</div>
      <div class="step-card-addr">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        ${o.address || '—'}
      </div>
      ${o.comment ? `<div class="step-comment"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg> ${o.comment}</div>` : ''}
      <div class="step-items-mini">
        ${(o.items || []).map(i => `<span class="step-item-chip">${i.name} ×${i.quantity}</span>`).join('')}
      </div>
      ${atClient
        ? `<div class="arrived-chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Расидед!</div>
           <button class="btn-step-final" onclick="deliverOrder('${o.id}')">
             <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
             Фармоиш дода шуд! 🎉
           </button>`
        : `<button class="btn-step-primary" onclick="advance('${o.id}','client_arrived')">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
             Расидам ба муштарӣ
           </button>`
      }
    </div>`;
}

// ─── Рендер активного заказа ──────────────────────────────────
function renderActive() {
  const el = document.getElementById('active-content');
  if (!el) return;
  if (!activeOrder) {
    el.innerHTML = `<div class="empty"><div class="empty-ico">🛵</div><div class="empty-t">Фармоиши фаъол нест</div><div class="empty-s">Аз рӯйхат фармоиш қабул кунед</div></div>`;
    return;
  }
  const o = activeOrder;
  let stepHtml = '';
  if (['courier_heading', 'courier_arrived'].includes(o.status)) stepHtml = renderStep1(o);
  else if (['collecting'].includes(o.status))                    stepHtml = renderStep2(o);
  else if (['delivering', 'client_arrived'].includes(o.status))  stepHtml = renderStep3(o);

  el.innerHTML = `
    <div class="ao-wrap">
      ${renderTracker(o)}
      ${renderOrderHead(o)}
      ${stepHtml}
    </div>`;
}

// ─── Отметить товар ──────────────────────────────────────────
window.toggleItem = function (key, oid) {
  if (checkedItems.has(key)) checkedItems.delete(key);
  else checkedItems.add(key);
  renderActive();
};

// ─── Подтвердить сборку → переход к доставке ─────────────────
window.confirmCollect = async function (oid) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: 'delivering', updatedAt: serverTimestamp() });
    toast('Молҳо ҷамъ шуданд! Ба роҳ бароед 🛵', 'ok');
  } catch { toast('Хато', 'err'); }
};

// ─── Завершить доставку ───────────────────────────────────────
window.deliverOrder = async function (oid) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: 'delivered', updatedAt: serverTimestamp() });
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
    toast('🎉 Расонида шуд! +' + EPD + ' см', 'ok');
    goPage('dashboard');
    loadHistory();
  } catch { toast('Хато', 'err'); }
};

// ─── Продвинуть статус ───────────────────────────────────────
window.advance = async function (oid, ns) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: ns, updatedAt: serverTimestamp() });
    toast(SL[ns] ? SL[ns] + ' ✓' : 'Навсозӣ шуд', 'ok');
  } catch { toast('Хато', 'err'); }
};

// ─── Дашборд: баннер активного заказа ────────────────────────
function renderDashActive() {
  const w = document.getElementById('dash-active-wrap');
  if (!w) return;
  if (!activeOrder) { w.innerHTML = ''; return; }
  const o = activeOrder;
  const si = statusToStep(o.status);
  const icon = TRACK_STEPS[si]?.icon || '📦';
  w.innerHTML = `<div class="active-banner" onclick="goPage('active')">
    <div class="ab-pulse"></div>
    <div class="ab-body">
      <div class="ab-lbl">Ҳоло дар кор</div>
      <div class="ab-txt">${icon} #${o.id.slice(-6).toUpperCase()} · ${SL[o.status]} · ${o.address || ''}</div>
    </div>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}

// ─── История ─────────────────────────────────────────────────
async function loadHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  el.innerHTML = '<div class="pload"><div class="spin"></div> Боргузорӣ…</div>';
  try {
    const q   = query(collection(db, COL.ORDERS), where('courierId', '==', CU.uid), where('status', '==', 'delivered'), orderBy('updatedAt', 'desc'), limit(50));
    const sn  = await getDocs(q);
    historyOrders = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    renderHistory();
  } catch {
    el.innerHTML = `<div class="empty"><div class="empty-ico">📭</div><div class="empty-t">Расониданиҳо нест</div></div>`;
  }
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  const te = historyOrders.length * EPD;
  const ht = document.getElementById('hist-total-txt');
  if (ht) ht.textContent = historyOrders.length + ' расониш · ' + te + ' см';
  if (!historyOrders.length) {
    el.innerHTML = `<div class="empty"><div class="empty-ico">📭</div><div class="empty-t">Расониданиҳо нест</div><div class="empty-s">Расониданиҳои иҷрошуда ин ҷо намоён мешаванд</div></div>`;
    return;
  }
  el.innerHTML = historyOrders.map(o => {
    const d = o.updatedAt?.toDate ? o.updatedAt.toDate().toLocaleDateString('tg-TJ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    const cnt = (o.items || []).reduce((s, i) => s + i.quantity, 0);
    return `<div class="hc">
      <div class="hc-ico"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="hc-body">
        <div class="hc-top"><span class="hc-num">#${o.id.slice(-6).toUpperCase()}</span><span class="hc-earn">+${EPD} см</span></div>
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
  const pn  = document.getElementById('p-name');     if (pn)  pn.textContent  = name || 'Курьер';
  const pe  = document.getElementById('p-email');    if (pe)  pe.textContent  = CU.email || '';
  const av  = document.getElementById('p-av');       if (av)  av.innerHTML    = UD?.avatarUrl ? `<img src="${UD.avatarUrl}" alt="">` : init;
  const pv  = document.getElementById('p-veh');      if (pv)  pv.textContent  = VEHICLE_TYPES[CD?.vehicle || 'foot'] || '—';
  const pfn = document.getElementById('pf-name');    if (pfn) pfn.value       = name;
  const pfe = document.getElementById('pf-email');   if (pfe) pfe.value       = CU.email || '';
  const pfp = document.getElementById('pf-phone');   if (pfp) pfp.value       = UD?.phone || '';
  const pfv = document.getElementById('pf-vehicle'); if (pfv) pfv.value       = CD?.vehicle || 'foot';
  const pst = document.getElementById('ps-total');   if (pst) pst.textContent = CD?.totalDeliveries || 0;
  const pse = document.getElementById('ps-earn');    if (pse) pse.textContent = (CD?.earnings || 0) + ' см';
  const psr = document.getElementById('ps-rating');  if (psr) psr.textContent = CD?.rating ? CD.rating.toFixed(1) : '—';
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
    toast('Сақл шуд ✓', 'ok');
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
    toast('Акс навсозӣ шуд ✓', 'ok');
  } catch { toast('Хатои боргузорӣ', 'err'); }
};
