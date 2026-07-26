// ============================================================
// 共通ユーティリティ — 工程定義・金額/日付表記・進捗計算・DOM補助
// ============================================================

// 7段階の製作工程（固定）
export const STAGES = ['設計', '加工', '艤装', '塗装', '電装', '検査', '納品'];

export const STATUSES = ['順調', '要注意', '遅延'];

// 部品・資材（段階3）
export const PART_KINDS = ['部品', '資材'];
export const PART_STATUSES = ['未発注', '発注済', '入荷待ち', '入荷済'];

// 発注状況 → タグ配色（READMEの指定どおり）
const PART_STATUS_CLASS = {
  '未発注': 'tag-outline',
  '発注済': 'tag-accent',
  '入荷待ち': 'tag-outline',
  '入荷済': 'tag-neutral',
};

// 部品から派生プロパティを付与（表示用ビューモデル）
export function decoratePart(p) {
  const need = Number(p.need) || 0;
  const stock = Number(p.stock) || 0;
  const kind = PART_KINDS.includes(p.kind) ? p.kind : '部品';
  const status = PART_STATUSES.includes(p.status) ? p.status : '未発注';
  return {
    ...p,
    kind,
    need,
    stock,
    status,
    kindClass: kind === '資材' ? 'tag-neutral' : 'tag-accent',
    statusClass: PART_STATUS_CLASS[status] || 'tag-outline',
    low: stock < need,                                   // 在庫が必要数を下回る
    shortBy: Math.max(0, need - stock),
    ordering: status === '発注済' || status === '入荷待ち', // 発注中
  };
}

// 検査（段階3）
export const JUDGES = ['合格', '要調整', '不合格', '未判定'];

// 判定 → タグ配色（READMEの指定どおり）
const JUDGE_CLASS = {
  '合格': 'tag-neutral',
  '要調整': 'tag-outline',
  '不合格': 'tag-accent',
  '未判定': 'tag-outline',
};
export function judgeClass(j) { return JUDGE_CLASS[j] || 'tag-outline'; }

// タップ時の巡回順：未判定 → 合格 → 要調整 → 不合格 → 未判定
const JUDGE_CYCLE = ['未判定', '合格', '要調整', '不合格'];
export function nextJudge(j) {
  const i = JUDGE_CYCLE.indexOf(j);
  return JUDGE_CYCLE[(i + 1) % JUDGE_CYCLE.length];
}

// 図面・仕様書（段階4）
export const DOC_GROUPS = ['図面', '仕様書', '見積・書類'];

// バイト数を読みやすい単位に
export function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// YYYY-MM-DD → YYYY/MM/DD
export function fmtDate(iso) {
  return iso ? String(iso).replace(/-/g, '/') : '—';
}

// 拡張子 → 種類（バッジ配色・プレビュー判定に使用）
export function extKind(ext) {
  const e = String(ext || '').toUpperCase();
  if (e === 'PDF') return 'pdf';
  if (['DXF', 'DWG'].includes(e)) return 'cad';
  if (['XLSX', 'XLS', 'CSV'].includes(e)) return 'sheet';
  if (['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'HEIC', 'BMP'].includes(e)) return 'img';
  if (['DOC', 'DOCX'].includes(e)) return 'doc';
  return 'file';
}

// プレビュー方式を判定：'image' | 'pdf' | 'none'
// ブラウザで表示できるラスター画像のみ 'image' 扱い。
// DXF は image/vnd.dxf 等の contentType を持つことがあるため、拡張子/型を限定する。
const RASTER_EXT = ['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'BMP'];
const RASTER_CT = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'];
export function previewKind(contentType, ext) {
  const ct = String(contentType || '').toLowerCase();
  const e = String(ext || '').toUpperCase();
  if (RASTER_EXT.includes(e) || RASTER_CT.includes(ct)) return 'image';
  if (ct === 'application/pdf' || e === 'PDF') return 'pdf';
  return 'none';
}

// 状態 → 進捗ライン色
export function barColor(status) {
  if (status === '遅延') return '#a52a21';
  if (status === '要注意') return '#e0912f';
  return '#4a9d6b';
}

// 金額（¥・ja-JP区切り）
export function yen(n) {
  const v = Number(n) || 0;
  return '¥' + v.toLocaleString('ja-JP');
}

// 進捗をパーセント表記
export function pct(n) {
  return (Number(n) || 0) + '%';
}

// 工程indexから自動算出する進捗の目安（0=設計→0%, 6=納品→100%）
export function autoProgress(stageIndex) {
  const i = clamp(stageIndex, 0, STAGES.length - 1);
  return Math.round((i / (STAGES.length - 1)) * 100);
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// 納期(YYYY-MM-DD) と基準日から 残日数を算出
export function dueDaysFrom(dueISO, baseDate = new Date()) {
  if (!dueISO) return null;
  const due = new Date(dueISO + 'T00:00:00');
  const base = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const ms = due - base;
  return Math.round(ms / 86400000);
}

// 納期表示ラベル（残N日 / 遅延N日）
export function dueLabel(dueISO, baseDate = new Date()) {
  const d = dueDaysFrom(dueISO, baseDate);
  if (d === null) return '—';
  if (d < 0) return '遅延' + Math.abs(d) + '日';
  if (d === 0) return '本日';
  return '残' + d + '日';
}

// 納期を MM/DD 表記に
export function dueShort(dueISO) {
  if (!dueISO) return '—';
  const d = new Date(dueISO + 'T00:00:00');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return mm + '/' + dd;
}

// 今日の日付（YYYY/MM/DD）
export function todayLabel(base = new Date()) {
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// HTMLエスケープ
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 案件から派生プロパティを付与（表示用ビューモデル）
export function decorateCase(c, baseDate = new Date()) {
  const si = clamp(Number(c.stageIndex) || 0, 0, STAGES.length - 1);
  const status = c.status || '順調';
  const progress = c.progress != null ? Number(c.progress) : autoProgress(si);
  return {
    ...c,
    stageIndex: si,
    status,
    progress,
    stage: STAGES[si],
    stepLabel: (si + 1) + ' / ' + STAGES.length,
    steps: STAGES.map((name, i) => ({
      name,
      state: i < si ? 'done' : i === si ? 'current' : 'todo',
    })),
    barColor: barColor(status),
    dueDays: dueDaysFrom(c.due, baseDate),
    dueLabel: dueLabel(c.due, baseDate),
    dueShort: dueShort(c.due),
    isLate: status === '遅延',
    isWarn: status === '要注意',
    isOk: status === '順調',
  };
}

// 小さなDOM生成ヘルパ
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// トースト表示
let toastWrap;
export function toast(msg, kind = '') {
  if (!toastWrap) {
    toastWrap = h('<div class="toast-wrap"></div>');
    document.body.appendChild(toastWrap);
  }
  const el = h(`<div class="toast ${kind}"></div>`);
  el.textContent = msg;
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

// 四隅レジストレーションマーク
export const CORNERS = '<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>';

// 工程ステッパー HTML
export function stepperHTML(steps, height) {
  const hstyle = height ? ` style="height:${height}px"` : '';
  return `<div class="stepper">` + steps.map(st =>
    `<span class="seg-cell ${st.state}"${hstyle}></span>`
  ).join('') + `</div>`;
}
