# Workaround for a mismatch between vitest.extensions.config.ts's CLI-arg
# include-narrowing (test/vitest/vitest.pattern-file.ts) and vitest's own
# positional-arg filter: the config sets `dir: "extensions"`, so the include
# glob is correctly relativized (drops the "extensions/" prefix), but vitest's
# own CLI filter still compares against the same dir-relative file ids while
# `pnpm test:extension <name>` (and any manually typed CLI target) supplies a
# root-relative string. No single literal string satisfies both comparisons,
# so a single extension's tests silently collect zero files ("No test files
# found, exiting with code 0"). This bypasses both mechanisms by setting the
# include glob via OPENCLAW_VITEST_INCLUDE_FILE and passing NO positional arg.
#
# Usage: ./scripts/run-extension-tests-workaround.ps1 -ExtensionId dragon-task-orchestrator

param(
    [string]$ExtensionId = "dragon-task-orchestrator",
    [string]$Config = "test/vitest/vitest.extensions.config.ts"
)

$ErrorActionPreference = "Stop"

$repoRoot = git rev-parse --show-toplevel
Set-Location $repoRoot

$artifactsDir = Join-Path $repoRoot ".artifacts"
New-Item -ItemType Directory -Force -Path $artifactsDir | Out-Null

$pattern = "extensions/$ExtensionId/**/*.test.ts"
$includeFile = Join-Path $artifactsDir "vitest-include-$ExtensionId.json"
# Written by hand (not ConvertTo-Json) to avoid its single-element-array
# unwrapping and BOM quirks on Windows PowerShell 5.1 — both would make the
# JSON.parse on the Node side either fail or silently not be an array.
Set-Content -Path $includeFile -Value "[`"$pattern`"]" -Encoding ascii -NoNewline

Write-Host "Include pattern: $pattern"
Write-Host "Include file:    $includeFile"

$env:OPENCLAW_VITEST_INCLUDE_FILE = $includeFile
try {
    pnpm exec vitest run --config $Config
    $exitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:\OPENCLAW_VITEST_INCLUDE_FILE -ErrorAction SilentlyContinue
    Remove-Item -Path $includeFile -ErrorAction SilentlyContinue
}

exit $exitCode
