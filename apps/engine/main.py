from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
import threading
import uuid
import os
import shutil
import subprocess
import time

import psycopg2
import pyodbc

# Opcionales
try:
    import pymysql
except Exception:  # pragma: no cover
    pymysql = None

try:
    from pymongo import MongoClient
except Exception:  # pragma: no cover
    MongoClient = None

try:
    import sqlite3
except Exception:  # pragma: no cover
    sqlite3 = None

try:
    import oracledb
except Exception:  # pragma: no cover
    oracledb = None

app = FastAPI(title="NexoraDB Migration Engine", version="0.2.0")

migraciones_activas: Dict[str, Dict[str, Any]] = {}

# -----------------------------
# Modelos
# -----------------------------
class ConexionConfig(BaseModel):
    motor: str  # postgres | sqlserver | mysql | sqlite | mongodb | oracle
    host: str
    port: int = 0
    database: str
    user: str = ""
    password: str = ""
    ssl: bool = False

    # Para SQLite: host puede ser ruta del archivo .db y database puede repetirse.


class TablaConfig(BaseModel):
    tabla_origen: str
    tabla_destino: Optional[str] = None
    esquema_origen: str = "public"
    esquema_destino: str = "public"


class MigrarMultipleRequest(BaseModel):
    origen: ConexionConfig
    destino: ConexionConfig
    tablas: List[TablaConfig]
    modo: str = Field("completo", description="estructura|datos|completo")
    batch_size: int = 5000
    drop_if_exists: bool = False


class QueryRequest(BaseModel):
    sql: str
    page: int = 1
    limit: int = 100


class BackupRequest(BaseModel):
    conexion: ConexionConfig
    output_path: str
    modo: str = Field("completo", description="estructura|datos|completo")


class RestoreRequest(BaseModel):
    conexion: ConexionConfig
    input_path: str


# -----------------------------
# Utilidades conexión
# -----------------------------

def conn_postgres(c: ConexionConfig):
    sslmode = "require" if c.ssl else "disable"
    return psycopg2.connect(
        host=c.host,
        port=c.port or 5432,
        dbname=c.database,
        user=c.user,
        password=c.password,
        sslmode=sslmode,
    )


def conn_sqlserver(c: ConexionConfig):
    driver = os.getenv("SQLSERVER_ODBC_DRIVER", "ODBC Driver 17 for SQL Server")
    conn_str = (
        f"DRIVER={{{driver}}};SERVER={c.host},{c.port or 1433};DATABASE={c.database};UID={c.user};PWD={c.password};"
        "TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn_str)


def conn_mysql(c: ConexionConfig):
    if pymysql is None:
        raise RuntimeError("pymysql no está instalado")
    return pymysql.connect(
        host=c.host,
        port=int(c.port or 3306),
        user=c.user,
        password=c.password,
        database=c.database,
        cursorclass=pymysql.cursors.DictCursor,
        ssl={"ssl": {}} if c.ssl else None,
    )


def conn_sqlite(c: ConexionConfig):
    if sqlite3 is None:
        raise RuntimeError("sqlite3 no disponible")
    # Para SQLite: usamos host como ruta o database como ruta
    path = c.host or c.database
    if not path:
        raise RuntimeError("Para SQLite debes enviar host=ruta_del_archivo.db")
    return sqlite3.connect(path)


def conn_mongodb(c: ConexionConfig):
    if MongoClient is None:
        raise RuntimeError("pymongo no está instalado")
    # MongoDB URI básica
    # host puede ser "localhost" y port 27017
    if c.user:
        uri = f"mongodb://{c.user}:{c.password}@{c.host}:{c.port or 27017}/{c.database}"
    else:
        uri = f"mongodb://{c.host}:{c.port or 27017}/{c.database}"
    client = MongoClient(uri)
    return client


def conn_oracle(c: ConexionConfig):
    if oracledb is None:
        raise RuntimeError("oracledb no está instalado (requiere Oracle Instant Client)")
    dsn = f"{c.host}:{c.port or 1521}/{c.database}"
    return oracledb.connect(user=c.user, password=c.password, dsn=dsn)


def quote_ident_pg(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


# -----------------------------
# Introspección / Explorer
# -----------------------------

def _connect_any(c: ConexionConfig):
    m = c.motor.lower()
    if m == "postgres":
        return conn_postgres(c)
    if m == "sqlserver":
        return conn_sqlserver(c)
    if m == "mysql":
        return conn_mysql(c)
    if m == "sqlite":
        return conn_sqlite(c)
    if m == "mongodb":
        return conn_mongodb(c)
    if m == "oracle":
        return conn_oracle(c)
    raise RuntimeError(f"Motor no soportado: {c.motor}")


@app.post("/explorer/schemas")
def explorer_schemas(cfg: ConexionConfig):
    m = cfg.motor.lower()
    if m == "mongodb":
        return {"schemas": ["default"]}
    if m == "sqlite":
        return {"schemas": ["main"]}
    if m == "postgres":
        with conn_postgres(cfg) as cn:
            with cn.cursor() as cur:
                cur.execute(
                    """
                    SELECT schema_name
                    FROM information_schema.schemata
                    WHERE schema_name NOT IN ('pg_catalog','information_schema')
                    ORDER BY schema_name
                    """
                )
                return {"schemas": [r[0] for r in cur.fetchall()]}
    if m == "sqlserver":
        cn = conn_sqlserver(cfg)
        cur = cn.cursor()
        cur.execute("SELECT name FROM sys.schemas ORDER BY name")
        rows = [r[0] for r in cur.fetchall()]
        cn.close()
        return {"schemas": rows}
    if m == "mysql":
        cn = conn_mysql(cfg)
        try:
            with cn.cursor() as cur:
                cur.execute(
                    "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"
                )
                return {"schemas": [r["schema_name"] for r in cur.fetchall()]}
        finally:
            cn.close()
    if m == "oracle":
        cn = conn_oracle(cfg)
        cur = cn.cursor()
        cur.execute("SELECT username FROM all_users ORDER BY username")
        rows = [r[0] for r in cur.fetchall()]
        cn.close()
        return {"schemas": rows}
    raise HTTPException(400, "Motor no soportado")


@app.post("/explorer/objects")
def explorer_objects(payload: Dict[str, Any]):
    """Devuelve tablas/vistas/funciones/índices/FKs para un esquema.

    Payload: { conexion: ConexionConfig, schema: str }
    """
    cfg = ConexionConfig(**payload.get("conexion", {}))
    schema = payload.get("schema") or ("dbo" if cfg.motor.lower() == "sqlserver" else "public")
    m = cfg.motor.lower()

    if m == "postgres":
        with conn_postgres(cfg) as cn:
            with cn.cursor() as cur:
                cur.execute(
                    """
                    SELECT table_name FROM information_schema.tables
                    WHERE table_schema=%s AND table_type='BASE TABLE'
                    ORDER BY table_name
                    """,
                    (schema,),
                )
                tablas = [r[0] for r in cur.fetchall()]

                cur.execute(
                    """
                    SELECT table_name FROM information_schema.views
                    WHERE table_schema=%s
                    ORDER BY table_name
                    """,
                    (schema,),
                )
                vistas = [r[0] for r in cur.fetchall()]

                cur.execute(
                    """
                    SELECT routine_name, routine_type
                    FROM information_schema.routines
                    WHERE specific_schema=%s
                    ORDER BY routine_name
                    """,
                    (schema,),
                )
                funciones = [{"name": r[0], "type": r[1]} for r in cur.fetchall()]

                cur.execute(
                    """
                    SELECT
                      i.relname AS index_name,
                      t.relname AS table_name,
                      pg_get_indexdef(ix.indexrelid) AS definition
                    FROM pg_class t
                    JOIN pg_index ix ON t.oid = ix.indrelid
                    JOIN pg_class i ON i.oid = ix.indexrelid
                    JOIN pg_namespace n ON n.oid = t.relnamespace
                    WHERE n.nspname=%s AND t.relkind='r'
                    ORDER BY t.relname, i.relname
                    """,
                    (schema,),
                )
                indexes = [
                    {"index": r[0], "table": r[1], "definition": r[2]} for r in cur.fetchall()
                ]

                cur.execute(
                    """
                    SELECT
                      tc.constraint_name,
                      tc.table_name,
                      kcu.column_name,
                      ccu.table_name AS foreign_table,
                      ccu.column_name AS foreign_column
                    FROM information_schema.table_constraints AS tc
                    JOIN information_schema.key_column_usage AS kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    JOIN information_schema.constraint_column_usage AS ccu
                      ON ccu.constraint_name = tc.constraint_name
                     AND ccu.table_schema = tc.table_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY'
                      AND tc.table_schema=%s
                    ORDER BY tc.table_name, tc.constraint_name
                    """,
                    (schema,),
                )
                fks = [
                    {
                        "name": r[0],
                        "table": r[1],
                        "column": r[2],
                        "ref_table": r[3],
                        "ref_column": r[4],
                    }
                    for r in cur.fetchall()
                ]

                return {
                    "schema": schema,
                    "tables": tablas,
                    "views": vistas,
                    "functions": funciones,
                    "indexes": indexes,
                    "foreign_keys": fks,
                }

    if m == "sqlserver":
        cn = conn_sqlserver(cfg)
        cur = cn.cursor()
        # tables
        cur.execute(
            """
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'
            ORDER BY TABLE_NAME
            """,
            (schema,),
        )
        tablas = [r[0] for r in cur.fetchall()]

        cur.execute(
            """
            SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS
            WHERE TABLE_SCHEMA=?
            ORDER BY TABLE_NAME
            """,
            (schema,),
        )
        vistas = [r[0] for r in cur.fetchall()]

        # functions & procs
        cur.execute(
            """
            SELECT o.name, o.type_desc
            FROM sys.objects o
            JOIN sys.schemas s ON s.schema_id=o.schema_id
            WHERE s.name=? AND o.type IN ('FN','TF','IF','P')
            ORDER BY o.name
            """,
            (schema,),
        )
        funciones = [{"name": r[0], "type": r[1]} for r in cur.fetchall()]

        # indexes
        cur.execute(
            """
            SELECT t.name AS table_name, i.name AS index_name, i.type_desc
            FROM sys.indexes i
            JOIN sys.tables t ON t.object_id=i.object_id
            JOIN sys.schemas s ON s.schema_id=t.schema_id
            WHERE s.name=? AND i.name IS NOT NULL
            ORDER BY t.name, i.name
            """,
            (schema,),
        )
        indexes = [{"table": r[0], "index": r[1], "definition": r[2]} for r in cur.fetchall()]

        # FKs
        cur.execute(
            """
            SELECT fk.name, pt.name AS parent_table, pc.name AS parent_column,
                   rt.name AS ref_table, rc.name AS ref_column
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id
            JOIN sys.tables pt ON pt.object_id=fkc.parent_object_id
            JOIN sys.columns pc ON pc.object_id=pt.object_id AND pc.column_id=fkc.parent_column_id
            JOIN sys.tables rt ON rt.object_id=fkc.referenced_object_id
            JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fkc.referenced_column_id
            JOIN sys.schemas s ON s.schema_id=pt.schema_id
            WHERE s.name=?
            ORDER BY pt.name, fk.name
            """,
            (schema,),
        )
        fks = [
            {"name": r[0], "table": r[1], "column": r[2], "ref_table": r[3], "ref_column": r[4]}
            for r in cur.fetchall()
        ]

        cn.close()
        return {
            "schema": schema,
            "tables": tablas,
            "views": vistas,
            "functions": funciones,
            "indexes": indexes,
            "foreign_keys": fks,
        }

    if m == "mysql":
        cn = conn_mysql(cfg)
        try:
            with cn.cursor() as cur:
                cur.execute(
                    """
                    SELECT table_name FROM information_schema.tables
                    WHERE table_schema=%s AND table_type='BASE TABLE'
                    ORDER BY table_name
                    """,
                    (schema,),
                )
                tablas = [r["table_name"] for r in cur.fetchall()]

                cur.execute(
                    """
                    SELECT table_name FROM information_schema.views
                    WHERE table_schema=%s
                    ORDER BY table_name
                    """,
                    (schema,),
                )
                vistas = [r["table_name"] for r in cur.fetchall()]

                cur.execute(
                    """
                    SELECT routine_name, routine_type
                    FROM information_schema.routines
                    WHERE routine_schema=%s
                    ORDER BY routine_name
                    """,
                    (schema,),
                )
                funciones = [{"name": r["routine_name"], "type": r["routine_type"]} for r in cur.fetchall()]

                cur.execute(
                    """
                    SELECT table_name, index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
                    FROM information_schema.statistics
                    WHERE table_schema=%s
                    GROUP BY table_name, index_name
                    ORDER BY table_name, index_name
                    """,
                    (schema,),
                )
                indexes = [
                    {"table": r["table_name"], "index": r["index_name"], "definition": r["cols"]}
                    for r in cur.fetchall()
                ]

                cur.execute(
                    """
                    SELECT constraint_name, table_name, column_name, referenced_table_name, referenced_column_name
                    FROM information_schema.key_column_usage
                    WHERE table_schema=%s AND referenced_table_name IS NOT NULL
                    ORDER BY table_name, constraint_name
                    """,
                    (schema,),
                )
                fks = [
                    {
                        "name": r["constraint_name"],
                        "table": r["table_name"],
                        "column": r["column_name"],
                        "ref_table": r["referenced_table_name"],
                        "ref_column": r["referenced_column_name"],
                    }
                    for r in cur.fetchall()
                ]

                return {
                    "schema": schema,
                    "tables": tablas,
                    "views": vistas,
                    "functions": funciones,
                    "indexes": indexes,
                    "foreign_keys": fks,
                }
        finally:
            cn.close()

    if m == "sqlite":
        cn = conn_sqlite(cfg)
        cur = cn.cursor()
        cur.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type,name")
        tablas, vistas = [], []
        for name, typ in cur.fetchall():
            if name.startswith('sqlite_'):
                continue
            (tablas if typ == 'table' else vistas).append(name)

        # SQLite no tiene "funciones" como objetos
        funciones = []

        # indexes
        indexes = []
        for t in tablas:
            cur.execute(f"PRAGMA index_list('{t}')")
            for row in cur.fetchall():
                # row: (seq, name, unique, origin, partial)
                indexes.append({"table": t, "index": row[1], "definition": f"unique={row[2]}"})

        # foreign keys
        fks = []
        for t in tablas:
            cur.execute(f"PRAGMA foreign_key_list('{t}')")
            for row in cur.fetchall():
                # (id, seq, table, from, to, on_update, on_delete, match)
                fks.append({"name": f"fk_{t}_{row[0]}", "table": t, "column": row[3], "ref_table": row[2], "ref_column": row[4]})

        cn.close()
        return {
            "schema": "main",
            "tables": tablas,
            "views": vistas,
            "functions": funciones,
            "indexes": indexes,
            "foreign_keys": fks,
        }

    if m == "mongodb":
        client = conn_mongodb(cfg)
        db = client[cfg.database]
        cols = db.list_collection_names()
        # indexes
        indexes = []
        for col in cols:
            for k, v in db[col].index_information().items():
                indexes.append({"table": col, "index": k, "definition": str(v.get('key'))})
        client.close()
        return {
            "schema": "default",
            "tables": cols,
            "views": [],
            "functions": [],
            "indexes": indexes,
            "foreign_keys": [],
        }

    if m == "oracle":
        cn = conn_oracle(cfg)
        cur = cn.cursor()
        # Oracle: schema = usuario
        cur.execute(
            """
            SELECT table_name FROM all_tables WHERE owner=:o ORDER BY table_name
            """,
            {"o": schema.upper()},
        )
        tablas = [r[0] for r in cur.fetchall()]
        cur.execute(
            """
            SELECT view_name FROM all_views WHERE owner=:o ORDER BY view_name
            """,
            {"o": schema.upper()},
        )
        vistas = [r[0] for r in cur.fetchall()]
        # funciones/procs
        cur.execute(
            """
            SELECT object_name, object_type FROM all_objects
            WHERE owner=:o AND object_type IN ('FUNCTION','PROCEDURE','PACKAGE')
            ORDER BY object_name
            """,
            {"o": schema.upper()},
        )
        funciones = [{"name": r[0], "type": r[1]} for r in cur.fetchall()]
        # FKs
        cur.execute(
            """
            SELECT a.constraint_name, a.table_name, acc.column_name,
                   c_pk.table_name r_table, acc_pk.column_name r_col
            FROM all_constraints a
            JOIN all_cons_columns acc ON acc.owner=a.owner AND acc.constraint_name=a.constraint_name
            JOIN all_constraints c_pk ON c_pk.owner=a.owner AND c_pk.constraint_name=a.r_constraint_name
            JOIN all_cons_columns acc_pk ON acc_pk.owner=c_pk.owner AND acc_pk.constraint_name=c_pk.constraint_name AND acc_pk.position=acc.position
            WHERE a.owner=:o AND a.constraint_type='R'
            ORDER BY a.table_name, a.constraint_name
            """,
            {"o": schema.upper()},
        )
        fks = [{"name": r[0], "table": r[1], "column": r[2], "ref_table": r[3], "ref_column": r[4]} for r in cur.fetchall()]
        cn.close()
        return {
            "schema": schema,
            "tables": tablas,
            "views": vistas,
            "functions": funciones,
            "indexes": [],
            "foreign_keys": fks,
        }

    raise HTTPException(400, "Motor no soportado")


@app.post("/explorer/columns")
def explorer_columns(payload: Dict[str, Any]):
    cfg = ConexionConfig(**payload.get("conexion", {}))
    schema = payload.get("schema") or ("dbo" if cfg.motor.lower() == "sqlserver" else "public")
    tabla = payload.get("table")
    if not tabla:
        raise HTTPException(400, "table es requerido")

    m = cfg.motor.lower()
    if m == "postgres":
        with conn_postgres(cfg) as cn:
            with cn.cursor() as cur:
                cur.execute(
                    """
                    SELECT
                      c.column_name,
                      c.data_type,
                      c.is_nullable,
                      c.character_maximum_length,
                      c.numeric_precision,
                      c.numeric_scale
                    FROM information_schema.columns c
                    WHERE c.table_schema=%s AND c.table_name=%s
                    ORDER BY c.ordinal_position
                    """,
                    (schema, tabla),
                )
                rows = cur.fetchall()
        return {
            "columns": [
                {
                    "name": r[0],
                    "type": r[1],
                    "nullable": r[2] == "YES",
                    "length": r[3],
                    "precision": r[4],
                    "scale": r[5],
                }
                for r in rows
            ]
        }

    if m == "sqlserver":
        cn = conn_sqlserver(cfg)
        cur = cn.cursor()
        cur.execute(
            """
            SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
            ORDER BY ORDINAL_POSITION
            """,
            (schema, tabla),
        )
        rows = cur.fetchall()
        cn.close()
        return {
            "columns": [
                {
                    "name": r[0],
                    "type": r[1],
                    "nullable": r[2] == "YES",
                    "length": r[3],
                    "precision": r[4],
                    "scale": r[5],
                }
                for r in rows
            ]
        }

    if m == "mysql":
        cn = conn_mysql(cfg)
        try:
            with cn.cursor() as cur:
                cur.execute(
                    """
                    SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, numeric_scale
                    FROM information_schema.columns
                    WHERE table_schema=%s AND table_name=%s
                    ORDER BY ordinal_position
                    """,
                    (schema, tabla),
                )
                rows = cur.fetchall()
                return {
                    "columns": [
                        {
                            "name": r["column_name"],
                            "type": r["data_type"],
                            "nullable": r["is_nullable"] == "YES",
                            "length": r["character_maximum_length"],
                            "precision": r["numeric_precision"],
                            "scale": r["numeric_scale"],
                        }
                        for r in rows
                    ]
                }
        finally:
            cn.close()

    if m == "sqlite":
        cn = conn_sqlite(cfg)
        cur = cn.cursor()
        cur.execute(f"PRAGMA table_info('{tabla}')")
        rows = cur.fetchall()
        cn.close()
        return {
            "columns": [
                {
                    "name": r[1],
                    "type": r[2],
                    "nullable": r[3] == 0,
                    "length": None,
                    "precision": None,
                    "scale": None,
                }
                for r in rows
            ]
        }

    if m == "mongodb":
        return {"columns": []}

    if m == "oracle":
        cn = conn_oracle(cfg)
        cur = cn.cursor()
        cur.execute(
            """
            SELECT column_name, data_type, nullable, data_length, data_precision, data_scale
            FROM all_tab_columns
            WHERE owner=:o AND table_name=:t
            ORDER BY column_id
            """,
            {"o": schema.upper(), "t": tabla.upper()},
        )
        rows = cur.fetchall()
        cn.close()
        return {
            "columns": [
                {
                    "name": r[0],
                    "type": r[1],
                    "nullable": r[2] == "Y",
                    "length": r[3],
                    "precision": r[4],
                    "scale": r[5],
                }
                for r in rows
            ]
        }

    raise HTTPException(400, "Motor no soportado")


# -----------------------------
# Query Tool (SELECT)
# -----------------------------

@app.post("/query")
def run_query(payload: Dict[str, Any]):
    cfg = ConexionConfig(**payload.get("conexion", {}))
    req = QueryRequest(**payload.get("request", {}))

    sql = (req.sql or "").strip()
    if not sql:
        raise HTTPException(400, "SQL vacío")

    # Permitimos SELECT y EXPLAIN (para Navicat-like)
    allowed = sql.lower().lstrip().startswith("select") or sql.lower().lstrip().startswith("with") or sql.lower().lstrip().startswith("explain")
    if not allowed:
        raise HTTPException(400, "Solo se permiten consultas SELECT/WITH/EXPLAIN por seguridad")

    m = cfg.motor.lower()
    t0 = time.time()

    if m == "postgres":
        with conn_postgres(cfg) as cn:
            with cn.cursor() as cur:
                # paginado naive
                paged = f"{sql} LIMIT {int(req.limit)} OFFSET {int((req.page-1)*req.limit)}"
                cur.execute(paged)
                cols = [d.name for d in cur.description]
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        return {"rows": rows, "page": req.page, "limit": req.limit, "ms": int((time.time()-t0)*1000)}

    if m == "sqlserver":
        cn = conn_sqlserver(cfg)
        cur = cn.cursor()
        # SQL Server OFFSET requires ORDER BY; si no hay, lo dejamos sin paginar
        final_sql = sql
        if "offset" not in sql.lower():
            # best-effort: agregar OFFSET/FETCH si hay ORDER BY
            if "order by" in sql.lower():
                final_sql = f"{sql} OFFSET {int((req.page-1)*req.limit)} ROWS FETCH NEXT {int(req.limit)} ROWS ONLY"
        cur.execute(final_sql)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        cn.close()
        return {"rows": rows, "page": req.page, "limit": req.limit, "ms": int((time.time()-t0)*1000)}

    if m == "mysql":
        cn = conn_mysql(cfg)
        try:
            with cn.cursor() as cur:
                paged = f"{sql} LIMIT {int(req.limit)} OFFSET {int((req.page-1)*req.limit)}"
                cur.execute(paged)
                rows = cur.fetchall()
                return {"rows": rows, "page": req.page, "limit": req.limit, "ms": int((time.time()-t0)*1000)}
        finally:
            cn.close()

    if m == "sqlite":
        cn = conn_sqlite(cfg)
        cur = cn.cursor()
        paged = f"{sql} LIMIT {int(req.limit)} OFFSET {int((req.page-1)*req.limit)}"
        cur.execute(paged)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        cn.close()
        return {"rows": rows, "page": req.page, "limit": req.limit, "ms": int((time.time()-t0)*1000)}

    if m == "mongodb":
        raise HTTPException(400, "MongoDB no soporta SQL en este MVP")

    if m == "oracle":
        cn = conn_oracle(cfg)
        cur = cn.cursor()
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchmany(req.limit)]
        cn.close()
        return {"rows": rows, "page": 1, "limit": req.limit, "ms": int((time.time()-t0)*1000)}

    raise HTTPException(400, "Motor no soportado")


# -----------------------------
# Monitoring (dashboard)
# -----------------------------

@app.post("/monitor/summary")
def monitor_summary(cfg: ConexionConfig):
    m = cfg.motor.lower()

    if m == "postgres":
        with conn_postgres(cfg) as cn:
            with cn.cursor() as cur:
                cur.execute("SELECT pg_database_size(current_database())")
                size = int(cur.fetchone()[0])
                cur.execute("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
                tables = int(cur.fetchone()[0])
                cur.execute("SELECT count(*) FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog','information_schema')")
                views = int(cur.fetchone()[0])
                cur.execute("SELECT count(*) FROM pg_stat_activity")
                sessions = int(cur.fetchone()[0])
        return {"db": cfg.database, "size_bytes": size, "tables": tables, "views": views, "sessions": sessions}

    if m == "sqlserver":
        cn = conn_sqlserver(cfg)
        cur = cn.cursor()
        cur.execute(
            """
            SELECT SUM(size)*8*1024 AS size_bytes FROM sys.database_files
            """
        )
        size = int(cur.fetchone()[0] or 0)
        cur.execute("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'")
        tables = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM INFORMATION_SCHEMA.VIEWS")
        views = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM sys.dm_exec_sessions")
        sessions = int(cur.fetchone()[0])
        cn.close()
        return {"db": cfg.database, "size_bytes": size, "tables": tables, "views": views, "sessions": sessions}

    if m == "mysql":
        cn = conn_mysql(cfg)
        try:
            with cn.cursor() as cur:
                cur.execute(
                    """
                    SELECT SUM(data_length+index_length) AS size_bytes
                    FROM information_schema.tables
                    WHERE table_schema=%s
                    """,
                    (cfg.database,),
                )
                size = int(cur.fetchone()["size_bytes"] or 0)
                cur.execute(
                    """
                    SELECT COUNT(*) AS c FROM information_schema.tables
                    WHERE table_schema=%s AND table_type='BASE TABLE'
                    """,
                    (cfg.database,),
                )
                tables = int(cur.fetchone()["c"])
                cur.execute(
                    """
                    SELECT COUNT(*) AS c FROM information_schema.views
                    WHERE table_schema=%s
                    """,
                    (cfg.database,),
                )
                views = int(cur.fetchone()["c"])
            return {"db": cfg.database, "size_bytes": size, "tables": tables, "views": views, "sessions": None}
        finally:
            cn.close()

    if m == "sqlite":
        path = cfg.host or cfg.database
        if not path:
            raise HTTPException(400, "SQLite: host debe ser ruta")
        size = os.path.getsize(path) if os.path.exists(path) else 0
        cn = conn_sqlite(cfg)
        cur = cn.cursor()
        cur.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        tables = int(cur.fetchone()[0])
        cur.execute("SELECT count(*) FROM sqlite_master WHERE type='view'")
        views = int(cur.fetchone()[0])
        cn.close()
        return {"db": os.path.basename(path), "size_bytes": size, "tables": tables, "views": views, "sessions": None}

    if m == "mongodb":
        client = conn_mongodb(cfg)
        db = client[cfg.database]
        stats = db.command("dbstats")
        collections = stats.get("collections")
        data_size = stats.get("dataSize")
        storage_size = stats.get("storageSize")
        client.close()
        return {
            "db": cfg.database,
            "size_bytes": int(storage_size or 0),
            "tables": int(collections or 0),
            "views": 0,
            "sessions": None,
            "extra": {"dataSize": data_size, "storageSize": storage_size},
        }

    if m == "oracle":
        cn = conn_oracle(cfg)
        cur = cn.cursor()
        # best-effort: requiere permisos
        try:
            cur.execute("SELECT SUM(bytes) FROM dba_data_files")
            size = int(cur.fetchone()[0] or 0)
        except Exception:
            size = 0
        cur.execute("SELECT COUNT(*) FROM user_tables")
        tables = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM user_views")
        views = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM v$session")
        sessions = int(cur.fetchone()[0])
        cn.close()
        return {"db": cfg.database, "size_bytes": size, "tables": tables, "views": views, "sessions": sessions}

    raise HTTPException(400, "Motor no soportado")


# -----------------------------
# Backup / Restore (por motor)
# -----------------------------

def _run_cmd(cmd: List[str], env: Optional[Dict[str, str]] = None):
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout or "").strip() or "Error ejecutando comando")
    return (p.stdout or "").strip()


@app.post("/backup/create")
def backup_create(req: BackupRequest):
    c = req.conexion
    motor = c.motor.lower()
    out = req.output_path
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    if motor == "postgres":
        env = os.environ.copy()
        env["PGPASSWORD"] = c.password
        cmd = [
            "pg_dump",
            "-h",
            c.host,
            "-p",
            str(c.port or 5432),
            "-U",
            c.user,
            "-f",
            out,
            c.database,
        ]
        if req.modo == "estructura":
            cmd.insert(1, "--schema-only")
        elif req.modo == "datos":
            cmd.insert(1, "--data-only")
        _run_cmd(cmd, env=env)
        return {"ok": True, "output": out}

    if motor == "mysql":
        if pymysql is None:
            raise HTTPException(400, "pymysql no instalado")
        env = os.environ.copy()
        env["MYSQL_PWD"] = c.password
        cmd = [
            "mysqldump",
            "-h",
            c.host,
            "-P",
            str(c.port or 3306),
            "-u",
            c.user,
        ]
        if req.modo == "estructura":
            cmd.append("--no-data")
        elif req.modo == "datos":
            cmd.append("--no-create-info")
        cmd.append(c.database)
        # redirección
        with open(out, "w", encoding="utf-8") as f:
            p = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE, text=True, env=env)
            if p.returncode != 0:
                raise HTTPException(400, (p.stderr or "").strip() or "mysqldump falló")
        return {"ok": True, "output": out}

    if motor == "sqlserver":
        # genera .bak (requiere permisos)
        # Nota: salida es .bak y se guarda en el servidor SQL Server.
        # Aquí hacemos un backup "TO DISK" en ruta local del servidor SQL Server.
        bak = out
        q = f"BACKUP DATABASE [{c.database}] TO DISK = N'{bak}' WITH INIT;"
        cmd = [
            "sqlcmd",
            "-S",
            f"{c.host},{c.port or 1433}",
            "-d",
            c.database,
            "-U",
            c.user,
            "-P",
            c.password,
            "-Q",
            q,
        ]
        _run_cmd(cmd)
        return {"ok": True, "output": bak, "note": "El archivo .bak se crea en el servidor SQL Server (ruta debe existir)."}

    if motor == "sqlite":
        src = c.host or c.database
        if not src:
            raise HTTPException(400, "SQLite: host debe ser ruta")
        shutil.copy2(src, out)
        return {"ok": True, "output": out}

    if motor == "mongodb":
        cmd = [
            "mongodump",
            "--host",
            c.host,
            "--port",
            str(c.port or 27017),
            "--db",
            c.database,
            "--out",
            out,
        ]
        if c.user:
            cmd += ["-u", c.user, "-p", c.password]
        _run_cmd(cmd)
        return {"ok": True, "output": out}

    if motor == "oracle":
        raise HTTPException(
            400,
            "Oracle expdp/impdp requiere configuración de DIRECTORY en el servidor; en este MVP se deja como guía.",
        )

    raise HTTPException(400, "Motor no soportado")


@app.post("/backup/restore")
def backup_restore(req: RestoreRequest):
    c = req.conexion
    motor = c.motor.lower()
    inp = req.input_path

    if motor == "postgres":
        env = os.environ.copy()
        env["PGPASSWORD"] = c.password
        cmd = [
            "psql",
            "-h",
            c.host,
            "-p",
            str(c.port or 5432),
            "-U",
            c.user,
            "-d",
            c.database,
            "-f",
            inp,
        ]
        _run_cmd(cmd, env=env)
        return {"ok": True}

    if motor == "mysql":
        env = os.environ.copy()
        env["MYSQL_PWD"] = c.password
        cmd = [
            "mysql",
            "-h",
            c.host,
            "-P",
            str(c.port or 3306),
            "-u",
            c.user,
            c.database,
        ]
        with open(inp, "r", encoding="utf-8", errors="ignore") as f:
            p = subprocess.run(cmd, stdin=f, stderr=subprocess.PIPE, text=True, env=env)
            if p.returncode != 0:
                raise HTTPException(400, (p.stderr or "").strip() or "restore MySQL falló")
        return {"ok": True}

    if motor == "sqlserver":
        q = f"RESTORE DATABASE [{c.database}] FROM DISK = N'{inp}' WITH REPLACE;"
        cmd = [
            "sqlcmd",
            "-S",
            f"{c.host},{c.port or 1433}",
            "-d",
            "master",
            "-U",
            c.user,
            "-P",
            c.password,
            "-Q",
            q,
        ]
        _run_cmd(cmd)
        return {"ok": True}

    if motor == "sqlite":
        dst = c.host or c.database
        if not dst:
            raise HTTPException(400, "SQLite: host debe ser ruta")
        shutil.copy2(inp, dst)
        return {"ok": True}

    if motor == "mongodb":
        cmd = [
            "mongorestore",
            "--host",
            c.host,
            "--port",
            str(c.port or 27017),
            "--db",
            c.database,
            "--drop",
            os.path.join(inp, c.database),
        ]
        if c.user:
            cmd += ["-u", c.user, "-p", c.password]
        _run_cmd(cmd)
        return {"ok": True}

    if motor == "oracle":
        raise HTTPException(400, "Oracle restore requiere impdp; se deja como guía en este MVP")

    raise HTTPException(400, "Motor no soportado")


# -----------------------------
# Migración (extendida)
# -----------------------------

def pg_type_map(src_motor: str, src_type: str) -> str:
    t = (src_type or "").lower()
    sm = src_motor.lower()

    # Normalizaciones comunes
    if t in ("int", "integer", "int4"):
        return "integer"
    if t in ("bigint", "int8"):
        return "bigint"
    if t in ("smallint", "int2"):
        return "smallint"
    if t in ("bit", "boolean", "bool"):
        return "boolean"
    if t in ("datetime", "datetime2", "smalldatetime", "timestamp", "timestamptz"):
        return "timestamp"
    if t in ("date",):
        return "date"
    if t in ("time",):
        return "time"
    if t in ("decimal", "numeric", "money", "smallmoney"):
        return "numeric"
    if t in ("float", "real", "double", "double precision"):
        return "double precision"
    if t in ("uniqueidentifier", "uuid"):
        return "uuid"
    if t in ("varbinary", "binary", "image", "blob", "bytea"):
        return "bytea"
    if "char" in t or "text" in t or "xml" in t or "clob" in t or "json" in t:
        return "text"

    # MySQL
    if sm == "mysql":
        if t in ("tinyint",):
            return "smallint"

    # SQLite
    if sm == "sqlite":
        if "int" in t:
            return "integer"
        if "real" in t or "floa" in t or "doub" in t:
            return "double precision"

    return "text"


def _columns_any(conn, motor: str, schema: str, table: str):
    m = motor.lower()
    if m == "sqlserver":
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COLUMN_NAME, DATA_TYPE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
            """,
            (schema, table),
        )
        return [(r[0], r[1]) for r in cur.fetchall()]

    if m == "postgres":
        cur = conn.cursor()
        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema=%s AND table_name=%s
            ORDER BY ordinal_position
            """,
            (schema, table),
        )
        return [(r[0], r[1]) for r in cur.fetchall()]

    if m == "mysql":
        cur = conn.cursor()
        cur.execute(
            """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema=%s AND table_name=%s
            ORDER BY ordinal_position
            """,
            (schema, table),
        )
        rows = cur.fetchall()
        return [(r["column_name"], r["data_type"]) for r in rows]

    if m == "sqlite":
        cur = conn.cursor()
        cur.execute(f"PRAGMA table_info('{table}')")
        rows = cur.fetchall()
        return [(r[1], r[2]) for r in rows]

    raise RuntimeError("Motor no soportado para columnas")


def _select_stream_any(conn, motor: str, schema: str, table: str, batch: int):
    m = motor.lower()
    if m == "sqlserver":
        cur = conn.cursor()
        cur.execute(f"SELECT * FROM [{schema}].[{table}]")
        cols = [d[0] for d in cur.description]
        while True:
            rows = cur.fetchmany(batch)
            if not rows:
                break
            yield cols, rows
        return

    if m == "postgres":
        cur = conn.cursor()
        cur.execute(f"SELECT * FROM {quote_ident_pg(schema)}.{quote_ident_pg(table)}")
        cols = [d[0] for d in cur.description]
        while True:
            rows = cur.fetchmany(batch)
            if not rows:
                break
            yield cols, rows
        return

    if m == "mysql":
        cur = conn.cursor()
        cur.execute(f"SELECT * FROM `{schema}`.`{table}`")
        cols = [d[0] for d in cur.description]
        while True:
            rows = cur.fetchmany(batch)
            if not rows:
                break
            # pymysql devuelve dict si DictCursor; convertimos a tuplas ordenadas
            if isinstance(rows[0], dict):
                tuple_rows = [tuple(r[c] for c in cols) for r in rows]
                yield cols, tuple_rows
            else:
                yield cols, rows
        return

    if m == "sqlite":
        cur = conn.cursor()
        cur.execute(f"SELECT * FROM '{table}'")
        cols = [d[0] for d in cur.description]
        while True:
            rows = cur.fetchmany(batch)
            if not rows:
                break
            yield cols, rows
        return

    raise RuntimeError("Motor no soportado para streaming")


def create_table_in_postgres(pg_cur, dest_schema: str, dest_table: str, cols, src_motor: str):
    cols_sql = []
    for col_name, data_type in cols:
        pg_type = pg_type_map(src_motor, data_type)
        cols_sql.append(f"{quote_ident_pg(col_name)} {pg_type}")
    ddl = (
        f"CREATE SCHEMA IF NOT EXISTS {quote_ident_pg(dest_schema)};\n"
        f"CREATE TABLE {quote_ident_pg(dest_schema)}.{quote_ident_pg(dest_table)} (\n  "
        + ",\n  ".join(cols_sql)
        + "\n);"
    )
    pg_cur.execute(ddl)


def drop_table_postgres(pg_cur, schema: str, table: str):
    pg_cur.execute(f"DROP TABLE IF EXISTS {quote_ident_pg(schema)}.{quote_ident_pg(table)} CASCADE")


def worker(job_id: str, req: MigrarMultipleRequest):
    state = migraciones_activas[job_id]
    state["estado"] = "ejecutando"
    state["total_tablas"] = len(req.tablas)

    try:
        src = _connect_any(req.origen)
        dst = _connect_any(req.destino)

        # MVP: destino principal postgres o mysql (2 destinos)
        if req.destino.motor.lower() not in ("postgres", "mysql"):
            raise ValueError("Destino soportado en este build: postgres | mysql")

        if req.destino.motor.lower() == "postgres":
            pg_conn = dst
            pg_cur = pg_conn.cursor()

            for t in req.tablas:
                src_schema = t.esquema_origen or ("dbo" if req.origen.motor.lower() == "sqlserver" else "public")
                dst_schema = t.esquema_destino or "public"
                src_table = t.tabla_origen
                dst_table = t.tabla_destino or t.tabla_origen

                state["tabla_actual"] = f"{src_schema}.{src_table}"

                if req.modo in ("estructura", "completo"):
                    if req.drop_if_exists:
                        drop_table_postgres(pg_cur, dst_schema, dst_table)
                        pg_conn.commit()
                    cols = _columns_any(src, req.origen.motor, src_schema, src_table)
                    create_table_in_postgres(pg_cur, dst_schema, dst_table, cols, req.origen.motor)
                    pg_conn.commit()

                if req.modo in ("datos", "completo"):
                    moved = 0
                    for cols, rows in _select_stream_any(src, req.origen.motor, src_schema, src_table, req.batch_size):
                        col_list = ",".join([quote_ident_pg(c) for c in cols])
                        placeholders = ",".join(["%s"] * len(cols))
                        insert_sql = f"INSERT INTO {quote_ident_pg(dst_schema)}.{quote_ident_pg(dst_table)} ({col_list}) VALUES ({placeholders})"
                        pg_cur.executemany(insert_sql, rows)
                        pg_conn.commit()
                        moved += len(rows)
                        state["registros_migrados"] += len(rows)

                state["tablas_migradas"] += 1

            state["estado"] = "completado"
            try:
                src.close()
            except Exception:
                pass
            try:
                dst.close()
            except Exception:
                pass
            return

        # Postgres -> MySQL (best-effort)
        if req.destino.motor.lower() == "mysql":
            if pymysql is None:
                raise ValueError("pymysql no instalado")

            mysql_conn = dst
            mysql_cur = mysql_conn.cursor()

            for t in req.tablas:
                src_schema = t.esquema_origen or ("public" if req.origen.motor.lower() == "postgres" else "dbo")
                src_table = t.tabla_origen
                dst_schema = req.destino.database
                dst_table = t.tabla_destino or t.tabla_origen

                state["tabla_actual"] = f"{src_schema}.{src_table}"

                cols = _columns_any(src, req.origen.motor, src_schema, src_table)

                if req.modo in ("estructura", "completo"):
                    # create table simplistic
                    defs = []
                    for col_name, typ in cols:
                        # map postgres types to mysql
                        lt = (typ or "").lower()
                        if "int" in lt:
                            mt = "BIGINT" if "big" in lt else "INT"
                        elif "bool" in lt:
                            mt = "TINYINT(1)"
                        elif "date" in lt and "time" not in lt:
                            mt = "DATE"
                        elif "time" in lt:
                            mt = "DATETIME"
                        else:
                            mt = "TEXT"
                        defs.append(f"`{col_name}` {mt}")
                    mysql_cur.execute(f"CREATE TABLE IF NOT EXISTS `{dst_table}` (" + ",".join(defs) + ")")
                    mysql_conn.commit()

                if req.modo in ("datos", "completo"):
                    moved = 0
                    for cols2, rows in _select_stream_any(src, req.origen.motor, src_schema, src_table, req.batch_size):
                        col_list = ",".join([f"`{c}`" for c in cols2])
                        ph = ",".join(["%s"] * len(cols2))
                        sql = f"INSERT INTO `{dst_table}` ({col_list}) VALUES ({ph})"
                        mysql_cur.executemany(sql, rows)
                        mysql_conn.commit()
                        moved += len(rows)
                        state["registros_migrados"] += len(rows)

                state["tablas_migradas"] += 1

            state["estado"] = "completado"
            try:
                src.close()
            except Exception:
                pass
            try:
                dst.close()
            except Exception:
                pass
            return

    except Exception as e:
        state["estado"] = "fallido"
        state["error"] = str(e)

    finally:
        state["fin"] = True


@app.post("/migrar-multiple")
def migrar_multiple(req: MigrarMultipleRequest):
    job_id = str(uuid.uuid4())
    migraciones_activas[job_id] = {
        "job_id": job_id,
        "estado": "pendiente",
        "tabla_actual": None,
        "total_tablas": len(req.tablas),
        "tablas_migradas": 0,
        "registros_migrados": 0,
        "error": None,
        "fin": False,
    }

    t = threading.Thread(target=worker, args=(job_id, req), daemon=True)
    t.start()

    return {"ok": True, "job_id": job_id}


@app.get("/progreso/{job_id}")
def progreso(job_id: str):
    if job_id not in migraciones_activas:
        raise HTTPException(404, "Job no encontrado")
    return migraciones_activas[job_id]
