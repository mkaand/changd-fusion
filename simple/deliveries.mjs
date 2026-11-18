export function listDeliveries(db,userId,{page=1,pageSize=20,status=null}={}){
  const from=`FROM (
    SELECT o.id,o.event_id,o.channel_id,o.attempts,o.status,o.next_attempt,o.payload,
      json_extract(c.payload,'$.name') channel_name,json_extract(c.payload,'$.provider') provider,
      m.id monitor_id,json_extract(m.payload,'$.name') monitor_name,
      CASE WHEN e.status='test' THEN 'test' ELSE 'monitor' END kind
      FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id
      WHERE c.user_id=? AND m.user_id=?
    UNION ALL
    SELECT t.id,NULL,t.channel_id,t.attempts,t.status,t.next_attempt,t.payload,
      json_extract(c.payload,'$.name'),json_extract(c.payload,'$.provider'),NULL,NULL,'test'
      FROM channel_test_deliveries t JOIN channels c ON c.id=t.channel_id WHERE c.user_id=?
  ) d`;
  const displayStatus="CASE WHEN d.status='pending' AND d.attempts>0 THEN 'retrying' ELSE d.status END";
  const where="WHERE (? IS NULL OR "+displayStatus+"=?)";
  const params=[userId,userId,userId,status,status];
  const rows=db.prepare("SELECT d.*,"+displayStatus+" display_status "+from+" "+where+" ORDER BY d.next_attempt DESC,d.id DESC LIMIT ? OFFSET ?").all(...params,pageSize,(page-1)*pageSize);
  const total=db.prepare("SELECT count(*) n "+from+" "+where).get(...params).n;
  return {items:rows.map(row=>{
    const payload=JSON.parse(row.payload);
    return {id:row.id,event_id:row.event_id,channel_id:row.channel_id,channel_name:row.channel_name,
      provider:row.provider,kind:row.kind,monitor_id:row.monitor_id,monitor_name:row.monitor_name,
      attempts:row.attempts,status:row.display_status,next_attempt:new Date(row.next_attempt).toISOString(),
      delivered_at:payload.delivered_at??null,accepted_at:payload.accepted_at??null,
      smtp_result:payload.smtp_result??null,last_error:payload.last_error??null};
  }),total,page,page_size:pageSize};
}

export function retryDelivery(db,id,userId){
  const row=db.prepare("SELECT o.* FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id WHERE o.id=? AND o.status='failed' AND json_extract(c.payload,'$.enabled')=1 AND c.user_id=? AND m.user_id=?").get(id,userId,userId);
  const testRow=row?null:db.prepare("SELECT t.* FROM channel_test_deliveries t JOIN channels c ON c.id=t.channel_id WHERE t.id=? AND t.status='failed' AND json_extract(c.payload,'$.enabled')=1 AND c.user_id=?").get(id,userId);
  const found=row??testRow;
  if(!found)return false;
  const payload={...JSON.parse(found.payload),last_error:null};
  const table=row?"outbox":"channel_test_deliveries";
  return !!db.prepare(`UPDATE ${table} SET status='pending',attempts=0,next_attempt=?,payload=? WHERE id=? AND status='failed'`)
    .run(Date.now(),JSON.stringify(payload),found.id).changes;
}
