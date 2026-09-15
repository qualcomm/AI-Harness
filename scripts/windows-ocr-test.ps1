param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ImagePath)) {
    Write-Error "Image not found: $ImagePath"
    exit 1
}

$fullPath = (Resolve-Path $ImagePath).ProviderPath

$winmdDir = Join-Path $env:WINDIR "System32\WinMetadata"

$csharp = @'
using System;
using System.Linq;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

public static class OcrHelper
{
    public static string Recognize(string path)
    {
        StorageFile file = StorageFile.GetFileFromPathAsync(path).AsTask().Result;
        using (IRandomAccessStream stream = file.OpenAsync(FileAccessMode.Read).AsTask().Result)
        {
            BitmapDecoder decoder = BitmapDecoder.CreateAsync(stream).AsTask().Result;
            SoftwareBitmap bitmap = decoder.GetSoftwareBitmapAsync().AsTask().Result;
            OcrEngine engine = OcrEngine.TryCreateFromUserProfileLanguages();
            if (engine == null)
            {
                throw new InvalidOperationException(
                    "No OCR-capable language pack installed. Install one via Settings > Time & Language > Language & region.");
            }
            OcrResult result = engine.RecognizeAsync(bitmap).AsTask().Result;
            return string.Join("\n", result.Lines.Select(l => l.Text));
        }
    }
}
'@

Add-Type -TypeDefinition $csharp -ReferencedAssemblies @(
    "System.Runtime.WindowsRuntime",
    (Join-Path $winmdDir "Windows.Foundation.winmd"),
    (Join-Path $winmdDir "Windows.Storage.winmd"),
    (Join-Path $winmdDir "Windows.Graphics.winmd"),
    (Join-Path $winmdDir "Windows.Media.winmd")
)

$text = [OcrHelper]::Recognize($fullPath)
$lines = $text -split "`n"

[PSCustomObject]@{
    imagePath = $fullPath
    lineCount = $lines.Count
    text      = $text
    lines     = $lines
} | ConvertTo-Json -Depth 3
