'use strict';
const $=id=>document.getElementById(id);
const set=(id,text)=>{$(id).textContent=text;};
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const clock=t=>t?new Date(t).toLocaleTimeString():'—';
let token='',me=null,snapshot={},cursor=0,messages=[],pollTimer=0,stopping=false,liveCall=null,hasSimulator=false;
let sim=false,usb=null,usbTask=null,lastPong=0,lastBoardUpdate=0,lastSend=0,boardBusy=false,usbOpening=false,retryBusy=false,awaitingArm='';
let rosterKey='',boardDetail='',audioTested=false;
let apMode='unknown',apPassword='',apWaiting=false,apTimeout=0,apChecked=false;
const isOp=()=>me?.role==='operator';
const pending=()=>snapshot.requests?.find(r=>r.state!=='acknowledged');
const isActive=c=>['ringing','connecting','connected'].includes(c.state);
const notice=text=>{set('notice',text||'');$('notice').hidden=!text;};
function bind(id,event,fn){$(id).addEventListener(event,async e=>{try{await fn(e);}catch(err){notice(err.message||String(err));}});}
async function api(action,data={}){
  const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({action,...data}),signal:AbortSignal.timeout(6500)});
  const body=await response.json();
  if(!response.ok)throw Object.assign(new Error(body.error||'Request failed'),{status:response.status});
  return body;
}
function rows(id,items,empty,format){
  const root=$(id),nodes=items.map(item=>{
    const [title,status,description]=format(item),row=element('div',undefined,'row'),label=element('div');
    label.append(element('strong',title));if(description)label.append(element('p',description));
    row.append(label,element('small',status));return row;
  });
  root.replaceChildren(...(nodes.length?nodes:[element('p',empty,'empty')]));
}
function requestRow(r){
  let status=r.state==='acknowledged'?'Acknowledged'+(r.mode==='simulation'?' · simulated':''):
    r.state==='alerted'?'Alert confirmed'+(r.mode==='simulation'?' · simulated':''):'Queued · awaiting board';
  if(r.state==='alerted'&&!snapshot.deskAvailable)status='Board offline · retry pending';
  return [r.name+' · '+clock(r.at),status,r.text];
}
function render(){
  if(!me)return;
  const peers=snapshot.peers||[],available=peers.filter(p=>p.online);
  const key=JSON.stringify(available.map(p=>[p.id,p.name]));
  if(key!==rosterKey){
    rosterKey=key;const previous=$('recipient').value;
    $('recipient').replaceChildren(new Option('Choose a device',''),...available.map(p=>new Option(p.name,p.id)));
    if(available.some(p=>p.id===previous))$('recipient').value=previous;
    else if(available.length===1)$('recipient').value=available[0].id;
    renderMessages();
  }
  $('start-call').disabled=!!liveCall||!$('recipient').value;
  rows('my-requests',(snapshot.requests||[]).filter(r=>r.from===me.id).slice().reverse(),'No requests sent.',requestRow);
  if(!isOp())return;
  const board=snapshot.board||{mode:'offline'},request=pending();
  set('online-count',available.length+1);set('call-count',(snapshot.calls||[]).filter(isActive).length);
  set('request-count',(snapshot.requests||[]).filter(r=>r.state!=='acknowledged').length);
  $('board-mode').dataset.mode=board.mode;set('board-mode',{offline:'Offline',usb:'USB connected',simulation:'Simulation'}[board.mode]);
  set('board-detail',boardDetail||(board.mode==='offline'?(board.seen?'Heartbeat lost at '+clock(board.seen)+'.':'No hardware heartbeat received.'):'Last heartbeat '+clock(board.seen)+(board.test?' · output test '+clock(board.test):'')));
  $('usb').disabled=!!usb||usbOpening;
  $('drop').disabled=!usb&&!sim;
  $('test-board').disabled=board.mode==='offline';
  $('retry').disabled=retryBusy||!request||board.mode==='offline';
  $('sim-ack').disabled=retryBusy||!sim||request?.state!=='alerted'||request.mode!=='simulation'||awaitingArm===request.id;
  $('simulate').disabled=!!usb||usbOpening;
  $('ap-start').disabled=board.mode!=='usb'||!usb||apWaiting||apMode==='on';
  $('ap-stop').disabled=board.mode!=='usb'||!usb||apWaiting||apMode==='off';
  set('simulate',sim?'Stop simulation':'Start simulation');
  rows('roster',[{...me,online:true},...peers],'No devices.',p=>[p.name,p.online?'Online':'Offline',p.role+' · last seen '+clock(p.seen)]);
  rows('call-log',(snapshot.calls||[]).slice().reverse(),'No calls yet.',c=>[c.fromName+' → '+c.toName,c.state,c.reason||clock(c.updated)]);
  rows('op-requests',(snapshot.requests||[]).slice().reverse(),'No assistance requests.',requestRow);
  rows('journal',snapshot.log||[],'No events yet.',e=>[e.type,clock(e.at),e.detail]);
}
function renderMessages(){
  const root=$('messages'),id=$('recipient').value;
  const shown=messages.filter(m=>m.from===id||m.to===id);
  const nodes=shown.map(m=>{
    const box=element('div',undefined,'message'+(m.from===me.id?' mine':''));
    box.append(element('small',(m.from===me.id?'You':m.name)+' · '+clock(m.at)));
    if(m.kind==='image'){
      const image=element('img');image.src=m.content;image.alt='Photo from '+m.name;box.append(image);
    }else box.append(document.createTextNode(m.content));
    return box;
  });
  root.replaceChildren(...(nodes.length?nodes:[element('p',id?'No messages yet.':'Select a recipient.','empty')]));
  root.scrollTop=root.scrollHeight;
}
async function poll(){
  if(!token||stopping)return;
  let interval=900;
  try{
    const next=await api('poll',{cursor});
    if(stopping||!token)return;
    snapshot=next;
    if(next.gap&&next.events.length)notice('Some older updates expired. Current call and request states are refreshed.');
    for(const e of next.events){
      cursor=Math.max(cursor,e.seq);
      if(e.kind==='text'||e.kind==='image'){
        messages.push(e);while(messages.length>100||messages.reduce((n,x)=>n+x.content.length,0)>3_000_000)messages.shift();
        if(!$('recipient').value&&e.from!==me.id&&[...$('recipient').options].some(o=>o.value===e.from))$('recipient').value=e.from;
        renderMessages();
      }else await callEvent(e);
    }
    const c=liveCall&&snapshot.calls.find(x=>x.id===liveCall.id);
    if(c&&liveCall)showCall(c.state==='connected'?'Connected':c.state==='connecting'?'Connecting audio…':undefined);
    if(c&&!isActive(c)&&liveCall){closeLocal();notice('Call '+c.state+(c.reason?' · '+c.reason:''));}
    set('network','● Local network');$('network').dataset.mode='';
    render();
    if(next.events.length===8)interval=100;
  }catch(e){
    if(e.status===401){await leave(false);notice(e.message);return;}
    set('network','● Reconnecting');$('network').dataset.mode='offline';
    interval=1400;
  }finally{if(token&&!stopping)pollTimer=setTimeout(poll,interval);}
}
bind('join-form','submit',async e=>{
  e.preventDefault();
  if(token)return;
  const form=e.currentTarget,button=form.querySelector('button'),data=new FormData(form);button.disabled=true;
  try{
    const joined=await api('join',{name:data.get('name'),code:data.get('code')});
    ({token,me,simulator:hasSimulator}=joined);stopping=false;cursor=0;snapshot={};messages=[];rosterKey='';boardDetail='';
    $('recipient').replaceChildren(new Option('Choose a device',''));renderMessages();
    $('join-view').hidden=true;$('room').hidden=false;$('leave').hidden=false;$('operator').hidden=!isOp();$('sim-controls').hidden=!hasSimulator;
    set('role',isOp()?'OPERATOR / DUTY DESK':'MEMBER / LOCAL ROOM');set('headline',isOp()?'Duty desk console.':'Communications room.');
    set('identity','Signed in as '+me.name);set('room-mode',location.hostname==='localhost'||location.hostname==='127.0.0.1'?'Laptop only':'Local network');
    form.reset();notice('');render();void poll();
  }finally{button.disabled=false;}
});
async function leave(send=true){
  stopping=true;clearTimeout(pollTimer);closeLocal();await disconnect(send);
  if(send&&token)try{await api('leave');}catch{}
  token='';me=null;awaitingArm='';$('room').hidden=true;$('leave').hidden=true;$('join-view').hidden=false;
}
bind('leave','click',()=>leave());
bind('recipient','change',()=>{renderMessages();render();});
bind('message-form','submit',async e=>{
  e.preventDefault();const input=$('message'),content=input.value.trim(),to=$('recipient').value;
  if(!to)throw Error('Choose a recipient first');if(!content)return;
  await api('text',{to,content});if(input.value.trim()===content)input.value='';notice('');
});
bind('request-form','submit',async e=>{
  e.preventDefault();const input=$('request-text'),text=input.value.trim();
  await api('request',{text});if(input.value.trim()===text)input.value='';notice('Request sent to the duty desk queue.');
});
bind('photo','change',async e=>{
  const to=$('recipient').value,file=e.target.files[0];e.target.value='';
  if(!file)return;if(!to)throw Error('Choose a recipient first');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8_000_000)throw Error('Choose a JPEG, PNG or WebP photo under 8 MB');
  const source=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=source;await img.decode();
    if(img.naturalWidth*img.naturalHeight>28_000_000)throw Error('Photo is too large to process');
    const scale=Math.min(1,860/Math.max(img.naturalWidth,img.naturalHeight)),canvas=element('canvas');
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
    let content=canvas.toDataURL('image/jpeg',0.78);
    if(content.length>340_000)content=canvas.toDataURL('image/jpeg',0.48);
    if(content.length>340_000)throw Error('Photo is still too large; choose a smaller image');
    await api('image',{to,content});notice('');
  }finally{URL.revokeObjectURL(source);}
});

function showCall(text){
  if(!liveCall)return;
  $('call-box').hidden=false;
  if(text)set('call-status',liveCall.name+' · '+text);
  $('answer').hidden=!liveCall.incoming;
  set('end-call',liveCall.incoming?'Decline':'End call');render();
}
function closeLocal(){
  const c=liveCall;liveCall=null;
  if(c){clearTimeout(c.drop);c.pc?.close();for(const t of c.stream?.getTracks()||[])t.stop();}
  $('remote-audio').srcObject=null;$('play-audio').hidden=true;$('call-box').hidden=true;render();
}
function signal(c,name,extra={}){return api('call',{id:c.id,signal:name,...extra});}
async function setup(c){
  if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection)throw Error('Microphone unavailable: open trusted HTTPS or use localhost');
  try{c.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true},video:false});}
  catch{throw Error('Microphone unavailable: check browser permission and audio input');}
  if(liveCall!==c){c.stream.getTracks().forEach(t=>t.stop());throw Error('Call closed');}
  const pc=c.pc=new RTCPeerConnection({iceServers:[]});
  for(const t of c.stream.getTracks())pc.addTrack(t,c.stream);
  pc.ontrack=async e=>{
    if(liveCall!==c)return;
    const audio=$('remote-audio');audio.srcObject=e.streams[0]||new MediaStream([e.track]);
    try{await audio.play();}catch{$('play-audio').hidden=false;}
  };
  pc.onconnectionstatechange=()=>{
    if(liveCall!==c)return;
    clearTimeout(c.drop);
    if(pc.connectionState==='connected'){
      showCall('Audio connected');c.mediaReady=true;void reportReady(c);
    }else if(pc.connectionState==='failed')void failCall(c,'Media connection failed');
    else if(pc.connectionState==='disconnected'){
      showCall('Audio interrupted');c.drop=setTimeout(()=>void failCall(c,'Media connection failed'),6500);
    }
  };
  return pc;
}
async function reportReady(c){
  if(c.mediaReady&&c.signaled&&!c.reported&&liveCall===c){
    c.reported=true;try{await signal(c,'ready');}catch{c.reported=false;}
  }
}
async function gather(pc,description){
  await pc.setLocalDescription(description);
  if(pc.iceGatheringState!=='complete'){
    await new Promise(resolve=>{
      const finish=()=>{clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',change);resolve();};
      const change=()=>{if(pc.iceGatheringState==='complete')finish();};
      const timeout=setTimeout(finish,4200);pc.addEventListener('icegatheringstatechange',change);change();
    });
  }
  return pc.localDescription.sdp;
}
async function failCall(c,reason){
  try{if(c.signaled||c.incoming||c.offer)await signal(c,'fail',{reason});}catch{}
  if(liveCall===c){closeLocal();notice(reason+' · check microphone permission, network or certificate trust.');}
}
async function callEvent(e){
  if(e.kind==='offer'){
    if(liveCall)return;
    liveCall={id:e.id,peer:e.from,name:e.name,incoming:true,offer:e.sdp};showCall('Incoming call');
  }else if(e.id===liveCall?.id){
    const c=liveCall;
    if(e.kind==='answer'){
      try{await c.pc.setRemoteDescription({type:'answer',sdp:e.sdp});showCall('Connecting audio…');}catch{await failCall(c,'Call setup failed');}
    }else if(e.kind==='end'){closeLocal();notice('Call '+e.state+(e.reason?' · '+e.reason:''));}
  }
}
bind('play-audio','click',async()=>{await $('remote-audio').play();$('play-audio').hidden=true;});
bind('start-call','click',async()=>{
  const peer=snapshot.peers?.find(p=>p.id===$('recipient').value);if(!peer||liveCall)return;
  const c=liveCall={id:crypto.randomUUID(),peer:peer.id,name:peer.name};
  showCall('Preparing microphone…');
  try{
    const pc=await setup(c),sdp=await gather(pc,await pc.createOffer());if(liveCall!==c)return;
    await signal(c,'offer',{to:peer.id,sdp});c.signaled=true;
    if(liveCall!==c){await signal(c,'end');return;}showCall('Ringing…');notice('');
  }catch(e){if(liveCall===c){closeLocal();throw e;}}
});
bind('answer','click',async()=>{
  const c=liveCall;if(!c?.incoming)return;c.incoming=false;showCall('Preparing microphone…');
  try{
    const pc=await setup(c);await pc.setRemoteDescription({type:'offer',sdp:c.offer});
    const sdp=await gather(pc,await pc.createAnswer());if(liveCall!==c)return;
    await signal(c,'answer',{sdp});c.signaled=true;await reportReady(c);showCall('Connecting audio…');notice('');
  }catch(e){if(liveCall===c)await failCall(c,e.message.startsWith('Microphone')?'Microphone unavailable':'Call setup failed');}
});
bind('end-call','click',async()=>{
  const c=liveCall;if(!c)return;
  try{if(c.signaled||c.offer)await signal(c,c.incoming?'decline':'end');}finally{closeLocal();}
});

const boardSignal=(mode,signal,id)=>api('board',{mode,signal,id});
async function writeBoard(line){
  const port=usb;
  if(!port?.writable)throw Error('ESP32 USB port is not open');
  const prior=port.fieldWrite||Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
    if(usb!==port)throw Error('ESP32 disconnected');
    const writer=port.writable.getWriter();
    try{await writer.write(new TextEncoder().encode(line+'\n'));}finally{writer.releaseLock();}
  });
  port.fieldWrite=next;await next;
}
async function fromBoard(line){
  if(['AP ON','AP OFF','AP ERROR'].includes(line)){
    clearTimeout(apTimeout);apWaiting=false;apMode=line.slice(3).toLowerCase();
    if(apMode!=='on')apPassword='';
    set('ap-status',apMode==='on'?'FieldLink-Local is on. The board stops it after one hour or on reset.':apMode==='off'?'ESP32 Wi‑Fi is off.':'The ESP32 could not start Wi‑Fi.');
    $('ap-key').hidden=!apPassword;
    set('ap-key',apPassword?'Wi‑Fi password: '+apPassword:'');
    render();return;
  }
  const m=/^PONG ([0-9a-f-]{36}|-) ([ILA])$/.exec(line);
  if(m){
    lastPong=Date.now();boardDetail='';
    if(!apChecked){apChecked=true;await writeBoard('AP?');}
    if(Date.now()-lastBoardUpdate>1800||snapshot.board?.mode!=='usb'){await boardSignal('usb','heartbeat');lastBoardUpdate=Date.now();}
    const r=pending();
    if(r&&r.id===m[1]){
      if(m[2]==='L'||m[2]==='A')await boardSignal('usb','armed',r.id);
      if(m[2]==='A')await boardSignal('usb','ack',r.id);
    }
  }else if(line==='TEST OK'){
    await boardSignal('usb','test');
    boardDetail='Firmware confirmed the test. Check that you saw the LED and heard the buzzer.';
  }else if(line==='TEST BUSY'){boardDetail='Output test waits until the active alert is acknowledged.';}
}
async function readBoard(link){
  const decoder=new TextDecoder();let buffer='';
  try{
    while(usb===link&&link.readable){
      const reader=link.readable.getReader();link.fieldReader=reader;
      try{
        while(usb===link){
          const {value,done}=await reader.read();if(done)break;
          buffer+=decoder.decode(value,{stream:true});
          let n;
          while((n=buffer.indexOf('\n'))!==-1){
            const line=buffer.slice(0,n).trim();buffer=buffer.slice(n+1);
            try{if(usb===link)await fromBoard(line);}catch(e){if(e.status!==409)boardDetail=e.message;}
          }
          if(buffer.length>240)buffer='';
        }
      }finally{reader.releaseLock();delete link.fieldReader;}
      break;
    }
  }catch{}
  if(usb===link){usb=null;boardDetail='USB connection lost. Reconnect the ESP32 and retry the alert.';try{await link.close();}catch{}try{if(token)await boardSignal('usb','disconnect');}catch{}render();}
}
async function disconnect(report=true){
  const port=usb;usb=null;sim=false;lastPong=0;lastSend=0;lastBoardUpdate=0;
  clearTimeout(apTimeout);apWaiting=false;apChecked=false;apMode='unknown';apPassword='';$('ap-key').hidden=true;set('ap-key','');set('ap-status','Reconnect to check Wi‑Fi. Resetting or unplugging the ESP32 turns Wi‑Fi off.');
  if(port){try{await port.fieldReader?.cancel();}catch{}try{await usbTask;}catch{}try{await port.fieldWrite;}catch{}try{await port.close();}catch{}}
  if(report&&token&&isOp())await boardSignal('usb','disconnect');
  boardDetail='';render();
}
bind('usb','click',async()=>{
  if(!navigator.serial)throw Error('Use Chrome or Edge on the operator laptop for USB access.');
  usbOpening=true;
  try{
    const port=await navigator.serial.requestPort();
    if(sim)await disconnect();
    await port.open({baudRate:115200});
    usb=port;lastPong=0;lastSend=0;lastBoardUpdate=0;apChecked=false;boardDetail='Waiting for the Field Link firmware heartbeat…';usbTask=readBoard(port);
  }finally{usbOpening=false;render();}
});
bind('drop','click',()=>disconnect());
async function setAP(enabled){
  if(!usb||apWaiting)return;
  apWaiting=true;render();
  if(enabled)apPassword=[...crypto.getRandomValues(new Uint8Array(10))].map(n=>n.toString(16).padStart(2,'0')).join('');
  set('ap-status',enabled?'Waiting for the ESP32 to start Wi‑Fi…':'Waiting for the ESP32 to stop Wi‑Fi…');
  apTimeout=setTimeout(()=>{
    apWaiting=false;apPassword='';$('ap-key').hidden=true;set('ap-key','');
    set('ap-status','No reply. Check that the ESP32 has the current Field Link firmware.');render();
  },6000);
  try{await writeBoard(enabled?'APSTART '+apPassword:'APSTOP');}
  catch(e){clearTimeout(apTimeout);apWaiting=false;apPassword='';render();throw e;}
}
bind('ap-start','click',()=>setAP(true));
bind('ap-stop','click',()=>setAP(false));
bind('simulate','click',async()=>{
  if(sim){await disconnect();return;}if(usb)return;
  await boardSignal('simulation','heartbeat');sim=true;boardDetail='Simulator active. No physical ESP32 outputs are being driven.';render();
});
bind('sim-ack','click',async()=>{const r=pending();if(sim&&r&&!retryBusy&&awaitingArm!==r.id)await boardSignal('simulation','ack',r.id);});
bind('test-board','click',async()=>{
  if(sim){await boardSignal('simulation','test');boardDetail='Simulated output test completed.';}
  else if(usb)await writeBoard('TEST');
  render();
});
bind('retry','click',async()=>{
  const r=pending();if(!r||retryBusy)return;
  retryBusy=true;awaitingArm=r.id;render();
  try{
    const mode=sim?'simulation':'usb';await boardSignal(mode,'retry',r.id);
    if(usb){await writeBoard('RETRY '+r.id);awaitingArm='';}
    lastSend=0;boardDetail='';
  }catch(e){awaitingArm='';throw e;}finally{retryBusy=false;render();}
});
setInterval(async()=>{
  if(!isOp()||stopping||boardBusy||retryBusy)return;
  boardBusy=true;
  try{
    if(liveCall)await reportReady(liveCall);
    const r=pending();
    if(sim){
      if(Date.now()-lastBoardUpdate>1800){await boardSignal('simulation','heartbeat');lastBoardUpdate=Date.now();}
      if(r&&(r.state==='queued'||r.mode!=='simulation'||awaitingArm===r.id)){
        await boardSignal('simulation','armed',r.id);if(awaitingArm===r.id)awaitingArm='';
      }
    }else if(usb){
      await writeBoard('PING');
      if(lastPong&&Date.now()-lastPong>6500)boardDetail='USB port is open but firmware has stopped responding.';
      if(lastPong&&Date.now()-lastPong<4500&&r&&Date.now()-lastSend>2100){
        await writeBoard('ALERT '+r.id);lastSend=Date.now();
      }
    }
  }catch(e){if(e.status!==409)boardDetail=e.message;}finally{boardBusy=false;}
},1100);
setInterval(()=>{if(liveCall&&!isOp())void reportReady(liveCall);},1500);
