# NexoraDB Studio (Desktop Electron) – Deploy rápido en Windows

Este paquete ya trae:

* **API (NestJS)** sirviendo la UI tipo Navicat (dark).
* **Engine (FastAPI)** para: Explorer (tablas/vistas/funciones/índices/FKs), Query SELECT, Migración, Backup/Restore y Monitor.
* **Desktop (Electron)** que levanta todo en localhost y abre la app.

## Requisitos en la PC / servidor

1. **Node.js 18+**
2. **Python 3.10+**
3. Drivers/herramientas según motor:
   - PostgreSQL: `pg_dump`, `psql` (vienen con PostgreSQL)
   - SQL Server: `sqlcmd` (Microsoft ODBC/Tools)
   - (Opcional) MySQL: `mysqldump`, `mysql`

> Para tu caso actual (PostgreSQL + SQL Server), con `pg_dump/psql` y `sqlcmd` es suficiente.

## 1) Arranque en modo prueba (DEV)

### A) Engine

```bat
cd apps\engine
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

### B) API + UI

En otra consola:

```bat
cd apps\api
npm install
set ENGINE_URL=http://127.0.0.1:8001
npm run start:prod
```

Luego abre:

* `http://127.0.0.1:3010`

## 2) Desktop Electron (recomendado para tus usuarios)

1) Levanta el Engine/Api automáticamente y abre la ventana.

```bat
cd apps\desktop
npm install
set NEXORA_PYTHON=python
npm run dev
```

## 3) Build instalador (.exe)

```bat
cd apps\desktop
npm run dist
```

Genera un instalador con **NSIS** (carpeta `dist/`).

## Notas importantes

* **Backup SQL Server**: el `.bak` se crea **en el servidor** de SQL Server, y la ruta debe existir allí.
* **Restore SQL Server**: requiere permisos y acceso a la ruta del `.bak` desde el servidor SQL.
* **Query Tool** permite `SELECT/WITH/EXPLAIN` por seguridad.
