'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type LogRow={id:number;time:string;kind:string;label:string;payload:string};
const FONT='ui-monospace, SFMono-Regular, Consolas, monospace';
const BORDER='1px solid #34404b';
const BASE:React.CSSProperties={
  background:'#080d12',color:'#e9e7d6',minHeight:'100vh',fontFamily:FONT,
  padding:'clamp(18px,4vw,60px)',
};
const PANEL:React.CSSProperties={background:'#0d1720',border:BORDER,borderRadius:14,padding:20};
function item(time:string,kind:string,label:string,payload:unknown,id:number):LogRow{
  return {id,time,kind,label,payload:JSON.stringify(payload)};
}
function isRoom(value:string){return /^[A-Za-z0-9_-]{8,64}$/.test(value)}
export default function GlassCommunet(){
  const [room,setRoom]=useState('');
  const [secret,setSecret]=useState('');
  const [privateConfig,setPrivateConfig]=useState<{room:string;token:string}|null>(null);
  const [connected,setConnected]=useState(false);
  const [rows,setRows]=useState<LogRow[]>([]);
  const [kindFilter,setKindFilter]=useState('all');
  const [error,setError]=useState('');
  const cursor=useRef(0);
  const id=useRef(0);
  const active=useRef(true);
  const append=useCallback((kind:string,label:string,payload:unknown)=>{
    setRows(prev=>[...prev,item(new Date().toLocaleTimeString(),kind,label,payload,++id.current)].slice(-120));
  },[]);
  useEffect(()=>{
    active.current=true;
    const controller=new AbortController();
    let close=false;
    const run=async()=>{
      while(!close && !controller.signal.aborted){
        try{
          const qs=privateConfig
            ? '?room='+encodeURIComponent(privateConfig.room)+'&cursor='+cursor.current : '';
          const response=await fetch('/api/glass/stream'+qs,{
            method:'GET',cache:'no-store',
            headers:privateConfig?{Authorization:'Bearer '+privateConfig.token}:{},
            signal:controller.signal,
          });
          if(!response.ok)throw new Error('Streaming HTTP '+response.status+
            ' — private access and environment configuration required.');
          if(!response.body)throw new Error('Streaming is unavailable in this browser');
          setConnected(true);setError('');
          let buff='';
          const reader=response.body.getReader();
          const decoder=new TextDecoder();
          while(!close){
            const next=await reader.read();
            if(next.done)break;
            buff+=decoder.decode(next.value,{stream:true});
            if(buff.length>200000){buff='';append('error','event-size-limit',null);}
            const segments=buff.split('\n\n');
            buff=segments.pop()||'';
            for(const segment of segments){
              const lines=segment.split('\n');
              const event=lines.find(line=>line.startsWith('event: '))?.slice(7) || 'event';
              const data=lines.find(line=>line.startsWith('data: '))?.slice(6);
              const seq=lines.find(line=>line.startsWith('id: '))?.slice(4);
              if(seq && /^\d+$/.test(seq))cursor.current=Math.max(cursor.current,Number(seq));
              if(!data)continue;
              try{const record=JSON.parse(data);append(event,event,record);}
              catch{append('parse','unparsed',data.slice(0,300));}
            }
          }
        }catch(e){
          if(!controller.signal.aborted){setConnected(false);setError(e instanceof Error?e.message:'Connection failed');}
        }
        if(!close&&!controller.signal.aborted)await new Promise(resolve=>setTimeout(resolve,1500));
      }
    };
    void run();
    return()=>{close=true;controller.abort();setConnected(false);active.current=false;};
  },[append,privateConfig]);
  const shown=rows.filter(row=>kindFilter==='all'||row.kind===kindFilter);
  return <main style={BASE}>
    <header style={{maxWidth:1120,margin:'0 auto 32px'}}>
      <p style={{fontSize:11,letterSpacing:3,color:'#e7b865'}}>GLASS / ACSP / UNISON · NET / COMMUNET</p>
      <h1 style={{fontSize:'clamp(30px,5vw,62px)',lineHeight:1.1,fontWeight:450,margin:'10px 0 8px'}}>
        The always-present event plane<span style={{color:'#e8b75e'}}>.</span></h1>
      <p style={{maxWidth:740,color:'#aeb9c5',fontSize:14,lineHeight:1.8}}>
        A continuously reconnecting Internet I/O surface. Public visitors observe only synthetic protocol
        heartbeats. Protected owner sessions reveal authorized numeric language/acoustic traces
        without transmitting microphone recordings, voiceprints, or transcripts.
      </p>
      <a href="/api/glass/protocol" style={{color:'#d6b878'}}>Machine-readable protocol / JSON</a>
    </header>
    <section style={{maxWidth:1120,margin:'auto',display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(275px,1fr))',gap:18}}>
      <div style={PANEL}>
        <p style={{fontSize:11,color:'#90aab8',letterSpacing:2}}>STREAM STATUS</p>
        <h2 style={{fontWeight:400,fontSize:24,margin:'5px 0'}}>
          <span style={{color:connected?'#6de0b3':'#d49b7e'}}>●</span> {connected?'CONNECTED':'CONNECTING'}
        </h2>
        <p style={{fontSize:13,color:'#a8b7c7'}}>{privateConfig?'AUTHORIZED SESSION':'PUBLIC SYNTHETIC CHANNEL'}</p>
        <p style={{fontSize:12,color:'#8ca0ae'}}>Last cursor: {cursor.current}</p>
        {error&&<p role="alert" style={{color:'#f0aa92',fontSize:12}}>{error}</p>}
      </div>
      <div style={PANEL}>
        <p style={{fontSize:11,color:'#90aab8',letterSpacing:2}}>PRIVATE SESSION — OPT IN</p>
        <label style={{display:'block',fontSize:12,margin:'4px 0'}}>Room ID</label>
        <input value={room} onChange={e=>setRoom(e.target.value)} placeholder="your-private-room"
          autoComplete="off" style={{width:'100%',padding:9,background:'#081019',border:BORDER,color:'#fff',borderRadius:5}}/>
        <label style={{display:'block',fontSize:12,margin:'10px 0 4px'}}>Read capability (never enters the URL)</label>
        <input value={secret} onChange={e=>setSecret(e.target.value)} placeholder="private bearer secret"
          type="password" autoComplete="off" style={{width:'100%',padding:9,background:'#081019',border:BORDER,color:'#fff',borderRadius:5}}/>
        <div style={{display:'flex',gap:10,marginTop:12}}>
          <button disabled={!isRoom(room)||secret.length<24}
            onClick={()=>{cursor.current=0;setRows([]);setPrivateConfig({room,token:secret});}}
            style={{padding:'9px 15px',background:'#d6b878',border:0,borderRadius:5,color:'#111',cursor:'pointer'}}>
            Read authorized stream</button>
          <button onClick={()=>{cursor.current=0;setRows([]);setPrivateConfig(null);setSecret('');}}
            style={{padding:'9px 15px',background:'#293644',color:'#eee',border:0,borderRadius:5,cursor:'pointer'}}>
            Public</button>
        </div>
      </div>
    </section>
    <section style={{maxWidth:1120,margin:'22px auto 0',...PANEL,minHeight:430}}>
      <div style={{display:'flex',justifyContent:'space-between',flexWrap:'wrap',alignItems:'center',gap:12}}>
        <div><span style={{color:'#6de0b3'}}>▸ </span><strong>GLASS EVENT STREAM</strong>
          <span style={{fontSize:11,color:'#8599a8',marginLeft:12}}>READ-ONLY VIEW · EVENTS {rows.length}</span></div>
        <label style={{fontSize:12,color:'#aeb9c5'}}>Filter <select value={kindFilter} onChange={e=>setKindFilter(e.target.value)}
          style={{background:'#17222c',color:'#fff',padding:5,border:BORDER,borderRadius:5}}>
          {['all','hello','heartbeat','record','service','reconnect','error'].map(k=><option key={k} value={k}>{k}</option>)}
        </select></label>
      </div>
      <div role="log" aria-live="off" style={{overflow:'auto',marginTop:20,height:390,borderTop:BORDER}}>
        {shown.length===0&&<p style={{color:'#82939d',fontSize:13}}>No admitted events yet. Public clock will appear automatically.</p>}
        {shown.map(row=><div key={row.id} style={{display:'grid',gridTemplateColumns:'85px 95px minmax(0,1fr)',gap:10,borderBottom:'1px solid #1f2c35',padding:'8px 0',fontSize:12}}>
          <span style={{color:'#91a6b9'}}>{row.time}</span>
          <span style={{color:row.kind==='record'?'#6de0b3':'#e6c07b'}}>{row.kind}</span>
          <code style={{color:'#c4cbd4',overflowWrap:'anywhere'}}>{row.payload}</code>
        </div>)}
      </div>
    </section>
    <footer style={{maxWidth:1120,margin:'30px auto',fontSize:12,color:'#758894'}}>
      NET → GOV · COM · EDU · GOV · ORG · EDU · GOV · COM → NET.
      Public I/O is not a public microphone feed. ACSP continuity identities remain separate.
    </footer>
  </main>;
}
