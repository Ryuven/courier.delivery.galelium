// ============================================================
//  firebase.js — Galelium Courier · courier.delivery.galelium.com
// ============================================================

import { initializeApp }  from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js';
import { getStorage }     from 'https://www.gstatic.com/firebasejs/11.8.1/firebase-storage.js';

const firebaseConfig = {
  apiKey:            'AIzaSyCjIAMFuwLKwmjChCuiz-MHLv5WZOczAAE',
  authDomain:        'delivery-galelium.firebaseapp.com',
  projectId:         'delivery-galelium',
  storageBucket:     'delivery-galelium.firebasestorage.app',
  messagingSenderId: '982466555080',
  appId:             '1:982466555080:web:c77ccbff0e71e540ddc9fd',
};

const app = initializeApp(firebaseConfig);

export const auth    = getAuth(app);
export const db      = getFirestore(app);
export const storage = getStorage(app);

export const COL = {
  USERS:    'users',
  ORDERS:   'orders',
  COURIERS: 'couriers',
};

// Статусы заказа (расширенные для 3-шагового флоу)
export const ORDER_STATUS = {
  PENDING:         'pending',
  CONFIRMED:       'confirmed',
  PREPARING:       'preparing',
  // Новые статусы для 3-шагового флоу курьера:
  COURIER_HEADING: 'courier_heading',   // Шаг 1: Курьер едет в магазин
  COURIER_ARRIVED: 'courier_arrived',   // Курьер прибыл в магазин
  COLLECTING:      'collecting',        // Шаг 2: Сборка товаров
  DELIVERING:      'delivering',        // Шаг 3: Везёт клиенту
  CLIENT_ARRIVED:  'client_arrived',    // Прибыл к клиенту
  DELIVERED:       'delivered',
  CANCELLED:       'cancelled',
};

export const EPD = 80; // Заработок за доставку (сомони)

export const VEHICLE_TYPES = {
  bicycle: 'Велосипед',
  scooter: 'Мотор/Скутер',
  car:     'Автомобил',
  foot:    'Пиёда',
};
