// ============================================================
//  app.js — Логика курьерского приложения Galelium Courier
//  Используется в: home.html
// ============================================================

import { auth, db, storage, COL, ORDER_STATUS, EPD, VEHICLE_TYPES } from './firebase.js';

import {
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js';

import {
  doc, getDoc, setDoc, updateDoc,
  getDocs, collection, query, where,
  orderBy, onSnapshot, serverTimestamp, limit,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js';

import {
  ref as sRef, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-storage.js';

// ─── Состояние приложения ────────────────────────────────────
let CU             = null;   // Firebase Auth user
let UD             = null;   // users/{uid} документ
let CD             = null;   // couriers/{uid} документ
let newOrders      = [];
let activeOrder    = null;
let historyOrders  = [];
let unsubNew       = null;
let unsubActive    = null;
let soundEnabled   = true;
let todayDeliveries = 0;
let todayEarnings  = 0;

// ─── Константы статусов ──────────────────────────────────────
const SL = {
  pending:    'Ожидает',
  confirmed:  'Подтверждён',
  preparing:  'Готовится',
  delivering: 'В пути',
  delivered:  'Доставлен',
  cancelled:  'Отменён',
};

const SSTEPS  = ['confirmed', 'preparing', 'delivering', 'delivered'];
const SICONS  = ['✅', '👨‍🍳', '🚴', '🎉'];
const SLBLS   = ['Подтверждён', 'Готовится', 'В пути', 'Доставлен'];
const SNBTNS  = ['Начать готовить', 'Выехал 🚴', '✓ Доставлен'];
const SNST    = ['preparing', 'delivering', 'delivered'];

// Таймеры обратного отсчёта для карточек заказов
const CDS = {};

// ─── Toast ───────────────────────────────────────────────────
window.toast = function (msg, type = '') {
  const w  = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<div class="tdot"></div><span>${msg}</span>`;
  w.appendChild(el);
  setTimeout(() => el.remove(), 3400);
};

// ─── Часы ────────────────────────────────────────────────────
function tick() {
  const el = document.getElementById('tb-time');
  if (el) el.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
setInterval(tick, 1000);
tick();

// ─── Auth: инициализация ─────────────────────────────────────
onAuthStateChanged(auth, async u => {
  if (!u) { location.href = 'login.html'; return; }
  CU = u;
  // Проверка роли
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

// ─── Выход ───────────────────────────────────────────────────
window.doLogout = async function () {
  if (unsubNew)    { unsubNew();    unsubNew    = null; }
  if (unsubActive) { unsubActive(); unsubActive = null; }
  try {
    await setDoc(doc(db, COL.COURIERS, CU.uid), { isOnline: false, updatedAt: serverTimestamp() }, { merge: true });
  } catch {}
  await signOut(auth);
  location.href = 'login.html';
};

// ─── Рендер сайдбара ─────────────────────────────────────────
function renderSB() {
  const name = UD?.displayName || CU.email || 'Курьер';
  const init = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  document.getElementById('sb-uname').textContent = name;
  const av = document.getElementById('sb-av');
  av.innerHTML = UD?.avatarUrl ? `<img src="${UD.avatarUrl}" alt="">` : init;
  updateOnlineUI(CD?.isOnline || false);
  updateEarnUI();
}

// ─── Онлайн / Офлайн ─────────────────────────────────────────
window.toggleOnline = async function (v) {
  try {
    await setDoc(doc(db, COL.COURIERS, CU.uid), { isOnline: v, updatedAt: serverTimestamp() }, { merge: true });
    CD = { ...CD, isOnline: v };
    updateOnlineUI(v);
    toast(v ? 'Вы онлайн 🟢' : 'Вы офлайн', 'ok');
  } catch { toast('Ошибка', 'err'); }
};

function updateOnlineUI(on) {
  const tog = document.getElementById('online-tog');
  if (tog) tog.checked = on;
  const v = document.getElementById('sb-online-val');
  if (v) { v.textContent = on ? 'Онлайн' : 'Офлайн'; v.className = 'sb-online-val' + (on ? ' on' : ''); }
  const card = document.getElementById('sb-online-card');
  if (card) card.className = 'sb-online' + (on ? ' is-online' : '');
  const chip = document.getElementById('tb-chip');
  if (chip) { chip.className = 'tb-chip' + (on ? ' online' : ' offline'); }
  const chipTxt = document.getElementById('tb-chip-txt');
  if (chipTxt) chipTxt.textContent = on ? 'Онлайн' : 'Офлайн';
}

function updateEarnUI() {
  const se = document.getElementById('sb-earn-val');
  if (se) se.textContent = todayEarnings + ' ₽';
  const de = document.getElementById('d-earn');
  if (de) de.textContent = todayEarnings + ' ₽';
}

// ─── Звук ────────────────────────────────────────────────────
window.toggleSound = function () {
  soundEnabled = !soundEnabled;
  const b = document.getElementById('sound-btn');
  b.className = 'tb-sound' + (soundEnabled ? ' on' : '');
  b.innerHTML = soundEnabled
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  toast(soundEnabled ? 'Звук включён' : 'Беззвучно', 'ok');
};

function playBeep() {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 140, 280].forEach((d, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 900 - i * 90; o.type = 'sine';
      g.gain.setValueAtTime(.15, ctx.currentTime + d / 1000);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + d / 1000 + .2);
      o.start(ctx.currentTime + d / 1000);
      o.stop(ctx.currentTime + d / 1000 + .2);
    });
  } catch {}
}

// ─── Навигация ────────────────────────────────────────────────
window.goPage = function (page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ni,.mn-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  document.querySelectorAll(`.ni[data-page="${page}"],.mn-item[data-page="${page}"]`).forEach(n => n.classList.add('active'));
  const T = {
    dashboard:  'Дашборд',
    'new-orders': 'Новые заказы',
    active:     'Активный заказ',
    history:    'История',
    profile:    'Профиль',
  };
  const tb = document.getElementById('tb-title');
  if (tb) tb.textContent = T[page] || 'Galelium Courier';
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

document.getElementById('sb-overlay').addEventListener('click', closeSB);

// ─── Статистика ───────────────────────────────────────────────
async function calcStats() {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const q  = query(collection(db, COL.ORDERS), where('courierId', '==', CU.uid), where('status', '==', 'delivered'));
    const sn = await getDocs(q);
    const all = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    const td  = all.filter(o => o.updatedAt?.toDate && o.updatedAt.toDate() >= today);
    todayDeliveries = td.length;
    todayEarnings   = todayDeliveries * EPD;
    const dt = document.getElementById('d-today');   if (dt) dt.textContent = todayDeliveries;
    const dT = document.getElementById('d-total');   if (dT) dT.textContent = CD?.totalDeliveries || 0;
    const dr = document.getElementById('d-rating');  if (dr) dr.textContent = CD?.rating ? CD.rating.toFixed(1) : '—';
    updateEarnUI();
    const pst = document.getElementById('ps-total');  if (pst) pst.textContent = CD?.totalDeliveries || 0;
    const pse = document.getElementById('ps-earn');   if (pse) pse.textContent = CD?.earnings || 0;
    const psr = document.getElementById('ps-rating'); if (psr) psr.textContent = CD?.rating ? CD.rating.toFixed(1) : '—';
  } catch {}
}

// ─── Realtime слушатели ───────────────────────────────────────
function startListeners() {
  listenNew();
  listenActive();
}

function listenNew() {
  if (unsubNew) { unsubNew(); unsubNew = null; }
  const q    = query(collection(db, COL.ORDERS), where('status', 'in', ['pending', 'confirmed']), where('courierId', '==', null));
  let first  = true;
  unsubNew   = onSnapshot(q, sn => {
    const prev = newOrders.length;
    newOrders  = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    updateNewBadge();
    renderNewOrders();
    renderDashNew();
    if (!first && newOrders.length > prev) {
      playBeep();
      toast('🔔 Новый заказ!', 'info');
      renderNotif();
    }
    first = false;
  });
}

function listenActive() {
  if (unsubActive) { unsubActive(); unsubActive = null; }
  const q  = query(collection(db, COL.ORDERS), where('courierId', '==', CU.uid), where('status', 'in', ['delivering', 'preparing']), limit(1));
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
  if (el) el.textContent = cnt + ' заказов';
}

function updateActiveBadge() {
  ['active-badge', 'mob-active-badge'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.style.display = activeOrder ? '' : 'none';
  });
}

// ─── Карточка нового заказа ───────────────────────────────────
function orderCard(o, cdShow = false) {
  const items = (o.items || []).map(i => `${i.name} ×${i.quantity}`).join(', ');
  const time  = o.createdAt?.toDate ? o.createdAt.toDate().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
  const pay   = o.paymentMethod === 'cash' ? 'Наличными' : o.paymentMethod === 'card' ? 'Картой' : 'Онлайн';
  const sc    = o.status === 'confirmed' ? 'var(--g)' : 'var(--yellow)';
  const sl    = o.status === 'confirmed' ? 'Подтверждён' : 'Ожидает';
  return `<div class="oc" id="oc-${o.id}">
    <div class="oc-head">
      <div>
        <div class="oc-meta">
          <span class="oc-num">#${o.id.slice(-6).toUpperCase()}</span>
          <span class="oc-status-pill" style="color:${sc};border-color:${sc}40;background:${sc}10">${sl}</span>
        </div>
        <div class="oc-addr">${o.address || 'Адрес не указан'}</div>
      </div>
      <div class="oc-time">${time}</div>
    </div>
    ${cdShow ? `<div class="cd-wrap"><div class="cd-track"><div class="cd-fill" id="cd-${o.id}" style="width:100%"></div></div><div class="cd-row"><span>Принять заказ</span><span id="cd-txt-${o.id}">60с</span></div></div>` : ''}
    <div class="oc-items"><div class="oc-items-lbl">Состав</div>${items}</div>
    <div class="oc-foot">
      <div>
        <div class="oc-chips">
          <div class="oc-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>${EPD} ₽</div>
          <div class="oc-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="1"/><path d="M2 10h20"/></svg>${pay}</div>
          ${o.comment ? `<div class="oc-chip"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>${o.comment}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <div class="oc-earn">${EPD} <span>₽</span></div>
        <button class="btn-acc" onclick="acceptOrder('${o.id}')" id="btn-${o.id}" ${activeOrder ? 'disabled' : ''}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Взять
        </button>
      </div>
    </div>
  </div>`;
}

// ─── Обратный отсчёт на карточке ─────────────────────────────
function startCD(oid) {
  if (CDS[oid]) return;
  let s = 60;
  CDS[oid] = setInterval(() => {
    s--;
    const bar = document.getElementById('cd-' + oid);
    const txt = document.getElementById('cd-txt-' + oid);
    if (bar) { bar.style.width = (s / 60 * 100) + '%'; bar.style.background = s < 15 ? 'var(--red)' : s < 30 ? 'var(--yellow)' : 'var(--acc)'; }
    if (txt) txt.textContent = s + 'с';
    if (s <= 0) { clearInterval(CDS[oid]); delete CDS[oid]; }
  }, 1000);
}

function sortByTime(arr) {
  return [...arr].sort((a, b) => {
    const ta = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
    const tb = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
    return ta - tb;
  });
}

// ─── Рендер новых заказов ─────────────────────────────────────
function renderNewOrders() {
  const el = document.getElementById('new-orders-list');
  if (!el) return;
  const sorted = sortByTime(newOrders);
  if (!sorted.length) {
    el.innerHTML = '<div class="empty"><span class="empty-ico">📭</span><div class="empty-title">Нет новых заказов</div><div class="empty-sub">Заказы появятся автоматически</div></div>';
    return;
  }
  el.innerHTML = sorted.map((o, i) => orderCard(o, i === 0)).join('');
  if (sorted[0]) startCD(sorted[0].id);
}

function renderDashNew() {
  const el = document.getElementById('dash-new-orders');
  if (!el) return;
  const sorted = sortByTime(newOrders);
  if (!sorted.length) {
    el.innerHTML = '<div class="empty" style="padding:30px 20px"><span class="empty-ico">📭</span><div class="empty-title">Новых заказов нет</div><div class="empty-sub">Ожидаем поступления…</div></div>';
    renderNotif();
    return;
  }
  el.innerHTML = sorted.slice(0, 3).map(o => orderCard(o)).join('');
  renderNotif();
}

function renderNotif() {
  const w = document.getElementById('notif-wrap');
  if (!w) return;
  if (!newOrders.length) { w.innerHTML = ''; return; }
  w.innerHTML = `<div class="nb" onclick="goPage('new-orders')">
    <div class="nb-pulse"></div>
    <div class="nb-info"><div class="nb-lbl">Новые заказы</div><div class="nb-txt">${newOrders.length} заказ(а) ждут курьера</div></div>
    <svg class="nb-arr" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}

// ─── Принять заказ ────────────────────────────────────────────
window.acceptOrder = async function (oid) {
  if (activeOrder) { toast('Уже есть активный заказ', 'err'); return; }
  const btn = document.getElementById('btn-' + oid);
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spin" style="border-color:rgba(5,8,10,.2);border-top-color:#05080a;width:12px;height:12px"></div>'; }
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), {
      courierId:   CU.uid,
      courierName: UD?.displayName || '',
      status:      'delivering',
      updatedAt:   serverTimestamp(),
    });
    await setDoc(doc(db, COL.COURIERS, CU.uid), { currentOrderId: oid, isActive: true, isOnline: true, updatedAt: serverTimestamp() }, { merge: true });
    CD = { ...CD, currentOrderId: oid, isActive: true, isOnline: true };
    const tog = document.getElementById('online-tog');
    if (tog) tog.checked = true;
    updateOnlineUI(true);
    toast('Заказ принят! Вперёд 🚴', 'ok');
    goPage('active');
  } catch (e) {
    toast('Ошибка: ' + e.message, 'err');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Взять'; }
  }
};

// ─── Активный заказ ───────────────────────────────────────────
function renderActive() {
  const el = document.getElementById('active-content');
  if (!el) return;
  if (!activeOrder) {
    el.innerHTML = '<div class="empty"><span class="empty-ico">🚴</span><div class="empty-title">Нет активного заказа</div><div class="empty-sub">Возьмите заказ из списка</div></div>';
    return;
  }
  const o    = activeOrder;
  const si   = SSTEPS.indexOf(o.status);
  const date = o.createdAt?.toDate ? o.createdAt.toDate().toLocaleString('ru-RU') : '—';
  const pay  = o.paymentMethod === 'cash' ? 'Наличными' : o.paymentMethod === 'card' ? 'Картой' : 'Онлайн';
  const steps = SSTEPS.map((s, i) => {
    const cls = i < si ? 'done' : i === si ? 'current' : '';
    return `<div class="step ${cls}"><div class="step-dot">${i <= si ? SICONS[i] : ''}</div><div class="step-lbl">${SLBLS[i]}</div></div>`;
  }).join('');
  const ni  = si + 1;
  const can = ni < SSTEPS.length;
  el.innerHTML = `<div class="ao">
    <div class="ao-head">
      <div>
        <div class="ao-num">Заказ #${o.id.slice(-6).toUpperCase()}</div>
        <div class="ao-addr">${o.address || '—'}</div>
      </div>
      <div class="ao-badge"><div class="ao-pulse"></div>${SL[o.status] || o.status}</div>
    </div>
    <div class="steps">${steps}</div>
    <div class="divider"></div>
    <div class="detail-grid">
      <div class="detail-item"><div class="detail-lbl">Клиент</div><div class="detail-val">${o.clientName || '—'}</div></div>
      <div class="detail-item"><div class="detail-lbl">Оплата</div><div class="detail-val">${pay}</div></div>
      <div class="detail-item"><div class="detail-lbl">Комментарий</div><div class="detail-val">${o.comment || 'Нет'}</div></div>
      <div class="detail-item"><div class="detail-lbl">Время заказа</div><div class="detail-val">${date}</div></div>
    </div>
    <div class="divider"></div>
    <div class="detail-lbl" style="margin-bottom:8px">Состав заказа</div>
    ${(o.items || []).map(i => `<div class="item-r"><span class="item-n">${i.name}</span><span class="item-q">×${i.quantity}</span><span class="item-p">${i.price * i.quantity} ₽</span></div>`).join('')}
    <div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid var(--b);font-size:.78rem">
      <span style="color:var(--text2)">Сумма клиента</span><span style="font-family:var(--fm);color:var(--text)">${o.total} ₽</span>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:.78rem">
      <span style="color:var(--muted)">Ваш заработок</span>
      <span style="font-family:var(--fm);color:var(--g);font-weight:600">${EPD} ₽</span>
    </div>
    ${can ? `<div class="sa"><button class="btn-st${SNST[si] === 'delivered' ? ' final' : ''}" onclick="advance('${o.id}','${SNST[si]}')">${SNBTNS[si]}</button></div>` : ''}
  </div>`;
}

function renderDashActive() {
  const w = document.getElementById('dash-active-wrap');
  if (!w) return;
  if (!activeOrder) { w.innerHTML = ''; return; }
  const o = activeOrder;
  w.innerHTML = `<div class="ab" onclick="goPage('active')">
    <div class="ab-pulse"></div>
    <div class="ab-info"><div class="ab-lbl">В работе сейчас</div><div class="ab-txt">#${o.id.slice(-6).toUpperCase()} · ${SL[o.status]} · ${o.address || ''}</div></div>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--g)" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </div>`;
}

// ─── Продвинуть статус заказа ─────────────────────────────────
window.advance = async function (oid, ns) {
  try {
    await updateDoc(doc(db, COL.ORDERS, oid), { status: ns, updatedAt: serverTimestamp() });
    if (ns === 'delivered') {
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
      const dt = document.getElementById('d-today');  if (dt) dt.textContent = todayDeliveries;
      const dT = document.getElementById('d-total');  if (dT) dT.textContent = CD.totalDeliveries;
      const pt = document.getElementById('ps-total'); if (pt) pt.textContent = CD.totalDeliveries;
      const pe = document.getElementById('ps-earn');  if (pe) pe.textContent = CD.earnings;
      updateEarnUI();
      toast('🎉 Доставлено! +' + EPD + ' ₽', 'ok');
      loadHistory();
    } else {
      toast('Статус: ' + SL[ns], 'ok');
    }
  } catch { toast('Ошибка', 'err'); }
};

// ─── История доставок ─────────────────────────────────────────
async function loadHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  el.innerHTML = '<div class="pload"><div class="spin"></div> Загрузка…</div>';
  try {
    const q  = query(collection(db, COL.ORDERS), where('courierId', '==', CU.uid), where('status', '==', 'delivered'), orderBy('updatedAt', 'desc'), limit(50));
    const sn = await getDocs(q);
    historyOrders = sn.docs.map(d => ({ id: d.id, ...d.data() }));
    renderHistory();
  } catch {
    el.innerHTML = '<div class="empty"><span class="empty-ico">📭</span><div class="empty-title">Нет доставок</div></div>';
  }
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  const te = historyOrders.length * EPD;
  const ht = document.getElementById('hist-total-txt');
  if (ht) ht.textContent = historyOrders.length + ' доставок · ' + te + ' ₽';
  if (!historyOrders.length) {
    el.innerHTML = '<div class="empty"><span class="empty-ico">📭</span><div class="empty-title">Нет доставок</div><div class="empty-sub">Выполненные доставки появятся здесь</div></div>';
    return;
  }
  el.innerHTML = historyOrders.map(o => {
    const d = o.updatedAt?.toDate
      ? o.updatedAt.toDate().toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '—';
    return `<div class="hc">
      <div class="hc-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></div>
      <div class="hc-info"><div class="hc-num">#${o.id.slice(-6).toUpperCase()}</div><div class="hc-addr">${o.address || '—'}</div><div class="hc-date">${d}</div></div>
      <div class="hc-earn">+${EPD} ₽</div>
    </div>`;
  }).join('');
}

// ─── Профиль ─────────────────────────────────────────────────
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
  const pse = document.getElementById('ps-earn');    if (pse) pse.textContent = CD?.earnings || 0;
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
    renderSB();
    renderProfile();
    toast('Сохранено', 'ok');
  } catch { toast('Ошибка', 'err'); }
};

window.uploadAvUI = async function (inp) {
  const f = inp.files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) { toast('Файл слишком большой', 'err'); return; }
  toast('Загружаем…');
  try {
    const sr  = sRef(storage, `avatars/${CU.uid}`);
    await uploadBytes(sr, f);
    const url = await getDownloadURL(sr);
    await setDoc(doc(db, COL.USERS, CU.uid), { avatarUrl: url, updatedAt: serverTimestamp() }, { merge: true });
    UD.avatarUrl = url;
    renderSB();
    renderProfile();
    toast('Аватар обновлён', 'ok');
  } catch { toast('Ошибка загрузки', 'err'); }
};
