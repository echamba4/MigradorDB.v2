# NexoraDB Studio (Desktop) – Quickstart

## Ejecutar (Windows)

1) Instala:
- Node.js 18+
- Python 3.10+ (recomendado 3.11 para máxima compatibilidad de drivers)

2) Doble click:
- `start_windows.bat`

Eso instala dependencias (una sola vez) y abre **NexoraDB Studio**.

## Notas de motores

- PostgreSQL: para Backup/Restore se recomienda tener `pg_dump` y `psql` en PATH.
- SQL Server: para Backup/Restore se requiere `sqlcmd` (Microsoft SQL Server Command Line Utilities).

## Puertos

- Engine (FastAPI): `127.0.0.1:8001`
- App (API+UI): `127.0.0.1:3010`

Si esos puertos están ocupados, cierra el proceso que los use.

## Endpoints nuevos del Engine (v0.2+)

- `POST /monitor/dashboard`: resumen agregado para múltiples conexiones (ideal para dashboard moderno).
- `POST /data/export`: asistente backend para exportar tablas en `excel`, `csv`, `txt`, `xml`, `json`, `mdb`, `accdb`, `sql`.
- `POST /data/import`: asistente backend para importar desde `excel`, `csv`, `txt`, `xml`, `json`, `mdb`, `accdb`.

> Nota: para Access (`.mdb/.accdb`) necesitas un driver ODBC de Microsoft Access disponible en el sistema.
> Nota: SQL Server y Access requieren `pyodbc` + ODBC Driver del sistema. En Python 3.13 puede requerir instalación manual adicional.

## App de prueba incluida (web)

- Abre `http://127.0.0.1:8001/` para usar una app web integrada con:
  - Registro/test de conexiones.
  - Dashboard agregado de múltiples bases.
  - Asistente de exportación/importación.
  - Backup rápido.
