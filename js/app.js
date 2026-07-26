// ============================================================
// 消防車両 製作管理アプリ — メインSPA
// ハッシュルーター + Firestoreリアルタイム同期
// 段階1: 案件一覧 / 案件詳細 / 登録・進捗管理
// ============================================================

import {
  STAGES, STATUSES, PART_KINDS, PART_STATUSES, JUDGES, judgeClass, nextJudge,
  DOC_GROUPS, fmtBytes, fmtDate, extKind, previewKind,
  yen, pct, autoProgress, decorateCase, decoratePart, esc, h, toast, CORNERS,
  stepperHTML, todayLabel, dueShort, clamp,
} from './util.js';
import {
  subscribeCases, subscribeCase, subscribePhotos,
  createCase, updateCase, patchCase, deleteCase, seedIfEmpty, getCase,
  uploadStagePhoto, updatePhoto, removePhoto,
  subscribeParts, createPart, updatePart, deletePart, seedPartsIfEmpty,
  subscribeInspections, addInspection, updateInspection, deleteInspection, seedInspectionsIfEmpty,
  subscribeDocuments, uploadDocument, updateDocument, removeDocument,
} from './store.js';
import { ready } from './firebase.js';

// ---- アプリ状態 --------------------------------------------
const state = {
  route: { name: 'orders', param: null },
  casesRaw: [],
  loading: true,
  authError: false,
  search: '',
  sort: 'due',            // 'due' | 'progress'
  // 部品・資材
  partsRaw: [],
  partsLoading: true,
  partSearch: '',
  partKind: 'all',        // 'all' | '部品' | '資材'
  partStatus: 'all',      // 'all' | 未発注 | 発注済 | 入荷待ち | 入荷済
  // 検査
  inspRaw: [],
  inspLoading: true,
  inspCaseId: null,
  // 図面・仕様書
  docsRaw: [],
  docsLoading: true,
  docsCaseId: null,
};

let unsubView = null;      // 現在ビューの購読解除
let partsSeedTried = false;
const inspSeedTried = new Set();  // 検査の標準項目を自動投入済みの案件

const IMG_ICON = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L4 21"/></svg>`;

// ============================================================
// 起動
// ============================================================
async function boot() {
  renderShell();
  window.addEventListener('hashchange', () => { state.route = parseHash(); renderRoute(); });
  state.route = parseHash();

  // 全案件をグローバル購読（一覧・工程ボードの即時反映用）
  subscribeCases(
    (rows) => {
      state.casesRaw = rows; state.loading = false;
      // ドラッグ操作中は再描画を抑止（ドロップ確定後の更新で反映される）
      // 検査・図面は案件情報に依存するため案件更新時も再描画
      const refreshOn = ['orders', 'board', 'inspection', 'docs'];
      if (refreshOn.includes(state.route.name) && !dragState) renderRoute();
      updateBadges();
    },
    (err) => { state.loading = false; state.authError = true; renderRoute(); }
  );

  renderRoute();

  // 初回のみサンプルデータ投入
  try {
    await ready;
    const seeded = await seedIfEmpty();
    if (seeded) toast('サンプル案件を登録しました');
  } catch (err) {
    state.authError = true;
    renderRoute();
  }
}

// ---- ルーティング ------------------------------------------
function parseHash() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean); // ['case','FE-2481']
  if (parts.length === 0) return { name: 'orders', param: null };
  const [head, param] = parts;
  const map = { '': 'orders', orders: 'orders', case: 'case', board: 'board', parts: 'parts', inspection: 'inspection', docs: 'docs', settings: 'settings', new: 'new', edit: 'edit' };
  return { name: map[head] || 'orders', param: param || null };
}

function go(hash) { location.hash = hash; }

// ============================================================
// シェル（永続的なナビ）
// ============================================================
function renderShell() {
  const app = h(`
    <div class="app">
      <header class="topnav">
        <a class="brand" href="#/"><b>積載車</b>製作管理</a>
        <nav>
          <a data-nav="orders" href="#/">案件一覧</a>
          <a data-nav="board" href="#/board">工程ボード</a>
          <a data-nav="parts" href="#/parts">部品・資材</a>
          <a data-nav="inspection" href="#/inspection">検査</a>
          <a data-nav="settings" href="#/settings">設定</a>
        </nav>
        <div class="nav-right">
          <span class="text-muted" style="font-size:13px">${todayLabel()}</span>
          <div class="avatar blueprint">現${CORNERS}</div>
        </div>
      </header>
      <header class="mobilehdr" id="mhdr"></header>
      <main class="main"><div id="view"></div></main>
      <nav class="tabbar">
        <a data-nav="orders" href="#/"><span class="ico">▤</span>一覧</a>
        <a data-nav="board" href="#/board"><span class="ico">▦</span>工程</a>
        <a data-nav="parts" href="#/parts"><span class="ico">◫</span>部品</a>
        <a data-nav="inspection" href="#/inspection"><span class="ico">✓</span>検査</a>
        <a data-nav="settings" href="#/settings"><span class="ico">⚙</span>設定</a>
      </nav>
      <button class="btn btn-primary fab" id="fab" title="新規案件">＋</button>
    </div>
  `);
  document.getElementById('root').replaceChildren(app);
  document.getElementById('fab').addEventListener('click', () => openCaseForm(null));
}

function setActiveNav(group) {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('on', el.dataset.nav === group);
  });
}

function setMobileHeader(html) {
  document.getElementById('mhdr').innerHTML = html;
}

function updateBadges() { /* 予約: 遅延件数などのバッジ表示に利用 */ }

// ============================================================
// ルート描画
// ============================================================
function renderRoute() {
  if (unsubView) { unsubView(); unsubView = null; }
  const view = document.getElementById('view');
  const fab = document.getElementById('fab');
  const { name, param } = state.route;

  if (state.authError) { view.replaceChildren(authErrorEl()); fab.style.display = 'none'; return; }

  const groupOf = { orders: 'orders', case: 'orders', new: 'orders', edit: 'orders', board: 'board', parts: 'parts', inspection: 'inspection', docs: 'orders', settings: 'settings' };
  setActiveNav(groupOf[name] || 'orders');

  switch (name) {
    case 'orders': renderOrders(view); break;
    case 'case': renderDetail(view, param); break;
    case 'board': renderBoard(view); break;
    case 'parts': renderParts(view); break;
    case 'inspection': renderInspection(view, param); break;
    case 'docs': renderDocs(view, param); break;
    case 'settings': renderPlaceholder(view, '設定', '準備中です。', '⚙'); break;
    default: renderOrders(view);
  }
}

// ============================================================
// 案件一覧（1a: PCテーブル / モバイルカード）
// ============================================================
function getVisibleCases() {
  const base = new Date();
  let rows = state.casesRaw.map((c) => decorateCase(c, base));
  const q = state.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter((c) =>
      (c.mgmtNo || '').toLowerCase().includes(q) ||
      (c.customer || '').toLowerCase().includes(q) ||
      (c.type || '').toLowerCase().includes(q));
  }
  if (state.sort === 'progress') rows.sort((a, b) => b.progress - a.progress);
  else rows.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  return rows;
}

function kpiData(rows) {
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const inMonth = rows.filter((c) => {
    if (!c.due) return false;
    const d = new Date(c.due + 'T00:00:00');
    return d.getFullYear() === thisYear && d.getMonth() === thisMonth;
  }).length;
  return [
    { value: rows.length, label: '進行中' },
    { value: inMonth, label: '今月納品' },
    { value: rows.filter((c) => c.status === '要注意').length, label: '要注意' },
    { value: rows.filter((c) => c.status === '遅延').length, label: '遅延' },
  ];
}

function renderOrders(view) {
  setMobileHeader(`
    <div>
      <div class="m-title">Fire apparatus production</div>
      <div class="m-sub">製作案件 ${state.casesRaw.length}件</div>
    </div>
  `);
  // モバイルはツールバーの「＋新規案件」に一本化（右上アイコン・FABは非表示）
  document.getElementById('fab').style.display = 'none';

  if (state.loading) { view.replaceChildren(loadingEl()); return; }

  const rows = getVisibleCases();
  const kpis = kpiData(state.casesRaw.map((c) => decorateCase(c)));

  const el = h(`
    <div class="container">
      <div class="page-head">
        <div>
          <div class="eyebrow">Production Orders</div>
          <h2>Fire apparatus production</h2>
        </div>
        <div class="kpis">
          ${kpis.map((k) => `<div class="kpi"><div class="v">${k.value}</div><div class="l">${esc(k.label)}</div></div>`).join('')}
        </div>
      </div>

      <div class="toolbar">
        <div class="seg pc-only">
          <label class="seg-opt"><input type="radio" name="view" checked>一覧</label>
          <label class="seg-opt"><input type="radio" name="view" disabled>カード</label>
          <label class="seg-opt"><input type="radio" name="view" onchange="location.hash='#/board'">工程</label>
        </div>
        <input class="input" id="search" style="max-width:260px" placeholder="管理No・顧客で検索" value="${esc(state.search)}">
        <div class="seg m-only">
          <label class="seg-opt"><input type="radio" name="msort" ${state.sort === 'due' ? 'checked' : ''} data-sort="due">納期順</label>
          <label class="seg-opt"><input type="radio" name="msort" ${state.sort === 'progress' ? 'checked' : ''} data-sort="progress">進捗順</label>
        </div>
        <button class="btn btn-primary push" id="new-case">＋ 新規案件</button>
      </div>

      <div class="legend pc-only">
        <span class="text-muted">進捗ラインの色：</span>
        <span class="item"><span class="swatch" style="background:#4a9d6b"></span>順調</span>
        <span class="item"><span class="swatch" style="background:#e0912f"></span>要注意</span>
        <span class="item"><span class="swatch" style="background:#a52a21"></span>遅延</span>
      </div>

      <!-- PC: データテーブル -->
      <div class="blueprint table-wrap">
        ${CORNERS}
        <table class="table">
          <thead><tr>
            <th style="width:88px">管理No</th>
            <th>顧客 / 車両タイプ</th>
            <th style="width:210px">現在の工程</th>
            <th style="width:120px">進捗</th>
            <th style="width:120px;text-align:right">受注金額</th>
            <th style="width:110px;text-align:right">材料原価</th>
            <th style="width:110px;text-align:right">工数原価</th>
            <th style="width:110px">納期</th>
            <th style="width:64px">担当</th>
            <th style="width:80px">状態</th>
          </tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>

      <!-- モバイル: カードリスト -->
      <div class="cardlist" id="cards"></div>
    </div>
  `);

  // イベント
  const search = el.querySelector('#search');
  search.addEventListener('input', debounce((e) => {
    state.search = e.target.value;
    refreshOrderRows();
  }, 180));
  el.querySelector('#new-case').addEventListener('click', () => openCaseForm(null));
  el.querySelectorAll('[data-sort]').forEach((r) => r.addEventListener('change', (e) => {
    state.sort = e.target.dataset.sort; refreshOrderRows();
  }));

  view.replaceChildren(el);
  fillOrderRows(rows);
}

function refreshOrderRows() { fillOrderRows(getVisibleCases()); }

function fillOrderRows(rows) {
  const tbody = document.getElementById('rows');
  const cards = document.getElementById('cards');
  if (!tbody || !cards) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty">該当する案件がありません</div></td></tr>`;
    cards.innerHTML = `<div class="empty">該当する案件がありません</div>`;
    return;
  }

  tbody.replaceChildren(...rows.map((c) => tableRow(c)));
  cards.replaceChildren(...rows.map((c) => mobileCard(c)));
}

function statusTag(c) {
  if (c.isLate) return `<span class="tag tag-late">遅延</span>`;
  if (c.isWarn) return `<span class="tag tag-outline">要注意</span>`;
  return `<span class="tag tag-neutral">順調</span>`;
}

function tableRow(c) {
  const tr = h(`
    <tr class="clickable" style="--bar:${c.barColor}">
      <td class="mono" style="font-size:13px;color:var(--color-accent-800)">${esc(c.mgmtNo)}</td>
      <td>
        <div style="font-family:var(--font-heading);font-size:16px;line-height:1.15">${esc(c.type)}</div>
        <div class="text-muted" style="font-size:12px">${esc(c.customer)} ・ ${esc(c.chassis)}</div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
          <span class="tag tag-accent">${esc(c.stage)}</span>
          <span class="text-muted mono" style="font-size:11px">${c.stepLabel}</span>
        </div>
        ${stepperHTML(c.steps)}
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="mono" style="font-size:13px;width:34px">${pct(c.progress)}</span>
          <div class="progressbar" style="flex:1;--bar:${c.barColor}"><span style="width:${clamp(c.progress,0,100)}%"></span></div>
        </div>
      </td>
      <td class="mono right" style="font-size:13px;color:var(--color-accent-800)">${yen(c.orderAmount)}</td>
      <td class="mono right" style="font-size:13px">${yen(c.materialCost)}</td>
      <td class="mono right" style="font-size:13px">${yen(c.laborCost)}</td>
      <td>
        <div class="mono" style="font-size:13px">${c.dueShort}</div>
        ${c.isLate
          ? `<div style="font-size:11px;color:var(--color-bg);background:var(--color-accent-900);display:inline-block;padding:1px 6px;margin-top:2px">${c.dueLabel}</div>`
          : `<div class="text-muted" style="font-size:11px">${c.dueLabel}</div>`}
      </td>
      <td style="font-size:13px">${esc(c.staff)}</td>
      <td>${statusTag(c)}</td>
    </tr>
  `);
  tr.addEventListener('click', () => go('#/case/' + encodeURIComponent(c.id)));
  return tr;
}

function mobileCard(c) {
  const card = h(`
    <div class="card blueprint" style="--bar:${c.barColor}">
      ${CORNERS}
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <span class="mono" style="font-size:12px;color:var(--color-accent-800)">${esc(c.mgmtNo)}</span>
        ${statusTag(c)}
      </div>
      <div style="font-family:var(--font-heading);font-size:17px;line-height:1.15">${esc(c.type)}</div>
      ${stepperHTML(c.steps)}
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="tag tag-accent">${esc(c.stage)}</span>
        <span class="mono" style="font-size:14px;color:var(--color-accent-800)">${pct(c.progress)}</span>
      </div>
      <div style="height:1px;background:var(--color-divider)"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;font-size:12px">
        <span><span class="text-muted" style="font-size:10px;letter-spacing:.06em">納期 </span><span class="mono">${c.dueShort}</span></span>
        ${c.isLate
          ? `<span style="font-size:11px;color:var(--color-bg);background:var(--color-accent-900);padding:2px 7px">${c.dueLabel}</span>`
          : `<span class="text-muted">${c.dueLabel}</span>`}
      </div>
    </div>
  `);
  card.addEventListener('click', () => go('#/case/' + encodeURIComponent(c.id)));
  card.style.cursor = 'pointer';
  return card;
}

// ============================================================
// 工程ボード（1c: 7工程カンバン / ドラッグ&ドロップで工程移動）
// ============================================================
let dragState = null;       // ドラッグ中の状態（null=非ドラッグ）
let boardScrollLeft = 0;    // 横スクロール位置を再描画後も保持

function renderBoard(view) {
  const lateCount = state.casesRaw.map((c) => decorateCase(c)).filter((c) => c.status === '遅延').length;
  setMobileHeader(`
    <div>
      <div class="m-title">工程ボード</div>
      <div class="m-sub">7工程カンバン ・ ⠿を掴んで工程移動</div>
    </div>
  `);
  // モバイルはツールバーの「＋新規案件」に一本化（右上アイコン・FABは非表示）
  document.getElementById('fab').style.display = 'none';

  if (state.loading) { view.replaceChildren(loadingEl()); return; }

  const el = h(`
    <div class="container board-container">
      <div class="page-head board-head">
        <div>
          <div class="eyebrow">Process Board</div>
          <h2>工程ボード</h2>
        </div>
        <div class="board-tools">
          <span class="tag ${lateCount ? 'tag-late' : 'tag-outline'}">遅延 ${lateCount}</span>
          <button class="btn btn-primary btn-sm" id="board-new">＋ 新規案件</button>
        </div>
      </div>
      <div class="board-hint text-muted">カードをタップで詳細へ。右上の <b>⠿ をドラッグ</b>すると工程を移動できます（本体のスワイプはボードの横スクロール）。</div>
      <div class="kanban-scroll">
        <div class="kanban-grid" id="kanban"></div>
      </div>
    </div>
  `);

  const grid = el.querySelector('#kanban');
  const decorated = state.casesRaw.map((c) => decorateCase(c));

  STAGES.forEach((name, i) => {
    const cases = decorated.filter((c) => c.stageIndex === i);
    const col = h(`
      <div class="kanban-col" data-stage="${i}">
        <div class="col-head">
          <div class="col-title">
            <span class="mono text-muted" style="font-size:11px">${String(i + 1).padStart(2, '0')}</span>
            <span class="col-name">${esc(name)}</span>
          </div>
          <span class="mono col-count">${cases.length}</span>
        </div>
        <div class="col-body"></div>
      </div>
    `);
    const body = col.querySelector('.col-body');
    if (cases.length === 0) {
      body.appendChild(h(`<div class="col-empty text-muted">—</div>`));
    } else {
      cases.forEach((c) => body.appendChild(boardCard(c)));
    }
    grid.appendChild(col);
  });

  const scroller = el.querySelector('.kanban-scroll');
  scroller.addEventListener('scroll', () => { boardScrollLeft = scroller.scrollLeft; });

  el.querySelector('#board-new').onclick = () => openCaseForm(null);

  view.replaceChildren(el);
  requestAnimationFrame(() => { scroller.scrollLeft = boardScrollLeft; });
}

function boardMark(c) {
  if (c.isLate) return `<span class="board-mark late" title="遅延"></span>`;
  if (c.isWarn) return `<span class="board-mark warn" title="要注意"></span>`;
  return '';
}

function boardCard(c) {
  const card = h(`
    <div class="blueprint kanban-card" style="--bar:${c.barColor}" data-id="${esc(c.id)}">
      ${CORNERS}
      <div class="kc-top">
        <span class="mono" style="font-size:11px;color:var(--color-accent-800)">${esc(c.mgmtNo)}</span>
        <div class="kc-top-right">
          ${boardMark(c)}
          <button class="kc-handle" title="ドラッグして工程を移動" aria-label="ドラッグして工程を移動">⠿</button>
        </div>
      </div>
      <div class="kc-type">${esc(c.type)}</div>
      <div class="text-muted kc-customer">${esc(c.customer || '—')}</div>
      ${stepperHTML(c.steps)}
      <div class="kc-foot">
        <span class="mono">${c.dueShort}</span>
        <span class="mono" style="color:var(--color-accent-800)">${pct(c.progress)}</span>
      </div>
    </div>
  `);
  // カード本体のタップ（ハンドル以外）＝詳細へ遷移。
  // スワイプ／スクロールでは click は発火しないため、横スクロールを妨げない。
  card.addEventListener('click', (e) => {
    if (e.target.closest('.kc-handle')) return;
    go('#/case/' + encodeURIComponent(c.id));
  });
  makeHandleDraggable(card.querySelector('.kc-handle'), card, c);
  return card;
}

// ---- ドラッグ&ドロップ（ハンドル限定・タッチ/マウス個別実装） ----
// ハンドル(⠿)を掴んだ時だけドラッグで工程移動。カード本体のスワイプはボード横スクロールに委ねる。
// iPhone実機対応：touchstartで即座に「掴んだ」状態にし、touchmoveをpreventDefaultして
// ページ全体のスクロールを止める。マウスは mousedown/move/up で同じ挙動を提供。
function makeHandleDraggable(handle, cardEl, c) {
  let grabbed = false, dragging = false, ghost = null;
  let startX = 0, startY = 0;

  const positionGhost = (x, y) => {
    if (!ghost) return;
    ghost.style.left = (x - ghost._ox) + 'px';
    ghost.style.top = (y - ghost._oy) + 'px';
  };

  // 掴んだ瞬間：視覚フィードバック＋スクロール凍結（まだゴーストは出さない）
  const grab = (x, y) => {
    grabbed = true;
    startX = x; startY = y;
    dragState = { id: c.id };
    handle.classList.add('grabbing');
    cardEl.classList.add('grabbed-src');
    document.body.classList.add('board-dragging');
  };

  // 実際に動かし始めたらゴースト（浮いたカード）を生成
  const beginDrag = (x, y) => {
    dragging = true;
    cardEl.classList.remove('grabbed-src');
    cardEl.classList.add('dragging-src');
    const r = cardEl.getBoundingClientRect();
    ghost = cardEl.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = r.width + 'px';
    ghost._ox = x - r.left;
    ghost._oy = y - r.top;
    document.body.appendChild(ghost);
    positionGhost(x, y);
  };

  const highlight = (x, y) => {
    const under = document.elementFromPoint(x, y);
    const col = under && under.closest ? under.closest('.kanban-col') : null;
    document.querySelectorAll('.kanban-col.drop-target').forEach((k) => { if (k !== col) k.classList.remove('drop-target'); });
    if (col) col.classList.add('drop-target');
    return col;
  };

  const moveTo = (x, y) => {
    if (!dragging) {
      if (Math.hypot(x - startX, y - startY) > 4) beginDrag(x, y);
      else return;
    }
    positionGhost(x, y);
    highlight(x, y);
  };

  const drop = (x, y) => {
    const wasDragging = dragging;
    const target = wasDragging ? highlight(x, y) : null;
    end();
    if (wasDragging && target) {
      const idx = Number(target.dataset.stage);
      if (Number.isInteger(idx) && idx !== c.stageIndex) moveCaseToStage(c, idx);
    }
  };

  const end = () => {
    grabbed = false; dragging = false; dragState = null;
    if (ghost) { ghost.remove(); ghost = null; }
    handle.classList.remove('grabbing');
    cardEl.classList.remove('grabbed-src');
    cardEl.classList.remove('dragging-src');
    document.body.classList.remove('board-dragging');
    document.querySelectorAll('.kanban-col.drop-target').forEach((k) => k.classList.remove('drop-target'));
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchCancel);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  // --- タッチ（iPhone等） ---
  function onTouchStart(e) {
    if (grabbed) return;
    e.preventDefault();  // スクロール開始・合成マウス/クリックを抑止（掴みを確実に）
    const t = e.changedTouches[0];
    grab(t.clientX, t.clientY);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchCancel);
  }
  function onTouchMove(e) {
    if (!grabbed) return;
    e.preventDefault();  // ハンドルを掴んでいる間はページ全体のスクロールを止める
    const t = e.touches[0] || e.changedTouches[0];
    moveTo(t.clientX, t.clientY);
  }
  function onTouchEnd(e) {
    const t = e.changedTouches[0];
    drop(t.clientX, t.clientY);
  }
  function onTouchCancel() { end(); }

  // --- マウス（PC） ---
  function onMouseDown(e) {
    if (e.button !== 0 || grabbed) return;
    e.preventDefault();
    grab(e.clientX, e.clientY);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }
  function onMouseMove(e) { if (grabbed) moveTo(e.clientX, e.clientY); }
  function onMouseUp(e) { drop(e.clientX, e.clientY); }

  handle.addEventListener('touchstart', onTouchStart, { passive: false });
  handle.addEventListener('mousedown', onMouseDown);
}

async function moveCaseToStage(c, newIndex) {
  const nextProgress = Math.max(Number(c.progress) || 0, autoProgress(newIndex));
  try {
    await patchCase(c.id, { stageIndex: newIndex, progress: nextProgress });
    toast(`「${c.mgmtNo}」を「${STAGES[newIndex]}」へ移動しました`);
  } catch (err) {
    toast('工程の更新に失敗しました：' + (err.message || err), 'err');
  }
}

// ============================================================
// 案件詳細（2a: PC工程別フォトログ / モバイル詳細）
// ============================================================
let detailPhotos = [];      // 現在案件の写真
let mobileStageSel = null;  // モバイルで選択中の工程index
let detailCaseId = null;    // 現在開いている案件ID（写真アップロード先）

function renderDetail(view, id) {
  view.replaceChildren(loadingEl());
  detailPhotos = [];
  mobileStageSel = null;
  detailCaseId = id;

  let current = null;
  const unsubCase = subscribeCase(id, (c) => {
    if (!c) { view.replaceChildren(notFoundEl()); return; }
    current = c;
    paintDetail(view, decorateCase(c));
  }, () => { state.authError = true; renderRoute(); });

  const unsubPhotos = subscribePhotos(id, (photos) => {
    detailPhotos = photos;
    if (current) paintDetail(view, decorateCase(current));
  });

  unsubView = () => { unsubCase(); unsubPhotos(); };
}

function photosForStage(i) { return detailPhotos.filter((p) => p.stageIndex === i); }

function paintDetail(view, c) {
  if (mobileStageSel === null) mobileStageSel = c.stageIndex;

  setMobileHeader(`
    <button class="m-back" id="m-back">‹</button>
    <div style="flex:1">
      <div class="m-title" style="font-size:18px">${esc(c.mgmtNo)}　${esc(c.type)}</div>
      <div class="m-sub">${esc(c.stage)} ・ 進捗 ${pct(c.progress)}</div>
    </div>
    <button class="m-icon" id="m-edit" style="border:none;width:auto">✎</button>
  `);
  document.getElementById('fab').style.display = 'none';

  const el = h(`<div></div>`);
  el.appendChild(detailDesktop(c));
  el.appendChild(detailMobile(c));
  view.replaceChildren(el);

  // モバイルヘッダー操作
  const back = document.getElementById('m-back');
  if (back) back.onclick = () => go('#/');
  const medit = document.getElementById('m-edit');
  if (medit) medit.onclick = () => openCaseForm(c);
}

// ---- PC版 工程別フォトログ ----
function detailDesktop(c) {
  const wrap = h(`
    <div class="container detail-desktop">
      <div class="detail-head">
        <div>
          <div style="display:flex;align-items:baseline;gap:10px">
            <span class="mono" style="font-size:14px;color:var(--color-accent-800)">${esc(c.mgmtNo)}</span>
            <span class="tag tag-accent">${esc(c.stage)}</span>
          </div>
          <h2 style="margin:4px 0 2px">${esc(c.type)}</h2>
          <div class="detail-meta">${esc(c.customer)} ・ シャシ ${esc(c.chassis)} ・ 担当 ${esc(c.staff || '—')}</div>
        </div>
        <div class="detail-prog">
          <div class="eyebrow">全体進捗 / 納期</div>
          <div style="display:flex;align-items:baseline;gap:8px;justify-content:flex-end">
            <span style="font-family:var(--font-heading);font-size:28px;line-height:1;color:var(--color-accent-800)">${pct(c.progress)}</span>
            <span class="mono" style="font-size:13px">${c.dueShort}（${c.dueLabel}）</span>
          </div>
          <div class="progressbar" style="margin-top:6px;--bar:${c.barColor}"><span style="width:${clamp(c.progress,0,100)}%"></span></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap">
            <a class="btn btn-secondary btn-sm" href="#/docs/${encodeURIComponent(c.id)}">📐 図面・仕様書</a>
            <button class="btn btn-secondary btn-sm" id="d-edit">✎ 編集</button>
            <button class="btn btn-secondary btn-sm" id="d-del">削除</button>
            <button class="btn btn-primary btn-sm" id="d-advance" ${c.stageIndex >= STAGES.length - 1 ? 'disabled' : ''}>次の工程へ進める →</button>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px" id="d-stages"></div>
    </div>
  `);

  const stagesWrap = wrap.querySelector('#d-stages');
  STAGES.forEach((name, i) => {
    stagesWrap.appendChild(stageRowDesktop(c, i, name));
  });

  wrap.querySelector('#d-edit').onclick = () => openCaseForm(c);
  wrap.querySelector('#d-del').onclick = () => confirmDelete(c);
  const adv = wrap.querySelector('#d-advance');
  if (adv) adv.onclick = () => advanceStage(c);
  return wrap;
}

function stageRowDesktop(c, i, name) {
  const st = i < c.stageIndex ? 'done' : i === c.stageIndex ? 'current' : 'todo';
  const photos = photosForStage(i);
  const stateTag = st === 'done'
    ? `<span class="tag tag-neutral" style="align-self:flex-start">完了</span>`
    : st === 'current'
      ? `<span class="tag tag-accent" style="align-self:flex-start">作業中</span>`
      : `<span class="tag tag-outline" style="align-self:flex-start">未着手</span>`;

  const row = h(`
    <div class="blueprint stage-row">
      ${CORNERS}
      <div class="stage-label">
        <div class="head"><span class="mono text-muted" style="font-size:12px">${String(i + 1).padStart(2, '0')}</span><span class="name">${esc(name)}</span></div>
        ${stateTag}
        <span class="text-muted mono" style="font-size:12px">写真 ${photos.length}枚</span>
        ${st === 'current' ? `<span class="tag tag-outline" style="align-self:flex-start;font-size:10px">📱 スマホ撮影と同期</span>` : ''}
      </div>
      <div class="photo-grid"></div>
    </div>
  `);
  const grid = row.querySelector('.photo-grid');
  photos.forEach((p, idx) => grid.appendChild(photoSlotDesktop(p, idx, photos, name)));
  const add = h(`<button class="btn btn-secondary photo-add">＋<span>写真を追加</span></button>`);
  add.onclick = () => pickAndUploadPhotos(c.id, i);
  grid.appendChild(add);
  return row;
}

function photoSlotDesktop(p, idx, photos, stageName) {
  const slot = h(`
    <div class="blueprint photo-slot">${CORNERS}
      <img alt="工程写真" src="${esc(p.url)}">
      <button class="photo-del" title="削除">✕</button>
    </div>
  `);
  slot.querySelector('img').onclick = () => openLightbox(photos, idx, stageName);
  slot.querySelector('.photo-del').onclick = (e) => { e.stopPropagation(); confirmDeletePhoto(p); };
  return slot;
}

// ---- モバイル版 案件詳細 ----
function detailMobile(c) {
  const sel = mobileStageSel;
  const photos = photosForStage(sel);
  const selName = STAGES[sel];
  const selState = sel < c.stageIndex ? 'done' : sel === c.stageIndex ? 'current' : 'todo';
  const selStateLabel = selState === 'done' ? '完了' : selState === 'current' ? '作業中' : '未着手';

  const wrap = h(`
    <div class="detail-mobile">
      <div class="m-detail-head">
        <div class="text-muted" style="font-size:12px">シャシ ${esc(c.chassis)} ・ 納期 ${c.dueShort}（${c.dueLabel}）</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          <div class="progressbar" style="flex:1;--bar:${c.barColor}"><span style="width:${clamp(c.progress,0,100)}%"></span></div>
          <span class="mono" style="font-size:13px;color:var(--color-accent-800)">${pct(c.progress)}</span>
        </div>
        <a href="#/docs/${encodeURIComponent(c.id)}" class="btn btn-secondary btn-block" style="height:38px;margin-top:9px;font-size:13px;gap:8px">📐 図面・仕様書を開く</a>
        <div class="stage-tabs" id="m-tabs"></div>
      </div>

      <div class="container" style="padding-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:baseline;gap:8px">
            <span class="mono text-muted" style="font-size:12px">${String(sel + 1).padStart(2, '0')}</span>
            <span style="font-family:var(--font-heading);font-size:22px">${esc(selName)}</span>
            <span class="tag ${selState === 'current' ? 'tag-accent' : selState === 'done' ? 'tag-neutral' : 'tag-outline'}">${selStateLabel}</span>
          </div>
          <span class="text-muted mono" style="font-size:12px">写真 ${photos.length}枚</span>
        </div>
        <div id="m-photos" style="display:flex;flex-direction:column;gap:13px"></div>
        <button class="btn btn-secondary btn-block" style="height:50px" id="m-addphoto">＋ 写真を追加</button>
      </div>

      <div class="bottombar">
        <button class="btn btn-secondary btn-icon" id="m-edit2" title="編集">✎</button>
        <button class="btn btn-secondary btn-icon" id="m-del2" title="削除">🗑</button>
        <button class="btn btn-primary" style="flex:1;height:44px" id="m-advance" ${c.stageIndex >= STAGES.length - 1 ? 'disabled' : ''}>次の工程へ進める →</button>
      </div>
    </div>
  `);

  // 工程タブ
  const tabs = wrap.querySelector('#m-tabs');
  STAGES.forEach((name, i) => {
    const stt = i < c.stageIndex ? 'done' : i === c.stageIndex ? 'current' : 'todo';
    const cls = i === sel ? (stt === 'current' ? 'tag current' : 'tag tag-accent') : (stt === 'done' ? 'tag tag-accent' : stt === 'current' ? 'tag current' : 'tag tag-neutral');
    const label = stt === 'done' ? '✓ ' + name : name;
    const t = h(`<span class="${cls}">${esc(label)}</span>`);
    if (i === sel) t.style.outline = '2px solid var(--color-accent)';
    t.onclick = () => { mobileStageSel = i; paintDetail(document.getElementById('view'), c); };
    tabs.appendChild(t);
  });

  // 写真ブロック
  const pwrap = wrap.querySelector('#m-photos');
  photos.forEach((p, idx) => pwrap.appendChild(photoBlockMobile(p, idx, photos, selName)));

  wrap.querySelector('#m-addphoto').onclick = () => pickAndUploadPhotos(c.id, sel);
  wrap.querySelector('#m-edit2').onclick = () => openCaseForm(c);
  wrap.querySelector('#m-del2').onclick = () => confirmDelete(c);
  const adv = wrap.querySelector('#m-advance');
  if (adv) adv.onclick = () => advanceStage(c);
  return wrap;
}

function photoBlockMobile(p, idx, photos, stageName) {
  const block = h(`
    <div class="blueprint photo-block">
      ${CORNERS}
      <div class="photo-big">
        <img alt="工程写真" src="${esc(p.url)}">
        <button class="zoom" title="拡大">⤢</button>
        <span class="badge">${idx + 1}/${photos.length}</span>
      </div>
      <div style="display:flex;align-items:center;gap:9px;font-size:11px">
        <span class="tag tag-accent">${esc(stageName)}</span>
        <span class="text-muted" style="font-size:10px;letter-spacing:.05em">工程タグ自動</span>
        <button class="btn btn-ghost btn-sm photo-del-text push" title="この写真を削除">削除</button>
      </div>
      <textarea class="input" placeholder="メモを入力（例：ホース収納部の取付を確認）" style="min-height:54px;font-size:16px">${esc(p.memo || '')}</textarea>
    </div>
  `);
  block.querySelector('.zoom').onclick = () => openLightbox(photos, idx, stageName);
  block.querySelector('.photo-del-text').onclick = () => confirmDeletePhoto(p);
  const ta = block.querySelector('textarea');
  ta.addEventListener('change', () => saveMemo(p, ta.value));
  return block;
}

// ---- 写真アップロード（カメラ撮影 / ファイル選択） ----
// 端末を問わず image/* を受け取り、リサイズ→アップロード→即同期。
function pickAndUploadPhotos(caseId, stageIndex) {
  const sheet = h(`
    <div class="modal-backdrop sheet-backdrop">
      <div class="photo-sheet blueprint">
        ${CORNERS}
        <div class="sheet-title">写真を追加（${esc(STAGES[stageIndex])}）</div>
        <button class="btn btn-primary btn-block" data-src="camera">📷 カメラで撮影</button>
        <button class="btn btn-secondary btn-block" data-src="file">🖼 ファイルから選択</button>
        <button class="btn btn-ghost btn-block" data-src="cancel">キャンセル</button>
      </div>
    </div>
  `);
  const close = () => sheet.remove();
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  sheet.querySelector('[data-src="cancel"]').onclick = close;
  sheet.querySelector('[data-src="camera"]').onclick = () => { close(); triggerFileInput(caseId, stageIndex, true); };
  sheet.querySelector('[data-src="file"]').onclick = () => { close(); triggerFileInput(caseId, stageIndex, false); };
  document.body.appendChild(sheet);
}

function triggerFileInput(caseId, stageIndex, useCamera) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (useCamera) input.setAttribute('capture', 'environment'); // 背面カメラで撮影
  else input.multiple = true;                                   // ファイルは複数選択可
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) await uploadFiles(caseId, stageIndex, files);
  });
  document.body.appendChild(input);
  input.click();
}

async function uploadFiles(caseId, stageIndex, files) {
  const total = files.length;
  let ok = 0;
  for (let i = 0; i < total; i++) {
    const step = { resize: '画像を最適化中', upload: 'アップロード中', save: '保存中' };
    showUpload(`写真を処理中… (${i + 1}/${total})`);
    try {
      await uploadStagePhoto(caseId, stageIndex, files[i], {
        onStage: (s) => showUpload(`${step[s] || '処理中'}… (${i + 1}/${total})`),
      });
      ok++;
    } catch (err) {
      console.error('写真アップロード失敗:', err);
      toast('アップロードに失敗しました：' + (err.message || err), 'err');
    }
  }
  hideUpload();
  if (ok) toast(`${ok}枚の写真を追加しました`);
  // 追加後は subscribePhotos が発火し、詳細画面が自動で再描画される
}

// アップロード進捗のオーバーレイ
let uploadBar = null;
function showUpload(text) {
  if (!uploadBar) {
    uploadBar = h(`<div class="upload-bar"><span class="spinner sm"></span><span class="msg"></span></div>`);
    document.body.appendChild(uploadBar);
  }
  uploadBar.querySelector('.msg').textContent = text;
  uploadBar.style.display = 'flex';
}
function hideUpload() { if (uploadBar) uploadBar.style.display = 'none'; }

// 写真メモを保存（変更時のみ）
async function saveMemo(photo, memo) {
  const next = memo || '';
  if ((photo.memo || '') === next) return;
  if (!detailCaseId) return;
  try {
    await updatePhoto(detailCaseId, photo.id, { memo: next });
    photo.memo = next; // ローカルにも反映
  } catch (err) {
    console.error(err);
    toast('メモの保存に失敗しました', 'err');
  }
}

async function confirmDeletePhoto(photo) {
  if (!detailCaseId) return;
  if (!confirm('この写真を削除します。よろしいですか？')) return;
  try {
    await removePhoto(detailCaseId, photo);
    toast('写真を削除しました');
  } catch (err) {
    console.error(err);
    toast('写真の削除に失敗しました：' + (err.message || err), 'err');
  }
}

// ---- ライトボックス（拡大ビューア） ----
function openLightbox(photos, startIdx, stageName) {
  if (!photos.length) return;
  const lb = h(`
    <div class="lightbox">
      <div class="lightbox-top">
        <button class="x">✕</button>
        <span style="font-family:var(--font-heading);font-size:15px">${esc(stageName)} ・ 写真</span>
        <span class="mono counter" style="font-size:13px;opacity:.85">${startIdx + 1} / ${photos.length}</span>
      </div>
      <div class="lightbox-track"></div>
      <button class="lightbox-nav prev">‹</button>
      <button class="lightbox-nav next">›</button>
      <div class="lightbox-dots"></div>
      <div class="lightbox-foot">
        <div style="display:flex;align-items:center;gap:9px;font-size:11px;margin-bottom:7px">
          <span class="tag tag-accent">${esc(stageName)}</span>
          <span style="opacity:.7;font-size:10px;letter-spacing:.05em">工程タグ自動</span>
        </div>
        <textarea class="input" placeholder="メモを入力" style="min-height:52px;font-size:16px;background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.25)"></textarea>
      </div>
    </div>
  `);
  const track = lb.querySelector('.lightbox-track');
  photos.forEach((p) => {
    const slide = h(`<div class="lightbox-slide"><img alt="写真" src="${esc(p.url)}"></div>`);
    enableMouseZoom(slide, slide.querySelector('img'));
    track.appendChild(slide);
  });
  const dotsWrap = lb.querySelector('.lightbox-dots');
  photos.forEach((_, i) => dotsWrap.appendChild(h(`<span class="${i === startIdx ? 'on' : ''}"></span>`)));

  const counter = lb.querySelector('.counter');
  const memo = lb.querySelector('textarea');
  let curIdx = startIdx;
  memo.value = photos[startIdx]?.memo || '';
  const update = () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i === curIdx) return;
    curIdx = i;
    counter.textContent = (i + 1) + ' / ' + photos.length;
    dotsWrap.querySelectorAll('span').forEach((s, k) => s.classList.toggle('on', k === i));
    memo.value = photos[i]?.memo || '';
  };
  track.addEventListener('scroll', debounce(update, 60));
  // 拡大ビューアでもメモを編集・保存できる（全端末へ同期）
  memo.addEventListener('change', () => { if (photos[curIdx]) saveMemo(photos[curIdx], memo.value); });
  lb.querySelector('.prev').onclick = () => track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' });
  lb.querySelector('.next').onclick = () => track.scrollBy({ left: track.clientWidth, behavior: 'smooth' });
  const close = () => lb.remove();
  lb.querySelector('.x').onclick = close;
  document.addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(lb)) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' });
    else if (e.key === 'ArrowRight') track.scrollBy({ left: track.clientWidth, behavior: 'smooth' });
  });
  document.body.appendChild(lb);
  requestAnimationFrame(() => { track.scrollLeft = track.clientWidth * startIdx; });
}

// PC(マウス)向けの写真ズーム。
// ・クリックで拡大/元に戻る（トグル）／ホイールで拡大縮小／拡大中はドラッグで移動
// ・スマホのピンチ拡大はネイティブのまま維持（マウス操作にのみ反応）
function enableMouseZoom(slide, img) {
  const MIN = 1, MAX = 5, TOGGLE = 2.5;
  let scale = 1, tx = 0, ty = 0;
  let dragging = false, sx = 0, sy = 0, downX = 0, downY = 0, moved = false;
  let lastPointerType = 'mouse';

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.transition = dragging ? 'none' : 'transform .12s ease-out';
    img.style.cursor = scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in';
    slide.classList.toggle('zoomed', scale > 1);
  };
  const setScale = (s) => {
    scale = Math.max(MIN, Math.min(MAX, s));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  };

  // ホイールで拡大縮小（画像上ではページ/トラックのスクロールを止める）
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    setScale(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  }, { passive: false });

  // 拡大中のドラッグで表示位置を移動（マウスのみ）
  img.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    if (e.pointerType !== 'mouse' || e.button !== 0 || scale <= 1) return;
    dragging = true; moved = false;
    downX = e.clientX; downY = e.clientY;
    sx = e.clientX - tx; sy = e.clientY - ty;
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    apply();
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx = e.clientX - sx; ty = e.clientY - sy;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 3) moved = true;
    apply();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { img.releasePointerCapture(e.pointerId); } catch (_) {}
    apply();
  };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  // クリックで拡大/縮小トグル（マウスのみ・ドラッグ直後は無視）。タッチのタップは対象外。
  img.addEventListener('click', (e) => {
    if (lastPointerType !== 'mouse') return;
    if (moved) { moved = false; return; }
    setScale(scale > 1 ? 1 : TOGGLE);
  });

  // ネイティブの画像ドラッグ（ゴースト）を無効化
  img.addEventListener('dragstart', (e) => e.preventDefault());
}

// ---- 進捗操作 ----
async function advanceStage(c) {
  if (c.stageIndex >= STAGES.length - 1) return;
  const next = c.stageIndex + 1;
  const nextProgress = Math.max(Number(c.progress) || 0, autoProgress(next));
  try {
    await patchCase(c.id, { stageIndex: next, progress: nextProgress });
    toast(`工程を「${STAGES[next]}」に進めました`);
  } catch (err) { toast('更新に失敗しました：' + err.message, 'err'); }
}

async function confirmDelete(c) {
  if (!confirm(`案件「${c.mgmtNo} ${c.type}」を削除します。よろしいですか？`)) return;
  try {
    await deleteCase(c.id);
    toast('案件を削除しました');
    go('#/');
  } catch (err) { toast('削除に失敗しました：' + err.message, 'err'); }
}

// ============================================================
// 案件フォーム（新規 / 編集）
// ============================================================
function openCaseForm(existing) {
  const isEdit = !!existing;
  const d = existing ? decorateCase(existing) : {
    mgmtNo: suggestMgmtNo(), customer: '', type: '', chassis: '', staff: '',
    stageIndex: 0, progress: 0, due: '', status: '順調', orderAmount: 0, materialCost: 0, laborCost: 0,
  };

  const modal = h(`
    <div class="modal-backdrop">
      <div class="modal blueprint">
        ${CORNERS}
        <div class="modal-head">
          <h3>${isEdit ? '案件を編集' : '新規案件を登録'}</h3>
          <button class="x" title="閉じる">✕</button>
        </div>
        <form class="modal-body" id="cform">
          <div class="form-grid">
            <div class="field">
              <label>管理No ${isEdit ? '' : '<span style="color:var(--color-accent)">*</span>'}</label>
              <input class="input" name="mgmtNo" value="${esc(d.mgmtNo)}" ${isEdit ? 'disabled' : 'required'} placeholder="FE-2482">
            </div>
            <div class="field">
              <label>担当</label>
              <input class="input" name="staff" value="${esc(d.staff)}" placeholder="田中">
            </div>
            <div class="field full">
              <label>車両タイプ <span style="color:var(--color-accent)">*</span></label>
              <input class="input" name="type" value="${esc(d.type)}" required placeholder="CD-I型 ポンプ自動車">
            </div>
            <div class="field">
              <label>顧客</label>
              <input class="input" name="customer" value="${esc(d.customer)}" placeholder="相模原市消防団">
            </div>
            <div class="field">
              <label>シャシ</label>
              <input class="input" name="chassis" value="${esc(d.chassis)}" placeholder="いすゞ ELF">
            </div>
            <div class="field">
              <label>現在の工程</label>
              <select class="select" name="stageIndex">
                ${STAGES.map((s, i) => `<option value="${i}" ${i === d.stageIndex ? 'selected' : ''}>${String(i + 1).padStart(2, '0')} ${esc(s)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>状態</label>
              <select class="select" name="status">
                ${STATUSES.map((s) => `<option ${s === d.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>進捗 %</label>
              <div style="display:flex;gap:8px">
                <input class="input" type="number" name="progress" min="0" max="100" value="${d.progress}">
                <button type="button" class="btn btn-secondary btn-sm nowrap" id="auto-prog" title="工程から自動計算">工程から</button>
              </div>
            </div>
            <div class="field">
              <label>納期</label>
              <input class="input" type="date" name="due" value="${esc(d.due)}">
            </div>
            <div class="field">
              <label>受注金額</label>
              <input class="input" type="number" name="orderAmount" min="0" step="1000" value="${d.orderAmount}">
            </div>
            <div class="field">
              <label>材料原価</label>
              <input class="input" type="number" name="materialCost" min="0" step="1000" value="${d.materialCost}">
            </div>
            <div class="field">
              <label>工数原価</label>
              <input class="input" type="number" name="laborCost" min="0" step="1000" value="${d.laborCost}">
            </div>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-secondary" id="cancel">キャンセル</button>
          <button class="btn btn-primary" id="save">${isEdit ? '保存' : '登録'}</button>
        </div>
      </div>
    </div>
  `);

  const close = () => modal.remove();
  const form = modal.querySelector('#cform');
  modal.querySelector('.x').onclick = close;
  modal.querySelector('#cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#auto-prog').onclick = () => {
    const si = Number(form.stageIndex.value);
    form.progress.value = autoProgress(si);
  };

  modal.querySelector('#save').onclick = async () => {
    if (!form.reportValidity()) return;
    const data = {
      mgmtNo: isEdit ? existing.mgmtNo : form.mgmtNo.value,
      customer: form.customer.value,
      type: form.type.value,
      chassis: form.chassis.value,
      staff: form.staff.value,
      stageIndex: Number(form.stageIndex.value),
      progress: Number(form.progress.value),
      due: form.due.value,
      status: form.status.value,
      orderAmount: Number(form.orderAmount.value),
      materialCost: Number(form.materialCost.value),
      laborCost: Number(form.laborCost.value),
    };
    const saveBtn = modal.querySelector('#save');
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    try {
      if (isEdit) {
        await updateCase(existing.id, data);
        toast('案件を保存しました');
      } else {
        const id = await createCase(data);
        toast('案件を登録しました');
        close();
        go('#/case/' + encodeURIComponent(id));
        return;
      }
      close();
    } catch (err) {
      toast(err.message || '保存に失敗しました', 'err');
      saveBtn.disabled = false; saveBtn.textContent = isEdit ? '保存' : '登録';
    }
  };

  document.body.appendChild(modal);
  form.querySelector('input:not([disabled])')?.focus();
}

// 次の管理No候補（FE-最大+1）
function suggestMgmtNo() {
  const nums = state.casesRaw
    .map((c) => (c.mgmtNo || '').match(/(\d+)/))
    .filter(Boolean).map((m) => Number(m[1]));
  const next = nums.length ? Math.max(...nums) + 1 : 2482;
  return 'FE-' + next;
}

// ============================================================
// 部品・資材（画面7: PCテーブル / モバイルカード）
// ============================================================
function renderParts(view) {
  setMobileHeader(`
    <div>
      <div class="m-title">部品・資材</div>
      <div class="m-sub">在庫と発注状況</div>
    </div>
  `);
  // モバイルはツールバーの「＋発注登録」に一本化（右上アイコン・FABは非表示）
  document.getElementById('fab').style.display = 'none';
  view.replaceChildren(loadingEl());

  // このビューにいる間だけ購読（案件一覧と同じリアルタイム同期）
  unsubView = subscribeParts(
    (rows) => { state.partsRaw = rows; state.partsLoading = false; paintParts(view); },
    () => { state.authError = true; renderRoute(); }
  );

  // 初回のみサンプル部品を投入
  if (!partsSeedTried) {
    partsSeedTried = true;
    seedPartsIfEmpty()
      .then((seeded) => { if (seeded) toast('サンプル部品を登録しました'); })
      .catch(() => {});
  }
}

function getVisibleParts(all) {
  let rows = all;
  const q = state.partSearch.trim().toLowerCase();
  if (q) {
    rows = rows.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.model || '').toLowerCase().includes(q) ||
      (p.caseId || '').toLowerCase().includes(q) ||
      (p.supplier || '').toLowerCase().includes(q));
  }
  if (state.partKind !== 'all') rows = rows.filter((p) => p.kind === state.partKind);
  if (state.partStatus !== 'all') rows = rows.filter((p) => p.status === state.partStatus);
  return rows;
}

function paintParts(view) {
  if (state.partsLoading) { view.replaceChildren(loadingEl()); return; }

  const all = state.partsRaw.map(decoratePart);
  const kpis = [
    { value: all.length, label: '登録品目' },
    { value: all.filter((p) => p.ordering).length, label: '発注中' },
    { value: all.filter((p) => p.low).length, label: '在庫不足' },
  ];
  const rows = getVisibleParts(all);

  const statusOpts = ['all', ...PART_STATUSES]
    .map((s) => `<option value="${s}" ${state.partStatus === s ? 'selected' : ''}>${s === 'all' ? '発注状況: すべて' : esc(s)}</option>`).join('');
  const kindOpts = ['all', ...PART_KINDS]
    .map((k) => `<option value="${k}" ${state.partKind === k ? 'selected' : ''}>${k === 'all' ? '区分: すべて' : esc(k)}</option>`).join('');

  const el = h(`
    <div class="container">
      <div class="page-head">
        <div>
          <div class="eyebrow">Parts &amp; Materials</div>
          <h2>部品・資材</h2>
        </div>
        <div class="kpis">
          ${kpis.map((k) => `<div class="kpi"><div class="v">${k.value}</div><div class="l">${esc(k.label)}</div></div>`).join('')}
        </div>
      </div>

      <div class="toolbar">
        <input class="input" id="part-search" style="max-width:230px" placeholder="品名・型番・仕入先で検索" value="${esc(state.partSearch)}">
        <select class="select" id="part-kind" style="max-width:150px">${kindOpts}</select>
        <select class="select" id="part-status" style="max-width:170px">${statusOpts}</select>
        <button class="btn btn-primary push" id="part-add">＋ 発注登録</button>
      </div>

      <!-- PC: データテーブル -->
      <div class="blueprint table-wrap">
        ${CORNERS}
        <table class="table">
          <thead><tr>
            <th style="width:82px">区分</th>
            <th>品名 / 型番</th>
            <th style="width:112px">使用案件</th>
            <th style="width:84px;text-align:right">必要数</th>
            <th style="width:112px;text-align:right">在庫数</th>
            <th style="width:140px">仕入先</th>
            <th style="width:104px;text-align:right">単価</th>
            <th style="width:96px">入荷予定</th>
            <th style="width:96px">発注状況</th>
            <th style="width:74px"></th>
          </tr></thead>
          <tbody id="part-rows"></tbody>
        </table>
      </div>

      <!-- モバイル: カードリスト -->
      <div class="cardlist" id="part-cards"></div>
    </div>
  `);

  el.querySelector('#part-search').addEventListener('input', debounce((e) => {
    state.partSearch = e.target.value; fillPartRows(view);
  }, 180));
  el.querySelector('#part-kind').addEventListener('change', (e) => { state.partKind = e.target.value; fillPartRows(view); });
  el.querySelector('#part-status').addEventListener('change', (e) => { state.partStatus = e.target.value; fillPartRows(view); });
  el.querySelector('#part-add').addEventListener('click', () => openPartForm(null));

  view.replaceChildren(el);
  fillPartRows(view, rows);
}

function fillPartRows(view, precomputed) {
  const rows = precomputed || getVisibleParts(state.partsRaw.map(decoratePart));
  const tbody = document.getElementById('part-rows');
  const cards = document.getElementById('part-cards');
  if (!tbody || !cards) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty">該当する品目がありません</div></td></tr>`;
    cards.innerHTML = `<div class="empty">該当する品目がありません</div>`;
    return;
  }
  tbody.replaceChildren(...rows.map((p) => partTableRow(p)));
  cards.replaceChildren(...rows.map((p) => partCard(p)));
}

// 在庫数セル（不足時は赤 + 「不足」バッジ）
function stockCellHTML(p) {
  if (p.low) {
    return `<span class="mono" style="color:var(--color-accent-900);font-weight:600">${p.stock}</span>
      <span class="tag tag-late" style="margin-left:6px;font-size:10px;padding:0 5px">不足${p.shortBy}</span>`;
  }
  return `<span class="mono">${p.stock}</span>`;
}

function partTableRow(p) {
  const tr = h(`
    <tr class="clickable">
      <td><span class="tag ${p.kindClass}">${esc(p.kind)}</span></td>
      <td>
        <div style="font-family:var(--font-heading);font-size:15px;line-height:1.15">${esc(p.name)}</div>
        <div class="text-muted mono" style="font-size:11px">${esc(p.model || '—')}</div>
      </td>
      <td class="mono" style="font-size:12px;color:var(--color-accent-800)">${esc(p.caseId || '—')}</td>
      <td class="mono right" style="font-size:13px">${p.need}</td>
      <td class="right" style="font-size:13px">${stockCellHTML(p)}</td>
      <td style="font-size:13px">${esc(p.supplier || '—')}</td>
      <td class="mono right" style="font-size:13px">${yen(p.price)}</td>
      <td class="mono" style="font-size:12px">${esc(p.eta || '—')}</td>
      <td><span class="tag ${p.statusClass}">${esc(p.status)}</span></td>
      <td>
        <div class="row-act" data-stop>
          <button class="btn btn-secondary" data-edit title="編集">✎</button>
          <button class="btn btn-secondary" data-del title="削除">🗑</button>
        </div>
      </td>
    </tr>
  `);
  tr.addEventListener('click', (e) => { if (e.target.closest('[data-stop]')) return; openPartForm(p); });
  tr.querySelector('[data-edit]').onclick = () => openPartForm(p);
  tr.querySelector('[data-del]').onclick = () => confirmDeletePart(p);
  return tr;
}

function partCard(p) {
  const card = h(`
    <div class="card blueprint">
      ${CORNERS}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span class="tag ${p.kindClass}">${esc(p.kind)}</span>
        <span class="tag ${p.statusClass}">${esc(p.status)}</span>
      </div>
      <div style="font-family:var(--font-heading);font-size:17px;line-height:1.15">${esc(p.name)}</div>
      <div class="text-muted mono" style="font-size:11px;margin-top:-4px">${esc(p.model || '—')}</div>
      <div style="height:1px;background:var(--color-divider)"></div>
      <div class="part-grid">
        <div><span class="k">使用案件</span><span class="v mono" style="color:var(--color-accent-800)">${esc(p.caseId || '—')}</span></div>
        <div><span class="k">仕入先</span><span class="v">${esc(p.supplier || '—')}</span></div>
        <div><span class="k">必要数</span><span class="v mono">${p.need}</span></div>
        <div><span class="k">在庫数</span><span class="v">${stockCellHTML(p)}</span></div>
        <div><span class="k">単価</span><span class="v mono">${yen(p.price)}</span></div>
        <div><span class="k">入荷予定</span><span class="v mono">${esc(p.eta || '—')}</span></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:2px">
        <button class="btn btn-secondary btn-sm" style="flex:1" data-edit>編集</button>
        <button class="btn btn-secondary btn-sm" data-del>削除</button>
      </div>
    </div>
  `);
  card.querySelector('[data-edit]').onclick = () => openPartForm(p);
  card.querySelector('[data-del]').onclick = () => confirmDeletePart(p);
  return card;
}

async function confirmDeletePart(p) {
  if (!confirm(`「${p.name}」を削除します。よろしいですか？`)) return;
  try {
    await deletePart(p.id);
    toast('部品を削除しました');
  } catch (err) { toast('削除に失敗しました：' + (err.message || err), 'err'); }
}

// ---- 発注登録 / 編集フォーム ----
function openPartForm(existing) {
  const isEdit = !!existing;
  const d = existing ? decoratePart(existing) : {
    kind: '部品', name: '', model: '', caseId: '', need: 1, stock: 0,
    supplier: '', price: 0, eta: '', status: '未発注',
  };

  // 使用案件の候補（既存案件の管理No + 共通）
  const caseIds = [...new Set(state.casesRaw.map((c) => c.mgmtNo).filter(Boolean))];

  const modal = h(`
    <div class="modal-backdrop">
      <div class="modal blueprint">
        ${CORNERS}
        <div class="modal-head">
          <h3>${isEdit ? '部品を編集' : '発注登録'}</h3>
          <button class="x" title="閉じる">✕</button>
        </div>
        <form class="modal-body" id="pform">
          <div class="form-grid">
            <div class="field">
              <label>区分</label>
              <select class="select" name="kind">
                ${PART_KINDS.map((k) => `<option ${k === d.kind ? 'selected' : ''}>${esc(k)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>発注状況</label>
              <select class="select" name="status">
                ${PART_STATUSES.map((s) => `<option ${s === d.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}
              </select>
            </div>
            <div class="field full">
              <label>品名 <span style="color:var(--color-accent)">*</span></label>
              <input class="input" name="name" value="${esc(d.name)}" required placeholder="消防ポンプ A-2級">
            </div>
            <div class="field">
              <label>型番</label>
              <input class="input" name="model" value="${esc(d.model)}" placeholder="TFP-A2/2026">
            </div>
            <div class="field">
              <label>使用案件</label>
              <input class="input" name="caseId" value="${esc(d.caseId)}" list="case-ids" placeholder="FE-2481 / 共通">
              <datalist id="case-ids">${caseIds.map((id) => `<option value="${esc(id)}">`).join('')}<option value="共通"></datalist>
            </div>
            <div class="field">
              <label>必要数</label>
              <input class="input" type="number" name="need" min="0" step="1" value="${d.need}">
            </div>
            <div class="field">
              <label>在庫数</label>
              <input class="input" type="number" name="stock" min="0" step="1" value="${d.stock}">
            </div>
            <div class="field">
              <label>仕入先</label>
              <input class="input" name="supplier" value="${esc(d.supplier)}" placeholder="トーハツ">
            </div>
            <div class="field">
              <label>単価</label>
              <input class="input" type="number" name="price" min="0" step="1" value="${d.price}">
            </div>
            <div class="field">
              <label>入荷予定</label>
              <input class="input" name="eta" value="${esc(d.eta)}" placeholder="08/01 または 在庫">
            </div>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-secondary" id="p-cancel">キャンセル</button>
          <button class="btn btn-primary" id="p-save">${isEdit ? '保存' : '登録'}</button>
        </div>
      </div>
    </div>
  `);

  const close = () => modal.remove();
  const form = modal.querySelector('#pform');
  modal.querySelector('.x').onclick = close;
  modal.querySelector('#p-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelector('#p-save').onclick = async () => {
    if (!form.reportValidity()) return;
    const data = {
      kind: form.kind.value,
      name: form.name.value,
      model: form.model.value,
      caseId: form.caseId.value,
      need: Number(form.need.value),
      stock: Number(form.stock.value),
      supplier: form.supplier.value,
      price: Number(form.price.value),
      eta: form.eta.value,
      status: form.status.value,
    };
    const saveBtn = modal.querySelector('#p-save');
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    try {
      if (isEdit) { await updatePart(existing.id, data); toast('部品を保存しました'); }
      else { await createPart(data); toast('部品を登録しました'); }
      close();
    } catch (err) {
      toast(err.message || '保存に失敗しました', 'err');
      saveBtn.disabled = false; saveBtn.textContent = isEdit ? '保存' : '登録';
    }
  };

  document.body.appendChild(modal);
  form.querySelector('input:not([disabled])')?.focus();
}

// ============================================================
// 検査（画面8: 案件ごとの検査項目テーブル / モバイルカード）
// ============================================================
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderInspection(view, caseId) {
  setMobileHeader(`
    <div>
      <div class="m-title">検査</div>
      <div class="m-sub">自主検査記録</div>
    </div>
  `);
  document.getElementById('fab').style.display = 'none';

  if (state.loading) { view.replaceChildren(loadingEl()); return; }
  if (!state.casesRaw.length) {
    view.replaceChildren(h(`<div class="container"><h2>検査</h2><div class="blueprint placeholder-page">${CORNERS}<div style="font-size:40px;opacity:.5">✓</div><div style="margin-top:10px">案件がありません。先に案件を登録してください。</div></div></div>`));
    return;
  }

  const casesById = Object.fromEntries(state.casesRaw.map((c) => [c.id, c]));
  const selId = (caseId && casesById[caseId]) ? caseId : state.casesRaw[0].id;
  state.inspCaseId = selId;
  state.inspLoading = true;
  state.inspRaw = [];

  view.replaceChildren(loadingEl());

  // このビューにいる間だけ購読（案件と同じリアルタイム同期）
  unsubView = subscribeInspections(
    selId,
    (rows) => { if (state.inspCaseId !== selId) return; state.inspRaw = rows; state.inspLoading = false; paintInspection(view); },
    () => { state.authError = true; renderRoute(); }
  );

  // 標準の検査項目を案件ごと初回のみ自動投入
  if (!inspSeedTried.has(selId)) {
    inspSeedTried.add(selId);
    seedInspectionsIfEmpty(selId)
      .then((seeded) => { if (seeded) toast('標準の検査項目を追加しました'); })
      .catch(() => {});
  }
}

function paintInspection(view) {
  if (state.inspLoading) { view.replaceChildren(loadingEl()); return; }
  const c = state.casesRaw.find((x) => x.id === state.inspCaseId);
  if (!c) { view.replaceChildren(loadingEl()); return; }
  const cd = decorateCase(c);

  const rows = state.inspRaw;
  const total = rows.length;
  const pass = rows.filter((r) => r.judge === '合格').length;
  const pending = rows.filter((r) => r.judge === '未判定').length;

  const caseOptions = state.casesRaw
    .map((cc) => `<option value="${esc(cc.id)}" ${cc.id === state.inspCaseId ? 'selected' : ''}>${esc(cc.mgmtNo)} ${esc(cc.type)}</option>`).join('');

  const el = h(`
    <div class="container">
      <div class="page-head">
        <div>
          <div class="eyebrow">Inspection</div>
          <h2>検査</h2>
          <div class="detail-meta">${esc(cd.mgmtNo)} ・ ${esc(cd.type)} ・ ${esc(cd.customer || '—')}</div>
        </div>
        <div class="kpis">
          <div class="kpi"><div class="v">${pass} / ${total}</div><div class="l">合格 / 全項目</div></div>
        </div>
      </div>

      <div class="toolbar">
        <select class="select" id="insp-case" style="max-width:280px" title="案件を選択">${caseOptions}</select>
        <button class="btn btn-primary push" id="insp-add">＋ 項目を追加</button>
      </div>

      <!-- PC: データテーブル -->
      <div class="blueprint table-wrap">
        ${CORNERS}
        <table class="table">
          <thead><tr>
            <th style="width:40px">#</th>
            <th>検査項目</th>
            <th style="width:132px">判定</th>
            <th style="width:96px">検査日</th>
            <th style="width:88px">検査員</th>
            <th>是正メモ</th>
            <th style="width:74px"></th>
          </tr></thead>
          <tbody id="insp-rows"></tbody>
        </table>
      </div>

      <!-- モバイル: カードリスト -->
      <div class="cardlist" id="insp-cards"></div>

      <!-- フッター: 未判定件数・PDF出力 -->
      <div class="insp-foot">
        <span class="text-muted">未判定 <b class="mono" style="color:var(--color-accent-800)">${pending}</b> 件 ／ 全 ${total} 項目</span>
        <button class="btn btn-secondary push" id="insp-pdf" ${total ? '' : 'disabled'}>検査記録をPDF出力</button>
      </div>
    </div>
  `);

  el.querySelector('#insp-case').addEventListener('change', (e) => go('#/inspection/' + encodeURIComponent(e.target.value)));
  el.querySelector('#insp-add').addEventListener('click', () => openInspectionForm(null));
  el.querySelector('#insp-pdf').addEventListener('click', () => exportInspectionPDF(cd, state.inspRaw));

  view.replaceChildren(el);
  fillInspectionRows();
}

function fillInspectionRows() {
  const rows = state.inspRaw;
  const tbody = document.getElementById('insp-rows');
  const cards = document.getElementById('insp-cards');
  if (!tbody || !cards) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty">検査項目がありません。「＋ 項目を追加」で登録できます。</div></td></tr>`;
    cards.innerHTML = `<div class="empty">検査項目がありません</div>`;
    return;
  }
  tbody.replaceChildren(...rows.map((r, i) => inspTableRow(r, i)));
  cards.replaceChildren(...rows.map((r, i) => inspCard(r, i)));
}

// タップで判定を切り替えるタグ（合格/要調整/不合格/未判定）
function judgeTag(r) {
  const b = h(`<button class="tag ${judgeClass(r.judge)} insp-judge" title="タップで判定を切替（合格→要調整→不合格→未判定）">${esc(r.judge)}</button>`);
  b.onclick = () => cycleJudge(r);
  return b;
}

async function cycleJudge(r) {
  const nj = nextJudge(r.judge);
  const patch = { judge: nj };
  // 未判定 → 判定 で検査日が空なら本日を自動補完
  if (nj !== '未判定' && !r.date) patch.date = todayISO();
  try {
    await updateInspection(state.inspCaseId, r.id, patch);
  } catch (err) {
    toast('判定の更新に失敗しました：' + (err.message || err), 'err');
  }
}

function inspTableRow(r, i) {
  const tr = h(`
    <tr>
      <td class="mono text-muted" style="font-size:12px">${i + 1}</td>
      <td style="font-family:var(--font-heading);font-size:15px">${esc(r.item)}</td>
      <td class="insp-judge-cell"></td>
      <td class="mono" style="font-size:12px">${dueShort(r.date)}</td>
      <td style="font-size:13px">${esc(r.inspector || '—')}</td>
      <td class="text-muted" style="font-size:12px">${esc(r.note || '')}</td>
      <td>
        <div class="row-act" data-stop>
          <button class="btn btn-secondary" data-edit title="編集">✎</button>
          <button class="btn btn-secondary" data-del title="削除">🗑</button>
        </div>
      </td>
    </tr>
  `);
  tr.querySelector('.insp-judge-cell').appendChild(judgeTag(r));
  tr.querySelector('[data-edit]').onclick = () => openInspectionForm(r);
  tr.querySelector('[data-del]').onclick = () => confirmDeleteInspection(r);
  return tr;
}

function inspCard(r, i) {
  const card = h(`
    <div class="card blueprint">
      ${CORNERS}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span class="mono text-muted" style="font-size:12px">#${i + 1}</span>
        <span class="insp-judge-slot"></span>
      </div>
      <div style="font-family:var(--font-heading);font-size:16px;line-height:1.2">${esc(r.item)}</div>
      <div style="height:1px;background:var(--color-divider)"></div>
      <div class="part-grid">
        <div><span class="k">検査日</span><span class="v mono">${dueShort(r.date)}</span></div>
        <div><span class="k">検査員</span><span class="v">${esc(r.inspector || '—')}</span></div>
      </div>
      ${r.note ? `<div style="font-size:12px"><span class="k" style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--color-text-muted)">是正メモ</span><div>${esc(r.note)}</div></div>` : ''}
      <div style="display:flex;gap:8px;margin-top:2px">
        <button class="btn btn-secondary btn-sm" style="flex:1" data-edit>編集</button>
        <button class="btn btn-secondary btn-sm" data-del>削除</button>
      </div>
    </div>
  `);
  card.querySelector('.insp-judge-slot').appendChild(judgeTag(r));
  card.querySelector('[data-edit]').onclick = () => openInspectionForm(r);
  card.querySelector('[data-del]').onclick = () => confirmDeleteInspection(r);
  return card;
}

async function confirmDeleteInspection(r) {
  if (!confirm(`検査項目「${r.item}」を削除します。よろしいですか？`)) return;
  try {
    await deleteInspection(state.inspCaseId, r.id);
    toast('検査項目を削除しました');
  } catch (err) { toast('削除に失敗しました：' + (err.message || err), 'err'); }
}

// ---- 検査項目の登録 / 編集フォーム ----
function openInspectionForm(existing) {
  const isEdit = !!existing;
  const d = existing || { item: '', judge: '未判定', date: '', inspector: '', note: '' };

  const modal = h(`
    <div class="modal-backdrop">
      <div class="modal blueprint">
        ${CORNERS}
        <div class="modal-head">
          <h3>${isEdit ? '検査項目を編集' : '検査項目を追加'}</h3>
          <button class="x" title="閉じる">✕</button>
        </div>
        <form class="modal-body" id="iform">
          <div class="form-grid">
            <div class="field full">
              <label>検査項目 <span style="color:var(--color-accent)">*</span></label>
              <input class="input" name="item" value="${esc(d.item)}" required placeholder="ポンプ性能・放水試験">
            </div>
            <div class="field">
              <label>判定</label>
              <select class="select" name="judge">
                ${JUDGES.map((j) => `<option ${j === d.judge ? 'selected' : ''}>${esc(j)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>検査日</label>
              <input class="input" type="date" name="date" value="${esc(d.date)}">
            </div>
            <div class="field">
              <label>検査員</label>
              <input class="input" name="inspector" value="${esc(d.inspector)}" placeholder="高橋">
            </div>
            <div class="field full">
              <label>是正メモ</label>
              <textarea class="input" name="note" placeholder="要調整・不合格の内容や是正指示など">${esc(d.note || '')}</textarea>
            </div>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-secondary" id="i-cancel">キャンセル</button>
          <button class="btn btn-primary" id="i-save">${isEdit ? '保存' : '追加'}</button>
        </div>
      </div>
    </div>
  `);

  const close = () => modal.remove();
  const form = modal.querySelector('#iform');
  modal.querySelector('.x').onclick = close;
  modal.querySelector('#i-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  modal.querySelector('#i-save').onclick = async () => {
    if (!form.reportValidity()) return;
    const data = {
      item: form.item.value,
      judge: form.judge.value,
      date: form.date.value,
      inspector: form.inspector.value,
      note: form.note.value,
    };
    const saveBtn = modal.querySelector('#i-save');
    saveBtn.disabled = true; saveBtn.textContent = '保存中…';
    try {
      if (isEdit) {
        await updateInspection(state.inspCaseId, existing.id, data);
        toast('検査項目を保存しました');
      } else {
        const maxOrder = state.inspRaw.reduce((m, r) => Math.max(m, Number(r.order) || 0), -1);
        await addInspection(state.inspCaseId, data, maxOrder + 1);
        toast('検査項目を追加しました');
      }
      close();
    } catch (err) {
      toast(err.message || '保存に失敗しました', 'err');
      saveBtn.disabled = false; saveBtn.textContent = isEdit ? '保存' : '追加';
    }
  };

  document.body.appendChild(modal);
  form.querySelector('input:not([disabled])')?.focus();
}

// ---- 検査記録をPDF出力（ブラウザの印刷→PDF保存を利用・日本語も安全） ----
function exportInspectionPDF(cd, rows) {
  const total = rows.length;
  const pass = rows.filter((r) => r.judge === '合格').length;
  const pending = rows.filter((r) => r.judge === '未判定').length;

  const report = h(`
    <div id="print-report">
      <div class="pr-head">
        <div class="pr-title">検査記録</div>
        <div class="pr-sub">${esc(cd.mgmtNo)} ・ ${esc(cd.type)}</div>
        <div class="pr-meta">顧客 ${esc(cd.customer || '—')} ／ シャシ ${esc(cd.chassis || '—')} ／ 担当 ${esc(cd.staff || '—')}</div>
        <div class="pr-meta">合格 ${pass} / ${total}　未判定 ${pending}件　出力日 ${todayLabel()}</div>
      </div>
      <table class="pr-table">
        <thead><tr><th style="width:32px">#</th><th>検査項目</th><th style="width:64px">判定</th><th style="width:80px">検査日</th><th style="width:70px">検査員</th><th>是正メモ</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(r.item)}</td>
            <td>${esc(r.judge)}</td>
            <td>${esc(dueShort(r.date))}</td>
            <td>${esc(r.inspector || '')}</td>
            <td>${esc(r.note || '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="pr-foot">消防車両 製作管理 ・ 自主検査記録</div>
    </div>
  `);
  document.body.appendChild(report);

  // 印刷ダイアログのファイル名候補にするためタイトルを一時変更
  const prevTitle = document.title;
  document.title = `検査記録_${cd.mgmtNo}`;

  const cleanup = () => {
    report.remove();
    document.title = prevTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  // 印刷を起動（ユーザーが「PDFに保存」を選べる）
  window.print();
  // afterprint が発火しない環境向けのフォールバック
  setTimeout(cleanup, 60000);
}

// ============================================================
// 図面・仕様書ビューア（画面6: 案件ごとのファイル一覧 / プレビュー）
// ============================================================
function renderDocs(view, caseId) {
  const c = state.casesRaw.find((x) => x.id === caseId);
  setMobileHeader(`
    <button class="m-back" id="m-back">‹</button>
    <div style="flex:1">
      <div class="m-title" style="font-size:18px">図面・仕様書</div>
      <div class="m-sub">${c ? esc(c.mgmtNo) + ' ・ ' + esc(c.type) : ''}</div>
    </div>
  `);
  document.getElementById('fab').style.display = 'none';

  if (state.loading) { view.replaceChildren(loadingEl()); return; }
  if (!caseId || !c) { view.replaceChildren(notFoundEl()); return; }

  state.docsCaseId = caseId;
  state.docsLoading = true;
  state.docsRaw = [];
  view.replaceChildren(loadingEl());

  // このビューにいる間だけ購読（写真と同じリアルタイム同期）
  unsubView = subscribeDocuments(
    caseId,
    (rows) => { if (state.docsCaseId !== caseId) return; state.docsRaw = rows; state.docsLoading = false; paintDocs(view); },
    () => { state.authError = true; renderRoute(); }
  );

  const back = document.getElementById('m-back');
  if (back) back.onclick = () => go('#/case/' + encodeURIComponent(caseId));
}

function paintDocs(view) {
  if (state.docsLoading) { view.replaceChildren(loadingEl()); return; }
  const c = state.casesRaw.find((x) => x.id === state.docsCaseId);
  const cd = c ? decorateCase(c) : null;
  const docs = state.docsRaw;

  const el = h(`
    <div class="container">
      <div class="page-head">
        <div>
          <div class="eyebrow">Drawings &amp; Documents</div>
          <h2>図面・仕様書</h2>
          <div class="detail-meta">${cd ? esc(cd.mgmtNo) + ' ・ ' + esc(cd.type) + ' ・ ' + esc(cd.customer || '—') : ''}</div>
        </div>
      </div>

      <div class="toolbar">
        <a class="btn btn-secondary pc-only" href="#/case/${encodeURIComponent(state.docsCaseId)}">‹ 案件詳細へ</a>
        <button class="btn btn-primary push" id="doc-add">＋ ファイルを追加</button>
      </div>

      <div id="doc-sections"></div>
    </div>
  `);
  el.querySelector('#doc-add').onclick = () => openDocUploadForm(state.docsCaseId);

  const sections = el.querySelector('#doc-sections');
  if (!docs.length) {
    sections.appendChild(h(`
      <div class="blueprint placeholder-page">
        ${CORNERS}
        <div style="font-size:40px;opacity:.5">📐</div>
        <div style="margin-top:10px">まだファイルがありません。<br>「＋ ファイルを追加」で図面・仕様書・書類をアップロードできます。</div>
      </div>
    `));
  } else {
    DOC_GROUPS.forEach((g) => {
      const items = docs.filter((d) => (DOC_GROUPS.includes(d.group) ? d.group : DOC_GROUPS[0]) === g);
      if (items.length) sections.appendChild(docSection(g, items));
    });
  }

  view.replaceChildren(el);
}

function docSection(title, items) {
  const sec = h(`
    <div class="doc-section">
      <div class="doc-section-title">${esc(title)}</div>
      <div class="doc-list"></div>
    </div>
  `);
  const list = sec.querySelector('.doc-list');
  items.forEach((d) => list.appendChild(docRow(d)));
  return sec;
}

function docRow(d) {
  const kind = extKind(d.ext);
  const label = (d.ext || '').slice(0, 4).toUpperCase() || 'FILE';
  const meta = [d.rev, fmtBytes(d.size), fmtDate(d.date)].filter(Boolean).join(' ・ ');
  const row = h(`
    <div class="blueprint doc-row">
      ${CORNERS}
      <button class="doc-open" title="開く">
        <span class="doc-tile ${kind}">${esc(label)}</span>
        <span class="doc-info">
          <span class="doc-name">${esc(d.name)}</span>
          <span class="doc-meta mono">${esc(meta)}</span>
        </span>
        <span class="doc-chev">›</span>
      </button>
      <button class="doc-del" title="削除">🗑</button>
    </div>
  `);
  row.querySelector('.doc-open').onclick = () => openDocPreview(d);
  row.querySelector('.doc-del').onclick = () => confirmDeleteDocument(d);
  return row;
}

// ---- プレビュー（PDFは全画面 / 画像はそのまま / それ以外はDL・共有） ----
function openDocPreview(d) {
  const kind = previewKind(d.contentType, d.ext);
  const ov = h(`
    <div class="docview">
      <div class="docview-top">
        <button class="x" title="閉じる">✕</button>
        <span class="docview-name">${esc(d.name)}</span>
        <span class="mono" style="font-size:12px;opacity:.85">${esc((d.ext || '').toUpperCase())}</span>
      </div>
      <div class="docview-body"></div>
      <div class="docview-foot">
        <button class="btn btn-secondary docview-share" style="flex:1">共有</button>
        <button class="btn btn-primary docview-dl" style="flex:2">ダウンロード</button>
      </div>
    </div>
  `);
  const body = ov.querySelector('.docview-body');
  if (kind === 'image') {
    body.appendChild(h(`<img class="docview-img" alt="${esc(d.name)}" src="${esc(d.url)}">`));
  } else if (kind === 'pdf') {
    body.appendChild(h(`<iframe class="docview-frame" src="${esc(d.url)}" title="${esc(d.name)}"></iframe>`));
  } else {
    body.appendChild(h(`
      <div class="docview-none">
        <span class="doc-tile ${extKind(d.ext)}" style="width:64px;height:76px;font-size:14px">${esc((d.ext || '').slice(0, 4).toUpperCase() || 'FILE')}</span>
        <div style="margin-top:16px;font-family:var(--font-heading);font-size:16px">${esc((d.ext || '').toUpperCase() || '不明')} はプレビュー未対応です</div>
        <div style="opacity:.75;font-size:12px;margin-top:6px">下のボタンからダウンロード / 共有できます。</div>
      </div>
    `));
  }
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  ov.querySelector('.x').onclick = close;
  ov.querySelector('.docview-dl').onclick = () => downloadDoc(d);
  ov.querySelector('.docview-share').onclick = () => shareDoc(d);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
}

function downloadDoc(d) {
  const a = document.createElement('a');
  a.href = d.url; a.target = '_blank'; a.rel = 'noopener';
  a.download = d.name || '';
  document.body.appendChild(a); a.click(); a.remove();
}

async function shareDoc(d) {
  if (navigator.share) {
    try { await navigator.share({ title: d.name, url: d.url }); }
    catch (_) { /* キャンセル等は無視 */ }
  } else {
    downloadDoc(d); // 共有API非対応環境はダウンロードにフォールバック
  }
}

async function confirmDeleteDocument(d) {
  if (!confirm(`「${d.name}」を削除します。よろしいですか？`)) return;
  try {
    await removeDocument(state.docsCaseId, d);
    toast('ファイルを削除しました');
  } catch (err) { toast('削除に失敗しました：' + (err.message || err), 'err'); }
}

// ---- ファイル追加（アップロード）フォーム ----
function openDocUploadForm(caseId) {
  const modal = h(`
    <div class="modal-backdrop">
      <div class="modal blueprint">
        ${CORNERS}
        <div class="modal-head">
          <h3>ファイルを追加</h3>
          <button class="x" title="閉じる">✕</button>
        </div>
        <form class="modal-body" id="dform">
          <div class="form-grid">
            <div class="field full">
              <label>ファイル <span style="color:var(--color-accent)">*</span></label>
              <input class="input" type="file" name="file" required>
              <div class="text-muted mono" id="d-fileinfo" style="font-size:12px"></div>
            </div>
            <div class="field">
              <label>種別</label>
              <select class="select" name="group">
                ${DOC_GROUPS.map((g) => `<option>${esc(g)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Rev（任意）</label>
              <input class="input" name="rev" placeholder="Rev.A">
            </div>
          </div>
        </form>
        <div class="modal-foot">
          <button class="btn btn-secondary" id="d-cancel">キャンセル</button>
          <button class="btn btn-primary" id="d-save">アップロード</button>
        </div>
      </div>
    </div>
  `);

  const close = () => modal.remove();
  const form = modal.querySelector('#dform');
  modal.querySelector('.x').onclick = close;
  modal.querySelector('#d-cancel').onclick = close;
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  form.file.addEventListener('change', () => {
    const f = form.file.files && form.file.files[0];
    modal.querySelector('#d-fileinfo').textContent = f ? `${f.name}（${fmtBytes(f.size)}）` : '';
  });

  modal.querySelector('#d-save').onclick = async () => {
    if (!form.reportValidity()) return;
    const file = form.file.files && form.file.files[0];
    if (!file) { toast('ファイルを選択してください', 'err'); return; }
    const group = form.group.value;
    const rev = form.rev.value;
    const saveBtn = modal.querySelector('#d-save');
    saveBtn.disabled = true; saveBtn.textContent = 'アップロード中…';
    const step = { upload: 'アップロード中', save: '保存中' };
    showUpload('アップロード中…');
    try {
      await uploadDocument(caseId, file, { group, rev }, { onStage: (s) => showUpload((step[s] || '処理中') + '…') });
      hideUpload();
      toast('ファイルを追加しました');
      close();
    } catch (err) {
      hideUpload();
      toast('アップロードに失敗しました：' + (err.message || err), 'err');
      saveBtn.disabled = false; saveBtn.textContent = 'アップロード';
    }
  };

  document.body.appendChild(modal);
}

// ============================================================
// 補助ビュー
// ============================================================
function renderPlaceholder(view, title, msg, icon) {
  setMobileHeader(`<div><div class="m-title">${esc(title)}</div></div>`);
  document.getElementById('fab').style.display = 'none';
  view.replaceChildren(h(`
    <div class="container">
      <h2>${esc(title)}</h2>
      <div class="blueprint placeholder-page">
        ${CORNERS}
        <div style="font-size:40px;opacity:.5">${icon}</div>
        <div style="margin-top:10px">${esc(msg)}</div>
      </div>
    </div>
  `));
}

function loadingEl() { return h(`<div class="loading"><div class="spinner"></div><div>読み込み中…</div></div>`); }
function notFoundEl() { return h(`<div class="container"><div class="empty">案件が見つかりません。<a href="#/">一覧へ戻る</a></div></div>`); }
function authErrorEl() {
  return h(`
    <div class="container">
      <div class="blueprint placeholder-page">
        ${CORNERS}
        <h3 style="color:var(--color-accent-800)">Firebase に接続できません</h3>
        <p style="max-width:520px;margin:10px auto 0;line-height:1.7">
          匿名認証が有効になっていない可能性があります。<br>
          Firebase コンソール → Authentication → Sign-in method →「匿名」を有効化してください。<br>
          詳しくは <b>README_SETUP.md</b> を参照してください。
        </p>
      </div>
    </div>
  `);
}

// ---- ユーティリティ ----
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

boot();
