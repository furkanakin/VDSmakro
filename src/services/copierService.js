const fs = require('fs-extra');
const path = require('path');

class CopierService {
    constructor() {
        this.basePath = path.join(__dirname, '../../');
    }

    async copyTelegramToAccounts() {
        const sourceExe = path.join(this.basePath, 'Telegram/Telegram.exe');
        const accountsDir = path.join(this.basePath, 'hesaplar');

        if (!await fs.pathExists(sourceExe)) {
            throw new Error('Kaynak Telegram.exe bulunamadı. Lütfen "Telegram" klasörünü kontrol edin.');
        }

        if (!await fs.pathExists(accountsDir)) {
            throw new Error('"hesaplar" klasörü bulunamadı.');
        }

        console.log('[Copier] Kopyalama işlemi başlatılıyor...');
        const folders = await fs.readdir(accountsDir);
        let successCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const folder of folders) {
            const folderPath = path.join(accountsDir, folder);
            const stats = await fs.stat(folderPath);

            if (stats.isDirectory()) {
                const targetExe = path.join(folderPath, 'Telegram.exe');

                // If already exists, skip (as per previous python logic requirement "already exists, skipping")
                if (await fs.pathExists(targetExe)) {
                    console.log(`[Copier] Atlanıyor (Zaten var): ${folder}`);
                    skippedCount++;
                    continue;
                }

                try {
                    await fs.copy(sourceExe, targetExe);
                    successCount++;
                } catch (err) {
                    console.error(`[Copier] Hata (${folder}):`, err.message);
                    errorCount++;
                }
            }
        }

        const result = {
            success: true,
            successful: successCount,
            skipped: skippedCount,
            failed: errorCount,
            total: folders.length
        };

        console.log(`[Copier] İşlem tamamlandı. Başarılı: ${successCount}, Atlanan: ${skippedCount}, Hata: ${errorCount}`);
        return result;
    }
}

module.exports = new CopierService();
