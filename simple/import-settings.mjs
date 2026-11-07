// Import a trusted settings bundle into an EMPTY SQLite data directory.
// The original PostgreSQL database is never modified by this operation.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { openSimpleDatabase,importConfiguration } from "./db.mjs";
const file=process.env.FUSION_IMPORT_FILE, dataDir=process.env.FUSION_DATA_DIR;
if(!file||!path.isAbsolute(file)||!dataDir||!path.isAbsolute(dataDir)) throw Error("absolute_import_paths_required");
const st=statSync(file);
if(!st.isFile() || st.size>20_000_000 || (st.mode&0o077)!==0) throw Error("unsafe_settings_bundle");
const bundle=JSON.parse(readFileSync(file,"utf8"));
const db=openSimpleDatabase(path.join(dataDir,"fusion.sqlite"));
try {
  const result=importConfiguration(db,bundle);
  process.stdout.write(JSON.stringify({status:"ok",...result})+"\n");
} finally { db.close(); }
