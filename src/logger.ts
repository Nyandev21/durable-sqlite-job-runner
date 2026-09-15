export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, context?: LogContext): void;
  error(event: string, error: unknown, context?: LogContext): void;
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

export class JsonLogger implements Logger {
  readonly #write: (line: string) => void;
  readonly #now: () => Date;

  constructor(
    write: (line: string) => void = (line) => console.log(line),
    now: () => Date = () => new Date(),
  ) {
    this.#write = write;
    this.#now = now;
  }

  info(event: string, context: LogContext = {}): void {
    this.#emit("info", event, context);
  }

  error(event: string, error: unknown, context: LogContext = {}): void {
    this.#emit("error", event, { ...context, error: normalizeError(error) });
  }

  #emit(level: "info" | "error", event: string, context: LogContext): void {
    this.#write(JSON.stringify({
      timestamp: this.#now().toISOString(),
      level,
      event,
      ...context,
    }));
  }
}

export const consoleLogger: Logger = new JsonLogger();
export const silentLogger: Logger = {
  info() {},
  error() {},
};
