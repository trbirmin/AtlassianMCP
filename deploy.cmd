@echo off
echo ===== Deployment starting =====

:: Setup
echo Setting up the environment...
call :ExecuteCmd npm ci

:: Build the TypeScript application
echo Building the TypeScript application...
call :ExecuteCmd npm run build

:: If %ERRORLEVEL% NEQ 0 goto error

:: Post-deployment step
echo ===== Deployment completed =====
goto end

::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: Helper function to execute a command and return its exit code
:ExecuteCmd
setlocal
set _CMD_=%*
call %_CMD_%
if "%ERRORLEVEL%" NEQ "0" (
  echo Failed to execute: %_CMD_%
  exit /b 1
)
exit /b 0

:error
echo An error has occurred during deployment.
exit /b 1

:end
echo Deployment finished successfully.
