// Import a trusted settings bundle into an EMPTY SQLite data directory.
// The original PostgreSQL database is never modified by this operation.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { openSimpleDatabase,importConfiguration } from "./db.mjs";
import { decrypt } from "../server/dist/crypto.js";
import { vaultBinding } from "../server/dist/vault.js";
const file=process.env.FUSION_IMPORT_FILE, dataDir=process.env.FUSION_DATA_DIR;
if(!file||!path.isAbsolute(file)||!dataDir||!path.isAbsolute(dataDir)) throw Error("absolute_import_paths_required");
const st=statSync(file);
if(!st.isFile() || st.size>20_000_000 || (st.mode&0o077)!==0) throw Error("unsafe_settings_bundle");
const bundle=JSON.parse(readFileSync(file,"utf8"));
// Fail before modifying the target if an original encryption key is wrong.
if(bundle.channels?.length || bundle.vault?.length) {
  try {
    for(const channel of bundle.channels) {
      const cfg=typeof channel.config==="string"?JSON.parse(channel.config):channel.config;
      if(!cfg?.encrypted || !decrypt(cfg.encrypted,process.env.CHANNEL_KEY))throw Error("invalid_channel");
    }
    for(const row of bundle.vault) {
      const values=decrypt(row.encrypted,process.env.CHANNEL_KEY,vaultBinding(row.monitor_id,row.user_id,row.origin));
      if(!values || typeof values!=="object")throw Error("invalid_vault");
    }
  }catch {
    throw Error("source_encryption_validation_failed");
  }
}
const db=openSimpleDatabase(path.join(dataDir,"fusion.sqlite"));
try {
  const result=importConfiguration(db,bundle,{channelKey:process.env.CHANNEL_KEY});
  process.stdout.write(JSON.stringify({status:"ok",...result})+"\n");
} finally { db.close(); }
