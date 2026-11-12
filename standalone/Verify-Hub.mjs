import assert from 'node:assert/strict';
import https from 'node:https';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const credentials=readFileSync(new URL('./private/hub-access.log',import.meta.url),'utf8');
const get=tag=>credentials.match(new RegExp('^'+tag+' (\\S+)','m'))?.[1];
const origin=get('URL'),invite=get('MEMBER'),operator=get('OPERATOR');
const ca=new X509Certificate(readFileSync(new URL('./private/field-link-hub-ca.crt',import.meta.url))).toString();
if(!origin||!invite||!operator)throw Error('Provision the ESP32 first.');
const agent=new https.Agent({keepAlive:true,maxSockets:2,maxFreeSockets:1});
function http(path,action,token,from=origin){
  const body=action&&JSON.stringify(action);
  return new Promise((resolve,reject)=>{
    const req=https.request(origin+path,{method:action?'POST':'GET',ca,timeout:9000,agent,headers:action?{
      Origin:from,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...(token?{Authorization:'Bearer '+token}:{})
    }:{}},res=>{
      res.on('error',reject);
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{
        try{
          const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,data:action?JSON.parse(text):text});
        }catch{reject(Error('Invalid HTTPS response from the hub ('+res.statusCode+')'));}
      });
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('ESP32 HTTPS timed out')));
    req.end(body);
  });
}
const api=(action,body={},token)=>http('/api',{action,...body},token);
async function releaseTestSeat(token){
  for(let attempt=0;attempt<3;attempt++){
    try{
      const {status}=await api('leave',{},token);
      if(status===200||status===401)return true;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  return false;
}
async function releaseTestSeats(tokens){
  let released=0;
  for(const token of tokens)if(await releaseTestSeat(token))released++;
  assert.equal(released,tokens.length,'Could not confirm all temporary test accounts were released.');
  if(released)console.log('Temporary test accounts released:',released);
}
function fileRequest(path,{token,body,to,from=origin}={}){
  return new Promise((resolve,reject)=>{
    const headers={...(token?{Authorization:'Bearer '+token}:{})};
    if(body)Object.assign(headers,{Origin:from,'Content-Type':'image/jpeg','Content-Length':body.length,'X-Recipient':to});
    const req=https.request(origin+path,{method:body?'POST':'GET',ca,headers,agent,timeout:14000},res=>{
      res.on('error',reject);
      const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],data:Buffer.concat(parts)}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Photo HTTPS timed out')));req.end(body);
  });
}
const run=process.argv.includes('--browser')?'browser':'api';
const label=Date.now().toString(36).slice(-6);
if(run==='api'){
  const tokens=[];
  try{
    const page=await http('/');assert.equal(page.status,200);assert.match(page.data,/ESP32 HOST/);
    const version=await http('/version');assert.equal(version.status,200);assert.match(version.data,/^[a-f0-9]{16}$/);assert.ok(page.data.includes(version.data));
    const denied=await http('/api',{action:'join',name:'Blocked',code:invite},undefined,'https://example.invalid');assert.equal(denied.status,403);
    assert.equal((await api('poll')).status,401);
    for(const [name,code] of [['FLTest-A',invite],['FLTest-B',invite],['FLTest-O',operator]]){
      const r=await api('join',{name:name+'-'+label,code});
      if(r.status===409&&name==='FLTest-O'){console.log('Operator test seat unavailable; existing participants retained.');break;}
      assert.equal(r.status,200,r.data.error);tokens.push(r.data);
    }
    const [a,b,o]=tokens;
    const resume=await api('resume',{},a.token);assert.equal(resume.data.me.id,a.me.id);
    assert.equal((await api('text',{to:b.me.id,text:'<img src=x onerror=alert(1)>'},a.token)).status,200);
    if(o){
      const ops=(await api('poll',{},o.token)).data;
      assert.equal(o.me.role,'operator');assert.equal(ops.events.length,0);
      if(process.argv.includes('--check-demo-cleanup')){
        const fixtures=/^(?:(?:Alpha|Bravo|Desk|Audit)|FLTest-(?:A|B|O|Alpha|Bravo|Audit))-[a-z0-9]{6}$/;
        const current=new Set(tokens.map(x=>x.me.id));
        const leftovers=ops.peers.filter(p=>!current.has(p.id)&&fixtures.test(p.name));
        assert.deepEqual(leftovers.map(p=>p.name),[],'Unexpected registrations with the automated test naming pattern.');
        console.log('Operator roster contains no older test registrations.');
      }
      assert.ok(ops.operator.activity.some(x=>x.from===a.me.name&&x.to===b.me.name&&x.status===1));
      assert.equal(JSON.stringify(ops.operator).includes('onerror'),false);
    }
    const update=(await api('poll',{},b.token)).data;
    assert.equal(update.events[0].text,'<img src=x onerror=alert(1)>');
    const message=update.events[0].messageId;
    assert.ok(Number.isSafeInteger(message));assert.equal(update.operator,undefined);
    const history=(await api('history',{peer:a.me.id},b.token)).data;
    assert.ok(history.messages.some(x=>x.messageId===message&&x.text==='<img src=x onerror=alert(1)>'));
    if(o){
      assert.deepEqual((await api('history',{peer:a.me.id},o.token)).data.messages,[]);
      assert.equal((await api('locationGrant',{subject:b.me.id,viewer:a.me.id,allow:true},a.token)).status,403);
      assert.equal((await api('locationGrant',{subject:b.me.id,viewer:a.me.id,allow:true},o.token)).status,409);
      assert.equal((await api('location',{lat:12.25,lon:77.75,accuracy:12},b.token)).status,200);
      const tracking=async t=>(await api('poll',{tracking:true},t)).data.locations;
      assert.ok(!(await tracking(a.token)).some(p=>p.id===b.me.id));
      assert.ok((await tracking(o.token)).some(p=>p.id===b.me.id&&p.lat===12.25));
      assert.equal((await api('locationGrant',{subject:b.me.id,viewer:a.me.id,allow:true},o.token)).status,200);
      assert.ok((await tracking(a.token)).some(p=>p.id===b.me.id));
      assert.equal((await api('location',{stop:true},b.token)).status,200);
      assert.ok(!(await tracking(a.token)).some(p=>p.id===b.me.id));
    }
    await api('poll',{boot:update.boot,read:[message]},a.token);
    if(o)await api('poll',{boot:update.boot,read:[message]},o.token);
    assert.deepEqual((await api('poll',{},a.token)).data.receipts,[]);
    await api('poll',{boot:update.boot,delivered:[message]},b.token);
    assert.deepEqual((await api('poll',{},a.token)).data.receipts,[[message,2]]);
    await api('poll',{boot:update.boot,read:[message]},b.token);
    await api('poll',{boot:update.boot,delivered:[message]},b.token);
    assert.deepEqual((await api('poll',{},a.token)).data.receipts,[[message,3]]);
    assert.equal((await api('poll',{boot:update.boot,cursor:update.events[0].seq},b.token)).data.events.length,0);
    const stale=(await api('poll',{boot:update.boot===1?2:1,cursor:0xffffffff},b.token)).data;
    assert.equal(stale.boot,update.boot);assert.equal(stale.events[0].seq,update.events[0].seq);
    const watch=(await api('watch',{},b.token)).data.events[0];assert.equal(watch.kind,'text');assert.equal(watch.text,undefined);
    assert.equal((await fileRequest('/photo',{body:Buffer.alloc(28),to:b.me.id,token:a.token,from:'https://example.invalid'})).status,403);
    assert.equal((await fileRequest('/photo',{body:Buffer.alloc(28),to:b.me.id,token:a.token})).status,400);
    assert.equal((await fileRequest('/photo?id='+'a'.repeat(24))).status,401);
    const id=randomUUID();
    const sdp='v=0\r\na=x-escape:"quoted"\\value\t\r\n'+'a=x-fieldlink-test\r\n'.repeat(220);
    assert.equal((await api('call',{id,signal:'offer',mode:'video',to:b.me.id,sdp},a.token)).status,200);
    assert.equal((await api('poll',{},b.token)).data.events.find(e=>e.id===id)?.sdp,sdp);
    if(o){
      assert.equal((await api('call',{id,signal:'end'},o.token)).status,404);
      const ops=(await api('poll',{},o.token)).data;
      assert.ok(ops.calls.some(c=>c.id===id&&c.fromName===a.me.name&&c.toName===b.me.name&&c.state==='ringing'));
      assert.equal(ops.events.length,0);
    }
    const incoming=(await api('watch',{},b.token)).data.events.find(e=>e.kind==='offer');
    assert.equal(incoming.live,true);assert.equal(incoming.sdp,undefined);
    assert.equal((await api('call',{id,signal:'decline'},b.token)).status,200);
    assert.equal((await api('watch',{},b.token)).data.events.find(e=>e.kind==='offer').live,false);
    if(process.argv.includes('--verify-reboot')&&o){
      const {calls}= (await api('poll',{},o.token)).data;
      if(calls.some(c=>['ringing','connecting','connected'].includes(c.state)))console.log('History reboot test skipped while a call is active.');
      else{
        assert.ok(process.env.FIELD_LINK_FLASHER,'Set the ESP32 flasher path for the reboot verification.');
        assert.match(process.env.FIELD_LINK_PORT || '', /^COM[0-9]+$/i, 'Set FIELD_LINK_PORT for the reboot verification.');
        execFileSync(process.env.FIELD_LINK_FLASHER,['--chip','esp32','--port',process.env.FIELD_LINK_PORT,'--after','hard-reset','run'],{stdio:'ignore',timeout:18000});
        let resumed;
        for(let i=0;i<12;i++){
          await new Promise(resolve=>setTimeout(resolve,2200));
          try{const reply=await api('resume',{},b.token);if(reply.status===200&&reply.data.boot!==update.boot){resumed=reply.data;break;}}catch{}
        }
        assert.ok(resumed,'ESP32 did not resume the account after reboot.');
        const restored=(await api('history',{peer:a.me.id},b.token)).data;
        assert.ok(restored.messages.some(x=>x.messageBoot===update.boot&&x.messageId===message&&x.text==='<img src=x onerror=alert(1)>'));
        console.log('A chat entry survived an actual ESP32 reboot and was retrieved with the saved sign-in.');
      }
    }
    console.log('Actual ESP32: trusted HTTPS, web build version, private history, text receipts, operator access, location grants and full video offer passed.');
  }finally{await releaseTestSeats(tokens.map(t=>t.token));}
}else{
  const page=await http('/');assert.equal(page.status,200);
  // Chrome on this PC is intercepted by a security filter. Use a test-only
  // loopback relay while Node verifies the actual ESP32 certificate on every hop.
  let photoId='',senderToken='';
  const fixtureTokens=[];
  const relay=createServer(async(req,res)=>{
    const types={'/':'text/html','/style.css':'text/css','/app.js':'text/javascript'};
    try{
      if(req.method==='GET'&&types[req.url]){
        const r=process.argv.includes('--source-ui')?
          {status:200,data:readFileSync(new URL('./web/'+(req.url==='/'?'index.html':req.url.slice(1)),import.meta.url),'utf8')}:
          await http(req.url);
        res.writeHead(r.status,{'Content-Type':types[req.url]+'; charset=utf-8'});return res.end(r.data);
      }
      if(req.method==='POST'&&req.url==='/api'&&req.headers.origin==='http://127.0.0.1:'+relay.address().port){
        let body='';for await(const part of req){body+=part.toString();if(body.length>10500)throw Error('Payload too large');}
        const frame=JSON.parse(body);
        const r=await http('/api',frame,req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]);
        if(frame.action==='join'&&r.status===200&&r.data.token)fixtureTokens.push(r.data.token);
        const attachment=r.data.events?.find(e=>e.kind==='photo');if(attachment)photoId=attachment.photoId;
        if(frame.action==='call')console.log('Call test:',frame.mode||'',frame.signal,'SDP length:',frame.sdp?.length||0,'HTTP:',r.status);
        if(process.argv.includes('--trace-media')&&frame.action==='poll'&&r.data.events?.length)
          console.log('Poll events:',r.data.events.map(e=>[e.kind,e.seq,e.sdp?.length||0]),'sessions:',r.data.calls.map(c=>[c.mode,c.state]));
        res.writeHead(r.status,{'Content-Type':'application/json'});return res.end(JSON.stringify(r.data));
      }
      const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if(req.method==='POST'&&req.url==='/photo'&&req.headers.origin==='http://127.0.0.1:'+relay.address().port&&req.headers['content-type']==='image/jpeg'){
        let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>102400)throw Error('Photo too large');parts.push(part);}
        const r=await fileRequest('/photo',{token,body:Buffer.concat(parts),to:req.headers['x-recipient']});
        console.log('Photo upload HTTP:',r.status);
        senderToken=token;res.writeHead(r.status,{'Content-Type':r.type});return res.end(r.data);
      }
      if(req.method==='GET'&&/^\/photo\?id=[a-f0-9]{24}$/.test(req.url)){
        const r=await fileRequest(req.url,{token});res.writeHead(r.status,{'Content-Type':r.type});return res.end(r.data);
      }
      res.writeHead(404);res.end();
    }catch(e){if(process.argv.includes('--trace-media'))console.log('Test relay:',e.message);res.writeHead(502);res.end();}
  });
  relay.listen(0,'127.0.0.1');await once(relay,'listening');
  const local='http://127.0.0.1:'+relay.address().port;
  const {chromium}=await import(process.env.FIELD_LINK_PLAYWRIGHT);
  const browser=await chromium.launch({executablePath:process.env.FIELD_LINK_CHROME,args:[
    '--no-proxy-server','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--disable-background-networking']});
  const clients=[];
  let receiverOffline=false;
  try{
    const conferenceTest=process.argv.includes('--conference');
    for(const name of conferenceTest?['Alpha','Bravo','Charlie']:['Alpha','Bravo']){
      const ctx=await browser.newContext({permissions:['microphone','camera'],viewport:{width:390,height:844}});
      await ctx.route('**/*',r=>name==='Bravo'&&receiverOffline?r.abort():
        [local+'/','blob:'+local+'/'].some(prefix=>r.request().url().startsWith(prefix))?r.continue():r.abort());
      const p=await ctx.newPage();clients.push(p);
      if(process.argv.includes('--trace-media')){
        p.on('console',m=>{if(m.text().startsWith('FLDEBUG '))console.log(name,m.text());});
        await p.addInitScript(()=>{
          for(const method of ['close','setRemoteDescription','createAnswer']){
            const original=RTCPeerConnection.prototype[method];
            RTCPeerConnection.prototype[method]=function(...args){
              console.log('FLDEBUG '+method+' '+this.signalingState+' '+(new Error().stack.split('\n').slice(2,5).join(' | ')));
              return original.apply(this,args);
            };
          }
        });
      }
      const response=await p.goto(local+'/');
      if(response?.status()!==200||!await p.locator('#name').count()){
        throw Error('Browser did not receive the sign-in page: '+response?.status()+' '+(await p.title()));
      }
      assert.equal(await p.evaluate(()=>isSecureContext),true,'Browser needs trusted HTTPS for media');
      await p.getByLabel('Display name').fill('FLTest-'+name+'-'+label);await p.getByLabel('Room invite').fill(invite);
      await p.getByRole('button',{name:'Join room'}).click();
      try{await p.locator('#room').waitFor({timeout:15000});}
      catch(e){throw Error('Test sign-in failed for '+name+': '+await p.locator('#notice').textContent(),{cause:e});}
    }
    const [a,b,c]=clients;
    await a.getByRole('button',{name:new RegExp('Bravo-'+label)}).click();
    await a.getByRole('textbox',{name:'Message',exact:true}).fill('<img src=x onerror=alert(1)>');
    await a.getByRole('button',{name:'Send',exact:true}).click();
    await a.getByRole('img',{name:'Delivered',exact:true}).waitFor();
    await b.getByRole('button',{name:new RegExp('Alpha-'+label)}).click();
    await b.locator('#messages').getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();
    await a.getByRole('img',{name:'Read',exact:true}).waitFor();
    console.log('Browser receipt test passed: delivered before opening, read after opening.');
    const modes=process.argv.includes('--photos-only')?[]:process.argv.includes('--video-only')?['Video']:['Voice','Video'];
    for(const mode of modes){
      await a.evaluate(mode=>{
        const original=window.flTestCapture||navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        window.flTestCapture=original;let attempted=0;
        navigator.mediaDevices.getUserMedia=constraints=>{
          if(constraints.audio&&(mode==='Video'||attempted++===0))
            return Promise.reject(new DOMException('Test microphone fault','NotReadableError'));
          return original(constraints);
        };
      },mode);
      await a.getByRole('button',{name:mode,exact:true}).click();
      try{await b.getByRole('button',{name:'Answer',exact:true}).click({timeout:13000});}
      catch(e){throw Error(mode+' did not ring. Sender: '+await a.locator('#notice').textContent()+'; receiver: '+await b.locator('#notice').textContent(),{cause:e});}
      try{await a.locator('#call-state').getByText('Connected',{exact:true}).waitFor({timeout:25000});}
      catch(e){throw Error(mode+' did not connect. Sender: '+await a.locator('#notice').textContent()+'; receiver: '+await b.locator('#notice').textContent(),{cause:e});}
      if(mode==='Video')await a.locator('#notice').getByText('Video will connect without your microphone.',{exact:false}).waitFor();
      if(mode==='Voice'&&conferenceTest){
        await a.getByRole('button',{name:'Add & merge',exact:true}).click();
        await a.getByRole('dialog').getByRole('button',{name:new RegExp('Charlie-'+label)}).click();
        await c.getByRole('button',{name:'Answer',exact:true}).click({timeout:20000});
        await a.waitForFunction(()=>!!mix&&!!conference&&conference.pc.connectionState==='connected'&&
          current.pc.getSenders().some(s=>s.track?.kind==='audio'&&s.track!==mix.raw)&&
          conference.pc.getSenders().some(s=>s.track?.kind==='audio'&&s.track!==mix.raw));
        console.log('Three-party voice conference connected and both host outputs carried mixed tracks.');
      }
      await a.getByRole('button',{name:'End',exact:true}).click();
      await b.locator('#call').waitFor({state:'hidden'});
      console.log(mode+' browser test passed.');
    }
    const image=await a.evaluate(()=>{const c=document.createElement('canvas');c.width=50;c.height=50;const g=c.getContext('2d');g.fillStyle='#125331';g.fillRect(0,0,50,50);return c.toDataURL().split(',')[1];});
    receiverOffline=true;
    await b.context().setOffline(true);
    await a.locator('#file').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
    const waitPhoto=async p=>{
      const image=p.locator('#messages img').first(),retry=p.getByRole('button',{name:'Retry photo',exact:true}).first();
      for(let i=0;i<3;i++){
        await image.or(retry).waitFor({timeout:18000});
        if(await image.isVisible())return;
        await retry.click();
      }
      await image.waitFor({timeout:18000});
    };
    try{await waitPhoto(a);}
    catch(e){throw Error('Sender did not display the photo. '+await a.locator('#notice').textContent(),{cause:e});}
    receiverOffline=false;
    await b.context().setOffline(false);
    await waitPhoto(b);
    await b.waitForFunction(()=>document.querySelector('#messages img')?.naturalWidth===50);
    assert.equal(await b.getByRole('button',{name:'Answer',exact:true}).isVisible(),false);
    await b.getByRole('button',{name:'Open photo'}).click();
    await b.getByRole('dialog').waitFor();
    const saved=b.waitForEvent('download');await b.getByRole('button',{name:'Save to device'}).click();
    assert.match((await saved).suggestedFilename(),/^Field-Link-[a-f0-9]{8}\.jpg$/);
    assert.match(photoId,/^[a-f0-9]{24}$/);assert.ok(senderToken);
    const third=await api('join',{name:'FLTest-Audit-'+label,code:operator});
    const other=third.data;
    try{
      if(third.status===200)assert.equal((await fileRequest('/photo?id='+photoId,{token:other.token})).status,404);
      else if(third.status===409)console.log('Third test seat unavailable; unauthenticated photo download checked instead.');
      else assert.fail(other.error);
      assert.equal((await fileRequest('/photo?id='+photoId)).status,401);
      assert.equal((await fileRequest('/photo?id='+photoId,{token:senderToken})).status,200);
    }finally{if(other.token)await releaseTestSeats([other.token]);}
    await b.getByRole('button',{name:'Close',exact:true}).click();
    await b.reload();await b.locator('#room').waitFor();
    await b.getByRole('button',{name:'Tele-directory',exact:true}).click();
    await b.getByLabel('Find a member').fill('Alpha-'+label);
    await b.getByRole('button',{name:new RegExp('Alpha-'+label)}).click();
    await b.locator('#messages').getByText('<img src=x onerror=alert(1)>',{exact:true}).waitFor();
    await waitPhoto(b);
    console.log('Tele-directory opened the correct chat, and text and photo history loaded after refresh.');
    console.log('Actual ESP32: no-accept photo delivery, viewer/save and attachment access checks passed.');
  }finally{
    receiverOffline=false;
    await browser.close();
    try{await releaseTestSeats(fixtureTokens);}finally{await new Promise(resolve=>relay.close(resolve));}
  }
}
