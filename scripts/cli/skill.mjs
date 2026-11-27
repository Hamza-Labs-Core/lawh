// Local agent skill installation and auto-refresh for Lawh.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteJson, readConfig } from './config.mjs';

export const SKILLS_REGISTRY_FILE = 'skills.json';

function registryPath(root, home) {
  return home ? join(home, SKILLS_REGISTRY_FILE) : join(root, '.wrangler', 'lawh-skills.json');
}

function isSymlink(filePath) {
  try { return lstatSync(filePath).isSymbolicLink(); } catch { return false; }
}

function atomicWriteFile(filePath, content, mode = 0o644) {
  mkdirSync(dirname(filePath), { recursive: true });
  if (isSymlink(filePath)) {
    throw new Error(`Refusing to overwrite symlink: ${filePath}`);
  }
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode });
  try { chmodSync(tmp, mode); } catch { /* Windows */ }
  renameSync(tmp, filePath);
  try { chmodSync(filePath, mode); } catch { /* Windows */ }
}

/**
 * Converts Lawh's canonical `skills/lawh/SKILL.md` template into a local bundled skill file
 * pointing directly at the installed `scripts/lawh.mjs` CLI.
 */
export function renderLocalSkill(sourceSkillMd, { cliPath, appUrl = '' }) {
  const displayUrl = appUrl ? appUrl.replace(/\/+$/, '') : '<your-lawh-url>';
  const cliCmd = /\s/.test(cliPath) ? `node "${cliPath}"` : `node ${cliPath}`;
  let out = sourceSkillMd.replaceAll('{{APP_URL}}', displayUrl);
  // Replace the curl download lines inside the Install & Connect block with a direct bundled CLI reference.
  out = out.replace(
    /Download the zero-dependency Node \(>= 22\) client directly from this Lawh copy so it matches the server version:\s*\n\n```bash\ncurl -fsSL [^\n]+\nchmod \+x lawh\.mjs\n/,
    `This skill bundles the zero-dependency Node (>= 22) client at \`${cliPath}\`. Run \`${cliCmd} update\` anytime to refresh it from your Lawh server.\n\n\`\`\`bash\n`,
  );
  out = out.replaceAll('node lawh.mjs', cliCmd);
  return out;
}

function canonicalDir(dirPath) {
  const abs = resolve(dirPath);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Detects default local agent skill directories on this machine without duplicating symlinked provider dirs. */
export function detectDefaultSkillDirs(homeDir = homedir()) {
  const primary = join(homeDir, '.agents', 'skills', 'lawh');
  const candidates = [primary];
  const seen = new Set([canonicalDir(primary)]);

  for (const provider of ['.claude', '.codex']) {
    const providerRoot = join(homeDir, provider);
    if (!existsSync(providerRoot)) continue;
    const candidate = join(providerRoot, 'skills', 'lawh');
    // Skip if it is already a symlink pointing to an already-selected skill directory.
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        const target = canonicalDir(candidate);
        if (seen.has(target)) continue;
      }
    } catch { /* does not exist yet */ }
    const canon = canonicalDir(candidate);
    if (seen.has(canon)) continue;
    seen.add(canon);
    candidates.push(candidate);
  }
  return candidates;
}

export function readSkillsRegistry(root, home) {
  const path = registryPath(root, home);
  if (!existsSync(path)) return { dirs: [], url: '' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const dirs = Array.isArray(parsed?.dirs) ? parsed.dirs.filter((d) => typeof d === 'string' && d.trim()) : [];
    const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
    return { dirs, url };
  } catch {
    return { dirs: [], url: '' };
  }
}

function writeSkillToDir({ dir, sourceSkillMd, sourceCli, appUrl }) {
  if (isSymlink(dir)) {
    throw new Error(`Refusing to install into symlinked directory: ${dir}`);
  }
  const scriptsDir = join(dir, 'scripts');
  if (isSymlink(scriptsDir)) {
    throw new Error(`Refusing to install into symlinked scripts directory: ${scriptsDir}`);
  }
  const cliPath = join(scriptsDir, 'lawh.mjs');
  const skillPath = join(dir, 'SKILL.md');
  atomicWriteFile(cliPath, sourceCli, 0o755);
  atomicWriteFile(skillPath, renderLocalSkill(sourceSkillMd, { cliPath, appUrl }), 0o644);
  return { dir, cliPath, skillPath };
}

/** Installs the Lawh agent skill into one or more local directories and records them for automatic refresh on `lawh self-update`. */
export function installSkill({ root, home = '', homeDir = homedir(), dirs = [], url = '' }) {
  const sourceSkillPath = join(root, 'skills', 'lawh', 'SKILL.md');
  const sourceCliPath = join(root, 'skills', 'lawh', 'lawh.mjs');
  if (!existsSync(sourceSkillPath) || !existsSync(sourceCliPath)) {
    throw new Error('Bundled Lawh skill files are missing from this installation.');
  }
  const sourceSkillMd = readFileSync(sourceSkillPath, 'utf8');
  const sourceCli = readFileSync(sourceCliPath, 'utf8');

  const prior = readSkillsRegistry(root, home);
  const cfg = readConfig(root);
  const appUrl = (url || cfg?.hosts?.app || prior.url || '').trim().replace(/\/+$/, '');

  const targets = dirs.length > 0 ? dirs.map((d) => resolve(d)) : detectDefaultSkillDirs(homeDir);
  const installed = [];
  const seenCanon = new Set();
  for (const dir of targets) {
    const canon = canonicalDir(dir);
    if (seenCanon.has(canon)) continue;
    seenCanon.add(canon);
    installed.push(writeSkillToDir({ dir, sourceSkillMd, sourceCli, appUrl }));
  }

  const mergedDirs = [...new Set([...prior.dirs.map((d) => resolve(d)), ...installed.map((i) => i.dir)])];
  atomicWriteJson(registryPath(root, home), { dirs: mergedDirs, ...(appUrl ? { url: appUrl } : {}) }, 0o600);
  return { installed, url: appUrl };
}

/** Refreshes all previously installed local Lawh skill directories that still exist on disk. */
export function refreshInstalledSkills({ root, home = '', url = '' }) {
  const prior = readSkillsRegistry(root, home);
  if (prior.dirs.length === 0) return { refreshed: [], url: '' };

  const sourceSkillPath = join(root, 'skills', 'lawh', 'SKILL.md');
  const sourceCliPath = join(root, 'skills', 'lawh', 'lawh.mjs');
  if (!existsSync(sourceSkillPath) || !existsSync(sourceCliPath)) {
    throw new Error('Bundled Lawh skill files are missing from this installation.');
  }
  const sourceSkillMd = readFileSync(sourceSkillPath, 'utf8');
  const sourceCli = readFileSync(sourceCliPath, 'utf8');

  const cfg = readConfig(root);
  const appUrl = (url || cfg?.hosts?.app || prior.url || '').trim().replace(/\/+$/, '');

  const keptDirs = [];
  const refreshed = [];
  for (const dir of prior.dirs) {
    if (!existsSync(dir)) continue;
    keptDirs.push(dir);
    refreshed.push(writeSkillToDir({ dir, sourceSkillMd, sourceCli, appUrl }));
  }

  if (keptDirs.length !== prior.dirs.length || appUrl !== prior.url) {
    atomicWriteJson(registryPath(root, home), { dirs: keptDirs, ...(appUrl ? { url: appUrl } : {}) }, 0o600);
  }
  return { refreshed, url: appUrl };
}
