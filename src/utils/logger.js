import { createLogger as winstonCreateLogger, format, transports } from 'winston';

const { combine, timestamp, printf, colorize, errors, splat } = format;

const lineFormat = printf(({ level, message, label, timestamp: ts, stack }) => {
  const tag = label ? `[${label}] ` : '';
  return `${ts} ${level}: ${tag}${stack || message}`;
});

export function createLogger(label = 'FormaFlow') {
  return winstonCreateLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    format: combine(
      colorize(),
      timestamp({ format: 'HH:mm:ss' }),
      errors({ stack: true }),
      format.label({ label }),
      splat(),
      lineFormat
    ),
    transports: [new transports.Console()]
  });
}

export const logger = createLogger('FormaFlow');
