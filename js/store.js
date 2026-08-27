// ============================================================
// データ層 — Firestore の案件(cases)・写真(photos)を扱う
// リアルタイム購読(onSnapshot)で全端末同期
// ============================================================

import {
  ready, db, storage,
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc,
  getDocs, getDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch,
  storageRef, uploadBytes, getDownloadURL, deleteObject,
} from './firebase.js';
import { STAGES, PART_KINDS, PART_STATUSES, JUDGES, DOC_GROUPS } from './util.js';
import { resizeImage } from './image.js';

const CASES = 'cases';
const PARTS = 'parts';

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

// 案件を削除。関連する工程写真・図面・検査（サブコレクション）と
// Storage 上の実体（写真・図面ファイル）もまとめて削除する。
export async function deleteCase(id) {
  await ready;

  const [photoSnap, docSnap, inspSnap] = await Promise.all([
    getDocs(collection(db, CASES, id, 'photos')),
    getDocs(collection(db, CASES, id, 'documents')),
    getDocs(collection(db, CASES, id, 'inspections')),
  ]);

  // Storage 実体（path を持つ写真・図面）を削除
  const paths = [];
  photoSnap.forEach((d) => { const p = d.data().path; if (p) paths.push(p); });
  docSnap.forEach((d) => { const p = d.data().path; if (p) paths.push(p); });
  await Promise.all(paths.map((p) => deleteObject(storageRef(storage, p)).catch(() => {})));

  // Firestore のサブコレクションを削除（件数に依存しないよう個別削除）
  const dels = [];
  photoSnap.forEach((d) => dels.push(deleteDoc(d.ref)));
  docSnap.forEach((d) => dels.push(deleteDoc(d.ref)));
  inspSnap.forEach((d) => dels.push(deleteDoc(d.ref)));
  await Promise.all(dels);

  // 最後に案件本体を削除
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
    orderDate: d.orderDate || '',
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

// カメラ/ファイルの画像を リサイズ → Storage へアップロード → 写真メタを Firestore に保存
// 工程タグ(stageTag)は工程indexから自動付与。全端末へ onSnapshot で即共有される。
export async function uploadStagePhoto(caseId, stageIndex, file, { takenBy = '', onStage } = {}) {
  await ready;
  const si = clampInt(stageIndex, 0, STAGES.length - 1);

  if (onStage) onStage('resize');
  const blob = await resizeImage(file); // 長辺1600px・約300KBのJPEG

  if (onStage) onStage('upload');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `cases/${caseId}/${si}_${Date.now()}_${rand}.jpg`;
  const sref = storageRef(storage, path);
  await uploadBytes(sref, blob, { contentType: 'image/jpeg' });
  const url = await getDownloadURL(sref);

  if (onStage) onStage('save');
  const id = await addPhoto(caseId, {
    stageIndex: si,
    stageTag: STAGES[si],
    url,
    path,
    memo: '',
    takenBy: (takenBy || '').trim(),
    bytes: blob.size,
  });
  return { id, url, path };
}

// 写真を削除（Firestoreメタ + Storage実体）
export async function removePhoto(caseId, photo) {
  await ready;
  await deleteDoc(doc(db, CASES, caseId, 'photos', photo.id));
  if (photo.path) {
    try { await deleteObject(storageRef(storage, photo.path)); }
    catch (err) { console.warn('Storageの写真削除に失敗（メタは削除済み）:', err); }
  }
}

// ---- 部品・資材 CRUD（段階3・topレベル parts コレクション） --
// parts ドキュメント：{ kind, name, model, caseId, need, stock, supplier, price, eta, status, createdAt, updatedAt }

export function subscribeParts(cb, onError) {
  let unsub = () => {};
  ready.then(() => {
    const q = query(collection(db, PARTS), orderBy('createdAt', 'asc'));
    unsub = onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => {
      console.error('部品購読エラー:', err);
      onError && onError(err);
    });
  }).catch((err) => onError && onError(err));
  return () => unsub();
}

export async function createPart(data) {
  await ready;
  const created = await addDoc(collection(db, PARTS), {
    ...normalizePart(data),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return created.id;
}

export async function updatePart(id, data) {
  await ready;
  await updateDoc(doc(db, PARTS, id), { ...normalizePart(data), updatedAt: serverTimestamp() });
}

export async function deletePart(id) {
  await ready;
  await deleteDoc(doc(db, PARTS, id));
}

// 入力値を正規化（型を揃える）
function normalizePart(d) {
  return {
    kind: PART_KINDS.includes(d.kind) ? d.kind : '部品',
    name: (d.name ?? '').trim(),
    model: (d.model ?? '').trim(),
    caseId: (d.caseId ?? '').trim(),
    need: clampInt(d.need, 0, 1000000),
    stock: clampInt(d.stock, 0, 1000000),
    supplier: (d.supplier ?? '').trim(),
    price: toNum(d.price),
    eta: (d.eta ?? '').trim(),
    status: PART_STATUSES.includes(d.status) ? d.status : '未発注',
  };
}

// ---- 検査（段階3・cases/{caseId}/inspections サブコレクション） --
// inspection ドキュメント：{ item, judge, date, inspector, note, order, createdAt, updatedAt }

export function subscribeInspections(caseId, cb, onError) {
  let unsub = () => {};
  ready.then(() => {
    const q = query(collection(db, CASES, caseId, 'inspections'), orderBy('order', 'asc'));
    unsub = onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => {
      console.error('検査購読エラー:', err);
      onError && onError(err);
    });
  }).catch((err) => onError && onError(err));
  return () => unsub();
}

export async function addInspection(caseId, data, order) {
  await ready;
  const created = await addDoc(collection(db, CASES, caseId, 'inspections'), {
    ...normalizeInspection(data),
    order: Number.isFinite(order) ? order : Date.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return created.id;
}

export async function updateInspection(caseId, id, partial) {
  await ready;
  const clean = {};
  // 判定タップ等の部分更新にも対応（渡された項目だけ正規化して更新）
  if ('item' in partial) clean.item = (partial.item ?? '').trim();
  if ('judge' in partial) clean.judge = JUDGES.includes(partial.judge) ? partial.judge : '未判定';
  if ('date' in partial) clean.date = (partial.date ?? '').trim();
  if ('inspector' in partial) clean.inspector = (partial.inspector ?? '').trim();
  if ('note' in partial) clean.note = (partial.note ?? '').trim();
  if ('order' in partial && Number.isFinite(partial.order)) clean.order = partial.order;
  await updateDoc(doc(db, CASES, caseId, 'inspections', id), { ...clean, updatedAt: serverTimestamp() });
}

export async function deleteInspection(caseId, id) {
  await ready;
  await deleteDoc(doc(db, CASES, caseId, 'inspections', id));
}

function normalizeInspection(d) {
  return {
    item: (d.item ?? '').trim(),
    judge: JUDGES.includes(d.judge) ? d.judge : '未判定',
    date: (d.date ?? '').trim(),
    inspector: (d.inspector ?? '').trim(),
    note: (d.note ?? '').trim(),
  };
}

// 標準の検査項目（初回のみ自動投入）
const STANDARD_INSPECTIONS = [
  'ポンプ性能・放水試験',
  '真空性能試験',
  '電装・配線',
  '灯火・保安基準',
  '寸法・全幅全高',
  '車両総重量',
  '外観・塗装',
];

// 案件の検査項目が未登録なら標準チェックリストを投入（全項目 未判定）
export async function seedInspectionsIfEmpty(caseId) {
  await ready;
  const col = collection(db, CASES, caseId, 'inspections');
  const snap = await getDocs(col);
  if (!snap.empty) return false;

  const batch = writeBatch(db);
  STANDARD_INSPECTIONS.forEach((item, i) => {
    batch.set(doc(col), {
      item, judge: '未判定', date: '', inspector: '', note: '',
      order: i,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
  return true;
}

// ---- 図面・仕様書・書類（段階4・cases/{caseId}/documents サブコレクション） --
// document ドキュメント：{ group, name, ext, size, rev, date, url, path, contentType, createdAt }
// 実体は Storage の cases/{caseId}/docs/ に保存（写真と同じ仕組み・全端末同期）

function ymd(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function subscribeDocuments(caseId, cb, onError) {
  let unsub = () => {};
  ready.then(() => {
    const q = query(collection(db, CASES, caseId, 'documents'), orderBy('createdAt', 'asc'));
    unsub = onSnapshot(q, (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    }, (err) => { console.error('図面購読エラー:', err); onError && onError(err); });
  }).catch((err) => onError && onError(err));
  return () => unsub();
}

// ファイルを Storage にアップロード → メタを Firestore に保存
export async function uploadDocument(caseId, file, { group, rev } = {}, { onStage } = {}) {
  await ready;
  if (onStage) onStage('upload');
  const rand = Math.random().toString(36).slice(2, 8);
  const safe = (file.name || 'file').replace(/[^\w.\-]+/g, '_');
  const path = `cases/${caseId}/docs/${Date.now()}_${rand}_${safe}`;
  const sref = storageRef(storage, path);
  await uploadBytes(sref, file, { contentType: file.type || 'application/octet-stream' });
  const url = await getDownloadURL(sref);

  if (onStage) onStage('save');
  const ext = ((file.name || '').split('.').pop() || '').toUpperCase().slice(0, 5);
  const created = await addDoc(collection(db, CASES, caseId, 'documents'), {
    group: DOC_GROUPS.includes(group) ? group : DOC_GROUPS[0],
    name: file.name || 'file',
    ext,
    size: file.size || 0,
    rev: (rev || '').trim(),
    date: ymd(),
    url,
    path,
    contentType: file.type || '',
    createdAt: serverTimestamp(),
  });
  return { id: created.id, url, path };
}

// 図面メタの一部を更新（種別・Rev の変更など）
export async function updateDocument(caseId, id, partial) {
  await ready;
  const clean = {};
  if ('group' in partial) clean.group = DOC_GROUPS.includes(partial.group) ? partial.group : DOC_GROUPS[0];
  if ('name' in partial) clean.name = (partial.name ?? '').trim();
  if ('rev' in partial) clean.rev = (partial.rev ?? '').trim();
  await updateDoc(doc(db, CASES, caseId, 'documents', id), clean);
}

// 図面を削除（Firestoreメタ + Storage実体）
export async function removeDocument(caseId, docu) {
  await ready;
  await deleteDoc(doc(db, CASES, caseId, 'documents', docu.id));
  if (docu.path) {
    try { await deleteObject(storageRef(storage, docu.path)); }
    catch (err) { console.warn('Storageの図面削除に失敗（メタは削除済み）:', err); }
  }
}

// 既存の案件で受注日が未設定のものに、仮の受注日を後付けで補完（初回のみ）。
// 仮値は「納期の120日前」。既存サンプルにも受注日が入るようにする。
export async function backfillOrderDates() {
  await ready;
  const snap = await getDocs(collection(db, CASES));
  const missing = snap.docs.filter((d) => !d.data().orderDate);
  if (!missing.length) return 0;

  const batch = writeBatch(db);
  missing.forEach((d) => {
    const data = d.data();
    const od = data.due ? isoMinusDays(data.due, 120) : '';
    batch.update(d.ref, { orderDate: od, updatedAt: serverTimestamp() });
  });
  await batch.commit();
  return missing.length;
}

function isoMinusDays(iso, days) {
  const base = new Date(iso + 'T00:00:00');
  if (isNaN(base)) return '';
  base.setDate(base.getDate() - days);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
