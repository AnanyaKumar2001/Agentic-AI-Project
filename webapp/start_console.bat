@echo off
rem Starts the CDR & IPDR Agent Console and opens it in the browser.
cd /d "%~dp0.."

set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

"%PY%" -c "import flask" 2>nul || (
  echo Installing requirements...
  "%PY%" -m pip install -r requirements.txt || goto :error
)

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:5050"
"%PY%" webapp\app.py
goto :eof

:error
echo Could not install requirements. See README.md.
pause
