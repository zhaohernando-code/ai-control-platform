function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function normalizeCliPort(value) {
  const raw = String(value ?? "").trim();
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new Error(`Invalid workbench server port: ${raw || "(empty)"}. Expected an integer from 0 to 65535.`);
    error.code = "INVALID_WORKBENCH_PORT";
    throw error;
  }
  return port;
}

export function parseWorkbenchServerCliArgs(args = process.argv.slice(2), env = process.env, defaults = {}) {
  if (args.includes("--serve-legacy-static") || env.AI_CONTROL_WORKBENCH_SERVE_LEGACY_STATIC === "1") {
    throw Object.assign(new Error("legacy static Workbench serving has been retired; serve the Workbench through the Next.js App Router runtime"), { code: "LEGACY_STATIC_WORKBENCH_RETIRED" });
  }

  const optionNames = new Set(["--host", "--port", "--history-path", "--snapshots-root", "--events-path", "--project-status", "--state-db"]);
  const optionsWithValues = new Set(["--host", "--port", "--history-path", "--snapshots-root", "--events-path", "--project-status", "--state-db"]);
  const positionalArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValues.has(arg.split("=")[0])) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (optionNames.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positionalArgs.push(arg);
  }

  const optionValue = (name) => {
    const equalsPrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) return inline.slice(equalsPrefix.length);
    return valueAfter(name, args);
  };
  const portValue = args.includes("--port")
    || args.some((arg) => arg.startsWith("--port="))
    ? optionValue("--port")
    : env.PORT ?? positionalArgs[0] ?? "4180";
  return {
    port: normalizeCliPort(portValue),
    host: optionValue("--host") || "127.0.0.1",
    historyPath: optionValue("--history-path"),
    snapshotsRoot: optionValue("--snapshots-root"),
    eventsPath: optionValue("--events-path"),
    projectStatusPath: optionValue("--project-status"),
    stateDbPath: optionValue("--state-db") || env.AI_CONTROL_WORKBENCH_STATE_DB || defaults.defaultStateDbPath
  };
}

export function workbenchServerHelpText() {
  return [
    "Usage: node tools/workbench-server.mjs [port] [--host <host>] [--port <port>] [--history-path <path>] [--snapshots-root <path>] [--events-path <path>] [--project-status <path>] [--state-db <path>]",
    "",
    "Starts the local workbench API service. Paths are resolved from the platform repo root. When --state-db is set, live workbench state is stored in SQLite instead of tracked JSON state files.",
    "",
    "Workbench pages are served by the Next.js App Router runtime. This API service no longer serves the retired native HTML shell."
  ].join("\n");
}
