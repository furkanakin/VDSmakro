const { spawn } = require('child_process');

class StreamManager {
    constructor() {
        this.socket = null;
        this.isStreaming = false;
        this.interval = null;
        this.serverId = null;
        this.settings = {
            quality: '540p',
            fps: 5
        };

        this.resolutions = {
            '540p': { w: 960, h: 540 },
            '720p': { w: 1280, h: 720 },
            '1080p': { w: 1920, h: 1080 }
        };

        this.psProcess = null;
        this.screenshotPromise = null;
        this.initPersistentPS();
    }

    initPersistentPS() {
        if (this.psProcess) return;

        console.log('[StreamManager] Initializing persistent PowerShell process...');
        this.psProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Add Win32 mouse_event definition ONCE
        const initScript = `
            $ErrorActionPreference = "SilentlyContinue"
            Add-Type -MemberDefinition @'
                [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, uint dwExtraInfo);
                [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
'@ -Name Win32 -Namespace Native
            [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
            [Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null
            Write-Host "PS_READY"
        `;
        this.psProcess.stdin.write(initScript + "\n");

        this.psProcess.stderr.on('data', (data) => {
            // console.error('[StreamManager] PS Error:', data.toString());
        });

        this.psProcess.on('exit', () => {
            console.log('[StreamManager] Persistent PS exited, restarting...');
            this.psProcess = null;
            setTimeout(() => this.initPersistentPS(), 1000);
        });
    }

    runPS(script) {
        if (!this.psProcess) return;
        this.psProcess.stdin.write(script + "\n");
    }

    setSocket(socket) {
        this.socket = socket;
    }

    updateSettings(newSettings) {
        let changed = false;
        if (newSettings.quality && newSettings.quality !== this.settings.quality) {
            this.settings.quality = newSettings.quality;
            changed = true;
        }
        if (newSettings.fps) {
            const newFps = parseInt(newSettings.fps);
            if (newFps !== this.settings.fps) {
                this.settings.fps = newFps;
                changed = true;
            }
        }

        if (changed && this.isStreaming) {
            this.stopStream();
            this.startStream();
        }
        console.log('[StreamManager] Current settings:', this.settings);
    }

    async startStream() {
        if (this.isStreaming) return;
        this.isStreaming = true;
        console.log(`[StreamManager] Stream started: ${this.settings.quality} @ ${this.settings.fps} FPS`);
        this.captureLoop();
    }

    async captureLoop() {
        if (!this.isStreaming) return;
        const startTime = Date.now();
        await this.captureAndSend();
        const waitTime = Math.max(0, (1000 / this.settings.fps) - (Date.now() - startTime));
        this.interval = setTimeout(() => this.captureLoop(), waitTime);
    }

    stopStream() {
        this.isStreaming = false;
        if (this.interval) {
            clearTimeout(this.interval);
            this.interval = null;
        }
        console.log('[StreamManager] Stream stopped');
    }

    async captureAndSend() {
        if (!this.socket || !this.isStreaming || !this.psProcess) return;

        try {
            const res = this.resolutions[this.settings.quality] || this.resolutions['540p'];
            const frame = await this.psRequestScreenshot(res.w, res.h);

            if (frame && frame !== 'ERROR') {
                this.socket.emit('macro:stream_frame', {
                    serverId: this.serverId,
                    image: `data:image/jpeg;base64,${frame}`
                });
            }
        } catch (err) { }
    }

    // Helper for command/response over persistent PS
    async psRequestScreenshot(w, h) {
        if (!this.psProcess) return null;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.psProcess.stdout.removeListener('data', onData);
                resolve(null);
            }, 5000);

            let buffer = '';
            const onData = (data) => {
                buffer += data.toString();
                if (buffer.includes('---FRAME_END---')) {
                    clearTimeout(timeout);
                    this.psProcess.stdout.removeListener('data', onData);
                    const parts = buffer.split('---FRAME_START---');
                    if (parts.length > 1) {
                        const content = parts[1].split('---FRAME_END---')[0].trim();
                        resolve(content);
                    } else {
                        resolve(null);
                    }
                }
            };

            this.psProcess.stdout.on('data', onData);

            const script = `
                try {
                    $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
                    $fullBmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height);
                    $gFull = [System.Drawing.Graphics]::FromImage($fullBmp);
                    $gFull.CopyFromScreen(0, 0, 0, 0, $fullBmp.Size);
                    $bmp = New-Object System.Drawing.Bitmap(${w}, ${h});
                    $g = [System.Drawing.Graphics]::FromImage($bmp);
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low;
                    $g.DrawImage($fullBmp, 0, 0, ${w}, ${h});
                    $ms = New-Object System.IO.MemoryStream;
                    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg);
                    $base64 = [Convert]::ToBase64String($ms.ToArray());
                    $g.Dispose(); $bmp.Dispose(); $gFull.Dispose(); $fullBmp.Dispose(); $ms.Dispose();
                    Write-Host "---FRAME_START---"
                    Write-Host $base64
                    Write-Host "---FRAME_END---"
                } catch { Write-Host "---FRAME_START---ERROR---FRAME_END---" }
            `;
            this.psProcess.stdin.write(script.replace(/\n/g, ' ') + "\n");
        });
    }

    handleRemoteInput(data) {
        if (!this.psProcess) return;

        try {
            let script = '';
            if (data.type === 'click' || data.type === 'right-click' || data.type === 'mousedown' || data.type === 'mouseup') {
                const isRight = data.type === 'right-click' || (data.button === 'right');
                const absX = Math.round(data.x * 65535);
                const absY = Math.round(data.y * 65535);
                let flags = 0x8001; // MOVE | ABSOLUTE
                if (data.type === 'click') flags |= 0x0006;
                else if (data.type === 'right-click') flags |= 0x0018;
                else if (data.type === 'mousedown') flags |= isRight ? 0x0008 : 0x0002;
                else if (data.type === 'mouseup') flags |= isRight ? 0x0010 : 0x0004;

                script = `[Native.Win32]::mouse_event(${flags}, ${absX}, ${absY}, 0, 0)`;
            } else if (data.type === 'scroll') {
                const delta = Math.round(data.delta || 0);
                script = `[Native.Win32]::mouse_event(0x0800, 0, 0, ${-delta}, 0)`;
            } else if (data.type === 'keydown') {
                script = `[System.Windows.Forms.SendKeys]::SendWait('${data.key}')`;
            } else if (data.type === 'text') {
                const safeText = data.text.replace(/'/g, "''").replace(/\\/g, "\\\\");
                script = `[System.Windows.Forms.SendKeys]::SendWait('${safeText}')`;
            }

            if (script) {
                this.runPS(script);
            }
        } catch (err) {
            console.error('[RemoteInput] Error:', err.message);
        }
    }

    async getScreenshot() {
        return this.psRequestScreenshot(1920, 1080); // Default for single shots
    }
}

module.exports = new StreamManager();
