import { readFileSync } from "node:fs";

const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.version)) throw Error("invalid_application_version");
export const APPLICATION_VERSION: string = parsed.version;
