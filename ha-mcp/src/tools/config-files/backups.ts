/**
 * Per-file backups in <configDir>/.ha-mcp-backups/<relative path>.<id>.bak
 *
 * <id> is a UTC timestamp like 20260926T101112345Z (plus "-N" on collision).
 * Files end in .bak so Home Assistant's !include_dir_* (which only loads .yaml)
 * never picks them up. Only the newest MAX_BACKUPS per file are kept.
 */
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { HAError } from "../../ha-client.js";
import { BACKUP_DIR } from "./sandbox.js";

export const MAX_BACKUPS = 20;
const ID_RE = /^\d{8}T\d{9}Z(?:-\d+)?$/;

export interface BackupInfo {
  id: string;
  created: string;
  size: number;
  /** "deleted" when the file was removed with ha_delete_config_file. */
  reason?: string;
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, "").replace(".", "");
}

function idToIso(id: string) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z` : id;
}

export class Backups {
  constructor(private readonly root: string, private readonly keep = MAX_BACKUPS) {}

  private async baseDir() {
    const dir = path.join(this.root, BACKUP_DIR);
    const st = await fs.lstat(dir).catch(() => null);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new HAError(`${BACKUP_DIR} must be a real directory inside the config dir`);
    }
    if (!st) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private async dirFor(rel: string) {
    const base = await this.baseDir();
    const d = path.join(base, path.dirname(rel));
    await fs.mkdir(d, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(d);
    const r = path.relative(base, real);
    if (r.startsWith("..") || path.isAbsolute(r)) throw new HAError("Backup path escapes the backup directory");
    return real;
  }

  private fileName(rel: string, id: string, reason?: string) {
    return `${path.basename(rel)}.${id}${reason ? "." + reason : ""}.bak`;
  }

  /** Store a copy of `content` as a new backup of rel. Returns its id. */
  async save(rel: string, content: Buffer | string, reason?: string): Promise<string> {
    const dir = await this.dirFor(rel);
    const base = stamp();
    for (let n = 0; n < 1000; n++) {
      const id = n === 0 ? base : `${base}-${n}`;
      try {
        await fs.writeFile(path.join(dir, this.fileName(rel, id, reason)), content, { flag: fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, mode: 0o600 });
        await this.rotate(rel);
        return id;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
    }
    throw new HAError("Could not create a unique backup name");
  }

  /** Move a file into the backups (used for delete). Returns its id. */
  async moveIn(rel: string, abs: string): Promise<string> {
    const dir = await this.dirFor(rel);
    const base = stamp();
    for (let n = 0; n < 1000; n++) {
      const id = n === 0 ? base : `${base}-${n}`;
      const dest = path.join(dir, this.fileName(rel, id, "deleted"));
      const exists = await fs.lstat(dest).then(() => true, () => false);
      if (exists) continue;
      try {
        await fs.rename(abs, dest);
      } catch (e: any) {
        if (e?.code !== "EXDEV") throw e;
        await fs.copyFile(abs, dest, fsc.COPYFILE_EXCL);
        await fs.unlink(abs);
      }
      await this.rotate(rel);
      return id;
    }
    throw new HAError("Could not create a unique backup name");
  }

  /** Backups of rel, newest first. */
  async list(rel: string): Promise<(BackupInfo & { file: string })[]> {
    const base = path.join(this.root, BACKUP_DIR);
    const dir = path.join(base, path.dirname(rel));
    const prefix = path.basename(rel) + ".";
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: (BackupInfo & { file: string })[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".bak")) continue;
      const middle = name.slice(prefix.length, -".bak".length);
      const [id, reason] = middle.split(".");
      if (!ID_RE.test(id) || (reason !== undefined && reason !== "deleted")) continue;
      const file = path.join(dir, name);
      const st = await fs.lstat(file).catch(() => null);
      if (!st || !st.isFile()) continue;
      out.push({ id, created: idToIso(id), size: st.size, file, ...(reason ? { reason } : {}) });
    }
    // ids sort chronologically as strings, except the -N suffix: compare numerically
    const key = (id: string) => {
      const [t, n] = id.split("-");
      return [t, Number(n ?? 0)] as const;
    };
    out.sort((a, b) => {
      const [ta, na] = key(a.id);
      const [tb, nb] = key(b.id);
      return ta === tb ? nb - na : ta < tb ? 1 : -1;
    });
    return out;
  }

  async read(rel: string, id?: string): Promise<{ info: BackupInfo; content: Buffer }> {
    const all = await this.list(rel);
    if (all.length === 0) throw new HAError(`No backups for ${rel}`);
    const hit = id ? all.find((b) => b.id === id) : all[0];
    if (!hit) throw new HAError(`Backup '${id}' not found for ${rel}. Available: ${all.map((b) => b.id).join(", ")}`);
    const { file, ...info } = hit;
    return { info, content: await fs.readFile(file) };
  }

  private async rotate(rel: string) {
    const all = await this.list(rel);
    for (const b of all.slice(this.keep)) await fs.unlink(b.file).catch(() => {});
  }
}
