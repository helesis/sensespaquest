@echo off
REM Sense Spa Quest: Node sunucusu + Edge/Chrome tam ekran kiosk
REM Farkli port: set PORT=8080 && start.bat  (.env icindeki PORT ile ayni olmali)
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js bulunamadi. Lutfen https://nodejs.org adresinden kurun.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo package.json bulunamadi. Bu dosyayi proje kokunde calistirin.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Ilk kurulum: npm install calistiriliyor...
  call npm install
  if errorlevel 1 (
    echo npm install basarisiz.
    pause
    exit /b 1
  )
)

if not defined PORT set "PORT=3000"
set "URL=http://127.0.0.1:%PORT%/"

echo Sense Spa Quest sunucusu ayri pencerede baslatiliyor...
start "SpaWarrior Server" /D "%~dp0" cmd /k "npm start"

echo Sunucunun ayaga kalkmasi bekleniyor...
timeout /t 5 /nobreak >nul

set "BROWSER="
set "BKIND="
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  set "BKIND=edge"
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  set "BKIND=edge"
) else if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  set "BKIND=chrome"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
  set "BKIND=chrome"
)

if defined BROWSER (
  echo Kiosk modu: %URL%
  if /I "%BKIND%"=="edge" (
    start "" "%BROWSER%" --kiosk "%URL%" --edge-kiosk-type=fullscreen --no-first-run
  ) else (
    start "" "%BROWSER%" --kiosk "%URL%" --no-first-run
  )
) else (
  echo Edge/Chrome bulunamadi. Varsayilan tarayicide aciliyor: %URL%
  start "" "%URL%"
)

echo.
echo Kiosk: genelde Alt+F4 veya cihaz kiosk cikis tusu ile kapanir.
echo Sunucuyu durdurmak icin "SpaWarrior Server" baslikli CMD penceresini kapatin.
endlocal
