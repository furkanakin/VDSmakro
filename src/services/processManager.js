const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

class ProcessManager {
    constructor() {
        this.activeProcesses = new Map(); // pid -> { pid, phoneNumber, startTime, duration, process, folderPath }
        this.settings = {
            maxProcesses: 10,
            rotationInterval: 30, // seconds
            warmupMin: 3 * 60 * 1000,
            warmupMax: 30 * 60 * 1000
        };

        this.rotationEnabled = false;
        this.rotationInterval = null;
        this.lastFocusedPid = null;

        // Check for expired processes every 5 seconds
        this.expirationInterval = setInterval(() => this.checkExpirations(), 5000);
    }

    updateSettings(newSettings) {
        // Support both snake_case (Backend) and camelCase (Agent)
        const maxProc = newSettings.max_processes || newSettings.maxProcesses;
        const rotInt = newSettings.rotation_interval || newSettings.rotationInterval;
        const wMin = newSettings.warmup_min || newSettings.warmupMin;
        const wMax = newSettings.warmup_max || newSettings.warmupMax;

        if (maxProc) this.settings.maxProcesses = parseInt(maxProc);
        if (rotInt) {
            this.settings.rotationInterval = parseInt(rotInt);
            if (this.rotationEnabled) {
                this.stopRotation();
                this.startRotation();
            }
        }
        if (wMin) this.settings.warmupMin = parseInt(wMin) * 60 * 1000;
        if (wMax) this.settings.warmupMax = parseInt(wMax) * 60 * 1000;

        console.log('[ProcessManager] Settings updated:', this.settings);
    }

    async launchTelegram(phoneNumber) {
        // Enforce dynamic limit
        if (this.activeProcesses.size >= this.settings.maxProcesses) {
            console.log(`[ProcessManager] Limit of ${this.settings.maxProcesses} reached. Killing oldest...`);
            let oldestPid = null;
            let oldestTime = Infinity;

            for (const [pid, proc] of this.activeProcesses) {
                if (proc.startTime < oldestTime) {
                    oldestTime = proc.startTime;
                    oldestPid = pid;
                }
            }

            if (oldestPid) {
                this.killProcess(oldestPid);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Check if already running
        for (const [pid, proc] of this.activeProcesses) {
            if (proc.phoneNumber === phoneNumber) {
                console.log(`[ProcessManager] Telegram already open for ${phoneNumber} (PID: ${pid})`);
                return { success: true, pid: pid };
            }
        }

        const folderPath = path.join(__dirname, '../../hesaplar', phoneNumber);
        const exePath = path.join(folderPath, 'Telegram.exe');

        if (!await fs.pathExists(exePath)) {
            throw new Error(`Telegram.exe not found for ${phoneNumber} at ${exePath}`);
        }

        console.log(`[ProcessManager] Launching Telegram for ${phoneNumber}...`);

        try {
            const child = spawn(exePath, [], {
                cwd: folderPath,
                detached: true,
                stdio: 'ignore'
            });

            if (!child.pid) throw new Error('Failed to spawn process');
            child.unref();

            const duration = Math.floor(Math.random() * (this.settings.warmupMax - this.settings.warmupMin + 1) + this.settings.warmupMin);

            const processInfo = {
                pid: child.pid,
                phoneNumber: phoneNumber,
                folderPath: folderPath,
                startTime: Date.now(),
                duration: duration,
                process: child
            };

            this.activeProcesses.set(child.pid, processInfo);
            console.log(`[ProcessManager] Started PID ${child.pid} for ${duration / 60000} minutes`);

            return { success: true, pid: child.pid };
        } catch (err) {
            console.error('[ProcessManager] Launch error:', err);
            throw err;
        }
    }

    checkExpirations() {
        const now = Date.now();
        for (const [pid, proc] of this.activeProcesses) {
            if (now - proc.startTime > proc.duration) {
                console.log(`[ProcessManager] Time expired for PID ${pid} (${proc.phoneNumber}). Killing...`);
                this.killProcess(pid);
            }
        }
    }

    startRotation() {
        this.rotationEnabled = true;
        const intervalMs = this.settings.rotationInterval * 1000;
        this.rotationInterval = setInterval(() => this.rotateWindows(), intervalMs);
        console.log(`[ProcessManager] Rotation started with ${this.settings.rotationInterval}s interval`);
    }

    stopRotation() {
        this.rotationEnabled = false;
        if (this.rotationInterval) {
            clearInterval(this.rotationInterval);
            this.rotationInterval = null;
        }
        console.log('[ProcessManager] Rotation stopped');
    }

    async rotateWindows() {
        if (!this.rotationEnabled || this.activeProcesses.size === 0) return;

        try {
            // Get all running Telegram processes from OS
            exec('powershell -command "Get-Process Telegram -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', (err, stdout) => {
                if (err || !stdout) return;

                const pids = stdout.trim().split(/\s+/).map(p => parseInt(p)).filter(n => !isNaN(n));
                if (pids.length === 0) return;

                // Randomly pick one that isn't the last one (if more than 1)
                let targetPid;
                if (pids.length > 1) {
                    const filtered = pids.filter(p => p !== this.lastFocusedPid);
                    targetPid = filtered[Math.floor(Math.random() * filtered.length)];
                } else {
                    targetPid = pids[0];
                }

                this.lastFocusedPid = targetPid;

                // Focus command (Minimize -> Maximize -> Switch -> Click)
                const focusCmd = `powershell -command "$code = '[DllImport(\\"user32.dll\\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\\"user32.dll\\")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab); [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);'; $type = Add-Type -MemberDefinition $code -Name Win32WindowOps -Namespace Win32Functions -PassThru; $p = Get-Process -Id ${targetPid} -ErrorAction SilentlyContinue; if ($p) { $type::ShowWindowAsync($p.MainWindowHandle, 6); Start-Sleep -Milliseconds 250; $type::ShowWindowAsync($p.MainWindowHandle, 3); $type::SwitchToThisWindow($p.MainWindowHandle, $true); Start-Sleep -Milliseconds 150; $type::SetCursorPos(41, 53); $type::mouse_event(0x02, 0, 0, 0, 0); $type::mouse_event(0x04, 0, 0, 0, 0); }"`;
                exec(focusCmd);
            });
        } catch (e) {
            console.error('[ProcessManager] Rotation error:', e.message);
        }
    }

    killProcess(pid) {
        if (!this.activeProcesses.has(pid)) return;
        const proc = this.activeProcesses.get(pid);

        try {
            console.log(`[ProcessManager] Killing PID ${pid} (${proc.phoneNumber})`);
            process.kill(pid);
        } catch (e) {
            // Fallback to taskkill
            exec(`taskkill /PID ${pid} /F`);
        }

        this.activeProcesses.delete(pid);
    }

    killAll() {
        console.log('[ProcessManager] Killing all Telegram processes...');
        exec('taskkill /F /IM Telegram.exe');
        this.activeProcesses.clear();
        this.stopRotation();
    }
}

module.exports = new ProcessManager();
