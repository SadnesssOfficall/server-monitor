export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
}

export function createLogger(write: (line: string) => void): Logger {
  return {
    log: (level, message, fields = {}) => {
      write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
    },
  };
}

export const silentLogger: Logger = {
  log: () => undefined,
};
