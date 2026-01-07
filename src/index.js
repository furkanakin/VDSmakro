require('dotenv').config();
const bootstrapper = require('./services/bootstrapper');
const socketClient = require('./services/socketClient');
const processManager = require('./services/processManager');

const { version } = require('../package.json');

async function main() {
    console.log('====================================');
    console.log(`   VDS MAKRO AGENT v${version}    `);
    console.log('====================================');

    // Set console title
    process.stdout.write(`\x1b]0;VDS MAKRO AGENT v${version}\x07`);

    try {
        // 1. Run bootstrap (Setup Telegram & Check for updates)
        await bootstrapper.bootstrap();

        // 2. Perform GitHub update if needed
        // Note: In a real scenario, an update might require a process restart.
        // For this version, we'll download files as requested.
        await bootstrapper.updateFromGithub();

        // 3. Connect to Master Server
        const managerUrl = process.env.MANAGER_URL || 'https://bot.takeyourpart.com';
        socketClient.connect(managerUrl);

        console.log('[Main] Agent is running and waiting for commands...');

        // 4. Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('[Main] Shutting down...');
            processManager.killAll();
            process.exit();
        });

    } catch (err) {
        console.error('[Main] Critical error during startup:', err.message);
        process.exit(1);
    }
}

main();
