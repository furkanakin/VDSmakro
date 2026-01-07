const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

class StreamManager {
    constructor() {
        this.socket = null;
        this.isStreaming = false;
        this.interval = null;
        this.settings = {
            quality: '540p',
            fps: 5
        };

        // Resolution mapping
        this.resolutions = {
            '540p': { w: 960, h: 540 },
            '720p': { w: 1280, h: 720 },
            '1080p': { w: 1920, h: 1080 }
        };
    }

    setSocket(socket) {
        this.socket = socket;
    }

    updateSettings(newSettings) {
        if (newSettings.quality) this.settings.quality = newSettings.quality;
        if (newSettings.fps) {
            this.settings.fps = parseInt(newSettings.fps);
            if (this.isStreaming) {
                this.stopStream();
                this.startStream();
            }
        }
        console.log('[StreamManager] Settings updated:', this.settings);
    }

    startStream() {
        if (this.isStreaming) return;
        this.isStreaming = true;

        const intervalMs = 1000 / this.settings.fps;
        this.interval = setInterval(() => this.captureAndSend(), intervalMs);
        console.log(`[StreamManager] Stream started: ${this.settings.quality} @ ${this.settings.fps} FPS`);
    }

    stopStream() {
        this.isStreaming = false;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        console.log('[StreamManager] Stream stopped');
    }

    async captureAndSend() {
        if (!this.socket || !this.isStreaming) return;

        try {
            // Using PowerShell for screenshot to avoid external deps
            // Resizing is done via GDI+ at the source for efficiency
            const res = this.resolutions[this.settings.quality] || this.resolutions['540p'];

            const psCommand = `powershell -command "$code = '[DllImport(\\"user32.dll\\")] public static extern IntPtr GetDesktopWindow(); [DllImport(\\"user32.dll\\")] public static extern IntPtr GetWindowDC(IntPtr hWnd); [DllImport(\\"gdi32.dll\\")] public static extern bool StretchBlt(IntPtr hdcDest, int nXOriginDest, int nYOriginDest, int nWidthDest, int nHeightDest, IntPtr hdcSrc, int nXOriginSrc, int nYOriginSrc, int nWidthSrc, int nHeightSrc, int dwRop);'; Add-Type -MemberDefinition $code -Name Win32 -Namespace Native; [Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $hDesk = [Native.Win32]::GetDesktopWindow(); $hBar = [Native.Win32]::GetWindowDC($hDesk); $bmp = New-Object System.Drawing.Bitmap(${res.w}, ${res.h}); $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); [Native.Win32]::StretchBlt($hdc, 0, 0, ${res.w}, ${res.h}, $hBar, 0, 0, $screen.Bounds.Width, $screen.Bounds.Height, 0x00CC0020) | Out-Null; $g.ReleaseHdc($hdc); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); [Convert]::ToBase64String($ms.ToArray()); $g.Dispose(); $bmp.Dispose(); $ms.Dispose();"`;

            const { stdout } = await execAsync(psCommand, { maxBuffer: 1024 * 1024 * 10 });
            const b64 = stdout.trim();

            if (b64) {
                this.socket.emit('macro:stream_frame', {
                    serverId: this.serverId, // Set by register
                    image: `data:image/jpeg;base64,${b64}`
                });
            }
        } catch (err) {
            // Silently fail or log occasionally
        }
    }

    async getScreenshot() {
        const res = this.resolutions['1080p']; // Always high res for manual screenshot
        const psCommand = `powershell -command "[Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $bmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); [Convert]::ToBase64String($ms.ToArray()); $g.Dispose(); $bmp.Dispose(); $ms.Dispose();"`;
        const { stdout } = await execAsync(psCommand, { maxBuffer: 1024 * 1024 * 10 });
        return `data:image/jpeg;base64,${stdout.trim()}`;
    }
}

module.exports = new StreamManager();
