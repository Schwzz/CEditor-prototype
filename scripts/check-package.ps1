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
        # The window title is renderer-attested: the renderer reports its
        # stage only after its module is fully wired, and only then does the
        # main process apply a title. The Home screen titles the window
        # exactly "Framecode"; the editor appends the document name, so its
        # title ends with " — Framecode". Any other title (including
        # Electron's pre-boot default) means the renderer never came up.
        $title = $process.MainWindowTitle
        if ($process.MainWindowHandle -ne 0 -and
            ($title -eq 'Framecode' -or $title.EndsWith(' — Framecode'))) {
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
