import { parseCursor, requireKey, safeJsonError, validatedRoom } from '../../../../src/glass/grammar';
import { readRoom } from '../../../../src/glass/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request):Promise<Response> {
  try {
    requireKey(request,'read');
    const url=new URL(request.url);
    const room=validatedRoom(url.searchParams.get('room'));
    const since=parseCursor(url.searchParams.get('since'));
    const rows=await readRoom(room,since);
    return Response.json({
      protocol:'GLASS-LIVE/0.1',room,since,
      events:rows,nextCursor:rows.at(-1)?.seq??since,
      links:{stream:'/api/glass/stream?room='+encodeURIComponent(room)},
    },{headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'}});
  } catch(error) {return safeJsonError(error);}
}
