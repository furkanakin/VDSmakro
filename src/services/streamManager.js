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

            // Use smaller maxBuffer and timeout for safety
            const { stdout } = await execAsync(psCommand, {
                maxBuffer: 1024 * 1024 * 10,
                timeout: 5000
            });
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
            console.log(`[RemoteInput] Event: ${data.type} (x: ${data.x}, y: ${data.y})`);
            let psScript = '';

            // Win32 Constants
            // MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004
            // MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_WHEEL = 0x0800
            // MOUSEEVENTF_ABSOLUTE = 0x8000 (Uses 0-65535 grid)

            if (data.type === 'click' || data.type === 'right-click' || data.type === 'mousedown' || data.type === 'mouseup') {
                const isRight = data.type === 'right-click' || (data.button === 'right');

                // Scale coordinates to 0-65535 range for ABSOLUTE movement
                const absX = Math.round(data.x * 65535);
                const absY = Math.round(data.y * 65535);

                psScript = `
                    $code = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, uint dwExtraInfo);';
                    if (-not ([System.Management.Automation.PSTypeName]'Native.Win32').Type) {
                        Add-Type -MemberDefinition $code -Name Win32 -Namespace Native;
                    }
                    
                    # Move to absolute position (0x8001 = MOVE | ABSOLUTE)
                    [Native.Win32]::mouse_event(0x8001, ${absX}, ${absY}, 0, 0);
                `;

                if (data.type === 'click') {
                    psScript += ` [Native.Win32]::mouse_event(0x0002, 0, 0, 0, 0); [Native.Win32]::mouse_event(0x0004, 0, 0, 0, 0); `;
                } else if (data.type === 'right-click') {
                    psScript += ` [Native.Win32]::mouse_event(0x0008, 0, 0, 0, 0); [Native.Win32]::mouse_event(0x0010, 0, 0, 0, 0); `;
                } else if (data.type === 'mousedown') {
                    psScript += isRight ? ` [Native.Win32]::mouse_event(0x0008, 0, 0, 0, 0); ` : ` [Native.Win32]::mouse_event(0x0002, 0, 0, 0, 0); `;
                } else if (data.type === 'mouseup') {
                    psScript += isRight ? ` [Native.Win32]::mouse_event(0x0010, 0, 0, 0, 0); ` : ` [Native.Win32]::mouse_event(0x0004, 0, 0, 0, 0); `;
                }
            } else if (data.type === 'scroll') {
                const delta = data.delta || 0;
                psScript = `
                    $code = '[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, uint dwExtraInfo);';
                    if (-not ([System.Management.Automation.PSTypeName]'Native.Win32Scroll').Type) {
                        Add-Type -MemberDefinition $code -Name Win32Scroll -Namespace Native;
                    }
                    [Native.Win32Scroll]::mouse_event(0x0800, 0, 0, ${-delta}, 0);
                `;
            } else if (data.type === 'keydown') {
                psScript = `[Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.SendKeys]::SendWait('${data.key}')`;
            } else if (data.type === 'text') {
                const safeText = data.text.replace(/'/g, "''").replace(/\\/g, "\\\\");
                psScript = `[Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.SendKeys]::SendWait('${safeText}')`;
            }

            if (psScript) {
                const psCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
                exec(psCommand, (err) => {
                    if (err) console.error('[RemoteInput] PowerShell Error:', err.message);
                });
            }
        } catch (err) {
            console.error('[RemoteInput] Fatal Error:', err.message);
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
