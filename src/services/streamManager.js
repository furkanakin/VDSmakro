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

        console.log('[StreamManager] Initializing persistent PowerShell process for screens...');
        this.psProcess = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const initScript = `
            $ErrorActionPreference = "SilentlyContinue"
            [Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
            [Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null
            Write-Host "PS_READY"
        `;
        this.psProcess.stdin.write(initScript + "\n");

        this.psProcess.on('exit', () => {
            this.psProcess = null;
            setTimeout(() => this.initPersistentPS(), 2000);
        });

        this.getScreenResolution(); // Pre-cache resolution
    }

    async getScreenResolution() {
        if (this.screenRes) return this.screenRes;
        try {
            const cmd = 'powershell -NoProfile -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height"';
            const { stdout } = await execAsync(cmd);
            const lines = stdout.trim().split(/\s+/);
            if (lines.length >= 2) {
                this.screenRes = { w: parseInt(lines[0]), h: parseInt(lines[1]) };
                console.log(`[StreamManager] Detected resolution: ${this.screenRes.w}x${this.screenRes.h}`);
                return this.screenRes;
            }
        } catch (e) {
            console.error('[StreamManager] Failed to get resolution:', e.message);
        }
        return { w: 1920, h: 1080 }; // Fallback
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

    async psRequestScreenshot(w, h) {
        if (!this.psProcess) return null;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.psProcess.stdout.removeAllListeners('data');
                resolve(null);
            }, 3000);

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

    async handleRemoteInput(data) {
        try {
            const res = await this.getScreenResolution();
            const processedData = { ...data };

            if (data.x !== undefined && data.y !== undefined) {
                processedData.x = Math.round(data.x * res.w);
                processedData.y = Math.round(data.y * res.h);
            }

            console.log(`[RemoteInput] Executing ${data.type} at (${processedData.x}, ${processedData.y}) [Raw: ${data.x}, ${data.y}] Resolution: ${res.w}x${res.h}`);

            const scriptPath = path.join(__dirname, 'input_control.py');
            const payload = JSON.stringify(processedData);

            const tryExecute = (cmd) => {
                return new Promise((resolve, reject) => {
                    const pyProc = spawn(cmd, [scriptPath, payload]);

                    let errOutput = '';
                    pyProc.stderr.on('data', (d) => errOutput += d.toString());

                    pyProc.on('error', (err) => reject(err));
                    pyProc.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Exit code ${code}: ${errOutput}`));
                    });
                });
            };

            try {
                await tryExecute('python');
            } catch (err) {
                try {
                    console.log('[RemoteInput] python failed, trying py...');
                    await tryExecute('py');
                } catch (err2) {
                    console.error('[RemoteInput] Error executing Python:', err2.message);
                }
            }
        } catch (err) {
            console.error('[RemoteInput] Critical Error:', err.message);
        }
    }

    async getScreenshot() {
        const res = await this.getScreenResolution();
        return this.psRequestScreenshot(res.w, res.h);
    }
}

module.exports = new StreamManager();
