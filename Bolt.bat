@echo off
title Bolt
cd /d "%~dp0"

REM This launched `npx http-server` until 2026-09-01, which serves the static
REM files and nothing else. Every proxied path — /finnhub, /sec, /anthropic —
REM 404s under it, so the board came up empty with no explanation. The server
REM is serve.mjs; see docs/NOTES.md.

REM The Finnhub key lives on the server now, never in the browser.
if "%FINNHUB_API_KEY%"=="" (
  echo.
  echo   FINNHUB_API_KEY is not set, so the board will load no data.
  echo   Set it once with:   setx FINNHUB_API_KEY "your-key"
  echo   then close this window and start Bolt again.
  echo.
)

REM Port 8080 only, deliberately. localStorage and IndexedDB are keyed by
REM origin, so every cached price, analyst trend and consensus snapshot lives
REM under http://localhost:8080 — walking to 8081 hands you an empty board that
REM looks like data loss. It also made every startup failure read as a port
REM conflict on the last port tried. If 8080 is taken, free it.
set NODE_EXE=node
where node >nul 2>nul || set NODE_EXE="%ProgramFiles%\nodejs\node.exe"

start "" http://localhost:8080
%NODE_EXE% serve.mjs 8080

echo.
echo   The server stopped. The lines above are the real reason — if it never
echo   started, they are the error, not a port problem.
echo.
pause
