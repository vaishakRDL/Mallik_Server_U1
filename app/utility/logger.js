const pino = require("pino");

const isProd = process.env.NODE_ENV === "production";

function createLogger() {
  // COMMON Pino base settings
  const baseLoggerConfig = {
    level: isProd ? "info" : "debug",
    base: null,               // removes pid & hostname (clean logs)
    timestamp: pino.stdTimeFunctions.isoTime, // ISO timestamps
  };

  // ------------------ PACKAGED EXE (pkg) ------------------
  // pino.transport() runs in a worker thread that loads its target with a dynamic import(),
  // which a pkg-built exe cannot do (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
  // Write through in-process streams instead; output and levels are the same as below.
  if (process.pkg) {
    if (!isProd) {
      const pretty = require("pino-pretty");
      return pino(
        baseLoggerConfig,
        pino.multistream([
          {
            level: "debug",
            stream: pretty({
              colorize: true,
              translateTime: "yyyy-mm-dd HH:MM:ss",
              ignore: "pid,hostname",
            }),
          },
        ])
      );
    }

    return pino(
      baseLoggerConfig,
      pino.multistream([
        {
          level: "error",
          stream: pino.destination({ dest: "error.log", mkdir: true }),
        },
      ])
    );
  }

  // ------------------ DEVELOPMENT ------------------
  if (!isProd) {
    return pino(
      baseLoggerConfig,
      pino.transport({
        targets: [
          {
            target: "pino-pretty",
            level: "debug",
            options: {
              colorize: true,
              translateTime: "yyyy-mm-dd HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
        ],
      })
    );
  }

  // ------------------ PRODUCTION -------------------
  return pino(
    baseLoggerConfig,
    pino.transport({
      targets: [
        // Error logs
        {
          target: "pino/file",
          level: "error",
          options: {
            destination: "error.log",
            mkdir: true,
          },
        },
      ],
    })
  );
}

module.exports = createLogger();
