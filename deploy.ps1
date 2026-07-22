# Déploie le module spell-template-bar vers le share Foundry.
# Usage :  pwsh ./deploy.ps1     (ou clic droit > Exécuter avec PowerShell)
$src  = Join-Path $PSScriptRoot "spell-template-bar"
$dest = "\\192.168.68.59\foundryuserdata\Data\modules\spell-template-bar"

if (-not (Test-Path $dest)) { throw "Share inaccessible : $dest" }

# Miroir : copie les fichiers du module, écrase l'ancien.
robocopy $src $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Echec robocopy (code $LASTEXITCODE)" }

Write-Host "Deploye -> $dest" -ForegroundColor Green
Write-Host "Recharge Foundry (F5) pour prendre les changements." -ForegroundColor Cyan
