param (
    [int]$width = 960,
    [int]$height = 540
)

try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    $fullBmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
    $gFull = [System.Drawing.Graphics]::FromImage($fullBmp)
    $gFull.CopyFromScreen(0, 0, 0, 0, $fullBmp.Size)
    
    $bmp = New-Object System.Drawing.Bitmap($width, $height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low
    $g.DrawImage($fullBmp, 0, 0, $width, $height)
    
    $ms = New-Object System.IO.MemoryStream
    $enc = [System.Drawing.Imaging.Encoder]::Quality
    $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($enc, 50)
    
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatDescription -eq 'JPEG' }
    $bmp.Save($ms, $codec, $encParams)
    
    $base64 = [Convert]::ToBase64String($ms.ToArray())
    Write-Host $base64
    
    $g.Dispose()
    $bmp.Dispose()
    $gFull.Dispose()
    $fullBmp.Dispose()
    $ms.Dispose()
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
