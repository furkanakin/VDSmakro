const io = require('socket.io-client');
const axios = require('axios');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const processManager = require('./processManager');
const streamManager = require('./streamManager');
const copierService = require('./copierService');
const bootstrapper = require('./bootstrapper');
const logger = require('./logger');

class SocketClient {
    constructor() {
        this.socket = null;
        this.managerUrl = process.env.MANAGER_URL || 'https://bot.takeyourpart.com';
        this.serverId = this.loadServerId();
        this.connected = false;
        this.heartbeatInterval = null;
        this.sessionCache = [];
        this.lastSessionUpdate = 0;
    }

    loadServerId() {
        const idPath = path.join(__dirname, '../../data/server_id.txt');
        if (fs.existsSync(idPath)) {
            return fs.readFileSync(idPath, 'utf8').trim();
        }
        const newId = uuidv4();
        fs.ensureDirSync(path.dirname(idPath));
        fs.writeFileSync(idPath, newId);
        return newId;
    }

    connect(url) {
        if (url) this.managerUrl = url;

        logger.info(`Connecting to Master: ${this.managerUrl}...`);

        this.socket = io(this.managerUrl, {
            reconnection: true,
            reconnectionAttempts: Infinity
        });

        streamManager.setSocket(this.socket);
        streamManager.serverId = this.serverId;

        this.socket.on('connect', () => {
            logger.success(`Connected to Master Server: ${this.managerUrl}`);
            this.connected = true;
            this.register();
            this.startHeartbeat();
        });

        this.socket.on('disconnect', (reason) => {
            logger.warn(`Disconnected from Master: ${reason}`);
            this.connected = false;
            this.stopHeartbeat();
            streamManager.stopStream(); // Ensure stream stops on disconnect
        });

        this.socket.on('connect_error', (err) => {
            logger.error('Socket connection error:', err);
        });

        // Remote Commands
        this.socket.on('macro:command', async (command) => {
            logger.info(`Received command: ${command.type} ${command.phoneNumber || ''}`);

            try {
                switch (command.type) {
                    case 'open_telegram':
                        if (command.phoneNumber) {
                            const res = await processManager.launchTelegram(command.phoneNumber);
                            if (res.success) {
                                this.socket.emit('macro:process_started', {
                                    accountId: command.accountId,
                                    phoneNumber: command.phoneNumber,
                                    pid: res.pid,
                                    status: 'started'
                                });
                                this.sendLog(`Telegram bașlatıldı: ${command.phoneNumber} (PID: ${res.pid})`, 'success');
                            }
                        }
                        break;

                    case 'kill_telegram':
                    case 'kill_all_telegram':
                        logger.info('Master requested to kill all Telegram processes');
                        processManager.killAll();
                        this.sendLog('Tüm Telegram süreçleri sonlandırıldı.', 'success');
                        break;

                    case 'copy_telegram_exe':
                        logger.info('Master requested Telegram.exe sync');
                        const result = await copierService.copyTelegramToAccounts();
                        this.sendLog(`Kopyalama tamamlandı: ${result.successful} başarılı, ${result.skipped} atlanan.`, 'success');
                        break;

                    case 'minimize_all':
                        logger.info('Master requested minimize all windows');
                        const { exec } = require('child_process');
                        exec('powershell -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"');
                        break;

                    case 'sync_sessions':
                        logger.info('Master requested session sync');
                        const sessions = await this.getSessions();
                        this.socket.emit('macro:update_sessions', sessions);
                        this.sendLog(`Sessison senkronize edildi: ${sessions.length} adet.`, 'success');
                        break;

                    case 'update_agent':
                        logger.info('Master requested agent update');
                        this.sendLog('Sistem güncellemesi bașlatıldı. Program indiriliyor ve yeniden bașlatılacak...', 'success');
                        const updateRes = await bootstrapper.updateFromGithub(true); // Force update
                        if (!updateRes) {
                            logger.error('Agent update failed');
                            this.sendLog('Hata: Güncelleme bașarısız oldu.', 'error');
                        }
                        break;

                    default:
                        logger.warn(`Unknown command type received: ${command.type}`);
                }
            } catch (err) {
                logger.error(`Command execution failed (${command.type}):`, err);
                this.sendLog(`Hata: ${err.message}`, 'error');
            }
        });

        this.socket.on('macro:get_details', async () => {
            const sessions = await this.getSessions();
            const processes = Array.from(processManager.activeProcesses.values()).map(p => {
                const elapsed = Date.now() - p.startTime;
                const remainingMs = Math.max(0, p.duration - elapsed);
                const mins = Math.floor(remainingMs / 60000);
                const secs = Math.floor((remainingMs % 60000) / 1000);
                return {
                    pid: p.pid,
                    phoneNumber: p.phoneNumber,
                    accountName: p.phoneNumber,
                    remainingTime: `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
                };
            });

            this.socket.emit('macro:node_details', {
                serverId: this.serverId,
                details: {
                    accounts: sessions.map(s => ({ phone_number: s, is_active: true })),
                    activeProcesses: processes,
                    disk: await this.getDiskInfo()
                }
            });
        });

        this.socket.on('macro:start_stream', () => streamManager.startStream());
        this.socket.on('macro:stop_stream', () => streamManager.stopStream());

        this.socket.on('macro:update_settings', (settings) => {
            processManager.updateSettings(settings);
            streamManager.updateSettings(settings);
        });

        this.socket.on('macro:get_screenshot', async () => {
            const image = await streamManager.getScreenshot();
            this.socket.emit('macro:screenshot', { serverId: this.serverId, image });
        });

        this.socket.on('macro:remote_input', (data) => {
            streamManager.handleRemoteInput(data);
        });
    }

    async getSessions(forceRefresh = false) {
        try {
            const now = Date.now();
            // Cache for 60 seconds unless forced
            if (!forceRefresh && this.sessionCache.length > 0 && (now - this.lastSessionUpdate < 60000)) {
                return this.sessionCache;
            }

            const accountsDir = path.join(__dirname, '../../hesaplar');
            if (!fs.existsSync(accountsDir)) return [];

            // Use withFileTypes to avoid separate stat calls, and readdir is async
            const entries = await fs.readdir(accountsDir, { withFileTypes: true });
            this.sessionCache = entries
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            this.lastSessionUpdate = now;
            return this.sessionCache;
        } catch (err) {
            logger.error('Session retrieval error:', err);
            return this.sessionCache || [];
        }
    }

    sendLog(message, type = 'info') {
        if (this.socket && this.connected) {
            this.socket.emit('macro:log', {
                serverId: this.serverId,
                message,
                type,
                timestamp: new Date()
            });
        }
    }

    async register() {
        const { version } = require('../../package.json');
        const sessions = await this.getSessions();
        let publicIp = '0.0.0.0';
        const ipProviders = [
            'https://api.ipify.org',
            'https://checkip.amazonaws.com',
            'https://ifconfig.me/ip',
            'https://ident.me',
            'https://api.ip.sb/ip'
        ];

        for (const provider of ipProviders) {
            try {
                const res = await axios.get(provider, { timeout: 8000 });
                if (res.data) {
                    publicIp = res.data.toString().trim();
                    if (publicIp.split('.').length === 4) {
                        console.log(`[Socket] Public IP detected via ${provider}: ${publicIp}`);
                        break;
                    }
                }
            } catch (e) {
                // Try next
            }
        }

        if (publicIp === '0.0.0.0') {
            console.error('[Socket] ERROR: Could not detect public IP from any provider!');
        }

        const info = {
            id: this.serverId,
            ip: publicIp,
            version: version, // Version added
            name: os.hostname(),
            platform: os.platform(),
            type: 'macro-node',
            availableSessions: sessions
        };
        this.socket.emit('macro:register', info);
    }

    startHeartbeat() {
        let heartbeatCount = 0;
        this.heartbeatInterval = setInterval(async () => {
            heartbeatCount++;
            const disk = await this.getDiskInfo();
            const cpu = await this.getCpuUsage();
            const sessions = await this.getSessions(false);

            const stats = {
                cpu: Math.round(cpu),
                ram: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
                accountCount: sessions.length,
                telegramCount: processManager.activeProcesses.size,
                disk: disk
            };
            this.socket.emit('macro:heartbeat', stats);

            // Sync sessions every 60 seconds (12 * 5s) instead of 30s
            // and force a refresh here
            if (heartbeatCount % 12 === 0) {
                this.socket.emit('macro:update_sessions', await this.getSessions(true));
            }
        }, 5000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }

    async getCpuUsage() {
        return new Promise((resolve) => {
            try {
                const { exec } = require('child_process');
                exec('powershell -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"', (err, stdout) => {
                    if (err) return resolve(0);
                    resolve(parseFloat(stdout) || 0);
                });
            } catch (e) {
                console.error('[Socket] getCpuUsage spawn error:', e.message);
                resolve(0);
            }
        });
    }

    async getDiskInfo() {
        return new Promise((resolve) => {
            try {
                const { exec } = require('child_process');
                exec('powershell -Command "Get-PSDrive C | Select-Object @{Name=\'Total\';Expression={($_.Used + $_.Free) / 1GB}}, @{Name=\'Free\';Expression={$_.Free / 1GB}} | ConvertTo-Json"', (err, stdout) => {
                    if (err) return resolve({ total: 0, free: 0, used: 0, percent: 0 });
                    try {
                        const data = JSON.parse(stdout);
                        const total = Math.round(data.Total);
                        const free = Math.round(data.Free);
                        const used = total - free;
                        const percent = Math.round((used / total) * 100);
                        resolve({ total, free, used, percent });
                    } catch (e) {
                        resolve({ total: 0, free: 0, used: 0, percent: 0 });
                    }
                });
            } catch (e) {
                console.error('[Socket] getDiskInfo spawn error:', e.message);
                resolve({ total: 0, free: 0, used: 0, percent: 0 });
            }
        });
    }
}

module.exports = new SocketClient();
