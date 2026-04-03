@echo off
setlocal enabledelayedexpansion

REM =====================================================
REM NexoraDB Studio - Arranque 1-click (Windows)
REM Requisitos: Node 18+, Python 3.10+, Docker Desktop
REM =====================================================

cd /d %~dp0

echo ==============================================
echo NexoraDB Studio - preparando entorno...
echo ==============================================

echo [1/6] Iniciando Meta-DB (Docker)...
docker compose up -d
if errorlevel 1 (
  echo.
  echo [ERROR] No se pudo iniciar Docker.
  echo - Instala Docker Desktop y vuelve a ejecutar.
  echo - Sin Meta-DB, el API no podra guardar conexiones.
  echo.
  pause
  exit /b 1
)

REM --- Engine venv ---
if not exist "apps\engine\venv" (
  echo [2/6] Creando venv para Engine...
  cd /d "%~dp0apps\engine"
  python -m venv venv
) else (
  echo [2/6] venv ya existe (Engine).
)

cd /d "%~dp0apps\engine"
call venv\Scripts\activate

echo [3/6] Instalando dependencias Python (Engine)...
pip install --upgrade pip >nul
pip install -r requirements.txt
echo [3.1/6] Intentando instalar pyodbc (opcional para SQL Server/Access)...
pip install pyodbc >nul 2>nul
if errorlevel 1 (
  echo [WARN] pyodbc no se pudo instalar automaticamente.
  echo        Si usaras SQL Server/Access, instala ODBC Driver + Build Tools y luego: pip install pyodbc
)

deactivate

REM --- API deps ---
cd /d "%~dp0apps\api"
if not exist "node_modules" (
  echo [4/6] Instalando dependencias Node (API)...
  npm install
) else (
  echo [4/6] node_modules ya existe (API).
)

REM --- Desktop deps ---
cd /d "%~dp0apps\desktop"
if not exist "node_modules" (
  echo [5/6] Instalando dependencias Node (Desktop)...
  npm install
) else (
  echo [5/6] node_modules ya existe (Desktop).
)

echo [6/6] Iniciando NexoraDB Studio (Electron)...
set NEXORA_PYTHON=python
npm run dev

endlocal
