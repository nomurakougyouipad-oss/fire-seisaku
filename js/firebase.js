// ============================================================
// Firebase 初期化 — Firestore / Storage / 匿名認証
// 静的サイト（GitHub Pages）から CDN の Firebase v10 モジュールを利用
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';

import firebaseConfig from '../firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);

// 匿名サインイン。ready が解決したらデータ操作可能。
export const ready = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch((err) => {
    console.error('匿名サインインに失敗:', err);
    reject(err);
  });
});

// Firestore/Storage の関数を再エクスポート（他モジュールで使用）
export {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDocs, getDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
};
