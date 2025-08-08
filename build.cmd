@echo off
setlocal

echo.
echo === SQL Wayfarer Extension Build Script ===
echo.

:: Step 0: Check for VSCE
where vsce >nul 2>&1
IF ERRORLEVEL 1 (
    echo [ERROR] vsce is not installed. Run: npm install -g @vscode/vsce
    pause
    exit /b 1
)

echo [1/6] Cleaning existing build artifacts...
del /q *.vsix 2>nul
echo - Removed previous .vsix files if any

echo [2/6] Removing node_modules and lock files...
rd /s /q node_modules 2>nul
del /q package-lock.json 2>nul
echo - Removed node_modules and package-lock.json

echo [3/6] Installing all dependencies (dev + prod)...
call npm install
IF ERRORLEVEL 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)
echo - Dependencies installed successfully

echo [4/6] Building with webpack...
call npx webpack --mode production
IF ERRORLEVEL 1 (
    echo [ERROR] Webpack build failed.
    pause
    exit /b 1
)
echo - Webpack build successful

echo [5/6] Pruning node_modules to production only...
timeout /t 3 /nobreak >nul
call npm prune --omit=dev
IF ERRORLEVEL 1 (
    echo [WARN] npm prune failed — forcing clean reinstall of production deps...
    timeout /t 2 /nobreak >nul
    rd /s /q node_modules
    timeout /t 1 /nobreak >nul
    call npm install --omit=dev
)
echo - Dev dependencies removed, node_modules is now production-only

echo [6/6] Creating VSIX package...
call vsce package
IF ERRORLEVEL 1 (
    echo [ERROR] Failed to create VSIX package.
    pause
    exit /b 1
)
echo - VSIX package created successfully

echo.
echo Generated package:
dir /b *.vsix 2>nul
echo.
echo You can now install this extension with:
echo   code --install-extension [filename].vsix

echo.
pause
