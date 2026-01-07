const { spawn, exec, execSync } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const path = require('path');
const fs = require('fs');

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
        this.isCapturing = false;

        // C# Utility configuration
        this.captureExe = path.join(__dirname, 'ScreenCapture.exe');
        this.captureSrc = path.join(__dirname, 'ScreenCapture.cs');
    }

    /**
     * Compiles the C# ScreenCapture utility if it doesn't exist.
     * This bypasses PowerShell AMSI blocks completely.
     */
    async ensureCaptureTool() {
        if (fs.existsSync(this.captureExe)) return true;

        console.log('[StreamManager] Compiling ScreenCapture utility...');
        const cscPaths = [
            'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
            'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
        ];

        let compiled = false;
        for (const csc of cscPaths) {
            if (fs.existsSync(csc)) {
                try {
                    const cmd = `"${csc}" /r:System.Drawing.dll /r:System.Windows.Forms.dll /target:exe /out:"${this.captureExe}" "${this.captureSrc}"`;
                    execSync(cmd);
                    console.log('[StreamManager] ScreenCapture compiled successfully.');
                    compiled = true;
                    break;
                } catch (e) {
                    console.error(`[StreamManager] Compilation failed with ${csc}:`, e.message);
                }
            }
        }
        return compiled;
    }

    async getScreenResolution() {
        if (this.screenRes) return this.screenRes;
        try {
            // Use basic PowerShell for resolution only (usually safe from AMSI)
            const cmd = 'powershell -NoProfile -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height"';
            const { stdout } = await execAsync(cmd);
            const lines = stdout.trim().split(/\s+/);
            if (lines.length >= 2) {
                this.screenRes = { w: parseInt(lines[0]), h: parseInt(lines[1]) };
                return this.screenRes;
            }
        } catch (e) {
            // Fallback to default
        }
        return { w: 1920, h: 1080 };
    }

    setSocket(socket) {
        this.socket = socket;
    }

    updateSettings(newSettings) {
        // Support both snake_case (Backend) and camelCase (Agent)
        const quality = newSettings.stream_quality || newSettings.quality;
        const fps = newSettings.stream_fps || newSettings.fps;

        let changed = false;
        if (quality && quality !== this.settings.quality) {
            this.settings.quality = quality;
            changed = true;
        }
        if (fps) {
            const newFps = parseInt(fps);
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

        const ok = await this.ensureCaptureTool();
        if (!ok) {
            console.error('[StreamManager] Cannot start stream: Capture tool missing/failed to compile.');
            return;
        }

        this.isStreaming = true;
        console.log(`[StreamManager] Stream started (C# Capture Mode)`);
        this.captureLoop();
    }

    async captureLoop() {
        if (!this.isStreaming) return;
        const startTime = Date.now();
        await this.captureAndSend();

        // Dynamically calculate wait time based on target FPS. Minimum 50ms floor.
        const targetDelay = 1000 / this.settings.fps;
        const elapsed = Date.now() - startTime;
        const waitTime = Math.max(50, targetDelay - elapsed);

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
                    image: frame
                });
            }
        } catch (err) {
        } finally {
            this.isCapturing = false;
        }
    }

    async takeScreenshot(w, h) {
        try {
            await this.ensureCaptureTool();
            const { stdout } = await execAsync(`"${this.captureExe}" ${w} ${h}`, { maxBuffer: 10 * 1024 * 1024 });
            const base64 = stdout.trim().replace(/\s/g, '');
            return base64 ? `data:image/jpeg;base64,${base64}` : null;
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

        if ((data.type === 'mousemove' || data.type === 'mousedrag') && this.inputQueue.length > 2) {
            this.isProcessingInput = false;
            return this.processInputQueue();
        }

        try {
            const res = await this.getScreenResolution();
            const processedData = { ...data };

            if (data.x !== undefined && data.y !== undefined) {
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
