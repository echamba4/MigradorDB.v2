# NexoraDB Studio (Desktop) – Quickstart

## Ejecutar (Windows)

1) Instala:
- Node.js 18+
- Python 3.10+

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
