const state = {
  connections: [],
  selected: -1,
  activeTab: 'objects',
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

function selectedConn() {
  if (state.selected < 0 || state.selected >= state.connections.length) return null;
  return state.connections[state.selected];
}

function renderConnections() {
  const root = $('connTree');
  if (!state.connections.length) {
    root.innerHTML = '<div class="muted">No hay conexiones.</div>';
    return;
  }

  root.innerHTML = state.connections
    .map((c, i) => {
      const active = i === state.selected ? 'active' : '';
      return `<button class="tree-item ${active}" data-index="${i}">🗄 ${c.name}<small>${c.motor} · ${c.database}</small></button>`;
    })
    .join('');

  root.querySelectorAll('.tree-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selected = Number(btn.dataset.index);
      renderConnections();
      renderProfile();
      loadSchemasAndObjects();
    });
  });
}

function renderProfile(extra = null) {
  const c = selectedConn();
  if (!c) {
    $('profileCard').innerHTML = 'Sin conexión seleccionada.';
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

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  $(`tab-${tab}`).classList.add('active');
  $('centerTitle').textContent =
    tab === 'objects' ? 'Objetos' :
    tab === 'dashboard' ? 'Dashboard' :
    tab === 'import' ? 'Asistente de Importación' :
    tab === 'export' ? 'Asistente de Exportación' : 'Backup';

  if (tab === 'dashboard') loadDashboard();
}

async function loadSchemasAndObjects() {
  const c = selectedConn();
  if (!c) return;
  try {
    const schemas = await api('/explorer/schemas', connPayload(c));
    const select = $('schemaSelect');
    select.innerHTML = (schemas.schemas || []).map((s) => `<option>${s}</option>`).join('');
    if (!select.value) return;
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
    $('objectsBody').innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')
      : '<tr><td colspan="3">Sin objetos.</td></tr>';
  } catch (err) {
    $('objectsBody').innerHTML = `<tr><td colspan="3">${err.message}</td></tr>`;
  }
}

async function loadDashboard() {
  if (!state.connections.length) {
    $('dashboardRaw').textContent = 'Agrega conexiones primero.';
    return;
  }
  try {
    const data = await api('/monitor/dashboard', { conexiones: state.connections.map(connPayload) });
    const t = data.totals || {};
    $('kpiCards').innerHTML = [
      ['Conexiones', t.connections || 0],
      ['Tablas', t.tables || 0],
      ['Vistas', t.views || 0],
      ['Sesiones', t.active_sessions || 0],
      ['Errores', t.with_errors || 0],
    ].map((k) => `<article class="kpi"><h4>${k[0]}</h4><strong>${k[1]}</strong></article>`).join('');
    $('dashboardRaw').textContent = JSON.stringify(data, null, 2);
    renderProfile(data.databases?.[state.selected] || null);
  } catch (err) {
    $('dashboardRaw').textContent = err.message;
  }
}

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
    e.target.reset();
    renderConnections();
    renderProfile();
    loadSchemasAndObjects();
  } catch (err) {
    alert('Conexión falló: ' + err.message);
  }
});

$('refreshObjects').addEventListener('click', loadObjects);
$('schemaSelect').addEventListener('change', loadObjects);

$('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = selectedConn();
  if (!c) return alert('Selecciona una conexión.');
  const f = new FormData(e.target);
  try {
    const data = await api('/data/import', {
      conexion: connPayload(c),
      schema: f.get('schema') || 'public',
      table: f.get('table'),
      formato: f.get('format'),
      input_path: f.get('input'),
      create_table_if_not_exists: true,
    });
    $('importResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $('importResult').textContent = err.message;
  }
});

$('exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = selectedConn();
  if (!c) return alert('Selecciona una conexión.');
  const f = new FormData(e.target);
  try {
    const data = await api('/data/export', {
      conexion: connPayload(c),
      schema: f.get('schema') || 'public',
      table: f.get('table'),
      formato: f.get('format'),
      output_path: f.get('output'),
      where_clause: f.get('where') || null,
    });
    $('exportResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $('exportResult').textContent = err.message;
  }
});

$('backupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = selectedConn();
  if (!c) return alert('Selecciona una conexión.');
  const f = new FormData(e.target);
  try {
    const data = await api('/backup/create', {
      conexion: connPayload(c),
      output_path: f.get('output'),
      modo: f.get('mode'),
    });
    $('backupResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $('backupResult').textContent = err.message;
  }
});

document.querySelectorAll('.ribbon button').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

renderConnections();
renderProfile();
switchTab('objects');
