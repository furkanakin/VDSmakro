const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

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
            console.log('[StreamManager] Settings changed, restarting stream...');
            this.stopStream();
            this.startStream();
        }
        console.log('[StreamManager] Current settings:', this.settings);
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

            // Robust screen capture with scaling
            const psScript = `
                [Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null;
                [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null;
                try {
                    $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
                    $fullBmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height);
                    $gFull = [System.Drawing.Graphics]::FromImage($fullBmp);
                    $gFull.CopyFromScreen(0, 0, 0, 0, $fullBmp.Size);
                    
                    $bmp = New-Object System.Drawing.Bitmap(${res.w}, ${res.h});
                    $g = [System.Drawing.Graphics]::FromImage($bmp);
                    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low;
                    $g.DrawImage($fullBmp, 0, 0, ${res.w}, ${res.h});
                    
                    $ms = New-Object System.IO.MemoryStream;
                    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg);
                    [Convert]::ToBase64String($ms.ToArray());
                    
                    $g.Dispose();
                    $bmp.Dispose();
                    $gFull.Dispose();
                    $fullBmp.Dispose();
                    $ms.Dispose();
                } catch {
                    "ERROR: " + $_.Exception.Message
                }
            `;

            const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;

            const { stdout } = await execAsync(psCommand, { maxBuffer: 1024 * 1024 * 15 });
            const output = stdout.trim();

            if (output && !output.startsWith('ERROR:')) {
                this.socket.emit('macro:stream_frame', {
                    serverId: this.serverId,
                    image: `data:image/jpeg;base64,${output}`
                });
            }
        } catch (err) {
            // Silently ignore or log occasionally
        }
    }

    async handleRemoteInput(data) {
        try {
            let psScript = '';

            if (data.type === 'click' || data.type === 'mousedown' || data.type === 'mouseup') {
                const btn = data.button === 'right' ? 'Right' : 'Left';
                const action = data.type === 'mousedown' ? 'Down' : (data.type === 'mouseup' ? 'Up' : 'Click');

                psScript = `
                    $code = '[DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, uint dwExtraInfo); [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y);';
                    Add-Type -MemberDefinition $code -Name Win32 -Namespace Native;
                    [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null;
                    $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
                    $targetX = [int]($screen.Bounds.Width * ${data.x});
                    $targetY = [int]($screen.Bounds.Height * ${data.y});
                    [Native.Win32]::SetCursorPos($targetX, $targetY);
                `;

                if (data.type === 'click') {
                    psScript += ` if ('${btn}' -eq 'Left') { [Native.Win32]::mouse_event(0x0002, 0, 0, 0, 0); [Native.Win32]::mouse_event(0x0004, 0, 0, 0, 0); } else { [Native.Win32]::mouse_event(0x0008, 0, 0, 0, 0); [Native.Win32]::mouse_event(0x0010, 0, 0, 0, 0); } `;
                } else if (data.type === 'mousedown') {
                    psScript += ` if ('${btn}' -eq 'Left') { [Native.Win32]::mouse_event(0x0002, 0, 0, 0, 0); } else { [Native.Win32]::mouse_event(0x0008, 0, 0, 0, 0); } `;
                } else if (data.type === 'mouseup') {
                    psScript += ` if ('${btn}' -eq 'Left') { [Native.Win32]::mouse_event(0x0004, 0, 0, 0, 0); } else { [Native.Win32]::mouse_event(0x0010, 0, 0, 0, 0); } `;
                }
            } else if (data.type === 'keydown') {
                psScript = `[Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.SendKeys]::SendWait('${data.key}')`;
            } else if (data.type === 'text') {
                const safeText = data.text.replace(/'/g, "''");
                psScript = `[Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.SendKeys]::SendWait('${safeText}')`;
            }

            if (psScript) {
                const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
                exec(psCommand);
            }
        } catch (err) {
            console.error('[RemoteInput] Error:', err.message);
        }
    }

    async getScreenshot() {
        try {
            const psScript = `
                [Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null;
                [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null;
                $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
                $bmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height);
                $g = [System.Drawing.Graphics]::FromImage($bmp);
                $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size);
                $ms = New-Object System.IO.MemoryStream;
                $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg);
                [Convert]::ToBase64String($ms.ToArray());
                $g.Dispose();
                $bmp.Dispose();
                $ms.Dispose();
            `;
            const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
            const { stdout } = await execAsync(psCommand, { maxBuffer: 1024 * 1024 * 15 });
            return `data:image/jpeg;base64,${stdout.trim()}`;
        } catch (e) {
            return null;
        }
    }
}

module.exports = new StreamManager();
