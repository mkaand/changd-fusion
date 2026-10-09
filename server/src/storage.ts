import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  unlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export class Storage {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }
  async save(buffer: Buffer) {
    await this.init();
    const name = randomUUID() + ".png";
    await writeFile(path.join(this.root, name), buffer, {
      flag: "wx",
      mode: 0o600,
    });
    return name;
  }
  async file(name: string) {
    if (!/^[a-f\d-]{36}\.png$/.test(name)) throw Error("Invalid artifact");
    const file = await realpath(path.join(this.root, name));
    if (path.dirname(file) !== (await realpath(this.root)))
      throw Error("Invalid artifact");
    return file;
  }
  async read(name: string) {
    return readFile(await this.file(name));
  }
  async remove(name: string) {
    try {
      await unlink(await this.file(name));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  async files() {
    await this.init();
    return (await readdir(this.root)).filter((n) =>
      /^[a-f\d-]{36}\.png$/.test(n),
    );
  }
}
