import { randomUUID } from "node:crypto";

export function queueChannelTest(db, channelId, userId) {
  const row=db.prepare("SELECT payload FROM channels WHERE id=? AND user_id=?").get(channelId,userId);
  if(!row)return null;
  const channel=JSON.parse(row.payload);
  if(!channel.enabled)return false;
  const id=randomUUID(),now=Date.now();
  db.prepare("INSERT INTO channel_test_deliveries(id,channel_id,next_attempt,created_at,payload) VALUES(?,?,?,?,?)")
    .run(id,channelId,now,now,JSON.stringify({}));
  return id;
}
