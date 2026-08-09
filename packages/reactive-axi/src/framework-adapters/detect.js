import { readFile } from "node:fs/promises";
import path from "node:path";

// Prioritized, most-specific-first. A naive "has `vite` in deps -> plain Vite" check would
// misclassify TanStack Start: its own package.json carries a real `vite` devDependency
// (confirmed empirically while bootstrapping the tanstack-start fixture - it runs `vite dev`
// under the hood), so anything more specific than plain Vite must be checked first or it
// silently loses to the generic fallback. Next.js and CRA never carry a `vite` dependency at
// all (confirmed against the bootstrapped fixtures), so they were never actually at risk of
// this particular collision - but the ordering principle is what keeps the detector safe to
// extend further later, not luck.
const DETECTORS = [
  { framework: "tanstack-start", depName: "@tanstack/react-start" },
  { framework: "next", depName: "next" },
  { framework: "cra", depName: "react-scripts" },
  { framework: "vite", depName: "vite" },
];

/** @returns {Promise<string | null>} */
export async function detectFramework(projectRoot) {
  const packageJsonPath = path.join(projectRoot, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const { framework, depName } of DETECTORS) {
    if (deps[depName]) return framework;
  }
  return null;
}

// User-facing display names, shown in the chrome shell's topbar - not the same as the
// detector's internal framework id (e.g. "cra", not "Create React App").
const FRAMEWORK_LABELS = {
  vite: "Vite",
  "tanstack-start": "TanStack Start",
  next: "Next.js",
  cra: "Create React App",
};

// The *installed*, resolved version (read from the package's own node_modules/.../package.json),
// not the semver range in the project's package.json - the range says what's allowed, this
// says what's actually running.
async function readInstalledVersion(projectRoot, packageName) {
  try {
    const pkgJsonPath = path.join(projectRoot, "node_modules", ...packageName.split("/"), "package.json");
    const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the human-facing label and real installed versions for an already-detected
 * framework, plus the installed React version (relevant regardless of framework - it's the
 * other half of "what the user is currently working with"). Never throws - a version that
 * can't be read is reported as `null` rather than losing the rest of the session's info over
 * an unusual install layout.
 * @param {string} projectRoot
 * @param {string | null} framework
 * @returns {Promise<{ frameworkLabel: string | null, frameworkVersion: string | null, reactVersion: string | null }>}
 */
export async function detectStackVersions(projectRoot, framework) {
  const depName = DETECTORS.find((entry) => entry.framework === framework)?.depName || null;
  const [frameworkVersion, reactVersion] = await Promise.all([
    depName ? readInstalledVersion(projectRoot, depName) : Promise.resolve(null),
    readInstalledVersion(projectRoot, "react"),
  ]);
  return {
    frameworkLabel: framework ? FRAMEWORK_LABELS[framework] || framework : null,
    frameworkVersion,
    reactVersion,
  };
}
