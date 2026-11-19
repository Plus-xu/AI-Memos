#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$SourceDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $SourceDirectory).ProviderPath.TrimEnd([char[]]'\/')
$taskComparison = [System.StringComparison]::OrdinalIgnoreCase

function Get-SafeSourcePath([string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        [System.IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath -match '[:?#]' -or
        $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Unsafe extension resource path: $RelativePath"
    }
    $taskFullPath = [System.IO.Path]::GetFullPath((Join-Path $taskRoot $RelativePath))
    if (-not $taskFullPath.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar, $taskComparison)) {
        throw "Extension resource escaped the source directory: $RelativePath"
    }
    return $taskFullPath
}

function Assert-NoLink([string]$LiteralPath) {
    $taskItem = Get-Item -LiteralPath $LiteralPath -Force
    while ($null -ne $taskItem) {
        if ($taskItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw "Linked files or directories cannot be packaged: $($taskItem.FullName)"
        }
        $taskItem = if ($taskItem -is [System.IO.DirectoryInfo]) { $taskItem.Parent } else { $taskItem.Directory }
    }
}

Assert-NoLink $taskRoot
$taskCandidates = [System.Collections.Generic.List[string]]::new()
foreach ($taskRootFile in @('manifest.json', 'popup.html', 'panel.html', 'options.html')) {
    $taskFilePath = Get-SafeSourcePath $taskRootFile
    if (-not (Test-Path -LiteralPath $taskFilePath -PathType Leaf)) { throw "Missing extension file: $taskRootFile" }
    Assert-NoLink $taskFilePath
    $taskCandidates.Add($taskRootFile)
}

# A runtime allowlist excludes source maps, backups, environment files, credential
# exports, metadata, tests, and build tools, even when they sit under a runtime directory.
foreach ($taskDirectory in @('js', 'css', 'assets', '_locales')) {
    $taskDirectoryPath = Get-SafeSourcePath $taskDirectory
    if (-not (Test-Path -LiteralPath $taskDirectoryPath -PathType Container)) { throw "Missing runtime directory: $taskDirectory" }
    Assert-NoLink $taskDirectoryPath
    foreach ($taskItem in Get-ChildItem -LiteralPath $taskDirectoryPath -Recurse -Force) {
        Assert-NoLink $taskItem.FullName
        if ($taskItem.PSIsContainer) { continue }
        $taskRelative = [System.IO.Path]::GetRelativePath($taskRoot, $taskItem.FullName).Replace('\', '/')
        $taskAllowed = switch ($taskDirectory) {
            'js' { $taskRelative -match '^js/(?:[^./][^/]*/)*[^./][^/]*\.js$' }
            'css' { $taskRelative -match '^css/(?:[^./][^/]*/)*[^./][^/]*\.css$' }
            'assets' { $taskRelative -match '^assets/(?:[^./][^/]*/)*[^./][^/]*\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$' }
            '_locales' { $taskRelative -match '^_locales/[^./][^/]*/messages\.json$' }
        }
        if ($taskAllowed) { $taskCandidates.Add($taskRelative) }
    }
}

$taskFiles = @($taskCandidates | Sort-Object -Unique)
$taskFileSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($taskFile in $taskFiles) {
    [void]$taskFileSet.Add($taskFile)
    if ($taskFile.EndsWith('.json', [System.StringComparison]::OrdinalIgnoreCase)) {
        Get-Content -LiteralPath (Get-SafeSourcePath $taskFile) -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable | Out-Null
    }
}

$taskManifest = Get-Content -LiteralPath (Get-SafeSourcePath 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
$taskVersion = $taskManifest.version
if ($taskVersion -isnot [string] -or $taskVersion -notmatch '^(?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){0,3}$') {
    throw 'manifest.version must contain one to four integers without leading zeros.'
}
$taskVersionParts = @($taskVersion.Split('.') | ForEach-Object { [int]$_ })
if (@($taskVersionParts | Where-Object { $_ -gt 65535 }).Count -or
    @($taskVersionParts | Where-Object { $_ -ne 0 }).Count -eq 0) {
    throw 'manifest.version components must be in 0..65535 and must not all be zero.'
}
if ($taskManifest.manifest_version -ne 3) { throw 'This packager expects a Manifest V3 extension.' }

function Assert-PackagedResource([string]$Resource, [string]$Context = '') {
    if ([string]::IsNullOrWhiteSpace($Resource)) { throw "Empty resource reference in $Context" }
    $taskResourcePath = Get-SafeSourcePath $Resource
    $taskNormalized = [System.IO.Path]::GetRelativePath($taskRoot, $taskResourcePath).Replace('\', '/')
    if (-not $taskFileSet.Contains($taskNormalized)) {
        throw "Referenced resource is missing or outside the runtime allowlist: $Resource ($Context)"
    }
}

function Assert-Icons($Icons, [string]$Context) {
    if ($Icons -is [string]) { Assert-PackagedResource $Icons $Context }
    elseif ($Icons -is [System.Collections.IDictionary]) {
        foreach ($taskIcon in $Icons.Values) { Assert-PackagedResource $taskIcon $Context }
    }
}

Assert-PackagedResource $taskManifest.background.service_worker 'background.service_worker'
Assert-PackagedResource $taskManifest.action.default_popup 'action.default_popup'
Assert-Icons $taskManifest.icons 'icons'
if ($taskManifest.action.default_icon) { Assert-Icons $taskManifest.action.default_icon 'action.default_icon' }
if ($taskManifest.options_page) { Assert-PackagedResource $taskManifest.options_page 'options_page' }
if ($taskManifest.options_ui.page) { Assert-PackagedResource $taskManifest.options_ui.page 'options_ui.page' }
if ($taskManifest.side_panel.default_path) { Assert-PackagedResource $taskManifest.side_panel.default_path 'side_panel.default_path' }
foreach ($taskContentScript in $taskManifest.content_scripts) {
    foreach ($taskResource in @($taskContentScript.js) + @($taskContentScript.css)) {
        if ($taskResource) { Assert-PackagedResource $taskResource 'content_scripts' }
    }
}
if ($taskManifest.default_locale) {
    Assert-PackagedResource ('_locales/' + $taskManifest.default_locale + '/messages.json') 'default_locale'
}

foreach ($taskPage in @('popup.html','options.html','panel.html')) {
    $taskHtml = Get-Content -LiteralPath (Get-SafeSourcePath $taskPage) -Raw -Encoding utf8
    foreach ($taskReference in [regex]::Matches($taskHtml, '(?i)\b(?:src|href)\s*=\s*["'']([^"'']+)["'']')) {
        $taskResource = $taskReference.Groups[1].Value
        if (-not $taskResource.StartsWith('#')) { Assert-PackagedResource $taskResource $taskPage }
    }
}
foreach ($taskInjected in @('js/vendor/clipper-libraries.js','js/page-capture.js')) {
    Assert-PackagedResource $taskInjected 'user-initiated capture'
}

# CSS dependencies are resolved relative to the stylesheet instead of the root.
foreach ($taskCssFile in $taskFiles | Where-Object { $_.EndsWith('.css') }) {
    $taskCssText = Get-Content -LiteralPath (Get-SafeSourcePath $taskCssFile) -Raw -Encoding utf8
    foreach ($taskReference in [regex]::Matches($taskCssText, '(?i)url\(\s*["'']?([^"'')\s]+)["'']?\s*\)')) {
        $taskResource = $taskReference.Groups[1].Value
        if ($taskResource.StartsWith('#') -or $taskResource.StartsWith('data:', [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $taskCssDependency = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent (Get-SafeSourcePath $taskCssFile)) $taskResource))
        if (-not $taskCssDependency.StartsWith($taskRoot + [System.IO.Path]::DirectorySeparatorChar, $taskComparison)) {
            throw "CSS dependency escaped the source directory: $taskResource"
        }
        Assert-PackagedResource ([System.IO.Path]::GetRelativePath($taskRoot, $taskCssDependency)) $taskCssFile
    }
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $taskRoot 'artifacts' }
elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory = Join-Path $taskRoot $OutputDirectory }
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory).TrimEnd([char[]]'\/')
foreach ($taskDirectory in @('js', 'css', 'assets', '_locales')) {
    $taskRuntimePath = Get-SafeSourcePath $taskDirectory
    if ($taskOutput.Equals($taskRuntimePath, $taskComparison) -or
        $taskOutput.StartsWith($taskRuntimePath + [System.IO.Path]::DirectorySeparatorChar, $taskComparison)) {
        throw 'Packages must be written outside runtime directories.'
    }
}
$taskExistingOutputParent = $taskOutput
while (-not (Test-Path -LiteralPath $taskExistingOutputParent)) { $taskExistingOutputParent = Split-Path -Parent $taskExistingOutputParent }
Assert-NoLink $taskExistingOutputParent
if (-not (Test-Path -LiteralPath $taskOutput -PathType Container)) { New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null }
Assert-NoLink $taskOutput
$taskPackageName = 'ai-memos-' + $taskVersion + '.zip'
$taskPackage = Join-Path $taskOutput $taskPackageName
$taskChecksum = $taskPackage + '.sha256'
$taskStaging = Join-Path $taskOutput ('.ai-memos-' + [System.Guid]::NewGuid().ToString('N') + '.tmp')
foreach ($taskDestination in @($taskPackage, $taskChecksum)) {
    if (Test-Path -LiteralPath $taskDestination) { Assert-NoLink $taskDestination }
}
$taskExpectedHashes = @{}
foreach ($taskFile in $taskFiles) { $taskExpectedHashes[$taskFile] = (Get-FileHash -LiteralPath (Get-SafeSourcePath $taskFile) -Algorithm SHA256).Hash }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskStream = [System.IO.File]::Open($taskStaging, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
    $taskArchive = [System.IO.Compression.ZipArchive]::new($taskStream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($taskFile in $taskFiles) {
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $taskArchive, (Get-SafeSourcePath $taskFile), $taskFile, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $taskArchive.Dispose() }
} finally { $taskStream.Dispose() }

$taskVerification = [System.IO.Compression.ZipFile]::OpenRead($taskStaging)
try {
    if ($taskVerification.Entries.Count -ne $taskFiles.Count) { throw 'Archive file count does not match the validated runtime inventory.' }
    foreach ($taskEntry in $taskVerification.Entries) {
        if (-not $taskFileSet.Contains($taskEntry.FullName)) { throw "Unexpected archive entry: $($taskEntry.FullName)" }
        $taskEntryStream = $taskEntry.Open()
        $taskHasher = [System.Security.Cryptography.SHA256]::Create()
        try { $taskEntryHash = ([System.BitConverter]::ToString($taskHasher.ComputeHash($taskEntryStream))).Replace('-', '') }
        finally { $taskHasher.Dispose(); $taskEntryStream.Dispose() }
        if ($taskEntryHash -ne $taskExpectedHashes[$taskEntry.FullName]) { throw "Runtime file changed while packaging: $($taskEntry.FullName)" }
    }
    $taskManifestReader = [System.IO.StreamReader]::new($taskVerification.GetEntry('manifest.json').Open(), [System.Text.Encoding]::UTF8)
    try { $taskPackagedManifest = $taskManifestReader.ReadToEnd() | ConvertFrom-Json -AsHashtable }
    finally { $taskManifestReader.Dispose() }
    if ($taskPackagedManifest.version -ne $taskVersion) { throw 'manifest.version changed while packaging; retry after source edits finish.' }
} finally { $taskVerification.Dispose() }

# The staged file and both final destinations are direct children of the checked
# output directory. Move only this generated file; never move or delete a tree.
Move-Item -LiteralPath $taskStaging -Destination $taskPackage -Force
$taskHash = (Get-FileHash -LiteralPath $taskPackage -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($taskChecksum, $taskHash + '  ' + $taskPackageName + "`n", [System.Text.UTF8Encoding]::new($false))

[pscustomobject][ordered]@{
    Version = $taskVersion
    PackagePath = $taskPackage
    ChecksumPath = $taskChecksum
    FileCount = $taskFiles.Count
    SHA256 = $taskHash
}
