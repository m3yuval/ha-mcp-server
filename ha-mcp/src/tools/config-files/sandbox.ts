/**
 * Path sandbox and file policy for the Home Assistant config directory.
 *
 * Every path a tool receives goes through Sandbox.resolve(), which:
 *   - resolves it against the real (symlink-free) config dir,
 *   - refuses `..` escapes and absolute paths outside the config dir,
 *   - resolves symlinks (fs.realpath) of the file, or of its nearest existing
 *     parent when the file does not exist yet, and refuses anything whose real
 *     location is outside the config dir.
 * The returned `abs` is the REAL path, so later reads/writes never follow a
 * symlink out of the sandbox.
 *
 * Policy (what may be read / written) lives in assertReadable/assertWritable.
 */
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { HAError } from "../../ha-client.js";

export const BACKUP_DIR = ".ha-mcp-backups";
export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;

/** Extensions that may be created/edited. `.py` only under python_scripts/. */
export const WRITABLE_EXTENSIONS = [".yaml", ".yml", ".json", ".txt", ".md", ".jinja", ".j2"];

/** Directories skipped when listing unless include_system is set (big, binary or internal). */
export const SYSTEM_DIRS = new Set([
  ".storage",
  ".cloud",
  "deps",
  "tts",
  "backups",
  "www",
  "media",
  "custom_components",
  "node_modules",
  "__pycache__",
  ".git",
  "image",
  "zigbee2mqtt",
]);

/** Always hidden from listings. */
const NEVER_LIST = new Set([BACKUP_DIR]);

const TEXT_EXTENSIONS = new Set([
  ...WRITABLE_EXTENSIONS,
  ".py",
  ".conf",
  ".cfg",
  ".ini",
  ".toml",
  ".csv",
  ".log",
  ".sh",
  ".js",
  ".css",
  ".html",
  ".xml",
  ".env",
]);

export interface Resolved {
  /** Real absolute path (symlinks resolved). */
  abs: string;
  /** Path relative to the config dir, with forward slashes ("" = the config dir itself). */
  rel: string;
  exists: boolean;
  isFile: boolean;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
  mode?: number;
}

function isInside(root: string, p: string) {
  const r = path.relative(root, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}

function toRel(root: string, p: string) {
  return path.relative(root, p).split(path.sep).join("/");
}

export function isDbFile(rel: string) {
  return /\.db(-shm|-wal|-journal)?$/i.test(rel) || /\.sqlite3?$/i.test(rel);
}

export function isSecretsFile(rel: string) {
  return path.posix.basename(rel).toLowerCase() === "secrets.yaml";
}

export function isStorage(rel: string) {
  return rel === ".storage" || rel.startsWith(".storage/");
}

export function isYaml(rel: string) {
  return /\.ya?ml$/i.test(rel);
}

export function isTextLike(rel: string) {
  const ext = path.posix.extname(rel).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // .storage files have no extension but are JSON
  return isStorage(rel) && ext === "";
}

export class Sandbox {
  private rootPromise?: Promise<string>;

  constructor(private readonly configDir: string) {}

  /** Real path of the config dir (cached). */
  root(): Promise<string> {
    if (!this.rootPromise) {
      this.rootPromise = fs.realpath(this.configDir).catch((e) => {
        this.rootPromise = undefined;
        throw new HAError(`CONFIG_DIR '${this.configDir}' is not accessible: ${(e as Error).message}`);
      });
    }
    return this.rootPromise;
  }

  async resolve(input: string): Promise<Resolved> {
    if (typeof input !== "string" || input.trim() === "") throw new HAError("A path is required");
    if (input.includes("\0")) throw new HAError("Invalid path (NUL byte)");
    const root = await this.root();
    let p = input.trim();
    if (path.isAbsolute(p)) {
      const configAbs = path.resolve(this.configDir);
      if (isInside(root, p)) {
        // fine: absolute inside the real config dir
      } else if (isInside(configAbs, path.resolve(p))) {
        p = path.relative(configAbs, path.resolve(p));
      } else {
        // Common HA spellings of the config dir, e.g. "/config/automations.yaml".
        const m = /^\/(config|homeassistant)(\/.*)?$/.exec(p);
        if (!m) throw new HAError(`Refusing path outside the Home Assistant config directory: ${input}`);
        p = (m[2] ?? "/").slice(1) || ".";
      }
    }
    const lexical = path.resolve(root, p);
    if (!isInside(root, lexical)) {
      throw new HAError(`Refusing path that escapes the Home Assistant config directory: ${input}`);
    }

    let real: string;
    let exists = true;
    try {
      real = await fs.realpath(lexical);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw new HAError(`Cannot access ${input}: ${e?.message ?? e}`);
      // Dangling symlink? lstat succeeds while realpath fails.
      const l = await fs.lstat(lexical).catch(() => null);
      if (l?.isSymbolicLink()) throw new HAError(`Refusing broken symlink: ${input}`);
      exists = false;
      // Resolve the nearest existing ancestor; the rest does not exist, so it has no symlinks.
      let ancestor = path.dirname(lexical);
      const rest: string[] = [path.basename(lexical)];
      for (;;) {
        try {
          const ra = await fs.realpath(ancestor);
          real = path.join(ra, ...rest);
          break;
        } catch (err: any) {
          if (err?.code !== "ENOENT") throw new HAError(`Cannot access ${input}: ${err?.message ?? err}`);
          const l2 = await fs.lstat(ancestor).catch(() => null);
          if (l2?.isSymbolicLink()) throw new HAError(`Refusing broken symlink in path: ${input}`);
          rest.unshift(path.basename(ancestor));
          ancestor = path.dirname(ancestor);
        }
      }
    }
    if (!isInside(root, real!)) {
      throw new HAError(`Refusing path: '${input}' resolves (via a symlink) outside the Home Assistant config directory`);
    }
    const out: Resolved = { abs: real!, rel: toRel(root, real!), exists, isFile: false, isDir: false };
    if (exists) {
      const st = await fs.stat(real!);
      out.isFile = st.isFile();
      out.isDir = st.isDirectory();
      out.size = st.size;
      out.mtimeMs = st.mtimeMs;
      out.mode = st.mode & 0o777;
    }
    return out;
  }

  // ------------------------------------------------------------- policy

  assertReadable(r: Resolved) {
    const rel = r.rel;
    const first = rel.split("/")[0];
    if (first === BACKUP_DIR) {
      throw new HAError("Backups are not read directly. Use ha_list_config_backups / ha_restore_config_backup.");
    }
    if (first === ".cloud") throw new HAError("Refusing to read .cloud/ (Home Assistant Cloud credentials)");
    if (/^\.storage\/(auth|auth_provider\.|onboarding)/.test(rel)) {
      throw new HAError(`Refusing to read ${rel} (authentication data)`);
    }
    if (isDbFile(rel)) throw new HAError("Refusing to read database files");
    if (r.exists && r.isDir) throw new HAError(`${rel || "."} is a directory. Use ha_list_config_files.`);
    if (!r.exists) throw new HAError(`File not found: ${rel}`);
    if (!r.isFile) throw new HAError(`Not a regular file: ${rel}`);
    if ((r.size ?? 0) > MAX_READ_BYTES) {
      throw new HAError(`File is too large to read (${r.size} bytes, max ${MAX_READ_BYTES})`);
    }
  }

  /**
   * Can this path be created/overwritten/edited/deleted by the generic file
   * tools? secrets.yaml is refused here: use ha_set_secret so values never
   * pass through tool arguments, logs or diffs.
   */
  assertWritable(r: Resolved, opts: { allowSecrets?: boolean } = {}) {
    const rel = r.rel;
    if (rel === "") throw new HAError("Refusing to write the config directory itself");
    const first = rel.split("/")[0];
    if (isStorage(rel)) {
      throw new HAError(
        ".storage/ is managed by Home Assistant and must not be edited by hand (it is overwritten at runtime). Use the UI/API instead.",
      );
    }
    if (first === BACKUP_DIR) throw new HAError("Backups can only be changed via ha_restore_config_backup");
    if (first === ".cloud" || first === "deps" || first === ".git") throw new HAError(`Refusing to write under ${first}/`);
    if (isDbFile(rel)) throw new HAError("Refusing to write database files");
    if (/\.log(\.\d+|\.old|\.fault)?$/i.test(rel)) throw new HAError("Refusing to write log files");
    if (isSecretsFile(rel) && !opts.allowSecrets) {
      throw new HAError(
        "secrets.yaml cannot be written or edited with the generic file tools, so secret values never appear in arguments, logs or diffs. Use ha_set_secret / ha_delete_secret.",
      );
    }
    const ext = path.posix.extname(rel).toLowerCase();
    const okExt = WRITABLE_EXTENSIONS.includes(ext) || (ext === ".py" && first === "python_scripts");
    if (!okExt) {
      throw new HAError(
        `Refusing to write '${rel}': allowed file types are ${WRITABLE_EXTENSIONS.join(", ")} (and .py inside python_scripts/)`,
      );
    }
    if (r.exists && !r.isFile) throw new HAError(`Not a regular file: ${rel}`);
  }
}

// ------------------------------------------------------------- file io

/** True if the buffer looks binary (NUL byte or invalid UTF-8 in the first 8 KB). */
export function looksBinary(buf: Buffer) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === buf.length ? head : trimUtf8(head));
    return false;
  } catch {
    return true;
  }
}

/** Drop a possibly cut multi-byte char at the end of a slice. */
function trimUtf8(b: Buffer) {
  let end = b.length;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (b[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i >= 0 && b[i] >= 0xc0) end = i;
  return b.subarray(0, end);
}

export async function readText(abs: string): Promise<string> {
  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) throw new HAError("Refusing: file looks binary");
  return buf.toString("utf8");
}

/** Write via temp file + rename in the same directory. Creates parent dirs. */
export async function atomicWrite(abs: string, content: string | Buffer, mode?: number) {
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(abs)}.ha-mcp-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  let prev: { uid: number; gid: number; mode: number } | undefined;
  try {
    const st = await fs.stat(abs);
    prev = { uid: st.uid, gid: st.gid, mode: st.mode & 0o777 };
  } catch {
    /* new file */
  }
  try {
    const fh = await fs.open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, mode ?? prev?.mode ?? 0o644);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (prev) {
      await fs.chmod(tmp, mode ?? prev.mode).catch(() => {});
      await fs.chown(tmp, prev.uid, prev.gid).catch(() => {});
    }
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

// ------------------------------------------------------------- listing

/** Minimal glob → RegExp: `**` any dirs, `*` within a segment, `?`, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, close).split(",").map((s) => s.replace(/[.+^${}()|[\]\\*?]/g, "\\$&")).join("|") + ")";
        i = close;
      }
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "i");
}

export interface ListedFile {
  path: string;
  size: number;
  modified: string;
  symlink?: boolean;
}

export async function listFiles(
  root: string,
  start: string,
  opts: { maxDepth: number; match?: RegExp; matchBasename: boolean; includeSystem: boolean; allText: boolean; limit: number },
): Promise<{ files: ListedFile[]; truncated: boolean; skipped_dirs: string[] }> {
  const files: ListedFile[] = [];
  const skipped: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const abs = path.join(dir, e.name);
      const rel = toRel(root, abs);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      let symlink = false;
      if (e.isSymbolicLink()) {
        // Only list symlinks whose target is inside the config dir; never descend into them (loops).
        const real = await fs.realpath(abs).catch(() => null);
        if (!real || !isInside(root, real)) continue;
        const st = await fs.stat(abs).catch(() => null);
        if (!st) continue;
        symlink = true;
        isFile = st.isFile();
        isDir = false;
      }
      if (isDir) {
        if (NEVER_LIST.has(rel)) continue;
        if (!opts.includeSystem && dir === root && SYSTEM_DIRS.has(e.name)) {
          skipped.push(rel + "/");
          continue;
        }
        if (!opts.includeSystem && (e.name === "__pycache__" || e.name === "node_modules" || e.name === ".git")) continue;
        if (depth + 1 < opts.maxDepth) await walk(abs, depth + 1);
        continue;
      }
      if (!isFile) continue;
      if (e.name.includes(".ha-mcp-tmp-")) continue;
      if (isDbFile(rel)) continue;
      if (!opts.includeSystem && /\.log(\.\d+|\.old|\.fault)?$/i.test(e.name)) continue;
      const wanted = opts.allText ? isTextLike(rel) : isYaml(rel);
      if (!wanted) continue;
      if (opts.match && !opts.match.test(opts.matchBasename ? e.name : rel)) continue;
      const st = await fs.stat(abs).catch(() => null);
      if (!st) continue;
      if (files.length >= opts.limit) {
        truncated = true;
        return;
      }
      files.push({ path: rel, size: st.size, modified: new Date(st.mtimeMs).toISOString(), ...(symlink ? { symlink: true } : {}) });
    }
  };
  await walk(start, 0);
  return { files, truncated, skipped_dirs: skipped };
}
