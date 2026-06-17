// ============================================================
//  firebase.js — Firebase конфиг и инициализация
//  Courier Panel · courier.delivery.galelium.com
//  Подключение: import { auth, db, storage } from './firebase.js'
// ============================================================

import { initializeApp }  from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js';
import { getStorage }     from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-storage.js';

// ─── Конфигурация Firebase ───────────────────────────────────
const firebaseConfig = {
  apiKey:            'AIzaSyCjIAMFuwLKwmjChCuiz-MHLv5WZOczAAE',
  authDomain:        'delivery-galelium.firebaseapp.com',
  projectId:         'delivery-galelium',
  storageBucket:     'delivery-galelium.firebasestorage.app',
  messagingSenderId: '982466555080',
  appId:             '1:982466555080:web:c77ccbff0e71e540ddc9fd',
};

// ─── Инициализация ───────────────────────────────────────────
const app = initializeApp(firebaseConfig);

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);

// ─── Константы коллекций ─────────────────────────────────────
export const COL = {
  USERS:    'users',
  ORDERS:   'orders',
  COURIERS: 'couriers',
};

// ─── Роли ────────────────────────────────────────────────────
export const ROLES = {
  CLIENT:  'client',
  COURIER: 'courier',
  ADMIN:   'admin',
};

// ─── Статусы заказов ─────────────────────────────────────────
export const ORDER_STATUS = {
  PENDING:    'pending',
  CONFIRMED:  'confirmed',
  PREPARING:  'preparing',
  DELIVERING: 'delivering',
  DELIVERED:  'delivered',
  CANCELLED:  'cancelled',
};

// ─── Заработок за доставку (сомони) ─────────────────────────
export const EPD = 80;

// ─── Типы транспорта ─────────────────────────────────────────
export const VEHICLE_TYPES = {
  bicycle: '🚴 Велосипед',
  scooter: '🛵 Самокат',
  car:     '🚗 Автомобиль',
  foot:    '🚶 Пешком',
};
