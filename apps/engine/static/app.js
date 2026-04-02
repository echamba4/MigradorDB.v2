const DB_TYPES = [
  { key: 'postgres', label: 'PostgreSQL', port: 5432, db: 'postgres', user: 'postgres' },
  { key: 'mysql', label: 'MySQL', port: 3306, db: 'mysql', user: 'root' },
  { key: 'sqlserver', label: 'SQL Server', port: 1433, db: 'master', user: 'sa' },
  { key: 'sqlite', label: 'SQLite', port: 0, db: 'database.db', user: '' },
  { key: 'mongodb', label: 'MongoDB', port: 27017, db: 'admin', user: '' },
  { key: 'oracle', label: 'Oracle', port: 1521, db: 'xe', user: 'system' },
];

const state = {
  connections: [],
  selected: -1,
  activeTab: 'query',
  treeMeta: {},
};

const $ = (id) => document.getElementById(id);

function connPayload(c) {
  return {
    motor: c.motor,
    host: c.host,
    port: Number(c.port || 0),
    database: c.database,
    user: c.user || '',
    password: c.password || '',
    ssl: !!c.ssl,
  };
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
  return data;
}

const selectedConn = () => (state.selected >= 0 ? state.connections[state.selected] : null);

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  $(`tab-${tab}`).classList.add('active');
  $('centerTitle').textContent = {
    query: 'Nueva Consulta',
    objects: 'Objetos',
    dashboard: 'Dashboard',
    import: 'Asistente de Importación',
    export: 'Asistente de Exportación',
    backup: 'Copias de seguridad',
  }[tab] || 'NexoraDB';

  if (tab === 'dashboard') loadDashboard();
  if (tab === 'objects') loadSchemasAndObjects();
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function initDbTypeModal() {
  $('dbTypeGrid').innerHTML = DB_TYPES.map((d) =>
    `<button class="db-item" data-db="${d.key}">${d.label}</button>`
  ).join('');

  $('dbTypeGrid').querySelectorAll('.db-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const db = DB_TYPES.find((x) => x.key === btn.dataset.db);
      if (!db) return;
      $('connModalTitle').textContent = `Nueva conexión (${db.label})`;
      const f = $('connForm');
      f.motor.value = db.key;
      f.port.value = db.port || '';
      f.database.value = db.db;
      f.user.value = db.user;
      f.host.value = db.key === 'sqlite' ? 'C:\\ruta\\archivo.db' : 'localhost';
      closeModal('dbTypeModal');
      openModal('connModal');
    });
  });
}

async function loadMetaForConnection(index) {
  const c = state.connections[index];
  if (!c) return;
  try {
    const schemas = await api('/explorer/schemas', connPayload(c));
    const firstSchema = (schemas.schemas || [])[0] || 'public';
    const objects = await api('/explorer/objects', { conexion: connPayload(c), schema: firstSchema });
    state.treeMeta[index] = { schemas: schemas.schemas || [], objectsBySchema: { [firstSchema]: objects } };
    renderTree();
    if (index === state.selected) {
      loadSchemasAndObjects();
      updateQueryLabel();
    }
  } catch (e) {
    state.treeMeta[index] = { error: e.message };
    renderTree();
  }
}

function renderTree() {
  const root = $('connTree');
  if (!state.connections.length) {
    root.innerHTML = '<div class="muted">No hay conexiones. Usa botón Conexión.</div>';
    return;
  }

  root.innerHTML = state.connections.map((c, idx) => {
    const active = idx === state.selected ? 'active' : '';
    const meta = state.treeMeta[idx];
    if (!meta || meta.error) {
      return `<details ${active ? 'open' : ''}><summary class="conn-summary ${active}" data-select="${idx}">🗄 ${c.name}</summary>
      <div class="tree-node muted">${meta?.error || 'Cargando...'}</div></details>`;
    }
    const schema = meta.schemas?.[0] || 'public';
    const obj = meta.objectsBySchema?.[schema] || {};
    const items = (label, arr, icon, type) => `<details open><summary>${icon} ${label}</summary>
      ${(arr || []).map((x) => `<button class="leaf" data-select="${idx}" data-schema="${schema}" data-table="${typeof x === 'string' ? x : x.name}" data-type="${type}">${typeof x === 'string' ? x : x.name}</button>`).join('') || '<div class="tree-node muted">(vacío)</div>'}
    </details>`;

    return `<details ${active ? 'open' : ''}>
      <summary class="conn-summary ${active}" data-select="${idx}">🗄 ${c.name}</summary>
      <div class="tree-node">📁 ${c.database}</div>
      <details open>
        <summary>🧩 ${schema}</summary>
        ${items('Tablas', obj.tables, '📘', 'table')}
        ${items('Vistas', obj.views, '👁', 'view')}
        ${items('Funciones', obj.functions, 'ƒ', 'function')}
        <details><summary>🧾 Consultas</summary><button class="leaf" data-newquery="${idx}">Nueva consulta</button></details>
      </details>
    </details>`;
  }).join('');

  root.querySelectorAll('[data-select]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selected = Number(el.dataset.select);
      renderTree();
      renderProfile();
      updateQueryLabel();
      if (el.dataset.table) {
        const schema = el.dataset.schema || 'public';
        const table = el.dataset.table;
        $('sqlEditor').value = `select * from ${schema}.${table} limit 200;`;
        switchTab('query');
      }
    });
  });

  root.querySelectorAll('[data-newquery]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selected = Number(el.dataset.newquery);
      updateQueryLabel();
      $('sqlEditor').value = 'select * from nombre_tabla limit 200;';
      switchTab('query');
    });
  });
}

function renderProfile(extra = null) {
  const c = selectedConn();
  if (!c) {
    $('profileCard').textContent = 'Sin conexión seleccionada.';
    $('profileCard').classList.add('muted');
    return;
  }
  $('profileCard').classList.remove('muted');
  $('profileCard').innerHTML = `
    <h3>${c.name}</h3>
    <p><strong>Motor:</strong> ${c.motor}</p>
    <p><strong>Host:</strong> ${c.host}</p>
    <p><strong>Puerto:</strong> ${c.port || '-'}</p>
    <p><strong>DB:</strong> ${c.database}</p>
    <p><strong>Usuario:</strong> ${c.user || '-'}</p>
    ${extra ? `<hr/><pre>${JSON.stringify(extra, null, 2)}</pre>` : ''}
  `;
}

function updateQueryLabel() {
  const c = selectedConn();
  $('queryConnLabel').textContent = c ? `${c.name} (${c.motor})` : 'Sin conexión seleccionada';
}

async function loadSchemasAndObjects() {
  const c = selectedConn();
  if (!c) return;
  try {
    const data = await api('/explorer/schemas', connPayload(c));
    const select = $('schemaSelect');
    select.innerHTML = (data.schemas || []).map((s) => `<option>${s}</option>`).join('');
    await loadObjects();
  } catch (err) {
    $('objectsBody').innerHTML = `<tr><td colspan="3">${err.message}</td></tr>`;
  }
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
  } catch (err) {
    $('objectsBody').innerHTML = `<tr><td colspan="3">${err.message}</td></tr>`;
  }
}

async function runQuery(explain = false) {
  const c = selectedConn();
  if (!c) return alert('Selecciona una conexión desde el árbol.');
  let sql = $('sqlEditor').value.trim();
  if (!sql) return;
  if (explain) sql = `explain ${sql}`;
  try {
    const data = await api('/query', {
      conexion: connPayload(c),
      request: { sql, page: 1, limit: 200 },
    });
    const rows = data.rows || [];
    const cols = rows.length ? Object.keys(rows[0]) : [];
    $('queryHead').innerHTML = cols.length ? `<tr>${cols.map((c2) => `<th>${c2}</th>`).join('')}</tr>` : '<tr><th>Resultado</th></tr>';
    $('queryBody').innerHTML = rows.length
      ? rows.map((r) => `<tr>${cols.map((c2) => `<td>${String(r[c2] ?? '')}</td>`).join('')}</tr>`).join('')
      : '<tr><td>Sin filas</td></tr>';
    $('queryMeta').textContent = JSON.stringify({ ms: data.ms, page: data.page, limit: data.limit, rows: rows.length }, null, 2);
  } catch (err) {
    $('queryHead').innerHTML = '<tr><th>Error</th></tr>';
    $('queryBody').innerHTML = `<tr><td>${err.message}</td></tr>`;
    $('queryMeta').textContent = err.message;
  }
}

async function loadDashboard() {
  if (!state.connections.length) return;
  try {
    const data = await api('/monitor/dashboard', { conexiones: state.connections.map(connPayload) });
    const t = data.totals || {};
    $('kpiCards').innerHTML = [
      ['Conexiones', t.connections || 0],
      ['Tablas', t.tables || 0],
      ['Vistas', t.views || 0],
      ['Sesiones', t.active_sessions || 0],
      ['Errores', t.with_errors || 0],
    ].map(([k, v]) => `<article class="kpi"><h4>${k}</h4><strong>${v}</strong></article>`).join('');
    $('dashboardRaw').textContent = JSON.stringify(data, null, 2);
    renderProfile(data.databases?.[state.selected] || null);
  } catch (e) {
    $('dashboardRaw').textContent = e.message;
  }
}

$('openConnWizard').addEventListener('click', () => openModal('dbTypeModal'));
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeModal(btn.dataset.close)));

$('testConnBtn').addEventListener('click', async () => {
  const f = new FormData($('connForm'));
  const c = Object.fromEntries(f.entries());
  c.ssl = !!f.get('ssl');
  c.port = Number(c.port || 0);
  try {
    const data = await api('/connection/test', connPayload(c));
    $('connTestResult').textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    $('connTestResult').textContent = e.message;
  }
});

$('connForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const c = Object.fromEntries(f.entries());
  c.ssl = !!f.get('ssl');
  c.port = Number(c.port || 0);
  try {
    await api('/connection/test', connPayload(c));
    state.connections.push(c);
    state.selected = state.connections.length - 1;
    closeModal('connModal');
    $('connTestResult').textContent = '';
    renderTree();
    renderProfile();
    updateQueryLabel();
    loadMetaForConnection(state.selected);
  } catch (e2) {
    $('connTestResult').textContent = e2.message;
  }
});

$('runQuery').addEventListener('click', () => runQuery(false));
$('explainQuery').addEventListener('click', () => runQuery(true));
$('refreshObjects').addEventListener('click', loadObjects);
$('schemaSelect').addEventListener('change', loadObjects);

document.querySelectorAll('.ribbon button[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

$('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = selectedConn();
  if (!c) return alert('Selecciona conexión');
  const f = new FormData(e.target);
  try {
    const data = await api('/data/import', { conexion: connPayload(c), schema: f.get('schema'), table: f.get('table'), formato: f.get('format'), input_path: f.get('input'), create_table_if_not_exists: true });
    $('importResult').textContent = JSON.stringify(data, null, 2);
  } catch (e2) { $('importResult').textContent = e2.message; }
});

$('exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = selectedConn();
  if (!c) return alert('Selecciona conexión');
  const f = new FormData(e.target);
  try {
    const data = await api('/data/export', { conexion: connPayload(c), schema: f.get('schema'), table: f.get('table'), formato: f.get('format'), output_path: f.get('output'), where_clause: f.get('where') || null });
    $('exportResult').textContent = JSON.stringify(data, null, 2);
  } catch (e2) { $('exportResult').textContent = e2.message; }
});

$('backupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = selectedConn();
  if (!c) return alert('Selecciona conexión');
  const f = new FormData(e.target);
  try {
    const data = await api('/backup/create', { conexion: connPayload(c), output_path: f.get('output'), modo: f.get('mode') });
    $('backupResult').textContent = JSON.stringify(data, null, 2);
  } catch (e2) { $('backupResult').textContent = e2.message; }
});

initDbTypeModal();
renderTree();
renderProfile();
updateQueryLabel();
switchTab('query');
