# Roda um arquivo .jsx no Illustrator aberto (via COM) e imprime o retorno.
# Uso: powershell -File tools/run-jsx.ps1 caminho/do/script.jsx
param([Parameter(Mandatory = $true)][string]$Path)
$ai = New-Object -ComObject Illustrator.Application
$code = [System.IO.File]::ReadAllText((Resolve-Path $Path), [System.Text.Encoding]::UTF8)
$ai.DoJavaScript($code)
