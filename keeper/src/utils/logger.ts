import winston from 'winston'
import path from 'path'
import fs from 'fs'

const logDir = 'logs'
fs.mkdirSync(logDir, { recursive: true }) // winston's File transport won't create it itself

const fileFormat = winston.format.combine(
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.errors({ stack: true }),
	winston.format.splat(),
	winston.format.json()
)

const consoleFormat = winston.format.combine(
	winston.format.colorize(),
	winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
	winston.format.printf(({ timestamp, level, message, ...meta }) => {
		let msg = `${timestamp} [${level}]: ${message}`
		if (Object.keys(meta).length > 0) msg += ` ${JSON.stringify(meta)}`
		return msg
	})
)

const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: fileFormat,
	transports: [
		new winston.transports.Console({ format: consoleFormat }),
		new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error', maxsize: 10_485_760, maxFiles: 5 }),
		new winston.transports.File({ filename: path.join(logDir, 'combined.log'), maxsize: 10_485_760, maxFiles: 10 }),
	],
})

export default logger
