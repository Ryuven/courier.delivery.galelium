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
          <div class="fsb-lbl-sub">${isDone ? 'Тайёр ✓' : s.sub}</div>
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
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.4rem;opacity:.6">🛍️</div>`;
    return `<div class="s1-thumb">${img}</div>`;
  }).join('');

  return `
  <div class="flow-panel">
    ${renderStepBar(1)}
    ${renderOrderBadge(o)}

    <!-- Hero блок -->
    <div class="s1-hero ${arrived ? 'arrived' : ''}">
      <div class="s1-hero-icon">${arrived ? '✅' : '🏪'}</div>
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
              ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${item.name}">` : '<span style="font-size:1.1rem">🛍️</span>'}
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
        : `<div class="ci-no-img">🛍️</div>`;
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

// Открыть оверлей сканера для конкретного товара
window.openScanner = async function (key, oid, itemIdx) {
  if (scannerActive) return;
  const o = activeOrder;
  if (!o) return;
  const item = (o.items || [])[itemIdx];
  if (!item) return;

  scannerItemKey  = key;
  scannerOid      = oid;
  scannerItemName = item.name;

  // Если у товара нет barcode в данных заказа — берём из Firestore products
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

  showScannerOverlay();
};

function showScannerOverlay() {
  const ov = document.getElementById('scanner-overlay');
  if (!ov) return;

  const hasBC = !!scannerExpected;

  ov.innerHTML = `
    <div class="sc-panel">
      <div class="sc-header">
        <div class="sc-title">Скан штрих-код</div>
        <button class="sc-close" onclick="closeScanner()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="sc-item-info">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
        ${scannerItemName}
        ${!hasBC ? '<span class="sc-nobc-warn">⚠️ Штрих-код нест — вуруди дастӣ</span>' : ''}
      </div>

      ${hasBC ? `
      <!-- Видео-камера -->
      <div class="sc-cam-wrap" id="sc-cam-wrap">
        <video id="sc-video" autoplay playsinline muted></video>
        <div class="sc-laser"></div>
        <div class="sc-corners">
          <div class="sc-corner tl"></div><div class="sc-corner tr"></div>
          <div class="sc-corner bl"></div><div class="sc-corner br"></div>
        </div>
        <div class="sc-cam-hint" id="sc-cam-hint">Камераро ба штрих-код нишон диҳед</div>
      </div>
      <div class="sc-result" id="sc-result"></div>
      <div class="sc-divider"><span>ё</span></div>
      ` : ''}

      <!-- Ручной ввод -->
      <div class="sc-manual">
        <div class="sc-manual-lbl">Дастӣ ворид кунед</div>
        <div class="sc-manual-row">
          <input class="sc-manual-inp" id="sc-manual-inp" type="text"
            inputmode="numeric" pattern="[0-9]*"
            placeholder="${hasBC ? 'Рақами штрих-код' : 'Ҳар рақам ё код'}"
            onkeydown="if(event.key==='Enter')submitManual()"
          />
          <button class="sc-manual-btn" onclick="submitManual()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </button>
        </div>
      </div>

      ${!hasBC ? `
      <button class="btn-flow-next" style="margin-top:4px" onclick="confirmItemNoBarcode()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
        Дастӣ тасдиқ — штрих-код нест
      </button>
      ` : ''}
    </div>`;

  ov.classList.add('open');
  scannerActive = true;

  if (hasBC) startCamera();
  setTimeout(() => document.getElementById('sc-manual-inp')?.focus(), 300);
}

// Запуск камеры с BarcodeDetector API
async function startCamera() {
  if (!('BarcodeDetector' in window)) {
    showScanResult('warn', '⚠️ Камераи браузер BarcodeDetector дастгирӣ намекунад. Дастӣ ворид кунед.');
    return;
  }
  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    const video = document.getElementById('sc-video');
    if (!video) return;
    video.srcObject = barcodeStream;
    await video.play();

    barcodeDetector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix']
    });
    detectLoop(video);
  } catch (e) {
    showScanResult('warn', '⚠️ Камера дастрас нест: ' + e.message);
  }
}

let lastDetected = null;
let lastDetectedTime = 0;

function detectLoop(video) {
  if (!scannerActive || !barcodeDetector) return;
  barcodeRAF = requestAnimationFrame(async () => {
    try {
      const barcodes = await barcodeDetector.detect(video);
      if (barcodes.length > 0) {
        const now = Date.now();
        const code = barcodes[0].rawValue;
        // Дебаунс — один и тот же код не обрабатываем чаще раза в 2с
        if (code !== lastDetected || now - lastDetectedTime > 2000) {
          lastDetected     = code;
          lastDetectedTime = now;
          handleScannedCode(code);
          return; // Пауза, дадим UI обновиться
        }
      }
    } catch {}
    detectLoop(video);
  });
}

function handleScannedCode(code) {
  const hint = document.getElementById('sc-cam-hint');
  if (hint) hint.textContent = `Скан: ${code}`;
  validateBarcode(code);
}

// Ручной ввод
window.submitManual = function () {
  const inp = document.getElementById('sc-manual-inp');
  const val = inp?.value.trim();
  if (!val) { inp?.focus(); return; }
  validateBarcode(val);
};

// Товар без штрихкода — подтвердить вручную
window.confirmItemNoBarcode = function () {
  markItemDone();
};

// Валидация кода
function validateBarcode(code) {
  if (!scannerExpected) {
    // Нет штрихкода в базе — любой ввод подтверждает
    showScanResult('ok', `✅ Тасдиқ шуд!`, true);
    return;
  }
  const clean   = code.trim().replace(/\s/g, '');
  const expected = String(scannerExpected).trim().replace(/\s/g, '');
  if (clean === expected) {
    showScanResult('ok', `✅ Дуруст! ${scannerItemName}`, true);
  } else {
    showScanResult('err', `❌ Хато! Интизор: ${expected} · Гирифт: ${clean}`);
    playErrorBeep();
    // Через 2с продолжаем сканировать
    setTimeout(() => {
      const res = document.getElementById('sc-result');
      if (res) res.innerHTML = '';
      const video = document.getElementById('sc-video');
      if (video && scannerActive) detectLoop(video);
    }, 2000);
  }
}

function showScanResult(type, msg, autoClose = false) {
  // Стоп камеры пока показываем результат
  if (barcodeRAF) { cancelAnimationFrame(barcodeRAF); barcodeRAF = null; }
  const res = document.getElementById('sc-result');
  if (res) {
    res.className = `sc-result show ${type}`;
    res.textContent = msg;
  }
  if (autoClose) {
    playSuccessBeep();
    setTimeout(() => {
      markItemDone();
    }, 700);
  }
}

// Успешно отсканировано — отметить товар
function markItemDone() {
  const key = scannerItemKey;
  closeScanner();
  if (key) {
    checkedItems.add(key);
    renderActive();
    // Виброотклик
    if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
  }
}

// Закрыть сканер
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
  const atClient = o.status === 'client_arrived';
  const itemCount = (o.items || []).reduce((s, i) => s + i.quantity, 0);
  const pay = o.paymentMethod === 'cash' ? '💵 Нақдӣ ба курьер' : o.paymentMethod === 'card' ? '💳 Корт' : '🌐 Онлайн';

  return `
  <div class="flow-panel">
    ${renderStepBar(3)}
    ${renderOrderBadge(o)}

    <!-- Hero -->
    <div class="s1-hero ${atClient ? 'arrived' : ''}" style="${atClient ? '' : 'background:linear-gradient(135deg,rgba(59,130,246,.12),rgba(59,130,246,.04));border-color:rgba(59,130,246,.25)'}">
      <div class="s1-hero-icon">${atClient ? '🎉' : '🛵'}</div>
      <div class="s1-hero-body">
        <div class="s1-hero-title" style="${atClient ? '' : 'color:#93c5fd'}">${atClient ? 'Расидед ба муштарӣ!' : 'Дар роҳ ба муштарӣ'}</div>
        <div class="s1-hero-sub">${atClient ? 'Фармоишро супоред ва тасдиқ кунед' : 'Ба суроғ зер равед'}</div>
      </div>
    </div>

    <!-- Адрес клиента -->
    <div class="info-card">
      <div class="info-card-icon" style="background:rgba(59,130,246,.12);color:#60a5fa">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
      </div>
      <div class="info-card-body">
        <div class="info-card-lbl">Суроғи муштарӣ</div>
        <div class="info-card-val">${o.address || '—'}</div>
        ${o.comment ? `<div class="info-card-sub">💬 ${o.comment}</div>` : ''}
      </div>
      <div class="info-card-arrow">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>
    </div>

    <!-- Карточка оплаты -->
    <div class="info-card">
      <div class="info-card-icon" style="background:var(--amberd);color:var(--amber)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="1"/><path d="M2 10h20"/></svg>
      </div>
      <div class="info-card-body">
        <div class="info-card-lbl">Пардохт</div>
        <div class="info-card-val">${pay}</div>
        <div class="info-card-sub">Маблағи фармоиш: ${o.total || 0} см</div>
      </div>
    </div>

    <!-- Итог товаров -->
    <div class="s3-items">
      <div class="s3-items-header">
        <span class="s3-items-title">Таркиби фармоиш</span>
        <span class="s3-items-count">${itemCount} мол</span>
      </div>
      ${(o.items || []).map(item => `
        <div class="s3-item">
          <div class="s3-item-img">
            ${item.imageUrl ? `<img src="${item.imageUrl}" alt="${item.name}">` : '<span style="font-size:1rem">🛍️</span>'}
          </div>
          <div class="s3-item-name">${item.name}</div>
          <div class="s3-item-right">
            <span class="s3-item-qty">×${item.quantity}</span>
            <span class="s3-item-price">${item.price * item.quantity} см</span>
          </div>
        </div>
      `).join('')}
      <div class="s3-total-row">
        <span>Ҷамъи шумо</span>
        <span class="s3-total-earn">+${EPD} см</span>
      </div>
    </div>

    <!-- Кнопки -->
    <div class="flow-actions">
      ${atClient
        ? `<div style="background:linear-gradient(135deg,rgba(26,158,74,.08),rgba(34,197,94,.04));border:2px solid rgba(26,158,74,.22);border-radius:18px;padding:20px;margin-bottom:12px">
            <div style="font-size:.55rem;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--acc);margin-bottom:12px;text-align:center">Рамзи тасдиқ аз муштарӣ</div>
            <div style="display:flex;gap:8px;align-items:center">
              <input id="confirm-code-inp" type="number" maxlength="4" placeholder="0000"
                style="flex:1;font-family:var(--fd);font-weight:900;font-size:2rem;text-align:center;letter-spacing:.2em;background:var(--s1);border:2px solid var(--b1);border-radius:14px;color:var(--tx);padding:12px 8px;outline:none;appearance:textfield;-moz-appearance:textfield;width:100%;box-sizing:border-box"
                oninput="this.value=this.value.slice(0,4)"
                onfocus="this.style.borderColor='var(--acc)'"
                onblur="this.style.borderColor='var(--b1)'"/>
            </div>
            <div style="font-size:.62rem;color:var(--tx3);margin-top:10px;text-align:center">Муштарӣ рамзи 4-рақамро мегӯяд</div>
          </div>
          <button class="btn-flow-final" onclick="deliverOrder('${o.id}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            Тасдиқ ва анҷом додан 🎉
          </button>`
        : `<button class="btn-flow-primary" onclick="advance('${o.id}','client_arrived')" style="background:linear-gradient(135deg,#3b82f6,#60a5fa);box-shadow:0 4px 16px rgba(59,130,246,.3)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Расидам ба муштарӣ
          </button>`
      }
    </div>
  </div>`;
}

// ─── Рендер активного заказа ─────────────────────────────
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
  el.innerHTML = stepHtml || `<div class="empty"><div class="empty-ico">⏳</div><div class="empty-t">Интизор…</div></div>`;
}

// toggleItem удалён — заменён на openScanner + validateBarcode

// ─── Подтвердить сборку → переход к доставке ─────────────────
window.confirmCollect = async function (oid) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: 'delivering', updatedAt: serverTimestamp() });
    toast('Молҳо ҷамъ шуданд! Ба роҳ бароед 🛵', 'ok');
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
    toast('Рамз нодуруст аст! Аз муштарӣ пурсед 🔐', 'err');
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
      <div class="ab-txt">${icon} #${o.orderNumber || o.id.slice(-6).toUpperCase()} · ${SL[o.status]} · ${o.address || ''}</div>
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
    el.innerHTML = `<div class="empty"><div class="empty-ico">📭</div><div class="empty-t">Расониданиҳо нест</div><div class="empty-s">Хатои боргузорӣ: ${e.message}</div></div>`;
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
