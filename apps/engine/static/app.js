const state = { connections: [] };

const byId = (id) => document.getElementById(id);

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

function refreshConnectionSelectors() {
  const selects = document.querySelectorAll('select[name="conn"]');
  const opts = state.connections
    .map((c, i) => `<option value="${i}">${c.name} (${c.motor})</option>`)
    .join('');
  selects.forEach((s) => (s.innerHTML = opts || '<option value="">Sin conexiones</option>'));

  byId('connList').innerHTML = state.connections
    .map((c, i) => `<div>#${i + 1} <strong>${c.name}</strong> → ${c.motor}://${c.host}/${c.database}</div>`)
    .join('');
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

byId('connForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const c = Object.fromEntries(f.entries());
  c.ssl = !!f.get('ssl');
  c.port = Number(c.port || 0);

  try {
    await api('/connection/test', connPayload(c));
    state.connections.push(c);
    refreshConnectionSelectors();
    e.target.reset();
  } catch (err) {
    alert('Conexión falló: ' + err.message);
  }
});

byId('loadStats').addEventListener('click', async () => {
  if (!state.connections.length) return alert('Agrega conexiones primero');
  try {
    const payload = { conexiones: state.connections.map(connPayload) };
    const data = await api('/monitor/dashboard', payload);
    byId('stats').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    byId('stats').textContent = err.message;
  }
});

byId('exportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const idx = Number(f.get('conn'));
  const c = state.connections[idx];
  if (!c) return alert('Selecciona conexión válida');

  try {
    const data = await api('/data/export', {
      conexion: connPayload(c),
      schema: f.get('schema') || 'public',
      table: f.get('table'),
      formato: f.get('format'),
      output_path: f.get('output'),
      where_clause: f.get('where') || null,
    });
    byId('exportResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    byId('exportResult').textContent = err.message;
  }
});

byId('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const idx = Number(f.get('conn'));
  const c = state.connections[idx];
  if (!c) return alert('Selecciona conexión válida');

  try {
    const data = await api('/data/import', {
      conexion: connPayload(c),
      schema: f.get('schema') || 'public',
      table: f.get('table'),
      formato: f.get('format'),
      input_path: f.get('input'),
      create_table_if_not_exists: true,
    });
    byId('importResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    byId('importResult').textContent = err.message;
  }
});

byId('backupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const idx = Number(f.get('conn'));
  const c = state.connections[idx];
  if (!c) return alert('Selecciona conexión válida');

  try {
    const data = await api('/backup/create', {
      conexion: connPayload(c),
      output_path: f.get('output'),
      modo: f.get('mode'),
    });
    byId('backupResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    byId('backupResult').textContent = err.message;
  }
});

refreshConnectionSelectors();
