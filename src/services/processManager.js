const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');

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

        if (wMax) this.settings.warmupMax = parseInt(wMax) * 60 * 1000;

        logger.info(`Settings updated: MaxProcesses=${this.settings.maxProcesses}, Rotation=${this.settings.rotationInterval}s`);
    }

    async verifyProcessRunning(exePath, pid) {
        if (!exePath) return false;
        // Escape single quotes for PowerShell
        const safePath = exePath.replace(/'/g, "''").toLowerCase();

        return new Promise((resolve) => {
            // First check by PID for performance if possible
            if (pid) {
                const checkPidCmd = `powershell -command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Id"`;
                exec(checkPidCmd, (err, stdout) => {
                    if (!err && stdout && parseInt(stdout.trim()) === pid) {
                        resolve(true);
                        return;
                    }
                    // If PID check fails, fallback to path-based check
                    this.verifyByPath(safePath).then(resolve);
                });
            } else {
                this.verifyByPath(safePath).then(resolve);
            }
        });
    }

    async verifyByPath(safePath) {
        // Get-CimInstance is efficient. We compare lowercase paths to avoid casing issues.
        const psCommand = `powershell -command "(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower() -eq '${safePath}' } | Measure-Object).Count"`;

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
        // We do this carefully to avoid race conditions
        const pidsToVerify = Array.from(this.activeProcesses.keys());
        for (const pid of pidsToVerify) {
            const proc = this.activeProcesses.get(pid);
            const isActuallyRunning = await this.verifyProcessRunning(proc.exePath, pid);
            if (!isActuallyRunning) {
                logger.warn(`Stale process detected for ${proc.phoneNumber} (PID: ${pid}). Removing from map.`);
                this.activeProcesses.delete(pid);
            }
        }

        // 2. Enforce dynamic limit (FIFO)
        if (oldestPid) {
            logger.info(`Limit of ${this.settings.maxProcesses} reached. Killing oldest process (PID: ${oldestPid}) for slot.`);
            this.killProcess(oldestPid);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait for cleanup
        }

        // 3. Check if already running (after safety cleanup)
        for (const [pid, proc] of this.activeProcesses) {
            if (proc.phoneNumber === phoneNumber) {
                logger.info(`Telegram already open for ${phoneNumber} (PID: ${pid})`);
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
            logger.success(`Launched Telegram for ${phoneNumber} (PID: ${child.pid}, Warmup: ${duration / 60000} min)`);

            // Auto-Maximize after launch using WindowHelper
            setTimeout(() => {
                if (fs.existsSync(this.helperExe)) {
                    logger.info(`Maximizing window for PID ${child.pid}`);
                    exec(`"${this.helperExe}" maximize ${child.pid}`);
                }
            }, 2000);

            return { success: true, pid: child.pid };
        } catch (err) {
            logger.error(`Launch error for ${phoneNumber}:`, err);
            throw err;
        }
    }

    checkExpirations() {
        const now = Date.now();
        for (const [pid, proc] of this.activeProcesses) {
            if (now - proc.startTime > proc.duration) {
                logger.info(`Time expired for ${proc.phoneNumber} (PID: ${pid}). Killing...`);
                this.killProcess(pid);
            }
        }
    }

    startRotation() {
        if (this.rotationInterval) clearInterval(this.rotationInterval);
        this.rotationEnabled = true;
        const intervalMs = this.settings.rotationInterval * 1000;
        this.rotationInterval = setInterval(() => this.rotateWindows(), intervalMs);
        logger.info(`Rotation started with ${this.settings.rotationInterval}s interval`);
    }

    stopRotation() {
        this.rotationEnabled = false;
        if (this.rotationInterval) {
            clearInterval(this.rotationInterval);
            this.rotationInterval = null;
        }
        logger.info('Rotation stopped');
    }

    async rotateWindows() {
        if (!this.rotationEnabled) return;

        try {
            // Get all running Telegram processes from OS
            exec('powershell -command "Get-Process Telegram -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', (err, stdout) => {
                if (err || !stdout) {
                    // If no processes found, just return
                    return;
                }

                const pids = stdout.trim().split(/\s+/).map(p => parseInt(p)).filter(n => !isNaN(n));
                if (pids.length === 0) return;

                // Update our internal tracking map based on what's actually running
                // Any PID in pids that isn't in activeProcesses but matches a phoneNumber folder should ideally be tracked,
                // but for now we focus on ensuring lastFocusedPid is valid.

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
                    logger.info(`Rotating focus to PID: ${targetPid} (Total: ${pids.length})`);
                    exec(`"${this.helperExe}" rotate ${targetPid} 41 53`);
                }
            });
        } catch (e) {
            logger.error('Rotation error:', e);
        }
    }

    killProcess(pid) {
        if (!this.activeProcesses.has(pid)) return;
        const proc = this.activeProcesses.get(pid);
        const { exePath } = proc;

        try {
            logger.info(`Killing PID ${pid} (${proc.phoneNumber})`);

            // 1. Try standard process kill
            try { process.kill(pid); } catch (e) { }

            // 2. CRITICAL: Path-based Kill (Guarantee RAM cleanup even if PID changed)
            if (exePath) {
                const safePath = exePath.replace(/'/g, "''");
                const psCommand = `powershell -command "Get-CimInstance Win32_Process -Filter \\"ExecutablePath = '${safePath}'\\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;

                exec(psCommand, (err) => {
                    if (err) logger.warn(`Path-based kill failed: ${exePath}`);
                    else logger.success(`Successfully killed process at path: ${exePath}`);
                });
            } else {
                exec(`taskkill /PID ${pid} /F`);
            }
        } catch (e) {
            logger.error(`Kill error for PID ${pid}:`, e);
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
