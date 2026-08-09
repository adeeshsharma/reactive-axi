// Shared across every framework adapter (not just Vite) - a bin-not-found or dev-server-crash
// failure looks the same shape regardless of which build tool produced it.

export class DevServerUnsupportedError extends Error {
  constructor(projectRoot, detected, supportedFrameworks) {
    super(
      detected
        ? `Detected framework "${detected}" at ${projectRoot}, but reactive-axi doesn't have an adapter for it yet (supported: ${supportedFrameworks.join(", ")})`
        : `Could not detect a supported dev server at ${projectRoot} (looked for: ${supportedFrameworks.join(", ")})`,
    );
    this.name = "DevServerUnsupportedError";
    this.projectRoot = projectRoot;
  }
}

export class DevServerSpawnError extends Error {
  constructor(projectRoot, detail) {
    super(`Dev server for ${projectRoot} failed to start: ${detail}`);
    this.name = "DevServerSpawnError";
    this.projectRoot = projectRoot;
  }
}
