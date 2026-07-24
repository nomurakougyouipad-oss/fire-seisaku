// ============================================================
// データ層 — Firestore の案件(cases)・写真(photos)を扱う
// リアルタイム購読(onSnapshot)で全端末同期
// ============================================================

import {
  ready, db,
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  getDocs, getDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch,
} from './firebase.js';
import { STAGES } from './util.js';

const CASES = 'cases';

// ---- 案件 CRUD ---------------------------------------------

// 全案件をリアルタイム購読。cb(cases[]) が更新のたびに呼ばれる。
export function subscribeCases(cb, onError) {
  let unsub = () => {};
  ready.then(() => {
    const q = query(collection(db, CASES), orderBy('due', 'asc'));
    unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cb(rows);
    }, (err) => {
      console.error('案件購読エラー:', err);
      onError && onError(err);
    });
  }).catch((err) => onError && onError(err));
  return () => unsub();
}

// 単一案件をリアルタイム購読
export function subscribeCase(id, cb, onError) {
  let unsub = () => {};
  ready.then(() => {
    unsub = onSnapshot(doc(db, CASES, id), (d) => {
      cb(d.exists() ? { id: d.id, ...d.data() } : null);
    }, (err) => {
      console.error('案件購読エラー:', err);
      onError && onError(err);
    });
  }).catch((err) => onError && onError(err));
  return () => unsub();
}

export async function getCase(id) {
  await ready;
  const d = await getDoc(doc(db, CASES, id));
  return d.exists() ? { id: d.id, ...d.data() } : null;
}

// 新規案件を作成。mgmtNo をドキュメントIDに使う（重複時は自動採番へフォールバック）
export async function createCase(data) {
  await ready;
  const payload = normalizeCase(data);
  const id = payload.mgmtNo && payload.mgmtNo.trim();
  if (id) {
    const refDoc = doc(db, CASES, id);
    const existing = await getDoc(refDoc);
    if (existing.exists()) throw new Error('その管理No は既に登録されています');
    await setDoc(refDoc, {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  }
  const created = await addDoc(collection(db, CASES), {
    ...payload,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return created.id;
}

export async function updateCase(id, data) {
  await ready;
  const payload = normalizeCase(data);
  delete payload.mgmtNo; // 管理No(=ID)は変更しない
  await updateDoc(doc(db, CASES, id), { ...payload, updatedAt: serverTimestamp() });
}

export async function patchCase(id, partial) {
  await ready;
  await updateDoc(doc(db, CASES, id), { ...partial, updatedAt: serverTimestamp() });
}

export async function deleteCase(id) {
  await ready;
  await deleteDoc(doc(db, CASES, id));
}

// 入力値を正規化（型を揃える）
function normalizeCase(d) {
  return {
    mgmtNo: (d.mgmtNo ?? '').trim(),
    customer: (d.customer ?? '').trim(),
    type: (d.type ?? '').trim(),
    chassis: (d.chassis ?? '').trim(),
    stageIndex: clampInt(d.stageIndex, 0, STAGES.length - 1),
    progress: clampInt(d.progress, 0, 100),
    due: d.due || '',
    staff: (d.staff ?? '').trim(),
    status: ['順調', '要注意', '遅延'].includes(d.status) ? d.status : '順調',
    orderAmount: toNum(d.orderAmount),
    materialCost: toNum(d.materialCost),
    laborCost: toNum(d.laborCost),
  };
}

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clampInt(v, lo, hi) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }

// ---- 写真（工程ごと。段階2で本格利用） --------------------
// cases/{caseId}/photos ドキュメント：{ stageIndex, stageTag, url, path, memo, takenBy, createdAt }

export function subscribePhotos(caseId, cb, onError) {
  let unsub = () => {};
  ready.then(() => {
    const q = query(collection(db, CASES, caseId, 'photos'), orderBy('createdAt', 'asc'));
    unsub = onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => { console.error('写真購読エラー:', err); onError && onError(err); });
  }).catch((err) => onError && onError(err));
  return () => unsub();
}

export async function addPhoto(caseId, data) {
  await ready;
  const created = await addDoc(collection(db, CASES, caseId, 'photos'), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return created.id;
}

export async function updatePhoto(caseId, photoId, partial) {
  await ready;
  await updateDoc(doc(db, CASES, caseId, 'photos', photoId), partial);
}

export async function deletePhoto(caseId, photoId) {
  await ready;
  await deleteDoc(doc(db, CASES, caseId, 'photos', photoId));
}

// ---- シード（初回のみ・サンプル7件を投入） ----------------

export async function seedIfEmpty() {
  await ready;
  const snap = await getDocs(collection(db, CASES));
  if (!snap.empty) return false;

  const batch = writeBatch(db);
  SEED_CASES.forEach((c) => {
    batch.set(doc(db, CASES, c.mgmtNo), {
      ...c,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
  return true;
}

// プロトタイプのサンプルデータ（納期は2026年の絶対日付に変換）
const SEED_CASES = [
  { mgmtNo: 'FE-2481', customer: '相模原市消防団', type: 'CD-I型 ポンプ自動車', chassis: 'いすゞ ELF', stageIndex: 2, progress: 44, due: '2026-09-30', staff: '田中', status: '順調', orderAmount: 3200000, materialCost: 1850000, laborCost: 620000 },
  { mgmtNo: 'FE-2479', customer: '厚木市消防本部', type: '水槽付ポンプ自動車', chassis: '日野 レンジャー', stageIndex: 3, progress: 61, due: '2026-08-22', staff: '佐藤', status: '順調', orderAmount: 4380000, materialCost: 2400000, laborCost: 980000 },
  { mgmtNo: 'FE-2475', customer: '海老名市消防団', type: '小型動力ポンプ付積載車', chassis: 'トヨタ ダイナ', stageIndex: 4, progress: 78, due: '2026-08-05', staff: '鈴木', status: '要注意', orderAmount: 2080000, materialCost: 1120000, laborCost: 540000 },
  { mgmtNo: 'FE-2470', customer: '座間市消防本部', type: '資機材搬送車', chassis: 'いすゞ フォワード', stageIndex: 5, progress: 92, due: '2026-07-31', staff: '高橋', status: '順調', orderAmount: 3450000, materialCost: 1680000, laborCost: 1240000 },
  { mgmtNo: 'FE-2468', customer: '大和市消防団', type: 'CD-II型 ポンプ自動車', chassis: '三菱ふそう キャンター', stageIndex: 1, progress: 22, due: '2026-10-20', staff: '田中', status: '順調', orderAmount: 2960000, materialCost: 2050000, laborCost: 410000 },
  { mgmtNo: 'FE-2465', customer: '綾瀬市消防本部', type: '救助工作車', chassis: '日野 レンジャー', stageIndex: 0, progress: 8, due: '2026-11-15', staff: '伊藤', status: '順調', orderAmount: 4650000, materialCost: 3200000, laborCost: 260000 },
  { mgmtNo: 'FE-2460', customer: '秦野市消防団', type: '水槽付ポンプ自動車', chassis: 'いすゞ フォワード', stageIndex: 4, progress: 70, due: '2026-07-25', staff: '佐藤', status: '遅延', orderAmount: 3980000, materialCost: 2380000, laborCost: 1050000 },
];
