const fs = require('fs-extra');
const path = require('path');

class Logger {
    constructor() {
        this.logPath = path.join(process.cwd(), 'agent.log');
    }

    formatMessage(level, message) {
        const now = new Date();
        const timestamp = now.toISOString().replace(/T/, ' ').replace(/\..+/, '');
        return `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    }

    async log(level, message, error = null) {
        let fullMessage = message;
        if (error) {
            fullMessage += ` | Error: ${error.message}`;
            if (error.stack) {
                fullMessage += `\nStack Trace:\n${error.stack}`;
            }
        }

        const formatted = this.formatMessage(level, fullMessage);

        // Print to console
        if (level === 'error') console.error(formatted.trim());
        else console.log(formatted.trim());

        // Append to file
        try {
            await fs.appendFile(this.logPath, formatted);
        } catch (err) {
            console.error('Failed to write to log file:', err);
        }
    }

    info(msg) { this.log('info', msg); }
    success(msg) { this.log('success', msg); }
    error(msg, err) { this.log('error', msg, err); }
    warn(msg) { this.log('warn', msg); }
}

module.exports = new Logger();
