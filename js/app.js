// ============================================================
// 消防車両 製作管理アプリ — メインSPA
// ハッシュルーター + Firestoreリアルタイム同期
// 段階1: 案件一覧 / 案件詳細 / 登録・進捗管理
// ============================================================

import {
  STAGES, STATUSES, yen, pct, autoProgress, decorateCase,
  esc, h, toast, CORNERS, stepperHTML, todayLabel, clamp,
} from './util.js';
import {
  subscribeCases, subscribeCase, subscribePhotos,
  createCase, updateCase, patchCase, deleteCase, seedIfEmpty, getCase,
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
};

let unsubView = null;      // 現在ビューの購読解除

const IMG_ICON = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L4 21"/></svg>`;

// ============================================================
// 起動
// ============================================================
async function boot() {
  renderShell();
  window.addEventListener('hashchange', () => { state.route = parseHash(); renderRoute(); });
  state.route = parseHash();

  // 全案件をグローバル購読（一覧の即時反映用）
  subscribeCases(
    (rows) => { state.casesRaw = rows; state.loading = false; if (state.route.name === 'orders') renderRoute(); updateBadges(); },
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
    case 'board': renderPlaceholder(view, '工程ボード', '段階3で実装します。', '▦'); break;
    case 'parts': renderPlaceholder(view, '部品・資材', '段階3で実装します。', '◫'); break;
    case 'inspection': renderPlaceholder(view, '検査', '段階3で実装します。', '✓'); break;
    case 'docs': renderPlaceholder(view, '図面・仕様書', '段階4で実装します。', '📐'); break;
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
    <button class="m-icon" id="m-add">≡</button>
  `);
  document.getElementById('fab').style.display = '';

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

  const mAdd = document.getElementById('m-add');
  if (mAdd) mAdd.onclick = () => openCaseForm(null);
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
// 案件詳細（2a: PC工程別フォトログ / モバイル詳細）
// ============================================================
let detailPhotos = [];      // 現在案件の写真
let mobileStageSel = null;  // モバイルで選択中の工程index

function renderDetail(view, id) {
  view.replaceChildren(loadingEl());
  detailPhotos = [];
  mobileStageSel = null;

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
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
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
  photos.forEach((p) => grid.appendChild(photoSlotDesktop(p)));
  const add = h(`<button class="btn btn-secondary photo-add">＋<span>写真を追加</span></button>`);
  add.onclick = () => addPhotoStub();
  grid.appendChild(add);
  return row;
}

function photoSlotDesktop(p) {
  const slot = h(`<div class="blueprint photo-slot">${CORNERS}<img alt="工程写真" src="${esc(p.url)}"></div>`);
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

  wrap.querySelector('#m-addphoto').onclick = () => addPhotoStub();
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
      </div>
      <textarea class="input" placeholder="メモを入力（例：ホース収納部の取付を確認）" style="min-height:54px;font-size:13px">${esc(p.memo || '')}</textarea>
    </div>
  `);
  block.querySelector('.zoom').onclick = () => openLightbox(photos, idx, stageName);
  return block;
}

// 段階1では写真アップロード未実装 → 案内
function addPhotoStub() {
  toast('写真アップロードは段階2で有効になります');
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
        <textarea class="input" placeholder="メモを入力" style="min-height:52px;font-size:13px;background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.25)"></textarea>
      </div>
    </div>
  `);
  const track = lb.querySelector('.lightbox-track');
  photos.forEach((p) => track.appendChild(h(`<div class="lightbox-slide"><img alt="写真" src="${esc(p.url)}"></div>`)));
  const dotsWrap = lb.querySelector('.lightbox-dots');
  photos.forEach((_, i) => dotsWrap.appendChild(h(`<span class="${i === startIdx ? 'on' : ''}"></span>`)));

  const counter = lb.querySelector('.counter');
  const memo = lb.querySelector('textarea');
  const update = () => {
    const i = Math.round(track.scrollLeft / track.clientWidth);
    counter.textContent = (i + 1) + ' / ' + photos.length;
    dotsWrap.querySelectorAll('span').forEach((s, k) => s.classList.toggle('on', k === i));
    memo.value = photos[i]?.memo || '';
  };
  track.addEventListener('scroll', debounce(update, 60));
  lb.querySelector('.prev').onclick = () => track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' });
  lb.querySelector('.next').onclick = () => track.scrollBy({ left: track.clientWidth, behavior: 'smooth' });
  const close = () => lb.remove();
  lb.querySelector('.x').onclick = close;
  document.body.appendChild(lb);
  requestAnimationFrame(() => { track.scrollLeft = track.clientWidth * startIdx; });
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
