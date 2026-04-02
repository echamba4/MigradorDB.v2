const DB_TYPES = [
  { key: 'postgres', label: 'PostgreSQL', port: 5432, db: 'postgres', user: 'postgres', icon: '🐘' },
  { key: 'mysql', label: 'MySQL', port: 3306, db: 'mysql', user: 'root', icon: '🐬' },
  { key: 'sqlserver', label: 'SQL Server', port: 1433, db: 'master', user: 'sa', icon: '🟦' },
  { key: 'sqlite', label: 'SQLite', port: 0, db: 'database.db', user: '', icon: '🧩' },
  { key: 'mongodb', label: 'MongoDB', port: 27017, db: 'admin', user: '', icon: '🍃' },
  { key: 'oracle', label: 'Oracle', port: 1521, db: 'xe', user: 'system', icon: '🟥' },
];

const state = { connections: [], selected: -1, activeTab: 'query', treeMeta: {}, dashboardTimer: null, metricsHistory: [] };
const $ = (id) => document.getElementById(id);
const selectedConn = () => (state.selected >= 0 ? state.connections[state.selected] : null);

function connPayload(c) {
  return { motor: c.motor, host: c.host, port: Number(c.port || 0), database: c.database, user: c.user || '', password: c.password || '', ssl: !!c.ssl };
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
  return data;
}

function showToast(msg, ok = true) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show ${ok ? 'ok' : 'err'}`;
  setTimeout(() => { el.className = 'toast'; }, 2200);
}

function showMiniModal(title, msg, autoCloseMs = 1800) {
  $('miniModalTitle').textContent = title;
  $('miniModalMsg').textContent = msg;
  $('miniModal').classList.remove('hidden');
  setTimeout(() => $('miniModal').classList.add('hidden'), autoCloseMs);
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  $(`tab-${tab}`).classList.add('active');
  $('centerTitle').textContent = { query: 'Nueva Consulta', objects: 'Objetos', dashboard: 'Dashboard', import: 'Asistente de Importación', export: 'Asistente de Exportación', backup: 'Copias de seguridad' }[tab] || 'NexoraDB';
  if (state.dashboardTimer) { clearInterval(state.dashboardTimer); state.dashboardTimer = null; }
  if (tab === 'dashboard') {
    loadDashboard();
    state.dashboardTimer = setInterval(loadDashboard, 5000);
  }
  if (tab === 'objects') loadSchemasAndObjects();
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function openConnMenu() {
  const menu = $('connTypeMenu');
  menu.innerHTML = DB_TYPES.map((d) => `<button class="menu-item" data-db="${d.key}">${d.icon} ${d.label}...</button>`).join('');
  menu.classList.toggle('hidden');
  menu.querySelectorAll('[data-db]').forEach((btn) => btn.onclick = () => selectDbType(btn.dataset.db));
}

function selectDbType(key) {
  const db = DB_TYPES.find((x) => x.key === key);
  if (!db) return;
  const f = $('connForm');
  f.reset();
  f.motor.value = db.key;
  f.port.value = db.port || '';
  f.database.value = db.db;
  f.user.value = db.user;
  f.host.value = db.key === 'sqlite' ? 'C:\\ruta\\archivo.db' : 'localhost';
  $('connModalTitle').textContent = `Nueva conexión (${db.label})`;
  $('connTypeMenu').classList.add('hidden');
  openModal('connModal');
}

async function loadMetaForConnection(index) {
  const c = state.connections[index];
  if (!c) return;
  try {
    let dbs = { databases: [c.database] };
    try {
      dbs = await api('/explorer/databases', connPayload(c));
    } catch (eDb) {
      // fallback para engines viejos sin endpoint /explorer/databases
      dbs = { databases: [c.database] };
    }
    const schemas = await api('/explorer/schemas', connPayload(c));
    const schemaList = schemas.schemas || ['public'];
    const objectsBySchema = {};
    for (const schema of schemaList) {
      objectsBySchema[schema] = await api('/explorer/objects', { conexion: connPayload(c), schema });
    }
    state.treeMeta[index] = { databases: dbs.databases || [c.database], schemas: schemaList, objectsBySchema, tableDetails: {} };
    renderTree();
    updateQueryLabel();
  } catch (e) {
    state.treeMeta[index] = { error: e.message };
    renderTree();
  }
}

async function ensureTableDetails(connIndex, schema, table) {
  const c = state.connections[connIndex];
  const meta = state.treeMeta[connIndex];
  if (!c || !meta) return null;
  const key = `${schema}.${table}`;
  if (meta.tableDetails[key]) return meta.tableDetails[key];
  try {
    const det = await api('/explorer/table-details', { conexion: connPayload(c), schema, table });
    meta.tableDetails[key] = det;
    return det;
  } catch {
    meta.tableDetails[key] = { columns: [], indexes: [], foreign_keys: [], constraints: [], triggers: [] };
    return meta.tableDetails[key];
  }
}

function dbIcon(motor) {
  const db = DB_TYPES.find((d) => d.key === motor);
  return db?.icon || '🗄';
}

function renderTree() {
  const root = $('connTree');
  if (!state.connections.length) { root.innerHTML = '<div class="muted">No hay conexiones. Clic en Conexión.</div>'; return; }

  root.innerHTML = state.connections.map((c, idx) => {
    const active = idx === state.selected ? 'active' : '';
    const meta = state.treeMeta[idx];
    if (!meta || meta.error) {
      return `<details ${active ? 'open' : ''}><summary class="conn-summary ${active}" data-select="${idx}">${dbIcon(c.motor)} ${c.name}</summary><div class="tree-node muted">${meta?.error || 'Cargando...'}</div></details>`;
    }

    const dbNodes = meta.databases.map((db) => `<div class="tree-node">🛢 ${db}</div>`).join('');
    const schemaNodes = meta.schemas.map((s) => {
      const o = meta.objectsBySchema[s] || {};
      const tableNodes = (o.tables || []).map((t) => `<details>
          <summary class="leaf" data-select="${idx}" data-schema="${s}" data-table="${t}">📘 ${t}</summary>
          <div class="child" data-detail="${idx}|${s}|${t}">Cargando detalle...</div>
      </details>`).join('') || '<div class="tree-node muted">(sin tablas)</div>';
      const viewNodes = (o.views || []).map((v) => `<div class="leaf">👁 ${v}</div>`).join('') || '<div class="tree-node muted">(sin vistas)</div>';
      const fnNodes = (o.functions || []).map((f) => `<div class="leaf">ƒ ${typeof f === 'string' ? f : f.name}</div>`).join('') || '<div class="tree-node muted">(sin funciones)</div>';
      return `<details open>
          <summary>🧩 ${s}</summary>
          <details open><summary>📚 Tablas</summary>${tableNodes}</details>
          <details><summary>👁 Vistas</summary>${viewNodes}</details>
          <details><summary>ƒ Funciones</summary>${fnNodes}</details>
          <details><summary>🧾 Consultas</summary><button class="leaf" data-newquery="${idx}">Nueva consulta</button></details>
      </details>`;
    }).join('');

    return `<details ${active ? 'open' : ''}><summary class="conn-summary ${active}" data-select="${idx}">${dbIcon(c.motor)} ${c.name}</summary>${dbNodes}${schemaNodes}</details>`;
  }).join('');

  root.querySelectorAll('[data-select]').forEach((el) => el.addEventListener('click', async () => {
    const idx = Number(el.dataset.select);
    state.selected = idx;
    renderProfile();
    updateQueryLabel();
    renderTree();
    if (el.dataset.table) {
      const schema = el.dataset.schema || 'public';
      const table = el.dataset.table;
      $('sqlEditor').value = `select * from ${schema}.${table} limit 200;`;
      switchTab('query');
      const slot = root.querySelector(`[data-detail="${idx}|${schema}|${table}"]`);
      if (slot) {
        const det = await ensureTableDetails(idx, schema, table);
        slot.innerHTML = `
          <details><summary>🧱 Campos</summary>${(det.columns || []).map((x) => `<div class='tree-node'>• ${x}</div>`).join('') || '<div class="tree-node muted">(vacío)</div>'}</details>
          <details><summary>🔠 Índices</summary>${(det.indexes || []).map((x) => `<div class='tree-node'>• ${x}</div>`).join('') || '<div class="tree-node muted">(vacío)</div>'}</details>
          <details><summary>🔗 Clave Foráneas</summary>${(det.foreign_keys || []).map((x) => `<div class='tree-node'>• ${x}</div>`).join('') || '<div class="tree-node muted">(vacío)</div>'}</details>
          <details><summary>✅ Restricciones</summary>${(det.constraints || []).map((x) => `<div class='tree-node'>• ${x}</div>`).join('') || '<div class="tree-node muted">(vacío)</div>'}</details>
          <details><summary>⚡ Triggers</summary>${(det.triggers || []).map((x) => `<div class='tree-node'>• ${x}</div>`).join('') || '<div class="tree-node muted">(vacío)</div>'}</details>`;
      }
    }
  }));

  root.querySelectorAll('[data-newquery]').forEach((el) => el.onclick = () => {
    state.selected = Number(el.dataset.newquery);
    updateQueryLabel();
    $('sqlEditor').value = 'select * from nombre_tabla limit 200;';
    switchTab('query');
  });
}

function renderProfile() {
  const c = selectedConn();
  if (!c) { $('profileCard').textContent = 'Sin conexión seleccionada.'; $('profileCard').classList.add('muted'); return; }
  $('profileCard').classList.remove('muted');
  $('profileCard').innerHTML = `<h3>${dbIcon(c.motor)} ${c.name}</h3><p><strong>Motor:</strong> ${c.motor}</p><p><strong>Host:</strong> ${c.host}</p><p><strong>Puerto:</strong> ${c.port || '-'}</p><p><strong>DB Inicial:</strong> ${c.database}</p><p><strong>Usuario:</strong> ${c.user || '-'}</p>`;
}

function updateQueryLabel() {
  const c = selectedConn();
  $('queryConnLabel').textContent = c ? `${dbIcon(c.motor)} ${c.name}` : 'Sin conexión seleccionada';
}

async function loadSchemasAndObjects() {
  const c = selectedConn();
  if (!c) return;
  try {
    const data = await api('/explorer/schemas', connPayload(c));
    $('schemaSelect').innerHTML = (data.schemas || []).map((s) => `<option>${s}</option>`).join('');
    await loadObjects();
  } catch (err) { $('objectsBody').innerHTML = `<tr><td colspan='3'>${err.message}</td></tr>`; }
}

async function loadObjects() {
  const c = selectedConn();
  if (!c) return;
  const schema = $('schemaSelect').value || 'public';
  try {
    const data = await api('/explorer/objects', { conexion: connPayload(c), schema });
    const rows = [];
    (data.tables || []).forEach((t) => rows.push([t, 'TABLE', schema]));
    (data.views || []).forEach((v) => rows.push([v, 'VIEW', schema]));
    (data.functions || []).forEach((f) => rows.push([f.name, f.type || 'FUNCTION', schema]));
    $('objectsBody').innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('') || '<tr><td colspan="3">Sin objetos.</td></tr>';
  } catch (err) { $('objectsBody').innerHTML = `<tr><td colspan='3'>${err.message}</td></tr>`; }
}

async function runQuery(explain = false) {
  const c = selectedConn();
  if (!c) return alert('Selecciona una conexión en el árbol.');
  let sql = $('sqlEditor').value.trim();
  if (!sql) return;
  if (explain) sql = `explain ${sql}`;
  try {
    const data = await api('/query', { conexion: connPayload(c), request: { sql, page: 1, limit: 200 } });
    const rows = data.rows || [];
    const cols = rows.length ? Object.keys(rows[0]) : [];
    $('queryHead').innerHTML = cols.length ? `<tr>${cols.map((x) => `<th>${x}</th>`).join('')}</tr>` : '<tr><th>Resultado</th></tr>';
    $('queryBody').innerHTML = rows.length ? rows.map((r) => `<tr>${cols.map((x) => `<td>${String(r[x] ?? '')}</td>`).join('')}</tr>`).join('') : '<tr><td>Sin filas</td></tr>';
    $('queryMeta').textContent = `Tiempo: ${data.ms} ms | Filas: ${rows.length}`;
  } catch (err) {
    $('queryHead').innerHTML = '<tr><th>Error</th></tr>';
    $('queryBody').innerHTML = `<tr><td>${err.message}</td></tr>`;
    $('queryMeta').textContent = 'Error ejecutando consulta';
  }
}

function renderChart(data) {
  const el = $('monitorBars');
  if (!el) return;
  const max = Math.max(1, ...data.map((d) => d.value || 0));
  el.innerHTML = data.map((d) => `<div class='bar-row'><span>${d.label}</span><div class='bar-bg'><div class='bar-fill' style='width:${Math.max(5, (d.value / max) * 100)}%'></div></div><b>${d.value}</b></div>`).join('');
}

function drawLineChart(canvasId, values, color = '#58a6ff') {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#141b24';
  ctx.fillRect(0, 0, w, h);
  if (!values.length) return;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  ctx.strokeStyle = '#2b3748';
  for (let i = 0; i < 5; i++) {
    const y = (h - 10) * (i / 4) + 5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * (w - 20) + 10;
    const y = h - 10 - ((v - min) / range) * (h - 20);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

async function loadDashboard() {
  if (!state.connections.length) { $('kpiCards').innerHTML = ''; $('monitorBars').innerHTML = ''; return; }
  try {
    const data = await api('/monitor/dashboard', { conexiones: state.connections.map(connPayload) });
    const t = data.totals || {};
    $('kpiCards').innerHTML = [['Conexiones', t.connections || 0], ['Tablas', t.tables || 0], ['Vistas', t.views || 0], ['Sesiones', t.active_sessions || 0], ['Errores', t.with_errors || 0], ['Tamaño(MB)', Math.round((t.size_bytes || 0) / 1024 / 1024)]].map(([k, v]) => `<article class='kpi'><h4>${k}</h4><strong>${v}</strong></article>`).join('');
    renderChart((data.databases || []).filter((d) => !d.error).slice(0, 8).map((d) => ({ label: d.db || '-', value: Math.round((d.size_bytes || 0) / 1024 / 1024) })));
    state.metricsHistory.push({
      sizeMb: Math.round((t.size_bytes || 0) / 1024 / 1024),
      sessions: Number(t.active_sessions || 0),
      ts: Date.now(),
    });
    state.metricsHistory = state.metricsHistory.slice(-30);
    drawLineChart('sizeChart', state.metricsHistory.map((x) => x.sizeMb), '#4ea3ff');
    drawLineChart('sessionChart', state.metricsHistory.map((x) => x.sessions), '#61d18a');
  } catch (e) {
    $('kpiCards').innerHTML = `<article class='kpi'><h4>Error</h4><strong>${e.message}</strong></article>`;
  }
}

$('openConnWizard').onclick = openConnMenu;
document.querySelectorAll('[data-close]').forEach((btn) => btn.onclick = () => closeModal(btn.dataset.close));
$('miniModal').onclick = () => $('miniModal').classList.add('hidden');

document.addEventListener('click', (e) => {
  if (!e.target.closest('#openConnWizard') && !e.target.closest('#connTypeMenu')) $('connTypeMenu').classList.add('hidden');
});

$('testConnBtn').onclick = async () => {
  const f = new FormData($('connForm'));
  const c = Object.fromEntries(f.entries()); c.ssl = !!f.get('ssl'); c.port = Number(c.port || 0);
  try {
    await api('/connection/test', connPayload(c));
    showMiniModal('Conexión Exitosa', 'La conexión se probó correctamente.');
    closeModal('connModal');
  } catch (e) { showToast(`Error: ${e.message}`, false); }
};

$('connForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const c = Object.fromEntries(f.entries()); c.ssl = !!f.get('ssl'); c.port = Number(c.port || 0);
  try {
    await api('/connection/test', connPayload(c));
    state.connections.push(c);
    state.selected = state.connections.length - 1;
    closeModal('connModal');
    e.target.reset();
    renderProfile();
    showToast('Conexión guardada', true);
    await loadMetaForConnection(state.selected);
  } catch (e2) { showToast(`Error: ${e2.message}`, false); }
};

$('runQuery').onclick = () => runQuery(false);
$('explainQuery').onclick = () => runQuery(true);
$('refreshObjects').onclick = loadObjects;
$('schemaSelect').onchange = loadObjects;

document.querySelectorAll('.ribbon button[data-tab]').forEach((btn) => btn.onclick = () => switchTab(btn.dataset.tab));

$('importForm').onsubmit = async (e) => {
  e.preventDefault(); const c = selectedConn(); if (!c) return alert('Selecciona conexión'); const f = new FormData(e.target);
  try { const data = await api('/data/import', { conexion: connPayload(c), schema: f.get('schema'), table: f.get('table'), formato: f.get('format'), input_path: f.get('input'), create_table_if_not_exists: true }); $('importResult').textContent = `Importado: ${data.rows} filas`; }
  catch (e2) { $('importResult').textContent = e2.message; }
};

$('exportForm').onsubmit = async (e) => {
  e.preventDefault(); const c = selectedConn(); if (!c) return alert('Selecciona conexión'); const f = new FormData(e.target);
  try { const data = await api('/data/export', { conexion: connPayload(c), schema: f.get('schema'), table: f.get('table'), formato: f.get('format'), output_path: f.get('output'), where_clause: f.get('where') || null }); $('exportResult').textContent = `Exportado: ${data.rows} filas`; }
  catch (e2) { $('exportResult').textContent = e2.message; }
};

$('backupForm').onsubmit = async (e) => {
  e.preventDefault(); const c = selectedConn(); if (!c) return alert('Selecciona conexión'); const f = new FormData(e.target);
  try { const data = await api('/backup/create', { conexion: connPayload(c), output_path: f.get('output'), modo: f.get('mode') }); $('backupResult').textContent = `Backup creado: ${data.output}`; }
  catch (e2) { $('backupResult').textContent = e2.message; }
};

renderTree();
renderProfile();
updateQueryLabel();
switchTab('query');
