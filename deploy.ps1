# Déploie les modules locaux vers le share Foundry.
# Usage :  pwsh ./deploy.ps1                          (déploie tous les modules listés)
#          pwsh ./deploy.ps1 arthaks-table-suite      (déploie un seul module)
param([string[]]$Modules)

$root    = $PSScriptRoot
$destDir = "\\192.168.68.59\foundryuserdata\Data\modules"

# Modules du repo à déployer (dossiers contenant un module.json).
$all = @("arthaks-table-suite")
if (-not $Modules -or $Modules.Count -eq 0) { $Modules = $all }

if (-not (Test-Path $destDir)) { throw "Share inaccessible : $destDir" }

foreach ($m in $Modules) {
    $src  = Join-Path (Join-Path $root "modules") $m
    $dest = Join-Path $destDir $m
    if (-not (Test-Path (Join-Path $src "module.json"))) { throw "Module introuvable : $src" }

    # Miroir : copie les fichiers du module, écrase l'ancien.
    robocopy $src $dest /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Echec robocopy pour $m (code $LASTEXITCODE)" }

    Write-Host "Deploye -> $dest" -ForegroundColor Green
}

Write-Host "Recharge Foundry (F5) pour prendre les changements." -ForegroundColor Cyan

# robocopy renvoie 1 (fichiers copiés) = succès ; ne pas propager comme échec.
exit 0
