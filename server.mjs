import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';

const assets = new Map([['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']].map(([route,file,type])=>[route,[readFileSync(new URL('./dist/'+file,import.meta.url)),type+'; charset=utf-8']]));
const code=()=>randomBytes(8).toString('hex');
const match=(v,c)=>typeof v==='string'&&Buffer.byteLength(v)===c.length&&timingSafeEqual(Buffer.from(v),Buffer.from(c));
const plain=(v,n)=>typeof v==='string'&&!!v.trim()&&v.length<=n;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const active=c=>['ringing','connecting','connected'].includes(c.state);
const sdp=v=>plain(v,32_000)&&v.startsWith('v=0');
function photo(v){
  const m=typeof v==='string'&&/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if(!m||m[1].length>350_000)return false;
  const b=Buffer.from(m[1],'base64');
  if(b.toString('base64')!==m[1]||b.length<=16||b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)return false;
  // Reject outsized decoded dimensions and unsupported JPEG frame types before forwarding.
  for(let i=2;i+4<b.length;){
    if(b[i++]!==255)return false;
    while(b[i]===255)i++;
    if(i+2>=b.length)return false;
    const marker=b[i++],len=b.readUInt16BE(i);
    if(len<2||i+len>b.length)return false;
    if(marker===192||marker===194){
      if(len<8||b[i+2]!==8)return false;
      const h=b.readUInt16BE(i+3),w=b.readUInt16BE(i+5);
      return w>0&&h>0&&w<=900&&h<=900;
    }
    if(marker===218||marker===217)return false;
    i+=len;
  }
  return false;
}

export function createApp({bind='127.0.0.1',port=8443,tls,simulator=false,now=Date.now}={}){
  const operatorCode=code(),inviteCode=code(),sessions=new Map(),calls=new Map(),requests=new Map(),limits=new Map(),log=[];
  let seq=0,board={mode:'offline',seen:0,test:0};
  const peer=id=>[...sessions.values()].find(p=>p.id===id);
  const online=p=>!!p&&now()-p.seen<15_000;
  const record=(type,detail)=>{log.unshift({type,detail,at:now()});if(log.length>60)log.pop();};
  const badge=p=>({id:p.id,name:p.name,role:p.role,seen:p.seen,online:online(p)});
  function emit(p,event){
    if(!p)return;
    const item={...event,seq:++seq,at:now()},size=JSON.stringify(item).length;
    p.inbox.push({item,size});p.bytes+=size;
    while(p.inbox.length>100||p.bytes>1_600_000){const old=p.inbox.shift();p.bytes-=old.size;p.dropped=old.item.seq;}
  }
  function end(c,state,reason){
    if(!active(c))return;
    Object.assign(c,{state,reason,updated:now()});
    for(const id of [c.from,c.to])emit(peer(id),{kind:'end',id:c.id,state,reason});
    record('Call '+state,c.fromName+' → '+c.toName+(reason?' · '+reason:''));
  }
  function clean(){
    for(const [key,p] of sessions)if(now()-p.seen>30*60_000)sessions.delete(key);
    for(const [key,r] of limits)if(now()>r.until)limits.delete(key);
    for(const [id,c] of calls){
      if(active(c)&&(!online(peer(c.from))||!online(peer(c.to))))end(c,'failed','Device stopped responding');
      else if(active(c)&&c.state!=='connected'&&now()-c.updated>45_000)end(c,'failed','Call setup timed out');
      if(!active(c)&&now()-c.updated>15*60_000)calls.delete(id);
    }
    if(board.mode!=='offline'&&now()-board.seen>6500){
      board={...board,mode:'offline'};record('Board offline','Heartbeat lost. Pending requests retained.');
    }
  }
  function rate(key,count,period){
    let r=limits.get(key);
    if(!r){if(limits.size>=1024)fail(429,'Retry shortly');r={n:0,until:now()+period};limits.set(key,r);}
    if(++r.n>count)fail(429,'Too many requests; retry shortly');
  }
  const pending=()=>[...requests.values()].find(r=>r.state!=='acknowledged');
  function apply(d,token,remote){
    const a=d.action;
    clean();
    if(a==='join'){
      rate('join:'+remote,15,60_000);
      const role=match(d.code,operatorCode)?'operator':match(d.code,inviteCode)?'member':null;
      if(!role)fail(401,'Invalid access code');
      const name=typeof d.name==='string'?d.name.trim():'';
      if(!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,23}$/.test(name))fail(400,'Use 1–24 letters, digits or simple separators');
      if(role==='operator'&&[...sessions.values()].some(p=>p.role==='operator'&&online(p)))fail(409,'The operator console is already in use');
      if([...sessions.values()].some(p=>online(p)&&p.name.toLowerCase()===name.toLowerCase()))fail(409,'That name is already in use');
      if(sessions.size>=20)fail(409,'Room is full');
      const key=randomBytes(24).toString('hex'), p={id:randomUUID(),name,role,seen:now(),inbox:[],bytes:0,dropped:0};
      sessions.set(key,p);record('Device joined',name+' · '+role);return {token:key,me:badge(p),simulator};
    }
    const p=sessions.get(token);
    if(!p)fail(401,'Join again');
    if(p.role==='operator'&&[...sessions.values()].some(x=>x!==p&&x.role==='operator'&&online(x)))fail(401,'Operator session was replaced');
    rate('api:'+p.id,80,10_000);p.seen=now();
    const op=p.role==='operator';
    if(a==='poll'){
      const cursor=Number.isSafeInteger(d.cursor)&&d.cursor>=0?d.cursor:0;
      return {peers:[...sessions.values()].filter(x=>x!==p&&(op||online(x))).map(badge),
        events:p.inbox.filter(x=>x.item.seq>cursor).slice(0,8).map(x=>x.item),gap:p.dropped>cursor,
        calls:[...calls.values()].filter(c=>op||c.from===p.id||c.to===p.id).slice(-40).map(({ready,...c})=>c),
        requests:[...requests.values()].filter(r=>op||r.from===p.id).slice(-80),deskAvailable:board.mode!=='offline',...(op?{board,log}: {})};
    }
    if(a==='leave'){sessions.delete(token);if(op)board={...board,mode:'offline'};clean();return {};}
    if(a==='request'){
      if(!plain(d.text,180))fail(400,'Describe the request in 1–180 characters');
      rate('request:'+p.id,6,60_000);
      if([...requests.values()].filter(r=>r.state!=='acknowledged').length>=16)fail(409,'Duty desk queue is full');
      if(requests.size>=80)requests.delete([...requests.values()].find(r=>r.state==='acknowledged').id);
      const r={id:randomUUID(),from:p.id,name:p.name,text:d.text.trim(),state:'queued',at:now()};
      requests.set(r.id,r);record('Assistance requested',p.name);return {id:r.id};
    }
    if(a==='board'){
      if(!op)fail(403,'Operator access required');
      const {mode,signal,id}=d;
      if(signal==='disconnect'){
        if(board.mode!=='offline')record('Board disconnected','Pending requests retained');
        board={...board,mode:'offline'};return {};
      }
      if(!['usb','simulation'].includes(mode)||mode==='simulation'&&!simulator)fail(400,'Invalid board mode');
      if(signal==='heartbeat'){
        if(board.mode!==mode)record('Board '+mode,mode==='usb'?'Firmware heartbeat confirmed':'Classroom simulator');
        board={mode,seen:now(),test:board.mode===mode?board.test:0};return {};
      }
      if(board.mode!==mode)fail(409,'Confirm board connection first');
      if(signal==='test'){board.test=now();record('Output test',mode==='usb'?'Firmware accepted LED and buzzer test':'Simulated output test');return {};}
      const r=pending();
      if(!r||id!==r.id)fail(409,'The active request changed');
      if(signal==='armed'){
        if(r.state==='queued'||r.mode!==mode){Object.assign(r,{state:'alerted',mode,alerted:now()});record('Alert confirmed',r.name+' · '+mode);}
      }else if(signal==='ack'){
        if(r.state!=='alerted'||r.mode!==mode)fail(409,'Alert must be confirmed first');
        Object.assign(r,{state:'acknowledged',ack:now()});record('Request acknowledged',r.name+' · '+mode);
      }else if(signal==='retry'){
        r.state='queued';delete r.mode;delete r.alerted;record('Alert retried',r.name);
      }else fail(400,'Unknown board signal');
      return {};
    }
    if(a==='text'||a==='image'){
      const to=peer(d.to);
      if(to===p||!online(to))fail(409,'Recipient is offline');
      if(a==='text'?!plain(d.content,1200):!photo(d.content))fail(400,'Invalid message or JPEG attachment');
      if(a==='image')rate('image:'+p.id,10,60_000);
      const item={kind:a,from:p.id,to:to.id,name:p.name,content:d.content};emit(to,item);emit(p,item);return {};
    }
    if(a==='call'){
      const {signal,id}=d;
      if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))fail(400,'Invalid call ID');
      if(signal==='offer'){
        const to=peer(d.to);
        if(to===p||!online(to))fail(409,'Recipient is offline');
        if(calls.has(id)||[...calls.values()].some(c=>active(c)&&[c.from,c.to].some(x=>x===p.id||x===to.id)))fail(409,'A participant is already in a call');
        if(!sdp(d.sdp))fail(400,'Invalid call offer');
        if(calls.size>=200)fail(429,'Call history is full; retry later');
        const c={id,from:p.id,to:to.id,fromName:p.name,toName:to.name,state:'ringing',updated:now(),ready:new Set()};
        calls.set(id,c);emit(to,{kind:'offer',id,from:p.id,name:p.name,sdp:d.sdp});record('Call ringing',p.name+' → '+to.name);return {};
      }
      const c=calls.get(id);
      if(!c||p.id!==c.from&&p.id!==c.to)fail(404,'Call not found');
      if(!active(c))return {};
      if(signal==='answer'){
        if(c.to!==p.id||c.state!=='ringing')fail(409,'Call cannot be answered');
        if(!sdp(d.sdp))fail(400,'Invalid call answer');
        Object.assign(c,{state:'connecting',updated:now()});emit(peer(c.from),{kind:'answer',id,sdp:d.sdp});
      }else if(signal==='ready'){
        if(c.state!=='connecting'&&c.state!=='connected')fail(409,'Call is not connecting');
        c.ready.add(p.id);
        if(c.ready.size===2&&c.state!=='connected'){Object.assign(c,{state:'connected',updated:now()});record('Call connected',c.fromName+' → '+c.toName);}
      }else if(['end','decline','fail'].includes(signal)){
        if(signal==='decline'&&(c.to!==p.id||c.state!=='ringing'))fail(409,'Call cannot be declined');
        end(c,{end:'ended',decline:'declined',fail:'failed'}[signal],signal==='fail'&&['Microphone unavailable','Media connection failed','Call setup failed'].includes(d.reason)?d.reason:'');
      }else fail(400,'Unknown call signal');
      return {};
    }
    fail(404,'Unknown action');
  }
  async function handler(req,res){
    const json=(status,value)=>{if(!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}};
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','microphone=(self), camera=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const localPort=req.socket.localPort||port;
    const isLan=!!req.socket.encrypted;
    const allowed=isLan?[bind+':'+localPort]:['127.0.0.1:'+localPort,'localhost:'+localPort];
    if(!allowed.includes(req.headers.host))return json(421,{error:'Use the address printed by the server'});
    if(req.method==='GET'&&assets.has(req.url)){
      const [body,type]=assets.get(req.url);res.writeHead(200,{'Content-Type':type});return res.end(body);
    }
    if(req.method!=='POST'||req.url!=='/api')return json(404,{error:'Not found'});
    if(req.headers.origin!==(isLan?'https://':'http://')+req.headers.host||
      req.headers['content-type']!=='application/json'||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')return json(403,{error:'Same-origin JSON required'});
    if(Number(req.headers['content-length'])>370_000){res.setHeader('Connection','close');req.resume();return json(413,{error:'Request too large'});}
    try{
      let size=0;const parts=[];
      for await(const chunk of req){
        size+=chunk.length;
        if(size>370_000){res.setHeader('Connection','close');json(413,{error:'Request too large'});return;}
        parts.push(chunk);
      }
      let d;try{d=JSON.parse(Buffer.concat(parts));}catch{fail(400,'Invalid JSON');}
      if(!d||typeof d!=='object'||Array.isArray(d))fail(400,'Invalid request');
      const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];
      json(200,apply(d,token,req.socket.remoteAddress));
    }catch(e){json(e.status||500,{error:e.status?e.message:'Request failed'});}
  }
  const server=tls?https.createServer({...tls,minVersion:'TLSv1.2'},handler):http.createServer(handler);
  const loopback=tls?http.createServer(handler):null;
  for(const listener of [server,loopback].filter(Boolean)){
    listener.headersTimeout=5000;listener.requestTimeout=10_000;listener.maxConnections=64;
  }
  return {server,loopback,operatorCode,inviteCode};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2),simulator=args.includes('--simulate'),rest=args.filter(a=>a!=='--simulate');
  let bind='127.0.0.1',tls;
  if(rest.length){
    const [flag,ip,cert,key]=rest;
    if(rest.length!==4||flag!=='--lan'||isIP(ip)!==4||ip==='0.0.0.0'||ip.startsWith('127.')){
      console.error('Usage: node server.mjs [--simulate] [--lan <local-IPv4> <cert.pem> <key.pem>]');process.exit(1);
    }
    bind=ip;tls={cert:readFileSync(cert),key:readFileSync(key)};
  }
  const port=8443,{server,loopback,operatorCode,inviteCode}=createApp({bind,tls,port,simulator});
  const fatal=e=>{console.error('Cannot start Field Link:',e.code);process.exit(1);};
  server.on('error',fatal);loopback?.on('error',fatal);
  const ready=()=>console.log(['FIELD LINK · http://127.0.0.1:'+port,
    ...(tls?['Phone address: https://'+bind+':'+port]:[]),'Member invite: '+inviteCode,'Operator code: '+operatorCode,
    simulator?'Simulator enabled.':'Simulator disabled.'].join('\n'));
  server.listen(port,bind,()=>{if(loopback)loopback.listen(port,'127.0.0.1',ready);else ready();});
}
