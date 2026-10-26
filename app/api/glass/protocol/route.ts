import { domainGrammar } from '../../../../src/glass/grammar';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET():Promise<Response> {
  return Response.json({
    protocol:'GLASS-LIVE/0.1',
    source:'NetGovComEduGovOrgEduGovComNet / ACSP/0.1-compatible',
    invariant:'GET never mutates; audio stays on device unless separate explicitly authorized transport is commissioned',
    api:{
      publish:'POST /api/glass/publish Authorization: Bearer GLASS_STREAM_WRITE_KEY',
      replay:'GET /api/glass/events?room={id}&since={cursor} Authorization: Bearer GLASS_STREAM_READ_KEY',
      privateSse:'GET /api/glass/stream?room={id}&cursor={cursor} Authorization: Bearer GLASS_STREAM_READ_KEY',
      publicSse:'GET /api/glass/stream (synthetic public protocol heartbeat; no real user session content)',
    },
    privacy:['no PCM','no transcript','no personally identifying device info','no public live voice session'],
    scopes:['read','write'],
    storage:'PostgreSQL append-only GLASS event table; separate from ACSP continuity resources',
    clocks:['device monotonically increasing generation','server event sequence','server received timestamp'],
    delivery:'bounded SSE reconnect and JSON polling; Vercel serverless processes are not permanent sockets',
    categorical:['ar','en','other','unknown'],
    scientificBoundary:'low-cost DSP is not a trained Qur\'an or multi-language model',
    domainComposition:domainGrammar(),
  },{headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
