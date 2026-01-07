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
            // If interval > 0, assume rotation should be enabled
            if (this.settings.rotationInterval > 0) {
                this.startRotation();
            } else {
                this.stopRotation();
            }
        }
        if (wMin) this.settings.warmupMin = parseInt(wMin) * 60 * 1000;
        if (wMax) this.settings.warmupMax = parseInt(wMax) * 60 * 1000;

        console.log('[ProcessManager] Settings updated:', this.settings);
    }

    async verifyProcessRunning(exePath) {
        if (!exePath) return false;
        // Escape single quotes for PowerShell
        const safePath = exePath.replace(/'/g, "''");
        const psCommand = `powershell -command "Get-WmiObject Win32_Process | Where-Object { $_.ExecutablePath -eq '${safePath}' } | Measure-Object | Select-Object -ExpandProperty Count"`;

        return new Promise((resolve) => {
            exec(psCommand, (err, stdout) => {
                if (err || !stdout) {
                    resolve(false);
                    return;
                }
                const count = parseInt(stdout.trim());
                resolve(count > 0);
            });
        });
    }

    async launchTelegram(phoneNumber) {
        // 1. Clean up stale/phantom processes from our tracking map first
        for (const [pid, proc] of this.activeProcesses) {
            const isActuallyRunning = await this.verifyProcessRunning(proc.exePath);
            if (!isActuallyRunning) {
                console.log(`[ProcessManager] Stale process detected for ${proc.phoneNumber} (PID: ${pid}). Removing from map.`);
                this.activeProcesses.delete(pid);
            }
        }

        // 2. Enforce dynamic limit (FIFO)
        if (this.activeProcesses.size >= this.settings.maxProcesses) {
            console.log(`[ProcessManager] Limit of ${this.settings.maxProcesses} reached. Finding oldest to kill...`);
            let oldestPid = null;
            let oldestTime = Infinity;

            for (const [pid, proc] of this.activeProcesses) {
                if (proc.startTime < oldestTime) {
                    oldestTime = proc.startTime;
                    oldestPid = pid;
                }
            }

            if (oldestPid) {
                console.log(`[ProcessManager] Killing oldest process (PID: ${oldestPid}) to free slot.`);
                this.killProcess(oldestPid);
                await new Promise(resolve => setTimeout(resolve, 1500)); // Wait for cleanup
            }
        }

        // 3. Check if already running (after safety cleanup)
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
                exePath: exePath, // CRITICAL: Store path for reliable path-based killing
                startTime: Date.now(),
                duration: duration,
                process: child
            };

            this.activeProcesses.set(child.pid, processInfo);
            console.log(`[ProcessManager] Started PID ${child.pid} for ${duration / 60000} minutes`);

            // Auto-Maximize after launch
            setTimeout(() => {
                const maximizeCmd = `powershell -command "$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p) { $ws = Add-Type -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32ShowWindow -PassThru; $ws::ShowWindow($p.MainWindowHandle, 3); }"`;
                exec(maximizeCmd);
            }, 2000);

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
        if (this.rotationInterval) clearInterval(this.rotationInterval);
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
            // Get all running Telegram processes from OS, sorted by ID for consistent rotation
            exec('powershell -command "Get-Process Telegram -ErrorAction SilentlyContinue | Sort-Object Id | Select-Object -ExpandProperty Id"', (err, stdout) => {
                if (err || !stdout) return;

                const pids = stdout.trim().split(/\s+/).map(p => parseInt(p)).filter(n => !isNaN(n));
                if (pids.length === 0) return;

                // Deterministic rotation: find next in list
                let nextIndex = 0;
                if (this.lastFocusedPid) {
                    const lastIdx = pids.indexOf(this.lastFocusedPid);
                    if (lastIdx !== -1) {
                        nextIndex = (lastIdx + 1) % pids.length;
                    }
                }

                const targetPid = pids[nextIndex];
                this.lastFocusedPid = targetPid;

                // Focus command (Minimize -> Maximize -> Switch -> Wait 1s -> Click Menu at 41,53)
                const focusCmd = `powershell -command "$code = '[DllImport(\\"user32.dll\\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\\"user32.dll\\")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab); [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);'; $type = Add-Type -MemberDefinition $code -Name Win32WindowOps -Namespace Win32Functions -PassThru; $p = Get-Process -Id ${targetPid} -ErrorAction SilentlyContinue; if ($p) { $type::ShowWindowAsync($p.MainWindowHandle, 6); Start-Sleep -Milliseconds 250; $type::ShowWindowAsync($p.MainWindowHandle, 3); $type::SwitchToThisWindow($p.MainWindowHandle, $true); Start-Sleep -Seconds 1; $type::SetCursorPos(41, 53); $type::mouse_event(0x02, 0, 0, 0, 0); $type::mouse_event(0x04, 0, 0, 0, 0); }"`;
                exec(focusCmd);
            });
        } catch (e) {
            console.error('[ProcessManager] Rotation error:', e.message);
        }
    }

    killProcess(pid) {
        if (!this.activeProcesses.has(pid)) return;
        const proc = this.activeProcesses.get(pid);
        const { exePath } = proc;

        try {
            console.log(`[ProcessManager] Killing PID ${pid} (${proc.phoneNumber})`);

            // 1. Try standard process kill
            try { process.kill(pid); } catch (e) { }

            // 2. CRITICAL: Path-based Kill (Guarantee RAM cleanup even if PID changed)
            if (exePath) {
                const safePath = exePath.replace(/'/g, "''");
                const psCommand = `powershell -command "Get-WmiObject Win32_Process | Where-Object { $_.ExecutablePath -eq '${safePath}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;

                exec(psCommand, (err) => {
                    if (err) console.log(`[ProcessManager] Path-based kill failed/not found: ${exePath}`);
                    else console.log(`[ProcessManager] Successfully killed process at path: ${exePath}`);
                });
            } else {
                // Fallback to taskkill if no path stored (backwards compatibility)
                exec(`taskkill /PID ${pid} /F`);
            }
        } catch (e) {
            console.error(`[ProcessManager] Kill error for PID ${pid}:`, e.message);
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
