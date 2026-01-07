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
            const res = this.resolutions[this.settings.quality] || this.resolutions['540p'];

            // We need to capture FULL screen first, then draw it RE-SIZED to our target bitmap
            const psCommand = `powershell -command "[Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; $screen = [System.Windows.Forms.Screen]::PrimaryScreen; $fullBmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height); $gFull = [System.Drawing.Graphics]::FromImage($fullBmp); $gFull.CopyFromScreen(0, 0, 0, 0, $fullBmp.Size); $bmp = New-Object System.Drawing.Bitmap(${res.w}, ${res.h}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low; $g.DrawImage($fullBmp, 0, 0, ${res.w}, ${res.h}); $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg); [Convert]::ToBase64String($ms.ToArray()); $g.Dispose(); $bmp.Dispose(); $gFull.Dispose(); $fullBmp.Dispose(); $ms.Dispose();"`;

            const { stdout } = await execAsync(psCommand, { maxBuffer: 1024 * 1024 * 10 });
            const b64 = stdout.trim();

            if (b64) {
                this.socket.emit('macro:stream_frame', {
                    serverId: this.serverId,
                    image: `data:image/jpeg;base64,${b64}`
                });
            }
        } catch (err) {
            // console.error('[Stream] Capture error:', err.message);
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
