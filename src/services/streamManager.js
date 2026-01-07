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

        this.inputQueue = [];
        this.isProcessingInput = false;

        // No persistent PS process - we'll spawn on demand for reliability
        this.isCapturing = false;
    }

    async getScreenResolution() {
        if (this.screenRes) return this.screenRes;
        try {
            const cmd = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height"';
            const { stdout } = await execAsync(cmd);
            const lines = stdout.trim().split(/\s+/);
            if (lines.length >= 2) {
                this.screenRes = { w: parseInt(lines[0]), h: parseInt(lines[1]) };
                return this.screenRes;
            }
        } catch (e) {
            console.error('[StreamManager] Resolution error:', e.message);
        }
        return { w: 1920, h: 1080 };
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
        console.log(`[StreamManager] Stream started (Fresh Capture Mode)`);
        this.captureLoop();
    }

    async captureLoop() {
        if (!this.isStreaming) return;
        const startTime = Date.now();
        await this.captureAndSend();
        // Since fresh captures are slow, we limit FPS naturally
        const waitTime = Math.max(500, (1000 / this.settings.fps) - (Date.now() - startTime));
        this.interval = setTimeout(() => this.captureLoop(), waitTime);
    }

    stopStream() {
        this.isStreaming = false;
        if (this.interval) {
            clearTimeout(this.interval);
            this.interval = null;
        }
    }

    async captureAndSend() {
        if (!this.socket || !this.isStreaming || this.isCapturing) return;

        try {
            this.isCapturing = true;
            const res = this.resolutions[this.settings.quality] || this.resolutions['540p'];
            const frame = await this.takeScreenshot(res.w, res.h);

            if (frame) {
                this.socket.emit('macro:stream_frame', {
                    serverId: this.serverId,
                    image: `data:image/jpeg;base64,${frame}`
                });
            }
        } catch (err) {
        } finally {
            this.isCapturing = false;
        }
    }

    async takeScreenshot(w, h) {
        // Fresh PowerShell spawn for maximum reliability
        const script = `
            Add-Type -AssemblyName System.Windows.Forms, System.Drawing;
            $screen = [System.Windows.Forms.Screen]::PrimaryScreen;
            $fullBmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height);
            $gFull = [System.Drawing.Graphics]::FromImage($fullBmp);
            $gFull.CopyFromScreen(0, 0, 0, 0, $fullBmp.Size);
            $bmp = New-Object System.Drawing.Bitmap(${w}, ${h});
            $g = [System.Drawing.Graphics]::FromImage($bmp);
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Low;
            $g.DrawImage($fullBmp, 0, 0, ${w}, ${h});
            $ms = New-Object System.IO.MemoryStream;
            $enc = [System.Drawing.Imaging.Encoder]::Quality;
            $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1);
            $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($enc, 50);
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.FormatDescription -eq 'JPEG' };
            $bmp.Save($ms, $codec, $encParams);
            $base64 = [Convert]::ToBase64String($ms.ToArray());
            $g.Dispose(); $bmp.Dispose(); $gFull.Dispose(); $fullBmp.Dispose(); $ms.Dispose();
            Write-Host $base64;
        `;
        try {
            const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\n/g, ' ')}"`, { maxBuffer: 10 * 1024 * 1024 });
            return stdout.trim().replace(/\s/g, '');
        } catch (e) {
            console.error('[StreamManager] Screenshot failed:', e.message);
            return null;
        }
    }

    async handleRemoteInput(data) {
        this.inputQueue.push(data);
        this.processInputQueue();
    }

    async processInputQueue() {
        if (this.isProcessingInput || this.inputQueue.length === 0) return;
        this.isProcessingInput = true;

        const data = this.inputQueue.shift();

        // THROTTLE: Skip intermediate movements if queue is long
        if ((data.type === 'mousemove' || data.type === 'mousedrag') && this.inputQueue.length > 2) {
            this.isProcessingInput = false;
            return this.processInputQueue();
        }

        try {
            const res = await this.getScreenResolution();
            const processedData = { ...data };

            if (data.x !== undefined && data.y !== undefined) {
                // Determine if coordinates are already scaled
                const scaleX = data.x <= 1.1 ? res.w : 1;
                const scaleY = data.y <= 1.1 ? res.h : 1;
                processedData.x = Math.round(data.x * scaleX);
                processedData.y = Math.round(data.y * scaleY);
            }

            const scriptPath = path.join(__dirname, 'input_control.py');
            const payload = JSON.stringify(processedData);

            const tryExecute = (cmd) => {
                return new Promise((resolve, reject) => {
                    const pyProc = spawn(cmd, [scriptPath, payload]);
                    pyProc.on('error', (err) => reject(err));
                    pyProc.on('close', (code) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Exit code ${code}`));
                    });
                });
            };

            try {
                await tryExecute('python');
            } catch (err) {
                try {
                    await tryExecute('py');
                } catch (err2) {
                }
            }
        } catch (err) {
            console.error('[RemoteInput] Error:', err.message);
        } finally {
            this.isProcessingInput = false;
            setImmediate(() => this.processInputQueue());
        }
    }

    async getScreenshot() {
        const res = await this.getScreenResolution();
        return this.takeScreenshot(res.w, res.h);
    }
}

module.exports = new StreamManager();
