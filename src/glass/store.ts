/** Durable, append-only Postgres stream storage.
 * Event seq is global and strictly increasing as an allocated sequence, but
 * database transaction commit ordering may differ. Clients replay with a
 * bounded cursor; close over last seen IDs and idempotent event keys.
 */
import { getRuntimeEnv } from '../runtime';
import { GlassError, type DerivedEvent } from './grammar';

export type GlassRow = {
  seq: number;
  room_id: string;
  client_event_id: string;
  kind: string;
  features: Record<string,unknown>;
  recorded_at: string;
};

const COLS='seq, room_id, client_event_id, kind, features, recorded_at';

export async function writeEvent(event: DerivedEvent): Promise<GlassRow> {
  const env = await getRuntimeEnv();
  return env.db.tx(async sql => {
    // Authoritative room write rate: max 8 events per rolling second,
    // serialized per room. No raw audio and no unbounded batch writes.
    await sql.query('select pg_advisory_xact_lock(hashtext($1))',[event.room]);
    const count=await sql.query<{count:number}>(
      "select count(*)::int as count from glass_trace_events where room_id=$1 and recorded_at>clock_timestamp()-interval '1 second'",
      [event.room],
    );
    if ((count.rows[0]?.count??0)>=8) throw new GlassError(429,'Per-room input rate budget exceeded');
    const inserted=await sql.query<GlassRow>(
      'insert into glass_trace_events(room_id,client_event_id,kind,features) values ($1,$2,$3,$4::jsonb) '+
      'on conflict(room_id,client_event_id) do nothing returning '+COLS,
      [event.room,event.eventId,event.kind,JSON.stringify(event.features)],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const existing=await sql.query<GlassRow>(
      'select '+COLS+' from glass_trace_events where room_id=$1 and client_event_id=$2',
      [event.room,event.eventId],
    );
    if(!existing.rows[0]) throw new GlassError(409,'Write concurrently superseded');
    if (existing.rows[0].kind!==event.kind ||
      JSON.stringify(Object.keys(existing.rows[0].features).sort().map(k=>[k,existing.rows[0].features[k]]))!==
      JSON.stringify(Object.keys(event.features).sort().map(k=>[k,event.features[k]]))) {
      throw new GlassError(409,'Idempotency key reused with differing payload');
    }
    return existing.rows[0];
  });
}

export async function readRoom(room: string, since: number, limit=64): Promise<GlassRow[]> {
  if (!Number.isInteger(limit) || limit<1 || limit>128) throw new GlassError(400,'Invalid pagination limit');
  const env = await getRuntimeEnv();
  const result=await env.db.query<GlassRow>(
    'select '+COLS+' from glass_trace_events where room_id=$1 and seq>$2 order by seq asc limit $3',
    [room,since,limit],
  );
  return result.rows;
}
