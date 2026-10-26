import { parseCursor, requireKey, safeJsonError, validatedRoom } from '../../../../src/glass/grammar';
import { readRoom } from '../../../../src/glass/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;

const ENCODER=new TextEncoder();
const SSE_HEADERS={
  'Content-Type':'text/event-stream; charset=utf-8',
  'Cache-Control':'no-cache, no-transform, private',
  'Connection':'keep-alive',
  'X-Accel-Buffering':'no',
  'X-Content-Type-Options':'nosniff',
  'X-Robots-Tag':'noindex',
};
function formatEvent(name:string,data:unknown,id?:number):Uint8Array {
  const label=id===undefined?'':'id: '+id+'\n';
  return ENCODER.encode(label+'event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n');
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function GET(request:Request):Promise<Response> {
  try{
    const url=new URL(request.url);
    const hasRoom=url.searchParams.has('room');
    const privateRoom=hasRoom?validatedRoom(url.searchParams.get('room')):null;
    const since=hasRoom?parseCursor(url.searchParams.get('cursor')):0;
    if(privateRoom)requireKey(request,'read');
    // GET without a room is a synthetic protocol heartbeat, not a shared microphone feed.
    const stream=new ReadableStream<Uint8Array>({
      async start(controller) {
        let cursor=since;
        const send=(name:string,data:unknown,id?:number)=>controller.enqueue(formatEvent(name,data,id));
        try{
          send('hello',{
            protocol:'GLASS-LIVE/0.1',visibility:privateRoom?'private':'public-synthetic',
            room:privateRoom??null,from:cursor,retryMs:1500,
          });
          for(let tick=0;tick<21 && !request.signal.aborted;tick++){
            if(privateRoom){
              const rows=await readRoom(privateRoom,cursor,64);
              for(const row of rows){
                send('record',row,row.seq);
                cursor=row.seq;
              }
              if(rows.length===64)continue;
            }
            send('heartbeat',{
              protocol:'GLASS-LIVE/0.1',source:'server-session',
              tick,mode:privateRoom?'private':'synthetic',
              readOnly:true,clock:Date.now(),
            });
            await pause(1000);
          }
          if(!request.signal.aborted)send('reconnect',{since:cursor});
        }catch(_error){
          try{send('service',{state:'temporarily-unavailable',retryMs:1500});}catch{}
        }finally{
          try{controller.close();}catch{}
        }
      },
      cancel() {/* cancellation is also reflected in request.signal */},
    });
    return new Response(stream,{headers:SSE_HEADERS});
  }catch(error){return safeJsonError(error);}
}
