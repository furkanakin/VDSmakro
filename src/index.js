require('dotenv').config();
const bootstrapper = require('./services/bootstrapper');
const socketClient = require('./services/socketClient');
const processManager = require('./services/processManager');
const logger = require('./services/logger');

const { version } = require('../package.json');

async function main() {
    console.log('====================================');
    console.log(`   VDS MAKRO AGENT v${version}    `);
    console.log('====================================');

    logger.info(`Agent starting... v${version}`);

    // Set console title
    process.stdout.write(`\x1b]0;VDS MAKRO AGENT v${version}\x07`);

    try {
        // 1. Run bootstrap (Setup Telegram & Check for updates)
        await bootstrapper.bootstrap();

        // 2. Connect to Master Server
        const managerUrl = process.env.MANAGER_URL || 'https://bot.takeyourpart.com';
        socketClient.connect(managerUrl);

        logger.info(`Agent is running and waiting for commands (Master: ${managerUrl})`);

        // 4. Handle graceful shutdown
        const shutdown = (signal) => {
            console.log(`[Main] ${signal} received. Shutting down...`);
            processManager.killAll();
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // Handle unexpected crashes
        process.on('uncaughtException', (err) => {
            logger.error('Uncaught Exception:', err);
            processManager.killAll();
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
            processManager.killAll();
            process.exit(1);
        });

    } catch (err) {
        logger.error('Critical error during startup:', err);
        process.exit(1);
    }
}

main();
