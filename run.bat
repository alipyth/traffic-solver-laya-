@echo off
setlocal
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker was not found. Install Docker Desktop first.
  pause
  exit /b 1
)
docker compose up --build -d
if errorlevel 1 (
  echo Failed to start Traffic AI Lab.
  pause
  exit /b 1
)
echo.
echo Traffic AI Lab is starting at http://localhost:8000
echo First Laya inference may download/load the model.
start http://localhost:8000
