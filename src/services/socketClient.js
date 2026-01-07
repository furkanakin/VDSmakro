const io = require('socket.io-client');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const processManager = require('./processManager');
const streamManager = require('./streamManager');
const copierService = require('./copierService');

class SocketClient {
    constructor() {
        this.socket = null;
        this.managerUrl = process.env.MANAGER_URL || 'https://bot.takeyourpart.com';
        this.serverId = this.loadServerId();
        this.connected = false;
        this.heartbeatInterval = null;
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

        console.log(`[Socket] Connecting to ${this.managerUrl}...`);

        this.socket = io(this.managerUrl, {
            reconnection: true,
            reconnectionAttempts: Infinity
        });

        streamManager.setSocket(this.socket);
        streamManager.serverId = this.serverId;

        this.socket.on('connect', () => {
            console.log('[Socket] Connected to Manager');
            this.connected = true;
            this.register();
            this.startHeartbeat();
        });

        this.socket.on('disconnect', () => {
            console.log('[Socket] Disconnected');
            this.connected = false;
            this.stopHeartbeat();
        });

        // Remote Commands
        this.socket.on('macro:command', async (command) => {
            console.log('[Socket] Received command:', command.type);

            try {
                switch (command.type) {
                    case 'open_telegram':
                        if (command.phoneNumber) {
                            await processManager.launchTelegram(command.phoneNumber);
                            this.sendLog(`Telegram başlatıldı: ${command.phoneNumber}`, 'success');
                        }
                        break;

                    case 'kill_telegram':
                    case 'kill_all_telegram':
                        processManager.killAll();
                        this.sendLog('Tüm Telegram süreçleri sonlandırıldı.', 'success');
                        break;

                    case 'copy_telegram_exe':
                        const result = await copierService.copyTelegramToAccounts();
                        this.sendLog(`Kopyalama tamamlandı: ${result.successful} başarılı, ${result.skipped} atlanan.`, 'success');
                        break;

                    case 'minimize_all':
                        const { exec } = require('child_process');
                        exec('powershell -Command "(New-Object -ComObject Shell.Application).MinimizeAll()"');
                        break;

                    case 'sync_sessions':
                        const sessions = await this.getSessions();
                        this.socket.emit('macro:update_sessions', sessions);
                        this.sendLog(`Sessison senkronize edildi: ${sessions.length} adet.`, 'success');
                        break;

                    default:
                        console.log('[Socket] Unknown command:', command.type);
                }
            } catch (err) {
                this.sendLog(`Hata: ${err.message}`, 'error');
            }
        });

        this.socket.on('macro:get_details', async () => {
            const sessions = await this.getSessions();
            this.socket.emit('macro:node_details', {
                serverId: this.serverId,
                details: {
                    accounts: sessions.map(s => ({ phone_number: s, is_active: true })),
                    activeProcesses: processManager.activeProcesses.size,
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
    }

    async getSessions() {
        const accountsDir = path.join(__dirname, '../../hesaplar');
        if (!fs.existsSync(accountsDir)) return [];
        const folders = await fs.readdir(accountsDir);
        return folders.filter(f => fs.statSync(path.join(accountsDir, f)).isDirectory());
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
            'https://ifconfig.me/ip',
            'https://ident.me'
        ];

        for (const provider of ipProviders) {
            try {
                const res = await axios.get(provider, { timeout: 5000 });
                if (res.data && typeof res.data === 'string') {
                    publicIp = res.data.trim();
                    break;
                }
            } catch (e) {
                // Try next
            }
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
        this.heartbeatInterval = setInterval(async () => {
            const disk = await this.getDiskInfo();
            const cpu = await this.getCpuUsage();
            const stats = {
                cpu: Math.round(cpu),
                ram: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
                accountCount: (await this.getSessions()).length,
                telegramCount: processManager.activeProcesses.size,
                disk: disk
            };
            this.socket.emit('macro:heartbeat', stats);
        }, 5000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }

    async getCpuUsage() {
        return new Promise((resolve) => {
            const { exec } = require('child_process');
            exec('powershell -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"', (err, stdout) => {
                if (err) return resolve(0);
                resolve(parseFloat(stdout) || 0);
            });
        });
    }

    async getDiskInfo() {
        return new Promise((resolve) => {
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
        });
    }
}

module.exports = new SocketClient();
