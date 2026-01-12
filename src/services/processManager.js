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
        // Fast check: Check if PID exists using Node.js native signal
        if (pid) {
            try {
                process.kill(pid, 0); // Throws if PID doesn't exist
                return true;
            } catch (e) {
                // PID doesn't exist, proceed to path check (handle PID reuse or crash)
                if (e.code === 'EPERM') return true; // Exists but no permission (still running)
            }
        }

        // Fallback: Path check using tasklist (much lighter than PowerShell)
        return this.verifyByPath(exePath);
    }

    async verifyByPath(safePath) {
        if (!safePath) return false;
        const filename = path.basename(safePath);

        return new Promise((resolve) => {
            // Use tasklist with filter (faster than Get-CimInstance)
            // IM = Image Name
            exec(`tasklist /FI "IMAGENAME eq ${filename}" /FO CSV /NH`, (err, stdout) => {
                if (err || !stdout) {
                    resolve(false);
                    return;
                }
                // stdout contains lines if process exists
                resolve(stdout.toLowerCase().includes(filename.toLowerCase()));
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

        // 2. Enforce dynamic limit (FIFO) - LRU Style
        if (this.activeProcesses.size >= this.settings.maxProcesses) {
            // Sort by startTime to get absolute oldest
            const sortedByAge = Array.from(this.activeProcesses.entries())
                .sort((a, b) => a[1].startTime - b[1].startTime);

            // Kill oldest enough to make room
            while (this.activeProcesses.size >= this.settings.maxProcesses && sortedByAge.length > 0) {
                const [oldestPid, oldestProc] = sortedByAge.shift();
                logger.info(`Limit of ${this.settings.maxProcesses} reached. Killing oldest process (PID: ${oldestPid}, Account: ${oldestProc.phoneNumber}) for new slot.`);
                this.killProcess(oldestPid);
                // No long await here, killProcess handles its own async cleanup but we want to move fast
            }

            // Short grace period for OS to release handles
            await new Promise(resolve => setTimeout(resolve, 1000));
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
            // Get running Telegram processes using WindowHelper (much faster/lighter using User32.dll)
            // If WindowHelper not available, use tasklist

            // For now, we rely on tasklist to find PIDs quickly without PowerShell
            exec('tasklist /FI "IMAGENAME eq Telegram.exe" /FO CSV /NH', (err, stdout) => {
                if (err || !stdout) return;

                // Parse CSV output: "Image Name","PID","Session Name","Session#","Mem Usage"
                // "Telegram.exe","1234","Console","1","50,000 K"
                const pids = [];
                const lines = stdout.trim().split('\n');

                lines.forEach(line => {
                    const parts = line.split(',');
                    if (parts.length >= 2) {
                        // Remove quotes and parse PID
                        const pidStr = parts[1].replace(/"/g, '');
                        const pid = parseInt(pidStr);
                        if (!isNaN(pid)) pids.push(pid);
                    }
                });

                if (pids.length === 0) return;

                // Rot logic remains same...
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

                // Use the lightweight WindowHelper for rotation
                if (fs.existsSync(this.helperExe)) {
                    // logger.info(`Rotating focus to PID: ${targetPid}`); // Reduced logging
                    exec(`"${this.helperExe}" rotate ${targetPid} 41 53`);
                }
            });
        } catch (e) {
            logger.error('Rotation error:', e);
        }
    } catch(e) {
        logger.error('Rotation error:', e);
    }
}

killProcess(pid) {
    if (!this.activeProcesses.has(pid)) return;
    const proc = this.activeProcesses.get(pid);
    const { exePath } = proc;

    try {
        logger.info(`Killing PID ${pid} (${proc.phoneNumber})`);

        // 2. CRITICAL: Cleanup using standard TaskKill (No PowerShell)
        // Taskkill is robust and native. /T kills child processes too.
        // First try nice kill
        try {
            process.kill(pid);
        } catch (e) { }

        // Then force kill by PID
        exec(`taskkill /PID ${pid} /T /F`, (err) => {
            // Ignore "process not found" errors as it means success
        });

        // Path based backup is too expensive with PS. We rely on PID tracking.
        if (exePath) {
            // only if absolutely needed, maybe check if file is locked?
            // For now, dropping the heavy PS path check. FIFO logic should handle limits.
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
