$ErrorActionPreference = 'Stop'
$executable = Join-Path $PWD 'release/win-unpacked/Framecode.exe'
if (!(Test-Path $executable)) { throw 'Packaged Framecode.exe was not produced.' }
$process = Start-Process -FilePath $executable -PassThru
try {
    $opened = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        $process.Refresh()
        if ($process.HasExited) { throw "Packaged Framecode exited with code $($process.ExitCode)." }
        if ($process.MainWindowHandle -ne 0 -and $process.MainWindowTitle.EndsWith(' — Framecode')) {
            $opened = $true
            break
        }
    }
    if (!$opened) { throw 'The packaged app did not open its initialized desktop window.' }
    Write-Output "Packaged Windows app opened: $($process.MainWindowTitle)"
    if (!$process.CloseMainWindow()) { throw 'The packaged window did not accept Close.' }
    if (!$process.WaitForExit(5000)) { throw 'The packaged app did not shut down after its window closed.' }
    if ($process.ExitCode -ne 0) { throw "The packaged app exited with code $($process.ExitCode)." }
    Write-Output 'Packaged Windows app shut down cleanly.'
} finally {
    if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
}
