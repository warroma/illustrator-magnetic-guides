# Ponte COM persistente para o Illustrator (usada pelo CLI em Node).
# Protocolo: uma linha por pedido no stdin = código ExtendScript em base64
# (UTF-8). Resposta: "OK:<base64>" ou "ERR:<base64>" numa linha no stdout.
# Mantém um único objeto COM vivo — cada chamada custa só a execução do
# script, sem reabrir a conexão.
$ErrorActionPreference = "Stop"
$ai = New-Object -ComObject Illustrator.Application
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = [Console]::In
$stdout = [Console]::Out
$stdout.WriteLine("READY")
$stdout.Flush()
while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Length -eq 0) { continue }
    try {
        $code = $utf8.GetString([System.Convert]::FromBase64String($line))
        $r = $ai.DoJavaScript($code)
        if ($null -eq $r) { $r = "" }
        $out = "OK:" + [System.Convert]::ToBase64String($utf8.GetBytes([string]$r))
    }
    catch {
        $out = "ERR:" + [System.Convert]::ToBase64String($utf8.GetBytes($_.Exception.Message))
    }
    $stdout.WriteLine($out)
    $stdout.Flush()
}
