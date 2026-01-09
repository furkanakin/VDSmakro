const { spawn, exec, execSync } = require('child_process');
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

        // C# Utility configuration
        this.helperExe = path.join(__dirname, 'WindowHelper.exe');
        this.helperSrc = path.join(__dirname, 'WindowHelper.cs');
        this.ensureHelperTool();

        // Check for expired processes every 5 seconds
        this.expirationInterval = setInterval(() => this.checkExpirations(), 5000);
    }

    /**
     * Compiles the C# WindowHelper utility if it doesn't exist.
     * This avoids heavy PowerShell JIT compilation (Add-Type) in loops.
     */
    ensureHelperTool() {
        if (fs.existsSync(this.helperExe)) return true;

        console.log('[ProcessManager] Compiling WindowHelper utility...');
        const cscPaths = [
            'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
            'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
        ];

        for (const csc of cscPaths) {
            if (fs.existsSync(csc)) {
                try {
                    const cmd = `"${csc}" /target:exe /out:"${this.helperExe}" "${this.helperSrc}"`;
                    execSync(cmd);
                    console.log('[ProcessManager] WindowHelper compiled successfully.');
                    return true;
                } catch (e) {
                    console.error(`[ProcessManager] Compilation failed with ${csc}:`, e.message);
                }
            }
        }
        return false;
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
        // Get-CimInstance is more efficient than Get-WmiObject
        const psCommand = `powershell -command "(Get-CimInstance Win32_Process -Filter \\"ExecutablePath = '${safePath}'\\" | Measure-Object).Count"`;

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

            // Auto-Maximize after launch using WindowHelper
            setTimeout(() => {
                if (fs.existsSync(this.helperExe)) {
                    exec(`"${this.helperExe}" maximize ${child.pid}`);
                }
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
            // Get all running Telegram processes from OS
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

                // Use the lightweight WindowHelper for rotation and clicking
                if (fs.existsSync(this.helperExe)) {
                    // rotate <pid> <click_x> <click_y>
                    exec(`"${this.helperExe}" rotate ${targetPid} 41 53`);
                }
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
                const psCommand = `powershell -command "Get-CimInstance Win32_Process -Filter \\"ExecutablePath = '${safePath}'\\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;

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
