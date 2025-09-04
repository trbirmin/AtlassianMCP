@echo off
echo Node version:
node -v
echo NPM version:
npm -v
echo Current directory: %cd%
echo Directory listing:
dir

echo Installing dependencies...
call npm ci

echo Building TypeScript...
call npm run build

echo Starting server...
npm start
