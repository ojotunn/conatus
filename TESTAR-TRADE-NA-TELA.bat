@echo off
title Teste do trade na tela
cd /d "%~dp0"

rem ============================================================================
rem  Testa o TRADE NA TELA: o agente conecta a carteira na pump.fun, digita o
rem  valor e clica em comprar — ao vivo, do jeito que o espectador vai ver.
rem
rem  NAO precisa da arena rodando. Isto e um teste isolado, sem LLM, sem gastar
rem  credito de API. Gasta so o dinheiro do trade (padrao ~$1 da carteira da
rem  Sable, que tem ~$42).
rem ============================================================================

rem ---- Acha o Node mesmo se o PATH nao atualizou ----
where node >nul 2>nul
if not errorlevel 1 goto nodeok
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
where node >nul 2>nul
if not errorlevel 1 goto nodeok
echo.
echo  Node.js nao encontrado. Instale em https://nodejs.org e tente de novo.
echo.
pause
exit /b 1
:nodeok

echo.
echo  ============================================================
echo   TESTE DO TRADE NA TELA
echo  ============================================================
echo.
echo   Escolha:
echo.
echo     [1]  ENSAIO   - abre a pagina e conecta a carteira, NAO compra
echo     [2]  COMPRAR  - vale dinheiro de verdade (~$1)
echo     [3]  COMPRAR  - valor menor ($0.30)
echo.
set /p ESCOLHA="  Digite 1, 2 ou 3 e aperte Enter: "

echo.
if "%ESCOLHA%"=="1" (
  node scripts/teste-trade-tela.js
) else if "%ESCOLHA%"=="2" (
  node scripts/teste-trade-tela.js --live
) else if "%ESCOLHA%"=="3" (
  node scripts/teste-trade-tela.js --live 0.3
) else (
  echo   Opcao invalida.
)

echo.
echo  ============================================================
echo   Terminou. Copie o texto acima e mande pro Claude.
echo  ============================================================
echo.
pause
