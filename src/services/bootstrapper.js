const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');

class Bootstrapper {
    constructor() {
        this.basePath = path.join(__dirname, '../../');
        this.telegramZipUrl = 'https://telegram.org/dl/desktop/win64_portable';
        this.githubRepoUrl = 'https://github.com/furkanakin/VDSmakro/archive/refs/heads/main.zip';
    }

    async bootstrap() {
        console.log('[Bootstrap] Starting initialization sequence...');

        // 1. Ensure essential folders exist
        await fs.ensureDir(path.join(this.basePath, 'data'));
        await fs.ensureDir(path.join(this.basePath, 'Telegram'));
        await fs.ensureDir(path.join(this.basePath, 'hesaplar'));

        // 2. Download and Setup Telegram Portable
        await this.setupTelegram();

        // 3. Check for app updates (optional logic, can be extended)
        // Since we are running the program, "updating" might involve a restart.
        // For now, let's implement the download logic as requested.
        console.log('[Bootstrap] Initialization complete.');
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
            zip.extractAllTo(path.join(this.basePath, 'Telegram'), true);

            console.log('[Bootstrap] Telegram Portable setup complete.');
            // await fs.remove(zipPath); // Optional: keep or delete
        } catch (err) {
            console.error('[Bootstrap] Failed to setup Telegram:', err.message);
        }
    }

    async updateFromGithub() {
        console.log('[Bootstrap] Checking for system updates from GitHub...');
        // Implementation for downloading all files excluding node_modules
        // This is tricky if the app is currently running. Usually requires a launcher/updater script.
        // For now, I'll implement the downloader as requested.

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
            // We need to extract files one by one to avoid overwriting node_modules or extracting to a subfolder
            const zipEntries = zip.getEntries();

            zipEntries.forEach(entry => {
                // Skip node_modules and the root folder in the zip (GitHub adds a root folder)
                if (!entry.entryName.includes('node_modules')) {
                    const relativePath = entry.entryName.split('/').slice(1).join('/');
                    if (relativePath) {
                        const targetPath = path.join(this.basePath, relativePath);
                        if (entry.isDirectory) {
                            fs.ensureDirSync(targetPath);
                        } else {
                            fs.writeFileSync(targetPath, entry.getData());
                        }
                    }
                }
            });

            console.log('[Bootstrap] GitHub update complete.');
        } catch (err) {
            console.error('[Bootstrap] Failed to update from GitHub:', err.message);
        }
    }
}

module.exports = new Bootstrapper();
