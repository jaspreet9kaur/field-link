import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { readFileSync } from 'node:fs';
import { createApp } from './server.mjs';

async function fixture(t,options={}){
  const app=createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  return {...app,url:'http://127.0.0.1:'+app.server.address().port};
}
async function post(url,action,data={},token,origin=url){
  const response=await fetch(url+'/api',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({action,...data})});
  return {status:response.status,body:await response.json()};
}
test('local server, permissions, text and request recovery',async t=>{
  let now=Date.now();
  const a=await fixture(t,{simulator:true,now:()=>now});
  const go=(action,d,token)=>post(a.url,action,d,token);
  const index=await fetch(a.url);assert.equal(index.status,200);assert.match(await index.text(),/duty desk/i);
  assert.match(index.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await go('poll',{})).status,401);
  assert.equal((await post(a.url,'join',{},undefined,'https://example.test')).status,403);
  const join=async(name,code)=>{const r=await go('join',{name,code});assert.equal(r.status,200);return r.body;};
  const member=await join('Workshop',a.inviteCode),desk=await join('Desk',a.operatorCode),other=await join('Stores',a.inviteCode);
  assert.equal((await go('board',{signal:'heartbeat',mode:'simulation'},member.token)).status,403);
  assert.equal((await go('text',{to:other.me.id,content:'<script>alert(1)</script>'},member.token)).status,200);
  const read=async p=>(await go('poll',{},p.token)).body;
  assert.equal((await read(desk)).events.length,0);
  assert.equal((await read(other)).events[0].content,'<script>alert(1)</script>');
  assert.equal((await go('image',{to:other.me.id,content:'data:image/svg+xml;base64,AAAA'},member.token)).status,400);
  const file=Buffer.from([255,216,255,192,0,17,8,255,255,0,3,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64');
  assert.equal((await go('image',{to:other.me.id,content:'data:image/jpeg;base64,'+file},member.token)).status,400);
  const request=(await go('request',{text:'Check test bench'},member.token)).body.id;
  assert.equal((await read(other)).requests.length,0);
  const board=(signal,id=request,mode='simulation')=>go('board',{signal,id,mode},desk.token);
  assert.equal((await board('heartbeat')).status,200);
  assert.equal((await board('ack')).status,409);
  assert.equal((await board('armed')).status,200);
  now+=7000;
  assert.equal((await read(desk)).board.mode,'offline');
  assert.equal((await read(member)).requests[0].state,'alerted');
  assert.equal((await board('ack')).status,409);
  await board('heartbeat');await board('retry');await board('armed');
  assert.equal((await board('ack')).status,200);
  assert.equal((await read(member)).requests[0].mode,'simulation');
  assert.equal((await read(member)).requests[0].state,'acknowledged');
  const call=crypto.randomUUID();
  const signal=(p,signal,extra={})=>go('call',{signal,id:call,...extra},p.token);
  assert.equal((await signal(member,'offer',{to:other.me.id,sdp:'v=0\r\n'})).status,200);
  assert.equal((await signal(desk,'end')).status,404);
  assert.equal((await signal(other,'answer',{sdp:'v=0\r\n'})).status,200);
  await signal(member,'ready');assert.equal((await read(desk)).calls[0].state,'connecting');
  await signal(other,'ready');assert.equal((await read(desk)).calls[0].state,'connected');
  assert.equal((await read(desk)).events.length,0);
});
test('hardware-only mode rejects simulator; join requests are rate limited',async t=>{
  const a=await fixture(t);
  const desk=(await post(a.url,'join',{name:'Desk',code:a.operatorCode})).body;
  assert.equal((await post(a.url,'board',{signal:'heartbeat',mode:'simulation'},desk.token)).status,400);
  assert.equal((await post(a.url,'board',{signal:'heartbeat',mode:'usb'},desk.token)).status,200);
  for(let i=0;i<14;i++)assert.equal((await post(a.url,'join',{name:'Test',code:'wrong'})).status,401);
  assert.equal((await post(a.url,'join',{name:'Test',code:'wrong'})).status,429);
});

test('phone HTTPS and operator HTTP share a room but reject cross-origin API requests',
  {skip:!process.env.FIELD_LINK_TEST_CERT},async t=>{
  const dir=process.env.FIELD_LINK_TEST_CERT, ip='192.0.2.42';
  const app=createApp({bind:ip,tls:{key:readFileSync(dir+'/server-key.pem'),cert:readFileSync(dir+'/server.pem')}});
  for(const server of [app.server,app.loopback]){
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(()=>new Promise(resolve=>server.close(resolve)));
  }
  const origin='https://'+ip+':'+app.server.address().port;
  const deskUrl='http://127.0.0.1:'+app.loopback.address().port;
  const desk=(await post(deskUrl,'join',{name:'Desk',code:app.operatorCode})).body;
  const phone=(data,originHeader=origin)=>new Promise((resolve,reject)=>{
    const body=JSON.stringify(data), req=https.request({
      hostname:'127.0.0.1',port:app.server.address().port,path:'/api',method:'POST',
      headers:{Host:new URL(origin).host,Origin:originHeader,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      ca:readFileSync(dir+'/field-link-ca.crt').toString('base64').match(/.{1,64}/g).reduce((s,line)=>s+line+'\n','-----BEGIN CERTIFICATE-----\n')+'-----END CERTIFICATE-----\n',
      checkServerIdentity:(_host,certificate)=>checkServerIdentity(ip,certificate)
    },res=>{let output='';res.on('data',c=>output+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(output)}));});
    req.on('error',reject);req.end(body);
  });
  assert.equal((await phone({action:'join',name:'Phone',code:app.inviteCode},deskUrl)).status,403);
  const member=await phone({action:'join',name:'Phone',code:app.inviteCode});assert.equal(member.status,200);
  assert.ok((await post(deskUrl,'poll',{},desk.token)).body.peers.some(p=>p.id===member.body.me.id));
});

test('browser: photo, request, simulated disconnect/retry and WebRTC call',{skip:!process.env.FIELD_LINK_PLAYWRIGHT},async t=>{
  const {chromium}=await import(process.env.FIELD_LINK_PLAYWRIGHT);
  const a=await fixture(t,{simulator:true});
  const browser=await chromium.launch({executablePath:process.env.FIELD_LINK_CHROME,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--disable-background-networking','--no-first-run']});
  t.after(()=>browser.close());
  const newPage=async(name,code,viewport)=>{
    const ctx=await browser.newContext({permissions:['microphone'],viewport});const p=await ctx.newPage();
    await p.goto(a.url);await p.getByLabel('Display name').fill(name);await p.getByLabel('Access code').fill(code);
    await p.getByRole('button',{name:'Connect to Field Link'}).click();await p.locator('#room').waitFor();return p;
  };
  const desk=await newPage('Duty Desk',a.operatorCode),member=await newPage('Workshop',a.inviteCode,{width:390,height:844});
  assert.equal(await member.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await desk.getByRole('button',{name:'Start simulation'}).click();
  await member.getByLabel('What do you need?').fill('Check the supply');
  await member.getByRole('button',{name:'Send to duty desk'}).click();
  await desk.locator('#op-requests').getByText('Alert confirmed · simulated').waitFor();
  await desk.getByRole('button',{name:'Disconnect',exact:true}).click();
  await desk.locator('#op-requests').getByText('Board offline · retry pending').waitFor();
  await desk.getByRole('button',{name:'Start simulation'}).click();
  await desk.getByRole('button',{name:'Retry alert'}).click();
  await desk.getByRole('button',{name:'Simulate button press'}).click();
  await member.locator('#my-requests').getByText('Acknowledged · simulated').waitFor();
  await member.getByLabel('Message',{exact:true}).fill('<img src=x onerror=alert(1)>');
  await member.getByRole('button',{name:'Send',exact:true}).click();
  await desk.locator('#messages').getByText('<img src=x onerror=alert(1)>').waitFor();
  const data=await member.evaluate(()=>{const c=document.createElement('canvas');c.width=64;c.height=64;c.getContext('2d').fillRect(0,0,64,64);return c.toDataURL('image/png').split(',')[1];});
  await member.locator('#photo').setInputFiles({name:'bench.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
  await desk.locator('#messages img').waitFor();
  assert.equal(await desk.locator('#messages img').evaluate(img=>img.complete&&img.naturalWidth===64),true);
  await member.getByRole('button',{name:'Voice call'}).click();
  await desk.getByRole('button',{name:'Answer',exact:true}).click({timeout:15_000});
  await desk.locator('#call-log').getByText('connected',{exact:true}).waitFor({timeout:20_000});
  await member.getByRole('button',{name:'End call'}).click();
  await desk.locator('#call-log').getByText('ended',{exact:true}).waitFor();
});

test('browser: USB protocol heartbeat, alert and mock button acknowledgement',{skip:!process.env.FIELD_LINK_PLAYWRIGHT},async t=>{
  const {chromium}=await import(process.env.FIELD_LINK_PLAYWRIGHT);
  const a=await fixture(t);
  const browser=await chromium.launch({executablePath:process.env.FIELD_LINK_CHROME,args:['--disable-background-networking','--no-first-run']});
  t.after(()=>browser.close());
  const desk=await browser.newPage();
  await desk.addInitScript(()=>{
    let controller,active='-',state='I',ap=false;
    const line=s=>controller.enqueue(new TextEncoder().encode(s+'\n'));
    const pong=()=>line('PONG '+active+' '+state);
    const port={
      open(){
        this.readable=new ReadableStream({start(c){controller=c;}});
        this.writable=new WritableStream({write(data){
          const msg=new TextDecoder().decode(data).trim();
          if(msg==='PING')pong();
          if(msg==='TEST')line('TEST OK');
          if(msg==='AP?')line(ap?'AP ON':'AP OFF');
          if(/^APSTART [0-9a-f]{20}$/.test(msg)){ap=true;line('AP ON');}
          if(msg==='APSTOP'){ap=false;line('AP OFF');}
          if(msg.startsWith('ALERT ')){
            const id=msg.slice(6);
            if(id!==active){active=id;state='L';}
            pong();
          }
        }});
      },
      close(){this.readable=null;this.writable=null;}
    };
    Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>port}});
    window.mockButton=()=>{if(state==='L'){state='A';pong();}};
    window.mockUnplug=()=>controller.error(new Error('USB removed'));
  });
  await desk.goto(a.url);
  await desk.getByLabel('Display name').fill('Desk');
  await desk.getByLabel('Access code').fill(a.operatorCode);
  await desk.getByRole('button',{name:'Connect to Field Link'}).click();
  await desk.getByRole('button',{name:'Connect ESP32'}).click();
  await desk.locator('#board-mode').getByText('USB connected').waitFor();
  await desk.getByText('Phone demo without a router',{exact:true}).click();
  await desk.getByRole('button',{name:'Start ESP32 Wi‑Fi'}).click();
  await desk.locator('#ap-key').getByText(/^Wi‑Fi password: [0-9a-f]{20}$/).waitFor();
  await desk.getByRole('button',{name:'Stop ESP32 Wi‑Fi'}).click();
  await desk.locator('#ap-status').getByText('ESP32 Wi‑Fi is off.').waitFor();
  await desk.getByRole('button',{name:'Test outputs'}).click();
  await desk.getByText('Firmware confirmed the test.',{exact:false}).waitFor();
  const member=(await post(a.url,'join',{name:'Workshop',code:a.inviteCode})).body;
  await post(a.url,'request',{text:'Check the USB protocol'},member.token);
  await desk.locator('#op-requests').getByText('Alert confirmed',{exact:true}).waitFor();
  await desk.evaluate(()=>window.mockUnplug());
  await desk.locator('#op-requests').getByText('Board offline · retry pending').waitFor();
  await desk.getByRole('button',{name:'Connect ESP32'}).click();
  await desk.locator('#board-mode').getByText('USB connected').waitFor();
  await desk.evaluate(()=>window.mockButton());
  await desk.locator('#op-requests').getByText('Acknowledged',{exact:true}).waitFor();
  const received=(await post(a.url,'poll',{},member.token)).body.requests[0];
  assert.equal(received.state,'acknowledged');assert.equal(received.mode,'usb');
});
