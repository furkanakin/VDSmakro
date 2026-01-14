const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const logger = require('./logger');
const processManager = require('./processManager');

class Bootstrapper {
    constructor() {
        this.basePath = path.join(__dirname, '../../');
        this.telegramZipUrl = 'https://telegram.org/dl/desktop/win64_portable';
        this.githubRepoUrl = 'https://github.com/furkanakin/VDSmakro/archive/refs/heads/main.zip';
        this.githubPackageUrl = 'https://raw.githubusercontent.com/furkanakin/VDSmakro/main/package.json';
    }

    async bootstrap() {
        logger.info('Starting initialization sequence...');

        // 0. Force cleanup of any 'ghost' Telegram processes from previous runs
        processManager.forceKillAllTelegramProcesses();

        // 1. Ensure essential folders exist
        await fs.ensureDir(path.join(this.basePath, 'data'));
        await fs.ensureDir(path.join(this.basePath, 'Telegram'));
        await fs.ensureDir(path.join(this.basePath, 'hesaplar'));

        // 2. Download and Setup Telegram Portable
        await this.setupTelegram();

        // 3. Check for app updates
        await this.checkForUpdates();

        console.log('[Bootstrap] Initialization complete.');
    }

    async checkForUpdates() {
        try {
            const { version: currentVersion } = require('../../package.json');
            logger.info(`Current version: v${currentVersion}. Checking for updates...`);

            // Add timestamp to bypass GitHub cache
            const response = await axios.get(`${this.githubPackageUrl}?t=${Date.now()}`);
            const remoteVersion = response.data.version;

            console.log(`[Bootstrap] Remote version: v${remoteVersion}`);

            if (this.isNewer(remoteVersion, currentVersion)) {
                console.log('[Bootstrap] A newer version is available. Starting automatic update...');
                await this.updateFromGithub(false); // Not forced, just standard update
            } else {
                console.log('[Bootstrap] Already up to date or local version is newer.');
            }
        } catch (err) {
            console.error('[Bootstrap] Failed to check for updates:', err.message);
        }
    }

    isNewer(remote, local) {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if (r[i] > l[i]) return true;
            if (r[i] < l[i]) return false;
        }
        return false;
    }

    async setupTelegram() {
        const telegramExe = path.join(this.basePath, 'Telegram/Telegram.exe');
        if (await fs.pathExists(telegramExe)) {
            console.log('[Bootstrap] Telegram.exe already exists, skipping download.');
            return;
        }

        console.log('[Bootstrap] Downloading Telegram Portable...');
        const zipPath = path.join(this.basePath, 'data/telegram_portable.zip');

        try {
            const response = await axios({
                url: this.telegramZipUrl,
                method: 'GET',
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(zipPath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log('[Bootstrap] Extracting Telegram Portable...');
            const zip = new AdmZip(zipPath);
            const tempExtractPath = path.join(this.basePath, 'data/temp_tg');
            await fs.ensureDir(tempExtractPath);
            zip.extractAllTo(tempExtractPath, true);

            // The zip usually contains a "Telegram" folder. Move its contents directly to our target.
            const internalTgPath = path.join(tempExtractPath, 'Telegram');
            const targetTgPath = path.join(this.basePath, 'Telegram');

            if (await fs.pathExists(internalTgPath)) {
                await fs.copy(internalTgPath, targetTgPath, { overwrite: true });
            } else {
                // If it doesn't have an internal Telegram folder, copy everything directly
                await fs.copy(tempExtractPath, targetTgPath, { overwrite: true });
            }

            await fs.remove(tempExtractPath);
            console.log('[Bootstrap] Telegram Portable setup complete.');
            // await fs.remove(zipPath); // Optional: keep or delete
        } catch (err) {
            console.error('[Bootstrap] Failed to setup Telegram:', err.message);
        }
    }

    async updateFromGithub(isForced = true) {
        if (isForced) {
            console.log('[Bootstrap] Force update triggered from Master...');
        }
        console.log('[Bootstrap] Downloading updates from GitHub...');
        const zipPath = path.join(this.basePath, 'data/update.zip');

        try {
            const response = await axios({
                url: this.githubRepoUrl,
                method: 'GET',
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(zipPath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log('[Bootstrap] Extracting updates...');
            const zip = new AdmZip(zipPath);
            const zipEntries = zip.getEntries();
            const rootFolderInZip = zipEntries[0].entryName.split('/')[0];

            for (const entry of zipEntries) {
                // Skip the root folder entry itself and anything in node_modules or data
                if (entry.isDirectory ||
                    entry.entryName.includes('node_modules') ||
                    entry.entryName.includes('data/') ||
                    entry.entryName.includes('hesaplar/') ||
                    entry.entryName.includes('.env')) {
                    continue;
                }

                // Remove the root folder name from GitHub zip
                const relativePath = entry.entryName.replace(rootFolderInZip + '/', '');
                if (!relativePath) continue;

                const targetPath = path.join(this.basePath, relativePath);
                await fs.ensureDir(path.dirname(targetPath));

                // Read content and write
                const content = entry.getData();
                await fs.writeFile(targetPath, content);
            }

            console.log('[Bootstrap] Update applied successfully. Restarting in 3 seconds...');

            // Clean up active telegrams before exit
            processManager.killAll();

            // Wait a bit then exit - Baslat.bat will restart us
            setTimeout(() => {
                process.exit(0);
            }, 3000);

            return true;
        } catch (err) {
            console.error('[Bootstrap] Update failed:', err.message);
            return false;
        }
    }
}

module.exports = new Bootstrapper();
