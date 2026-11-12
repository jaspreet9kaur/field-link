'use strict';
const el=id=>document.getElementById(id), put=(id,t)=>{el(id).textContent=t;};
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const bridge=window.FieldLinkNative;
const MAX_PHOTO=100*1024;
let token='',me=null,boot=0,cursor=0,peers=[],calls=[],thread='',messages=[],current=null,timer=0,tab='chats',heap=0;
let lastRoster='',lastActivity='',lastTraffic='',dashboard=null;
const delivered=new Set(),read=new Set();
const receiptLabel=['','Sent','Delivered','Read'];
const presenceDot=()=>node('span',undefined,'presence-dot');
let notifiedCall='';
let viewingPhoto=null;
let conference=null,mix=null,ringing=false,ringTimer=0,ringContext=null,speakerOn=false;
let historyThread='',historyAt=0,historyBusy=false,locationShare=null,locationTimer=0,locationSend=null;
let fixes=[],grants=[],grantRoster='';
const webBuild=document.querySelector('meta[name="field-link-build"]').content;
let updateRequest=null,availableBuild='',photoSending=false;
window.fieldLinkAnswerFromNotification=id=>{
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))return;
  notifiedCall=id;
  if(current?.incoming&&current.id===id){notifiedCall='';el('answer').click();}
};
const notice=s=>{put('notice',s||'');el('notice').hidden=!s;};
const active=c=>['ringing','connecting','connected'].includes(c.state);
const peer=id=>peers.find(p=>p.id===id);
const initials=name=>name.trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase();
function on(id,type,fn){el(id).addEventListener(type,async e=>{try{await fn(e);}catch(err){notice(err.message||'Action failed.');}});}
async function api(action,extra={}){
  const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({action,...extra}),signal:AbortSignal.timeout(9500)});
  const r=await response.json().catch(()=>null);
  if(!response.ok)throw Object.assign(new Error(r?.error||'Room request failed.'),{status:response.status});
  if(!r||typeof r!=='object')throw Error('The hub sent an incomplete response. Retry shortly.');
  return r;
}
function remember(){
  try{if(bridge)bridge.saveSession(token,boot,cursor);else if(token)sessionStorage.setItem('flhub',token);else sessionStorage.removeItem('flhub');}catch{}
}
function activate(data){
  me=data.me;if(data.token)token=data.token;boot=data.boot;cursor=0;
  tab=me.role==='operator'?'room':'chats';
  el('join').hidden=true;el('room').hidden=false;el('login').reset();
  put('identity',me.name+' · '+me.role+' · '+location.host);
  remember();render();clearTimeout(timer);void poll();
}
async function signOut(){
  await stopSharing();
  clearTimeout(timer);closeCall();token='';me=null;boot=0;cursor=0;peers=[];calls=[];thread='';dashboard=null;
  delivered.clear();read.clear();lastRoster='';lastActivity='';lastTraffic='';
  if(el('photo-view').open)el('photo-view').close();
  for(const m of messages)if(m.photo)URL.revokeObjectURL(m.photo);
  messages=[];remember();el('room').hidden=true;el('join').hidden=false;
}
function net(up){
  put('network',up?'Online':'Reconnecting');
  el('network').classList.toggle('off',!up);
}
function selectThread(id){
  thread=id;tab='chats';el('workspace').classList.toggle('open',!!id);
  lastRoster='';render();showMessages();if(id)void syncHistory(id);
}
const messageKey=m=>m.messageId?(m.messageBoot||m.boot)+'/'+m.messageId:'';
async function syncHistory(id){
  if(historyBusy||!id)return;
  historyBusy=true;const session=token;
  try{
    const data=await api('history',{peer:id});if(!me||session!==token||!Array.isArray(data.messages))return;
    const pane=el('messages'),follow=historyThread!==id||pane.scrollHeight-pane.scrollTop-pane.clientHeight<35;
    historyThread=id;historyAt=Date.now();
    const existing=new Map(messages.map(m=>[messageKey(m),m]));
    const archived=data.messages.map(m=>existing.get(messageKey(m))||{...m,boot:m.messageBoot});
    const keys=new Set(archived.map(messageKey));
    for(const m of archived)if(m.boot===boot&&m.from!==me.id&&!m.photoId&&!existing.has(messageKey(m)))delivered.add(m.messageId);
    messages=messages.filter(m=>!keys.has(messageKey(m)));
    const firstRecent=messages.findIndex(m=>m.from===id||m.to===id);
    messages.splice(firstRecent<0?messages.length:firstRecent,0,...archived);
    trimMessages();
    if(thread===id){
      showMessages(follow);for(const photo of archived.slice(-12).filter(x=>x.photoId&&!x.photo&&!x.failed).slice(-5))void loadPhoto(photo);
    }
  }catch{}finally{historyBusy=false;}
}
function trimMessages(){
  while(messages.length>90){const old=messages.shift();if(old.photo)URL.revokeObjectURL(old.photo);}
}
function duration(seconds){
  if(!Number.isFinite(seconds))return '–';
  const h=Math.floor(seconds/3600),m=Math.floor(seconds/60)%60,s=seconds%60;
  return h?h+'h '+m+'m':m?m+'m '+s+'s':s+'s';
}
function renderDashboard(){
  if(!dashboard)return;
  put('active-count',String(calls.filter(active).length));put('uptime',duration(dashboard.uptime));
  const reason=['Unknown','Power-on','External reset','Software restart','Panic','Interrupt watchdog','Task watchdog','Watchdog','Deep sleep','Brownout','SDIO'][dashboard.resetReason];
  put('reset-reason','Last boot: '+(reason||'Unknown'));
  const key=JSON.stringify(dashboard.activity);if(key===lastTraffic)return;lastTraffic=key;
  el('traffic-list').replaceChildren(...(dashboard.activity?.length?dashboard.activity.map(x=>node('p',x.from+' → '+x.to+' · '+(x.photo?'Photo':'Text')+' · '+receiptLabel[x.status],'record')):[node('p','No recent messages.')]));
}
function render(){
  if(!me)return;
  const p=peer(thread);
  const isOperator=me.role==='operator';
  const roster=[...peers].sort((a,b)=>Number(b.online)-Number(a.online)||a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
  el('workspace').hidden=tab!=='chats';el('room-info').hidden=tab!=='room';
  el('directory').hidden=tab!=='directory';el('tracking').hidden=tab!=='tracking';
  el('operator').hidden=el('operator-traffic').hidden=!isOperator;
  el('room-info').classList.toggle('operator-panel',isOperator);
  put('view-title',tab==='chats'?'Messages':tab==='directory'?'Tele-directory':tab==='tracking'?'Live location':isOperator?'Operator console':'Room');
  put('room-tab',isOperator?'Operator':'Room');put('call-heading',isOperator?'Live and recent calls':'Call activity');
  el('chats-tab').setAttribute('aria-pressed',String(tab==='chats'));el('room-tab').setAttribute('aria-pressed',String(tab==='room'));
  el('directory-tab').setAttribute('aria-pressed',String(tab==='directory'));el('tracking-tab').setAttribute('aria-pressed',String(tab==='tracking'));
  put('person',p?.name||'Select a chat');put('initials',p?initials(p.name):'FL');put('presence',p?(p.online?'Online':'Offline'):'Local network');
  el('initials').classList.toggle('online',!!p?.online);
  for(const key of ['voice','video'])el(key).disabled=!p?.online||!!current;
  for(const key of ['text','send'])el(key).disabled=!p;
  el('file').disabled=!p;
  const key=JSON.stringify([thread,...roster.map(x=>[x.id,x.name,x.online])]);
  if(lastRoster!==key){
    lastRoster=key;
    el('roster').replaceChildren(...(roster.length?roster.map(x=>{
      const b=node('button',undefined,'contact'),body=node('span');
      b.type='button';b.setAttribute('aria-current',String(x.id===thread));body.append(node('strong',x.name),node('small',x.online?'Online':'Offline'));
      b.append(node('span',initials(x.name),'avatar'+(x.online?' online':'')),body);b.addEventListener('click',()=>selectThread(x.id));return b;
    }):[node('p','No other members yet.')]));
    if(isOperator)el('operator-roster').replaceChildren(...[{...me,online:true},...roster].map(x=>{
      const row=node('p',undefined,'record device');if(x.online)row.append(presenceDot());
      row.append(node('span',x.name+' · '+x.role+' · '+(x.online?'Online':'Offline')));return row;
    }));
  }
  put('online-count',peers.filter(x=>x.online).length+1);put('heap',heap?Math.round(heap/1024)+' KB':'–');
  const activity=JSON.stringify(calls);if(lastActivity!==activity){
    lastActivity=activity;
    const ordered=calls.slice().reverse().sort((a,b)=>Number(active(b))-Number(active(a)));
    el('call-list').replaceChildren(...(ordered.length?ordered.map(c=>{
      const row=node('div',undefined,'record session'+(active(c)?' active':''));
      const endpoints=node('div',undefined,'call-diagram');endpoints.append(node('span',c.fromName),node('span','→','call-link'),node('span',c.toName));
      row.append(endpoints,node('small',(c.merge?'Conference · ':'')+c.mode+' · '+c.state+(c.duration===undefined?'':' · '+duration(c.duration))));return row;
    }):[node('p','No recent calls.')]));
  }
  if(isOperator)renderDashboard();
  if(tab==='directory')renderDirectory(roster);
  if(tab==='tracking')renderTracking(roster);
}
function renderDirectory(roster){
  const filter=el('directory-search').value.trim().toLowerCase();
  const rows=roster.filter(p=>p.name.toLowerCase().includes(filter)).map(p=>{
    const button=node('button',undefined,'directory-person'),avatar=node('span',initials(p.name),'avatar'+(p.online?' online':''));
    const info=node('span',p.name+' · '+(p.online?'Online':'Offline'));
    button.append(avatar,info,node('span','Message','directory-action'));button.addEventListener('click',()=>selectThread(p.id));return button;
  });
  el('directory-list').replaceChildren(...(rows.length?rows:[node('p','No matching members.')]));
}
function drawLocations(){
  const canvas=el('location-plot'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#0b2234';ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='#295067';ctx.lineWidth=1;
  for(let x=20;x<w;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  for(let y=20;y<h;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  if(!fixes.length)return;
  const origin=fixes[0],points=fixes.map(p=>({name:p.name,x:(p.lon-origin.lon)*111320*Math.cos(origin.lat*Math.PI/180),y:(p.lat-origin.lat)*111320}));
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
  const scale=Math.min((w-100)/Math.max(50,x1-x0),(h-85)/Math.max(50,y1-y0));
  ctx.font='15px system-ui';ctx.textAlign='center';
  for(const p of points){
    const x=w/2+(p.x-(x0+x1)/2)*scale,y=h/2-(p.y-(y0+y1)/2)*scale;
    ctx.fillStyle='#48e698';ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fill();ctx.fillStyle='#e4f4ff';ctx.fillText(p.name,x,y-12);
  }
  ctx.fillStyle='#b2d0e4';ctx.textAlign='left';ctx.fillText('Offline relative positions · North ↑',12,23);
}
function renderTracking(roster){
  el('location-list').replaceChildren(...(fixes.length?fixes.map(p=>node('p',p.name+' · '+p.lat.toFixed(5)+', '+p.lon.toFixed(5)+' · ±'+Math.round(p.accuracy)+' m · '+p.age+'s ago','record')):[node('p','No shared positions are available.')]));
  drawLocations();el('location-grant').hidden=me.role!=='operator';
  if(me.role!=='operator')return;
  const choices=[me,...roster],key=JSON.stringify(choices.map(p=>[p.id,p.name]));
  if(grantRoster!==key){
    grantRoster=key;
    for(const id of ['location-subject','location-viewer'])el(id).replaceChildren(node('option','Choose a member'),...choices.map(p=>{const option=node('option',p.name);option.value=p.id;return option;}));
    for(const id of ['location-subject','location-viewer'])el(id).firstChild.value='';
  }
  el('location-grants').replaceChildren(...grants.map(([subject,viewer])=>node('p',subject+' → '+viewer,'record')));
}
function markVisibleRead(){
  if(!me||!thread||tab!=='chats'||document.visibilityState!=='visible')return;
  const list=el('messages'),frame=list.getBoundingClientRect();
  if(!frame.height)return;
  for(const bubble of list.children){
    const id=Number(bubble.dataset.receipt);if(!id)continue;
    const item=messages.find(m=>m.boot===boot&&m.messageId===id);
    if(!item||item.localRead)continue;
    const box=bubble.getBoundingClientRect();
    if(box.bottom<=Math.max(0,frame.top)||box.top>=Math.min(window.innerHeight,frame.bottom))continue;
    item.localRead=true;read.add(id);
  }
}
function showMessages(follow=true){
  if(!me)return;
  const list=messages.filter(x=>x.from===thread||x.to===thread).map(x=>{
    const b=node('div',undefined,'bubble'+(x.from===me.id?' mine':''));
    if(x.photoId){
      if(x.photo){
        const button=node('button',undefined,'photo-thumb'),image=node('img');button.type='button';button.setAttribute('aria-label','Open photo');
        image.src=x.photo;image.alt='Shared photo';button.append(image);button.addEventListener('click',()=>openPhoto(x));b.append(button);
      }else if(x.failed)b.append(node('button','Retry photo'));else b.textContent='Loading photo…';
      if(x.failed)b.querySelector('button').addEventListener('click',()=>void loadPhoto(x));
    }
    else b.textContent=x.text;
    if(x.from===me.id&&x.messageId&&x.boot===boot){
      const status=x.status||1;
      const tick=node('span',status===1?'✓':'✓✓','receipt'+(status===3?' read':''));
      tick.title=receiptLabel[status];tick.setAttribute('role','img');tick.setAttribute('aria-label',receiptLabel[status]);b.append(tick);
    }else if(x.boot===boot&&x.messageId&&(!x.photoId||x.photo))b.dataset.receipt=x.messageId;
    return b;
  });
  const pane=el('messages'),previousScroll=pane.scrollTop;
  pane.replaceChildren(...(list.length?list:[node('p',thread?'No messages yet.':'Select a chat to start.')]));
  pane.scrollTop=follow?pane.scrollHeight:previousScroll;
  markVisibleRead();
}
function addMessage(m){
  m.boot=m.messageBoot||boot;
  if(m.from!==me.id&&m.messageId&&!m.photoId)delivered.add(m.messageId);
  const prior=messageKey(m)&&messages.find(x=>messageKey(x)===messageKey(m));if(prior)return prior;
  messages.push(m);
  trimMessages();showMessages();return m;
}
async function poll(){
  if(!me)return;
  let wait=1500;
  try{
    markVisibleRead();
    const sentDelivered=[...delivered].slice(0,16),sentRead=[...read].slice(0,16);
    const data=await api('poll',{boot,cursor,delivered:sentDelivered,read:sentRead,tracking:tab==='tracking'});
    if(!me)return;
    if(!Number.isSafeInteger(data.boot)||data.boot<=0||![data.events,data.peers,data.calls].every(Array.isArray))
      throw Error('Incomplete hub update');
    if(data.boot!==boot){boot=data.boot;cursor=0;delivered.clear();read.clear();dashboard=null;closeCall();notice('The ESP32 restarted. Your sign-in was retained.');wait=100;}
    else{
      for(const id of sentDelivered)delivered.delete(id);
      for(const id of sentRead)read.delete(id);
      peers=data.peers;calls=data.calls;heap=data.heap;dashboard=data.operator||null;fixes=data.locations||[];grants=data.locationGrants||[];
      for(const e of data.events){cursor=Math.max(cursor,e.seq);await processEvent(e);}
      const statuses=new Map(data.receipts||[]);let changed=false;
      for(const m of messages){
        const status=statuses.get(m.messageId);
        if(m.boot===boot&&m.from===me.id&&status>(m.status||1)){m.status=status;changed=true;}
      }
      if(changed)showMessages(false);
      if(current&&current.sent){
        const status=calls.find(c=>c.id===current.id);
        if(status){
          current.seenAtHub=true;
          if(!active(status))closeCall();
          else if(status.state==='connected'&&current.mode!=='photo'&&current.pc?.connectionState==='connected')showCall('Connected');
        }
        else if(current.seenAtHub)closeCall();
      }
      if(current&&current.pc?.connectionState==='connected')void ready(current);
      if(conference&&conference.sent){
        const state=calls.find(c=>c.id===conference.id);
        if(state&&!active(state))void endConference(null);
        else if(conference.pc?.connectionState==='connected')void ready(conference);
      }
      if(data.events.length===3)wait=200;
    }
    if(bridge)try{bridge.updateCursor(boot,cursor);}catch{}
    net(true);render();
    if(thread&&tab==='chats'&&(historyThread!==thread||Date.now()-historyAt>20000))void syncHistory(thread);
  }catch(e){
    if(e.status===401){await signOut();notice('Sign-in expired. Join the room again.');return;}
    net(false);wait=2300;
  }finally{if(me)timer=setTimeout(poll,wait);}
}
on('login','submit',async e=>{
  e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;
  try{activate(await api('join',{name:el('name').value.trim(),code:el('code').value.trim()}));notice('');}finally{button.disabled=false;}
});
on('signout','click',async()=>{await api('leave');await signOut();notice('');});
on('chats-tab','click',()=>{tab='chats';render();markVisibleRead();});
on('room-tab','click',()=>{tab='room';render();});
on('directory-tab','click',()=>{tab='directory';render();});
on('directory-search','input',render);
on('tracking-tab','click',()=>{tab='tracking';render();});
async function stopSharing(){
  if(!locationShare)return;
  locationShare=null;clearTimeout(locationTimer);el('share-location').disabled=true;
  put('share-location','Share my location');put('location-status','Location sharing stopped.');
  try{if(locationSend)await locationSend.catch(()=>{});await api('location',{stop:true});}catch{}
  finally{el('share-location').disabled=false;}
}
on('share-location','click',()=>{
  if(locationShare)return stopSharing();
  if(!navigator.geolocation)throw Error('This device does not provide location here.');
  const sharing=locationShare={};
  put('location-status','Waiting for a position…');put('share-location','Stop sharing');
  const next=()=>{if(locationShare===sharing)locationTimer=setTimeout(sample,7000);};
  const sample=()=>navigator.geolocation.getCurrentPosition(async ({coords})=>{
    if(locationShare!==sharing||document.hidden)return;
    try{
      locationSend=api('location',{lat:coords.latitude,lon:coords.longitude,accuracy:coords.accuracy});await locationSend;
      if(locationShare===sharing)put('location-status','Sharing with the operator and members the operator has allowed.');
    }catch(e){if(locationShare===sharing)put('location-status',e.message);}
    finally{locationSend=null;next();}
  },e=>{
    if(locationShare!==sharing)return;
    if(e.code===1){void stopSharing();put('location-status','Location permission was denied.');}
    else{put('location-status','Waiting for a location fix.');next();}
  },{enableHighAccuracy:true,maximumAge:5000,timeout:12000});
  sample();
});
on('location-grant','submit',async e=>{
  e.preventDefault();const allow=e.submitter?.value!=='revoke';
  await api('locationGrant',{subject:el('location-subject').value,viewer:el('location-viewer').value,allow});
  notice(allow?'Location access granted.':'Location access revoked.');
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)void stopSharing();else void checkUpdate();});
function showUpdate(build,status){
  availableBuild=build;
  el('update-banner').hidden=el('apply-update').hidden=!build;
  put('update-summary',build?'Update available':'Check this ESP32 for updates');
  put('update-status',status);
}
function checkUpdate(){
  if(updateRequest)return updateRequest;
  updateRequest=(async()=>{
    try{
      const response=await fetch('/version',{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw Error('Version unavailable');
      const next=(await response.text()).trim(),valid=/^[a-f0-9]{16}$/;
      if(!valid.test(webBuild)||!valid.test(next))throw Error('Invalid build marker');
      if(next===webBuild)showUpdate('','Field Link is up to date.');
      else showUpdate(next,'Update available from this ESP32.');
    }catch{showUpdate('','Could not check for updates. Connect to the hub Wi-Fi and try again.');}
  })().finally(()=>{updateRequest=null;});
  return updateRequest;
}
function updateBlocker(){
  if(current)return 'Finish your call before updating.';
  if(photoSending)return 'Wait for the photo to finish sending before updating.';
  if(locationShare)return 'Stop sharing your location before updating.';
  if(el('text').value||el('name').value||el('code').value)return 'Finish or clear your draft before updating.';
  return '';
}
function openUpdates(){
  if(el('settings-sheet').open)el('settings-sheet').close();
  el('updates-sheet').showModal();
  if(!availableBuild){put('update-status','Checking the ESP32…');void checkUpdate();}
}
setInterval(()=>{if(!document.hidden&&!el('updates-sheet').open)void checkUpdate();},20000);
void checkUpdate();
on('settings','click',()=>{el('settings-help').hidden=true;el('settings-sheet').showModal();});
on('close-settings','click',()=>el('settings-sheet').close());
on('open-updates','click',openUpdates);
on('update-banner-button','click',openUpdates);
on('close-updates','click',()=>el('updates-sheet').close());
on('check-update','click',async()=>{put('update-status','Checking the ESP32…');await checkUpdate();});
on('apply-update','click',async()=>{
  const blocker=updateBlocker();if(blocker){put('update-status',blocker);return;}
  el('apply-update').disabled=true;
  try{
    await checkUpdate();if(!availableBuild)return;
    const remaining=updateBlocker();if(remaining){put('update-status',remaining);return;}
    if(el('updates-sheet').open)location.reload();
  }finally{el('apply-update').disabled=false;}
});
on('reconnect','click',()=>location.reload());
put('settings-hub-address',location.host);
const settingsHelp={
  alerts:'Open Android Settings, then Apps → Field Link → Notifications. For a browser, use its site notification settings.',
  permissions:'Open Android Settings, then Apps → Field Link → Permissions. In a browser, use the controls next to the address.',
  hub:'Current hub: '+location.host+'. On older Android builds, use Hub address in the app’s top system menu to switch hubs.'
};
for(const button of document.querySelectorAll('[data-native]')){
  button.addEventListener('click',()=>{
    const target=button.dataset.native;
    if(bridge?.openSettings){el('settings-sheet').close();bridge.openSettings(target);return;}
    put('settings-help',settingsHelp[target]);el('settings-help').hidden=false;
  });
}
bridge?.useWebSettings?.();
el('messages').addEventListener('scroll',markVisibleRead,{passive:true});
document.addEventListener('visibilitychange',markVisibleRead);
on('back','click',()=>selectThread(''));
on('compose','submit',async e=>{
  e.preventDefault();const value=el('text').value.trim();
  if(!thread||!value)return;
  if(new TextEncoder().encode(value).length>900)throw Error('This message is too long.');
  await api('text',{to:thread,text:value});if(el('text').value.trim()===value)el('text').value='';notice('');
});

function soundCall(enabled){
  if(ringing===enabled)return;ringing=enabled;
  if(bridge?.ringCall){bridge.ringCall(enabled);return;}
  clearInterval(ringTimer);
  if(!enabled){if(ringContext)void ringContext.suspend().catch(()=>{});return;}
  if(!window.AudioContext)return;
  try{
    ringContext??=new AudioContext();void ringContext.resume().catch(()=>{});
    const tone=()=>{
      if(ringContext.state!=='running')return;
      const t=ringContext.currentTime;
      for(const [start,f] of [[0,440],[.24,520]]){
        const oscillator=ringContext.createOscillator(),gain=ringContext.createGain();
        oscillator.frequency.value=f;gain.gain.setValueAtTime(.1,t+start);gain.gain.exponentialRampToValueAtTime(.001,t+start+.16);
        oscillator.connect(gain).connect(ringContext.destination);oscillator.start(t+start);oscillator.stop(t+start+.17);
      }
    };
    tone();ringTimer=setInterval(tone,1400);
  }catch{}
}
on('test-ringtone','click',()=>{if(current?.incoming)return;soundCall(true);setTimeout(()=>{if(!current?.incoming)soundCall(false);},2200);});
function showCall(text){
  if(!current)return;
  el('call').hidden=false;
  put('call-who',current.name);put('call-kind',current.conferenceInvite?'CONFERENCE INVITE':current.mode.toUpperCase()+' CALL');
  if(text)put('call-state',text);
  el('remote').classList.toggle('audio-only',current.mode!=='video');
  el('answer').hidden=!current.incoming;el('preview').hidden=current.mode!=='video'||!current.stream;
  el('mute').hidden=!current.stream?.getAudioTracks().length;put('hangup',current.incoming?'Decline':'End');
  const live=!current.incoming&&!!current.stream;
  el('speaker').hidden=!live||!bridge?.speaker;el('speaker').setAttribute('aria-pressed',String(speakerOn));
  el('camera-toggle').hidden=el('flip-camera').hidden=!live||current.mode!=='video';
  el('merge-call').hidden=current.mode!=='voice'||current.pc?.connectionState!=='connected'||!!conference||!calls.some(c=>c.id===current.id&&c.state==='connected');
  el('conference-status').hidden=!conference;
  if(conference)put('conference-status',mix?'Conference · '+current.name+' + '+conference.name:'Adding '+conference.name+'…');
  soundCall(!!current.incoming);
  render();
}
function closeCall(){
  const c=current;current=null;soundCall(false);if(speakerOn)bridge?.speaker?.(false);speakerOn=false;
  if(conference)void endConference('end');
  if(c){clearTimeout(c.drop);c.pc?.close();c.stream?.getTracks().forEach(t=>t.stop());c.releaseMic?.();}
  el('remote').srcObject=null;el('preview').srcObject=null;el('play').hidden=true;el('call').hidden=true;put('mute','Mute mic');put('camera-toggle','Camera off');
  render();
}
window.addEventListener('pagehide',()=>{closeCall();void stopSharing();});
const signal=(c,kind,extra={})=>api('call',{id:c.id,signal:kind,...extra});
async function ready(c){
  if(!c.sent||c.ready||c.reporting)return;
  c.reporting=true;try{await signal(c,'ready');c.ready=true;if(current===c)showCall();}catch{}finally{c.reporting=false;}
}
async function end(c,kind='end'){
  if(current===c)closeCall();
  try{if(c.sent||c.offer)await signal(c,kind);}catch{}
}
async function endConference(kind){
  const leg=conference;if(!leg)return;conference=null;
  if(mix){
    const {context,baseSender,raw}=mix;mix=null;
    if(current&&raw.readyState==='live')try{await baseSender.replaceTrack(raw);}catch{}
    void context.close().catch(()=>{});
  }
  clearTimeout(leg.drop);leg.pc?.close();el('conference-audio').srcObject=null;
  if(current)showCall();
  if(kind&&leg.sent)try{await signal(leg,kind);}catch{}
}
async function mixConference(){
  const base=current,leg=conference;
  if(mix||!base?.remoteAudio||!leg?.remoteAudio||leg.pc.connectionState!=='connected')return;
  const raw=base.stream.getAudioTracks()[0];if(!raw)return;
  const baseSender=base.pc.getSenders().find(s=>s.track===raw),legSender=leg.pc.getSenders().find(s=>s.track===raw);
  if(!baseSender||!legSender)return;
  const context=new AudioContext();mix={context,baseSender,raw};
  try{
    await context.resume();if(!mix||mix.context!==context||current!==base||conference!==leg)return;
    const local=context.createMediaStreamSource(new MediaStream([raw]));
    const toBase=context.createMediaStreamDestination(),toLeg=context.createMediaStreamDestination();
    local.connect(toBase);local.connect(toLeg);
    context.createMediaStreamSource(new MediaStream([leg.remoteAudio])).connect(toBase);
    context.createMediaStreamSource(new MediaStream([base.remoteAudio])).connect(toLeg);
    await Promise.all([baseSender.replaceTrack(toBase.stream.getAudioTracks()[0]),legSender.replaceTrack(toLeg.stream.getAudioTracks()[0])]);
    if(current===base&&conference===leg)showCall();
  }catch{
    if(conference===leg){notice('Could not mix conference audio. The original call is still active.');await endConference('failed');}
  }
}
async function inviteConference(p){
  const base=current;if(!base||conference||!p.online)return;
  const raw=base.stream?.getAudioTracks()[0];if(!raw)throw Error('A working microphone is required to merge.');
  const leg=conference={id:crypto.randomUUID(),name:p.name,peer:p.id};
  const pc=leg.pc=new RTCPeerConnection({iceServers:[]});pc.addTrack(raw,base.stream);showCall();
  pc.ontrack=e=>{
    if(conference!==leg||e.track.kind!=='audio')return;
    leg.remoteAudio=e.track;el('conference-audio').srcObject=new MediaStream([e.track]);
    void el('conference-audio').play().catch(()=>{el('play').hidden=false;});void mixConference();
  };
  pc.onconnectionstatechange=()=>{
    if(conference!==leg)return;clearTimeout(leg.drop);
    if(pc.connectionState==='connected'){void ready(leg);void mixConference();}
    if(pc.connectionState==='failed')void endConference('failed');
    if(pc.connectionState==='disconnected')leg.drop=setTimeout(()=>{if(conference===leg)void endConference('failed');},8000);
  };
  try{
    const sdp=await gather(pc,await pc.createOffer());if(conference!==leg||current!==base)return;
    await signal(leg,'offer',{to:p.id,mode:'voice',merge:base.id,sdp});leg.sent=true;
    if(conference!==leg||current!==base)await signal(leg,'end');
  }catch(e){if(conference===leg)await endConference('failed');throw e;}
}
on('merge-call','click',()=>{
  const available=peers.filter(p=>p.online&&p.id!==current?.peer);
  const rows=available.map(p=>{
    const button=node('button',p.name);button.addEventListener('click',()=>{
      el('merge-sheet').close();void inviteConference(p).catch(e=>notice(e.message));
    });return button;
  });
  el('merge-people').replaceChildren(...(rows.length?rows:[node('p','No other members are online.')]));
  el('merge-sheet').showModal();
});
on('close-merge','click',()=>el('merge-sheet').close());
function photoLimit(buffer){
  if(buffer.byteLength>MAX_PHOTO||buffer.byteLength<24)return false;
  const b=new Uint8Array(buffer);
  if(b[0]!==255||b[1]!==216||b.at(-2)!==255||b.at(-1)!==217)return false;
  for(let i=2;i+4<b.length;){
    if(b[i++]!==255)return false;
    while(b[i]===255)i++;
    if(i+2>=b.length)return false;
    const marker=b[i++],len=b[i]*256+b[i+1];
    if(len<2||i+len>b.length)return false;
    if(marker===192||marker===194){
      const h=b[i+3]*256+b[i+4],w=b[i+5]*256+b[i+6];return len>=8&&w>0&&h>0&&w<=900&&h<=900;
    }
    if(marker===218||marker===217)return false;i+=len;
  }
  return false;
}
async function loadPhoto(message){
  if(message.photo||message.loading||!token)return;
  message.loading=true;message.failed=false;showMessages();
  try{
    const response=await fetch('/photo?id='+message.photoId,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
    if(!response.ok||response.headers.get('Content-Type')!=='image/jpeg')throw Error('Photo unavailable');
    const data=await response.arrayBuffer();
    if(!photoLimit(data))throw Error('Invalid photo');
    if(!messages.includes(message))return;
    message.blob=new Blob([data],{type:'image/jpeg'});message.photo=URL.createObjectURL(message.blob);
    if(message.boot===boot&&message.from!==me?.id&&message.messageId)delivered.add(message.messageId);
  }catch{message.failed=true;}finally{message.loading=false;showMessages();}
}
function openPhoto(message){
  if(!message.photo)return;
  viewingPhoto=message;el('full-photo').src=message.photo;el('photo-view').showModal();
}
on('close-photo','click',()=>el('photo-view').close());
on('photo-view','close',()=>{viewingPhoto=null;el('full-photo').removeAttribute('src');});
on('save-photo','click',async()=>{
  const m=viewingPhoto;if(!m?.blob)return;
  const filename='Field-Link-'+m.photoId.slice(0,8)+'.jpg';
  if(bridge?.savePhoto){
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(m.blob);});
    bridge.savePhoto(filename,String(data).split(',')[1]);
  }else{
    const a=node('a');a.href=m.photo;a.download=filename;document.body.append(a);a.click();a.remove();
  }
});
async function nativeMicrophone(c){
  if(current!==c||!window.AudioContext||!bridge?.openMicrophone?.(c.id))return null;
  let context,timer;
  const release=c.releaseMic=()=>{
    clearInterval(timer);bridge.closeMicrophone(c.id);
    if(context&&context.state!=='closed')void context.close().catch(()=>{});
  };
  try{
    context=new AudioContext();
    const output=context.createMediaStreamDestination();
    await Promise.race([context.resume(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Audio engine did not start.')),1200))]);
    if(current!==c){release();return null;}
    let next=0,last=performance.now();
    timer=setInterval(()=>{
      const encoded=bridge.readMicrophone(c.id);
      if(!encoded){
        if(performance.now()-last>1600){
          release();output.stream.getTracks().forEach(t=>t.stop());
          if(current===c){notice('The Android microphone stopped. Reopen the call to reconnect it.');showCall();}
        }
        return;
      }
      last=performance.now();const pcm=atob(encoded);
      const buffer=context.createBuffer(1,pcm.length/2,16000),samples=buffer.getChannelData(0);
      for(let i=0;i<samples.length;i++)samples[i]=((pcm.charCodeAt(i*2)|(pcm.charCodeAt(i*2+1)<<8))<<16>>16)/32768;
      const now=context.currentTime;
      if(next<now||next-now>.17)next=now+.05;
      const source=context.createBufferSource();source.buffer=buffer;source.connect(output);source.start(next);next+=buffer.duration;
    },30);
    return output.stream;
  }catch{release();return null;}
}
async function microphone(c){
  const devices=navigator.mediaDevices;
  if(bridge?.microphoneState){
    for(let i=0;i<12&&bridge.microphoneState()==='inactive';i++)await new Promise(r=>setTimeout(r,120));
    const state=bridge.microphoneState();
    if(state==='inactive')throw new DOMException('Open Field Link and try again.','InvalidStateError');
    if(state==='muted')throw new DOMException('Turn on Microphone access in Android Quick Settings.','NotAllowedError');
  }
  const recoverable=e=>['NotReadableError','AbortError','OverconstrainedError','NotFoundError'].includes(e.name);
  const raw={echoCancellation:false,noiseSuppression:false,autoGainControl:false};
  let failure;
  for(const constraints of [true,raw]){
    try{return await devices.getUserMedia({audio:constraints,video:false});}
    catch(e){if(!recoverable(e))throw e;failure=e;await new Promise(r=>setTimeout(r,230));}
  }
  for(const input of (await devices.enumerateDevices().catch(()=>[])).filter(d=>d.kind==='audioinput'&&d.deviceId&&d.deviceId!=='default').slice(0,2)){
    try{return await devices.getUserMedia({audio:{...raw,deviceId:{exact:input.deviceId}},video:false});}
    catch(e){if(!recoverable(e))throw e;failure=e;}
  }
  const native=await nativeMicrophone(c);
  if(native)return native;
  throw failure;
}
function captureError(device,e){
  const state=device==='Microphone'?bridge?.microphoneState?.():'';
  const tip=state==='inactive'?'Bring Field Link to the foreground and retry.':
    state==='muted'?'Turn on Microphone access in Android Quick Settings.':
    e?.name==='NotAllowedError'&&state!=='allowed'?'Allow access in Android Settings → Apps → Field Link → Permissions.':
    state==='allowed'?'Android granted permission, but WebView could not open the input. Try the phone’s built-in mic with Bluetooth off.':
    'Check that this device has an available input and retry.';
  return Error(device+' could not start. '+tip+(e?.name?' ('+e.name+')':''));
}
async function createPeer(c,remoteOffer){
  const pc=c.pc=new RTCPeerConnection({iceServers:[]});
  pc.ontrack=async e=>{
    if(current!==c)return;
    if(e.track.kind==='audio'){c.remoteAudio=e.track;void mixConference();}
    const existing=el('remote').srcObject;
    if(e.streams[0])el('remote').srcObject=e.streams[0];
    else if(existing instanceof MediaStream){if(!existing.getTracks().includes(e.track))existing.addTrack(e.track);}
    else el('remote').srcObject=new MediaStream([e.track]);
    try{await el('remote').play();}catch{el('play').hidden=false;}
  };
  if(remoteOffer)await pc.setRemoteDescription({type:'offer',sdp:remoteOffer});
    if(!navigator.mediaDevices?.getUserMedia)throw Error('Open the trusted HTTPS address to use microphone and camera.');
    const stream=c.stream=new MediaStream();
    if(c.mode==='video'){
      let video;
      try{video=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});}
      catch(e){throw captureError('Camera',e);}
      if(current!==c){video.getTracks().forEach(t=>t.stop());throw Error('Call already closed.');}
      for(const track of video.getVideoTracks())stream.addTrack(track);
    }
    try{
      const audio=await microphone(c);
      if(current!==c){audio.getTracks().forEach(t=>t.stop());throw Error('Call already closed.');}
      for(const track of audio.getAudioTracks())stream.addTrack(track);
    }catch(e){
      if(c.mode!=='video'||current!==c)throw captureError('Microphone',e);
      c.noMic=true;c.micNotice=captureError('Microphone',e).message;
    }
    if(c.noMic){
      const audio=pc.getTransceivers().find(tr=>tr.receiver.track.kind==='audio');
      if(audio)audio.direction='recvonly';else if(!remoteOffer)pc.addTransceiver('audio',{direction:'recvonly'});
    }
    for(const t of [...stream.getAudioTracks(),...stream.getVideoTracks()]){
      const sender=pc.addTrack(t,stream);
      if(t.kind==='video'){
        const tr=pc.getTransceivers().find(x=>x.sender===sender);
        const supported=RTCRtpReceiver.getCapabilities?.('video')?.codecs||[];
        const compact=[...supported.filter(x=>x.mimeType.toLowerCase()==='video/vp8').slice(0,1),
          ...supported.filter(x=>x.mimeType.toLowerCase()==='video/h264').slice(0,2)];
        if(compact.length)try{tr?.setCodecPreferences?.(compact);}catch{}
      }
    }
    if(c.mode==='video')el('preview').srcObject=stream;
  pc.onconnectionstatechange=()=>{
    if(current!==c||!pc.localDescription||!pc.remoteDescription)return;clearTimeout(c.drop);
    if(pc.connectionState==='connected'){showCall('Connected');void ready(c);}
    if(pc.connectionState==='failed'){notice('Local media connection failed.');void end(c,'failed');}
    if(pc.connectionState==='disconnected')c.drop=setTimeout(()=>{if(current===c){notice('Connection lost.');void end(c,'failed');}},8000);
  };
  return pc;
}
async function gather(pc,desc){
  await pc.setLocalDescription(desc);
  if(pc.iceGatheringState!=='complete')await new Promise(resolve=>{
    const done=()=>{clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',change);resolve();};
    const change=()=>{if(pc.iceGatheringState==='complete')done();};
    const timeout=setTimeout(done,4300);pc.addEventListener('icegatheringstatechange',change);change();
  });
  return pc.localDescription.sdp;
}
async function dial(mode){
  const p=peer(thread);if(!p?.online||current)return;
  const c=current={id:crypto.randomUUID(),peer:p.id,name:p.name,mode};showCall('Preparing…');
  try{
    const pc=await createPeer(c),sdp=await gather(pc,await pc.createOffer());if(current!==c)return;
    await signal(c,'offer',{to:p.id,mode,sdp});c.sent=true;
    if(current!==c){await end(c);return;}
    showCall('Ringing…');notice(c.noMic?'Video will connect without your microphone. '+c.micNotice:'');
  }catch(e){if(current===c){await end(c,'failed');throw e;}}
}
async function processEvent(e){
  if(e.kind==='text'){addMessage(e);return;}
  if(e.kind==='photo'&&/^[a-f0-9]{24}$/.test(e.photoId)){void loadPhoto(addMessage(e));return;}
  if(e.kind==='offer'){
    if(current||!calls.some(c=>c.id===e.id&&c.state==='ringing'))return;
    current={id:e.id,peer:e.from,name:e.name,mode:e.mode,incoming:true,offer:e.sdp,sent:true,conferenceInvite:e.conference===true};
    if(!thread)selectThread(e.from);showCall('Incoming call');
    if(notifiedCall===e.id){notifiedCall='';el('answer').click();}
  }else if(conference&&e.id===conference.id){
    const leg=conference;
    if(e.kind==='answer')try{await leg.pc.setRemoteDescription({type:'answer',sdp:e.sdp});}catch{await endConference('failed');}
    if(e.kind==='end'){await endConference(null);notice('Conference participant '+e.state+'.');}
  }else if(e.id===current?.id){
    if(e.kind==='answer'){try{await current.pc.setRemoteDescription({type:'answer',sdp:e.sdp});showCall('Connecting…');}catch{await end(current,'failed');}}
    if(e.kind==='end'){closeCall();notice('Session '+e.state+(e.reason?' · '+e.reason:''));}
  }
}
on('answer','click',async()=>{
  const c=current;if(!c?.incoming)return;c.incoming=false;showCall('Connecting…');
  try{
    const pc=await createPeer(c,c.offer);
    if(current!==c||pc.signalingState==='closed')return;
    const sdp=await gather(pc,await pc.createAnswer());if(current!==c)return;
    await signal(c,'answer',{sdp});if(pc.connectionState==='connected')void ready(c);
    if(c.noMic)notice('Video connected without your microphone. '+c.micNotice);
  }catch(e){await end(c,'failed');throw e;}
});
on('hangup','click',()=>current&&end(current,current.incoming?'decline':'end'));
on('voice','click',()=>dial('voice'));on('video','click',()=>dial('video'));
on('play','click',async()=>{await el('remote').play();if(conference)await el('conference-audio').play();el('play').hidden=true;});
on('speaker','click',()=>{
  if(!bridge?.speaker||!current)return;
  if(!bridge.speaker(!speakerOn))throw Error('Could not switch the audio output.');
  speakerOn=!speakerOn;showCall();
});
on('mute','click',()=>{
  const tracks=current?.stream?.getAudioTracks()||[];
  const mute=tracks.some(t=>t.enabled);for(const t of tracks)t.enabled=!mute;put('mute',mute?'Unmute mic':'Mute mic');
});
on('camera-toggle','click',()=>{
  const track=current?.stream?.getVideoTracks()[0];if(!track)return;
  track.enabled=!track.enabled;put('camera-toggle',track.enabled?'Camera off':'Camera on');
});
on('flip-camera','click',async()=>{
  const c=current,old=c?.stream?.getVideoTracks()[0];if(!old||c.flipping)return;
  const sender=c.pc.getSenders().find(s=>s.track===old);if(!sender)return;
  const oldFacing=old.getSettings().facingMode||c.facing||'user',next=oldFacing==='user'?'environment':'user',enabled=old.enabled;
  const video=facingMode=>navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:facingMode},width:{ideal:640},height:{ideal:480}},audio:false});
  c.flipping=true;old.stop();
  let fresh,flipped=true;
  try{
    try{fresh=await video(next);}catch{flipped=false;fresh=await video(oldFacing);}
    const track=fresh.getVideoTracks()[0];
    if(current!==c){track.stop();return;}
    track.enabled=enabled;await sender.replaceTrack(track);c.stream.removeTrack(old);c.stream.addTrack(track);c.facing=flipped?next:oldFacing;
    if(!flipped)notice('This device did not expose another camera.');
  }catch(e){fresh?.getTracks().forEach(t=>t.stop());throw captureError('Camera',e);}
  finally{c.flipping=false;}
});
on('file','change',async e=>{
  const file=e.target.files[0],to=thread;e.target.value='';if(!file||!to)return;
  if(photoSending)throw Error('Wait for the current photo to finish sending.');
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8000000)throw Error('Choose JPEG, PNG or WebP under 8 MB.');
  const source=URL.createObjectURL(file);photoSending=true;
  try{
    const img=new Image();img.src=source;await img.decode();
    if(img.naturalWidth*img.naturalHeight>28000000)throw Error('Photo is too large.');
    const scale=Math.min(1,860/Math.max(img.naturalWidth,img.naturalHeight)),canvas=node('canvas');
    canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
    const toBlob=q=>new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',q));
    let blob=await toBlob(.74);if(blob?.size>MAX_PHOTO)blob=await toBlob(.50);
    if(blob?.size>MAX_PHOTO){
      const width=Math.max(1,Math.round(canvas.width*.75)),height=Math.max(1,Math.round(canvas.height*.75));
      canvas.width=width;canvas.height=height;ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.drawImage(img,0,0,width,height);blob=await toBlob(.48);
    }
    if(!blob||blob.size>MAX_PHOTO)throw Error('Choose a smaller photo.');
    notice('Sending photo…');
    const response=await fetch('/photo',{method:'POST',headers:{Authorization:'Bearer '+token,'X-Recipient':to,'Content-Type':'image/jpeg'},body:blob,signal:AbortSignal.timeout(16000)});
    if(!response.ok)throw Error((await response.json()).error||'Photo was not sent.');
    notice('Photo sent.');
  }finally{photoSending=false;URL.revokeObjectURL(source);}
});
async function init(){
  try{token=bridge?bridge.restoreSession():sessionStorage.getItem('flhub')||'';}catch{}
  if(!token){net(true);return;}
  try{activate(await api('resume'));}catch(e){if(e.status===401)await signOut();else notice('The ESP32 hub is not responding. Reconnect to its network and reload.');}
}
void init();
