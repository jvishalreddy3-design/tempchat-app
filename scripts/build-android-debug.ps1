$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)

$javaCandidates = @()
if ($env:JAVA_HOME) { $javaCandidates += $env:JAVA_HOME }
if ($localAppData) { $javaCandidates += (Join-Path $localAppData 'Temp\tempchat-android-tools\jdk-21.0.12.1+1') }
if ($programFiles) { $javaCandidates += (Join-Path $programFiles 'Android\Android Studio\jbr') }
$javaHome = $javaCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
if (-not $javaHome) { throw 'No JDK was found. Install Android Studio or set JAVA_HOME to a compatible JDK.' }

$sdkCandidates = @()
if ($env:ANDROID_HOME) { $sdkCandidates += $env:ANDROID_HOME }
if ($env:ANDROID_SDK_ROOT) { $sdkCandidates += $env:ANDROID_SDK_ROOT }
if ($localAppData) { $sdkCandidates += (Join-Path $localAppData 'Android\Sdk') }
$androidSdk = $sdkCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'platform-tools\adb.exe') } | Select-Object -First 1
if (-not $androidSdk) { throw 'No Android SDK was found. Set ANDROID_HOME or install the Android SDK.' }

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $androidSdk
$env:ANDROID_SDK_ROOT = $androidSdk

Push-Location $workspaceRoot
try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend packaging failed.' }

    & npx cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor Android sync failed.' }

    & node scripts/materialize-android-assets.js
    if ($LASTEXITCODE -ne 0) { throw 'Preparing Android assets failed.' }

    Push-Location (Join-Path $workspaceRoot 'android')
    try {
        & .\gradlew.bat -I ..\scripts\isolated-android-build.gradle assembleDebug --no-daemon
        if ($LASTEXITCODE -ne 0) { throw 'Gradle assembleDebug failed.' }
    } finally {
        Pop-Location
    }

    $buildTemp = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
    $apk = Join-Path $buildTemp 'tempchat-android-build\_app\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw "Gradle reported success but the APK is missing: $apk" }
    $deliverable = Join-Path $workspaceRoot 'TempChat-debug.apk'
    Copy-Item -LiteralPath $apk -Destination $deliverable -Force
    Get-Item -LiteralPath $deliverable | Select-Object FullName, Length, LastWriteTime
} finally {
    Pop-Location
}
