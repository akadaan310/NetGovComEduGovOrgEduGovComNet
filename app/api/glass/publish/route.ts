import { parseEvent, requireKey, safeJsonError } from '../../../../src/glass/grammar';
import { writeEvent } from '../../../../src/glass/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request: Request): Promise<Response> {
  try {
    requireKey(request,'write');
    const contentType=request.headers.get('content-type')||'';
    if (!contentType.toLowerCase().startsWith('application/json'))
      return Response.json({ok:false,error:'application/json required'},{status:415});
    const len=Number(request.headers.get('content-length')||'0');
    if (len>2048) return Response.json({ok:false,error:'Event exceeds 2048 byte limit'},{status:413});
    // Buffer/body limit is enforced even if Content-Length is omitted.
    const body=await request.text();
    if(new TextEncoder().encode(body).length>2048)
      return Response.json({ok:false,error:'Event exceeds byte budget'},{status:413});
    let parsed: unknown;
    try{parsed=JSON.parse(body);}catch{return Response.json({ok:false,error:'Invalid JSON'},{status:400});}
    const event=parseEvent(parsed);
    const row=await writeEvent(event);
    return Response.json({ok:true,seq:row.seq,recorded_at:row.recorded_at,eventId:event.eventId},{
      status:201,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
    });
  } catch(error) {return safeJsonError(error);}
}
export async function GET(): Promise<Response> {
  return Response.json({ok:false,error:'GET cannot mutate event stream'},{status:405,headers:{Allow:'POST'}});
}
