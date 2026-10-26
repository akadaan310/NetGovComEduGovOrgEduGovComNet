import { describe, expect, it } from 'vitest';
import {
  constantTimeKey, domainGrammar, parseCursor, parseEvent,
  validatedRoom, GlassError
} from '../src/glass/grammar';

describe('GLASS-LIVE/0.1 transport grammar',()=>{
  it('computes source-derived NET envelope and categorical permutations',()=>{
    const name=domainGrammar();
    expect(name.interior).toEqual(['Gov','Com','Edu','Gov','Org','Edu','Gov','Com']);
    expect(name.frequency).toEqual({Gov:3,Com:2,Edu:2,Org:1});
    expect(name.multisetOrders).toBe(1680);
    expect(name.unconstrainedFiveTypeInterior).toBe(390625);
    expect(()=>domainGrammar('ComGovNet')).toThrow(GlassError);
  });
  it('accepts bounded numerical/categorical traces but not audio/text payloads',()=>{
    const input={
      room:'glass_testroom12',eventId:'g123456789a',kind:'audio.trace',
      features:{rms:0.21,zcr:0.04,voice:true,traceId:'dsp.rms',language:'unknown'},
    };
    expect(parseEvent(input).features.rms).toBe(.21);
    expect(()=>parseEvent({...input,features:{rawPcm:[0,1,2]}})).toThrow();
    expect(()=>parseEvent({...input,features:{transcript:'سورة الفاتحة'}})).toThrow();
    expect(()=>parseEvent({...input,features:{speaker:'name'}})).toThrow();
    expect(()=>parseEvent({...input,features:{language:'private-voice'}})).toThrow();
    expect(()=>parseEvent({...input,kind:'video.frame'})).toThrow();
    expect(()=>parseEvent({...input,features:{rms:Infinity}})).toThrow();
  });
  it('rejects forged secret, handles cursor/room correctly',()=>{
    const key='someprivatewritekeywithatleast32chars';
    expect(constantTimeKey(key,key)).toBe(true);
    expect(constantTimeKey('guess',key)).toBe(false);
    expect(constantTimeKey('',undefined)).toBe(false);
    expect(parseCursor('0004')).toBe(4);
    expect(()=>parseCursor('1e10')).toThrow();
    expect(()=>validatedRoom('../abc')).toThrow();
  });
});
