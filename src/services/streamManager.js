const { spawn, exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const path = require('path');

class StreamManager {
    constructor() {
        this.socket = null;
        this.isStreaming = false;
        this.interval = null;
        this.serverId = null;
        this.screenRes = null;
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
        this.initPersistentPS();
    }

    initPersistentPS() {
        if (this.psProcess) return;

        console.log('[StreamManager] Initializing persistent PowerShell process...');
        this.psProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

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

        this.psProcess.on('exit', () => {
            this.psProcess = null;
            setTimeout(() => this.initPersistentPS(), 2000);
        });

        this.getScreenResolution();
    }

    async getScreenResolution() {
        if (this.screenRes) return this.screenRes;
        try {
            const cmd = 'powershell -NoProfile -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height"';
            const { stdout } = await execAsync(cmd);
            const lines = stdout.trim().split(/\s+/);
            if (lines.length >= 2) {
                this.screenRes = { w: parseInt(lines[0]), h: parseInt(lines[1]) };
                console.log(`[StreamManager] Resolution cached: ${this.screenRes.w}x${this.screenRes.h}`);
                return this.screenRes;
            }
        } catch (e) { }
        return { w: 1920, h: 1080 };
    }

    runPS(script) {
        if (!this.psProcess) return;
        this.psProcess.stdin.write(script + "\n");
    }

    setSocket(socket) {
        this.socket = socket;
    }

    updateSettings(newSettings) {
        if (newSettings.quality && newSettings.quality !== this.settings.quality) {
            this.settings.quality = newSettings.quality;
            if (this.isStreaming) { this.stopStream(); this.startStream(); }
        }
        if (newSettings.fps) {
            this.settings.fps = parseInt(newSettings.fps);
        }
    }

    async startStream() {
        if (this.isStreaming) return;
        this.isStreaming = true;
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
        if (this.interval) { clearTimeout(this.interval); this.interval = null; }
    }

    async captureAndSend() {
        if (!this.socket || !this.isStreaming || !this.psProcess) return;
        try {
            const res = this.resolutions[this.settings.quality] || this.resolutions['540p'];
            const frame = await this.psRequestScreenshot(res.w, res.h);
            if (frame && frame !== 'ERROR') {
                this.socket.emit('macro:stream_frame', { serverId: this.serverId, image: `data:image/jpeg;base64,${frame}` });
            }
        } catch (err) { }
    }

    async psRequestScreenshot(w, h) {
        if (!this.psProcess) return null;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => { this.psProcess.stdout.removeAllListeners('data'); resolve(null); }, 3000);
            let buffer = '';
            const onData = (data) => {
                buffer += data.toString();
                if (buffer.includes('---FRAME_END---')) {
                    clearTimeout(timeout);
                    this.psProcess.stdout.removeListener('data', onData);
                    const parts = buffer.split('---FRAME_START---');
                    if (parts.length > 1) resolve(parts[1].split('---FRAME_END---')[0].trim());
                    else resolve(null);
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

    async handleRemoteInput(data) {
        if (!this.psProcess) return;
        try {
            const res = await this.getScreenResolution();
            let script = '';

            if (data.type === 'click' || data.type === 'right-click' || data.type === 'mousedown' || data.type === 'mouseup') {
                const targetX = Math.round(data.x * res.w);
                const targetY = Math.round(data.y * res.h);
                const isRight = data.type === 'right-click' || (data.button === 'right');

                let flags = 0;
                if (data.type === 'click') flags = 0x0002 | 0x0004; // LEFTDOWN | LEFTUP
                else if (data.type === 'right-click') flags = 0x0008 | 0x0010; // RIGHTDOWN | RIGHTUP
                else if (data.type === 'mousedown') flags = isRight ? 0x0008 : 0x0002;
                else if (data.type === 'mouseup') flags = isRight ? 0x0010 : 0x0004;

                // Move first using SetCursorPos (more precise than mouse_event MOVE), then click
                script = `[Native.Win32]::SetCursorPos(${targetX}, ${targetY}); [Native.Win32]::mouse_event(${flags}, 0, 0, 0, 0)`;
            } else if (data.type === 'scroll') {
                const delta = Math.round(data.delta || 0);
                script = `[Native.Win32]::mouse_event(0x0800, 0, 0, ${-delta}, 0)`;
            } else if (data.type === 'keydown' || data.type === 'text') {
                const text = data.type === 'text' ? data.text : data.key;
                const safeText = text.replace(/'/g, "''").replace(/\\/g, "\\\\");
                script = `[System.Windows.Forms.SendKeys]::SendWait('${safeText}')`;
            }

            if (script) this.runPS(script);
        } catch (err) { }
    }

    async getScreenshot() {
        const res = await this.getScreenResolution();
        return this.psRequestScreenshot(res.w, res.h);
    }
}

module.exports = new StreamManager();
