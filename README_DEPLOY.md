# NexoraDB Studio (Preview)

Esto es un **preview listo para pruebas** (tipo Navicat básico) con:
- **API/Core (NestJS compilado)**: puerto **3010**
- **UI web estática** servida por el mismo API: `http://localhost:3010`
- **Engine de migración (FastAPI)**: puerto **8001**
- **Metadata DB** (PostgreSQL en Docker): puerto **5433**

## 1) Requisitos
- Windows 10/11 o Windows Server
- **Node.js 18+**
- **Python 3.10+**
- **Docker Desktop** (para la metadata DB)
- Para SQL Server: instalar **ODBC Driver 17/18 for SQL Server**

## 2) Levantar Metadata DB
En la carpeta del proyecto:

```bash
docker compose up -d
```

## 3) Configurar API (.env)
Archivo: `apps/api/.env`

```env
CLAVE_MAESTRA=MiClaveUltraSecretaNexoraDB2026
META_DB_HOST=localhost
META_DB_PORT=5433
META_DB_USER=nexora
META_DB_PASS=nexora123
META_DB_NAME=nexoradb_metadata
ENGINE_URL=http://localhost:8001
PORT=3010
```

## 4) Levantar Engine (FastAPI)

```bash
cd apps/engine
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001
```

## 5) Levantar API + UI
En otra consola:

```bash
cd apps/api
node dist/main.js
```

Abre:
- `http://localhost:3010`

## 6) Uso rápido
1. **+ Conexión** → crea conexiones a PostgreSQL o SQL Server.
2. Click a la conexión → carga tablas y muestra tree.
3. Doble click a una tabla → ejecuta `SELECT * LIMIT 100`.
4. Botón **Migrar** → selecciona origen/destino/tablas → inicia migración.

> Nota: En este MVP el **destino soportado** por el engine es **PostgreSQL**.

---

## Qué incluye este preview
- CRUD de conexiones + test
- Tree tipo Navicat (conexión → DB → esquema → tablas)
- Query tool (ejecutar + grid + export CSV)
- Migración por tablas (estructura/datos/completo) con progreso

